// JB Export — main-world helper.
//
// Runs in the page's own JS world (manifest: "world": "MAIN"), not the
// extension's isolated world. Juicebox produces a candidate's real LinkedIn
// profile URL inside its own click handler, and whatever that handler does
// (window.open, rewriting the anchor href, a native anchor navigation)
// happens against the page's `window`/DOM. A content script in the isolated
// world has a different `window` object, so overriding window.open there
// captures nothing, even though the identical code works when pasted into
// the DevTools console (which runs in the page's world). Hence this file.
//
// Timing matters: Juicebox's handler is asynchronous and sometimes calls
// window.open well after the click (observed: >1.5s). A per-click hook that
// is removed on timeout therefore (a) lets that late call open a real tab,
// and (b) if the next row has already been clicked, attributes the late URL
// to the wrong candidate (an off-by-one seen in real exports). So the hooks
// are installed once and stay active for the whole export session, and a
// late capture is attributed to the last row that was clicked, as long as
// no newer row has been clicked since.
//
// Fast path: the first click reveals which Juicebox endpoint the handler
// calls for the row (observed: GET /api/profile/external?searchResultId=<id>,
// where <id> equals the row's data-id). Once that is confirmed on a real
// click, later rows are resolved by calling the same endpoint directly with
// the page's own session, in parallel, and reading the /in/ URL out of the
// response. Request and response are tied together, so a late answer can
// never land on the wrong candidate, and each row costs one request instead
// of a click plus a wait. If the endpoint ever fails the row falls back to
// the click path below.
//
// Mechanisms watched during a click (none is assumed):
//   * window.open(url)                    -> "window.open"
//   * the anchor's href being rewritten   -> "href-change"
//   * a native navigation on the anchor   -> blocked with preventDefault in
//     the capture phase (propagation is NOT stopped, so Juicebox's own React
//     handler still runs); the href it was about to follow is read
//   * window.location assignment          -> cannot be intercepted; reported
//     as "none" (see README limitations)
//
// Protocol with content.js (DOM events are shared across worlds, JS objects
// are not, so payloads are JSON strings):
//   content.js  -> 'jbexport:session'  {"active": true|false}
//   content.js  -> 'jbexport:resolve'  {"requestId","rowId","name"}
//   this script -> 'jbexport:resolved' {"requestId","url","method","clickedTag","anchorTarget"}
//   this script -> 'jbexport:late'     {"rowId","url","method"}   (capture after the row's request timed out)
//   this script -> 'jbexport:log'      {"line"}                     (diagnostic line for the debug file)
(() => {
  if (window.__jbExportMainWorldReady) return;
  window.__jbExportMainWorldReady = true;

  const PROFILE_RE = /linkedin\.com\/in\//i;
  const SEARCH_RE = /linkedin\.com\/search\//i;
  const MAX_WAIT_MS = 2500;      // per row, upper bound before content.js moves on
  const MIN_WAIT_MS = 700;       // adaptive floor once Juicebox's real latency is known
  const LATE_WINDOW_MS = 10000;  // how long a timed-out row can still claim a capture
  const GRACE_AFTER_TIMEOUT_MS = 300;

  let sessionActive = false;
  let inFlight = null;           // { rowId, requestId, name, settle }
  let lastClicked = null;        // { rowId, name, at, settled }
  // Rows that were clicked but never answered (within LATE_WINDOW_MS). A
  // capture that does not belong to the in-flight row is matched against
  // these by name, so a slow answer two or three rows back still lands on
  // its own candidate (a chain of off-by-one URLs was seen without this).
  let pending = [];              // [{ rowId, name, at }]
  const FAST_ANSWER_MS = 400;    // faster than Juicebox has ever answered a fresh click
  // Learned from the first real click: the endpoint Juicebox calls for a
  // row, with the row id replaced by {id}. null until verified.
  let apiTemplate = null;
  let apiHeaders = null;         // headers Juicebox itself sent with that request (auth lives here)
  let apiDisabled = false;       // set after an auth/permission failure so no more time is wasted
  let apiStats = { ok: 0, noProfile: 0, failed: 0, retried429: 0 };
  let apiSampleLogged = false;
  let clickQueue = Promise.resolve(); // click path is strictly one at a time
  let loggedMechanismOnce = false;
  let fetchLog = null;           // non-null only while the first click is being diagnosed
  // Latency of successful captures (ms). Juicebox usually answers in well
  // under a second; once a few samples exist the per-row wait shrinks to
  // ~3x the slowest of them, so rows that never answer stop costing 2.5s.
  const latencies = [];
  function currentWaitMs() {
    if (latencies.length < 5) return MAX_WAIT_MS;
    const sorted = latencies.slice().sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, p90 * 3));
  }

  function emit(name, payload) {
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
  }
  function log(line) {
    console.info(line);
    emit('jbexport:log', { line });
  }

  // Name tokens (>= 3 letters, ASCII-folded) for checking a captured slug
  // against the candidate it is about to be attributed to. Used only to
  // disambiguate a late answer from a fresh one; never to build a URL.
  function nameTokens(name) {
    return String(name || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
  }
  function slugMatchesName(url, name) {
    const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url || ''));
    if (!m) return false;
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (err) { /* keep raw */ }
    slug = slug.toLowerCase().replace(/[^a-z]/g, '');
    return nameTokens(name).some((t) => slug.includes(t));
  }

  // Juicebox answered with a people-search URL: it has no profile for this
  // candidate. That is a final answer, so the row settles at once instead
  // of waiting out the full timeout (this alone was most of the slowness).
  function handleNoProfile(url) {
    if (inFlight) inFlight.settle('', 'search-url');
  }

  function prunePending() {
    const now = Date.now();
    pending = pending.filter((p) => now - p.at < LATE_WINDOW_MS);
  }

  // Which pending row (if any) a capture belongs to: by name first, then,
  // for an answer that arrived faster than a fresh click can, the most
  // recently clicked pending row.
  function claimPending(url, arrivedFastAfterClick) {
    prunePending();
    let idx = pending.findIndex((p) => slugMatchesName(url, p.name));
    if (idx < 0 && arrivedFastAfterClick && pending.length) idx = pending.length - 1;
    if (idx < 0) return null;
    return pending.splice(idx, 1)[0];
  }

  function handleCapture(url, method) {
    if (inFlight) {
      const sinceClick = Date.now() - inFlight.clickedAt;
      // An answer that does not fit the in-flight candidate but does fit a
      // row still waiting for one goes to that row instead.
      if (!slugMatchesName(url, inFlight.name)) {
        const owner = claimPending(url, sinceClick < FAST_ANSWER_MS);
        if (owner) {
          emit('jbexport:late', { rowId: owner.rowId, url, method });
          return;
        }
      }
      inFlight.settle(url, method);
      return;
    }
    // No request in flight: a row's wait expired before Juicebox answered.
    const owner = claimPending(url, true);
    if (owner) emit('jbexport:late', { rowId: owner.rowId, url, method });
  }

  // ---- hooks: installed once, active only while an export session runs ----
  const originalOpen = window.open;
  window.open = function (url, ...rest) {
    const u = String(url || '');
    if (sessionActive) {
      if (PROFILE_RE.test(u)) handleCapture(u, 'window.open');
      else if (SEARCH_RE.test(u) || /linkedin\.com/i.test(u)) handleNoProfile(u);
      return null; // never open a tab during an export
    }
    return originalOpen.call(window, url, ...rest); // user's own clicks behave normally
  };

  document.addEventListener('click', (e) => {
    if (!sessionActive) return;
    const a = e.target && e.target.closest && e.target.closest('a');
    if (!a || !a.closest('[data-field="profiles"]')) return;
    // Block only the browser's own navigation (target=_blank on a stale
    // search URL is where stray "Search | LinkedIn" tabs came from).
    e.preventDefault();
    const h = a.getAttribute('href') || '';
    if (PROFILE_RE.test(h) && !SEARCH_RE.test(h)) handleCapture(h, 'anchor-navigation');
  }, true);

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (fetchLog) fetchLog.push(`${(init && init.method) || 'GET'} ${u}`);
    // Learn the per-row endpoint from a real click: only accepted when the
    // request carries exactly the row id we just clicked. The request's own
    // headers are kept too: SPAs usually authenticate with a bearer header,
    // not a cookie, so replaying the URL alone would get a 401.
    if (!apiTemplate && sessionActive && inFlight && u) {
      const m = /[?&]searchResultId=([^&#]+)/.exec(u);
      if (m && decodeURIComponent(m[1]) === inFlight.rowId) {
        apiTemplate = u.replace(m[1], '{id}');
        apiHeaders = plainHeaders(input, init);
        log(`[LinkedIn Resolver] API learned from click: ${apiTemplate} (headers: ${Object.keys(apiHeaders).join(', ') || 'none'})`);
      }
    }
    return originalFetch.apply(this, arguments);
  };

  // Copies request headers into a plain object, from either a Request input
  // or an init.headers (Headers instance, array, or object).
  function plainHeaders(input, init) {
    const out = {};
    const add = (h) => {
      if (!h) return;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach((v, k) => { out[k] = v; }); return; }
      if (Array.isArray(h)) { for (const [k, v] of h) out[k] = v; return; }
      if (typeof h === 'object') { for (const k of Object.keys(h)) out[k] = h[k]; }
    };
    if (input && typeof input === 'object' && input.headers) add(input.headers);
    if (init && init.headers) add(init.headers);
    for (const k of Object.keys(out)) {
      if (/^(content-length|host|connection)$/i.test(k)) delete out[k];
    }
    return out;
  }

  // Direct call of the learned endpoint. Returns null when the call could
  // not be trusted (network/HTTP error), so the caller falls back to a click.
  async function resolveViaApi(rowId) {
    if (!apiTemplate || apiDisabled) return null;
    const url = apiTemplate.replace('{id}', encodeURIComponent(rowId));
    const startedAt = Date.now();
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await originalFetch.call(window, url, { method: 'GET', headers: apiHeaders || {}, credentials: 'include' });
      } catch (err) {
        apiStats.failed += 1;
        return null;
      }
      if (res.status === 429 && attempt === 0) {
        // Rate limited: back off once, then try again before giving up.
        apiStats.retried429 += 1;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break;
    }
    if (!res.ok) {
      apiStats.failed += 1;
      if (res.status === 401 || res.status === 403) {
        // Auth is not replayable from here; stop trying so every row does
        // not pay for a failed request before its click.
        apiDisabled = true;
        log(`[LinkedIn Resolver] API returned HTTP ${res.status}; direct calls disabled for this session, using clicks`);
      } else if (apiStats.failed <= 3) {
        log(`[LinkedIn Resolver] API returned HTTP ${res.status} for a row; falling back to click`);
      }
      return null;
    }
    const text = await res.text();
    if (!apiSampleLogged) {
      apiSampleLogged = true;
      log(`[LinkedIn Resolver] API response sample (${text.length} chars): ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    const m = /https?:\\?\/\\?\/(?:[a-z]{2,3}\.)?linkedin\.com\\?\/in\\?\/[^"'\s<>\\]+/i.exec(text);
    const found = m ? m[0].replace(/\\\//g, '/') : '';
    if (found) apiStats.ok += 1; else apiStats.noProfile += 1;
    return {
      url: found,
      method: found ? 'api' : 'api-no-profile',
      waitedMs: Date.now() - startedAt,
      waitMs: 0,
      clickedTag: '',
      anchorTarget: '',
    };
  }

  // ---- per-row resolve ----
  function waitFor(check, timeoutMs, intervalMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const v = check();
        if (v) return resolve(v);
        if (Date.now() - started >= timeoutMs) return resolve('');
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  async function resolveRow(rowId, requestId, name) {
    const row = document.querySelector(`.MuiDataGrid-row[data-id="${CSS.escape(rowId)}"]`);
    if (!row) return { url: '', method: 'row-not-mounted', clickedTag: '', anchorTarget: '' };

    const cell = row.querySelector('[data-field="profiles"]');
    const icon = cell && cell.querySelector('img[src*="linkedin" i]');
    const anchor = cell && cell.querySelector('a[aria-label="LinkedIn"]');
    // The React handler is bound on the icon's wrapper, not necessarily on
    // the <a>; clicking the wrapper is what a real user click dispatches
    // through. Confirmed against a manual console test on the live page.
    const clickTarget = (icon && icon.closest('a,button,div')) || anchor;
    if (!clickTarget) return { url: '', method: 'no-icon', clickedTag: '', anchorTarget: '' };

    const hrefBefore = anchor ? anchor.getAttribute('href') || '' : '';
    const anchorTarget = anchor ? anchor.getAttribute('target') || '' : '';

    // If the previous row timed out, give its late answer a moment to land
    // before a new click makes attribution ambiguous.
    if (lastClicked && !lastClicked.settled) await new Promise((r) => setTimeout(r, GRACE_AFTER_TIMEOUT_MS));

    let captured = '';
    let method = 'none';
    let answered = false;
    let settleFn = null;
    const clickedAt = Date.now();
    const settled = new Promise((resolve) => {
      settleFn = (url, m) => {
        if (!answered) { answered = true; captured = url; method = m; }
        if (url) latencies.push(Date.now() - clickedAt);
        resolve(url);
      };
    });
    const waitMs = currentWaitMs();
    inFlight = { rowId, requestId, name, clickedAt, settle: settleFn };
    lastClicked = { rowId, name, at: clickedAt, settled: false };
    const diagnosing = !loggedMechanismOnce;
    if (diagnosing) fetchLog = [];

    try {
      clickTarget.click();
      await Promise.race([
        settled,
        waitFor(() => {
          const h = anchor ? anchor.getAttribute('href') || '' : '';
          if (h && h !== hrefBefore && PROFILE_RE.test(h) && !SEARCH_RE.test(h)) {
            settleFn(h, 'href-change');
            return h;
          }
          return '';
        }, waitMs, 50),
      ]);
    } finally {
      inFlight = null;
      if (answered) lastClicked.settled = true;
      else pending.push({ rowId, name, at: clickedAt });
      if (diagnosing) {
        loggedMechanismOnce = true;
        const insideAnchor = !!clickTarget.closest('a');
        log(
          `[LinkedIn Resolver] Mechanism check: clicked <${clickTarget.tagName.toLowerCase()}> (inside <a>: ${insideAnchor}), ` +
          `anchor target="${anchorTarget}", href before click was ${SEARCH_RE.test(hrefBefore) ? 'a people-search URL' : (hrefBefore || '(none)')}, ` +
          `observed: ${method} after ${Date.now() - clickedAt}ms${fetchLog.length ? `, fetches during click: ${fetchLog.join(' ; ')}` : ', no fetch calls during click'}`
        );
        fetchLog = null;
      }
    }

    return {
      url: captured,
      method: answered ? method : 'timeout',
      waitedMs: Date.now() - clickedAt,
      waitMs,
      clickedTag: clickTarget.tagName,
      anchorTarget,
    };
  }

  document.addEventListener('jbexport:session', (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    sessionActive = !!req.active;
    if (!sessionActive) {
      inFlight = null; lastClicked = null; pending = [];
      log(`[LinkedIn Resolver] Session summary: api template ${apiTemplate ? 'learned' : 'NOT learned'}${apiDisabled ? ' (disabled after auth error)' : ''}, api ok=${apiStats.ok} noProfile=${apiStats.noProfile} failed=${apiStats.failed} retried429=${apiStats.retried429}`);
    }
  });

  document.addEventListener('jbexport:resolve', async (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    const rowId = String(req.rowId);
    let result = null;
    try {
      result = await resolveViaApi(rowId);
    } catch (err) {
      result = null;
    }
    if (!result) {
      // Click path, serialised: only one click can be attributed at a time.
      const run = clickQueue.then(async () => {
        try {
          return await resolveRow(rowId, req.requestId, req.name || '');
        } catch (err) {
          inFlight = null;
          return { url: '', method: 'error', clickedTag: '', anchorTarget: '' };
        }
      });
      clickQueue = run.catch(() => {});
      result = await run;
    }
    emit('jbexport:resolved', { requestId: req.requestId, ...result });
  });
})();
