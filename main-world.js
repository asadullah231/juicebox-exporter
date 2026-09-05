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
  let prevTimedOut = null;       // the row before inFlight, if its wait expired unanswered
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

  function handleCapture(url, method) {
    if (inFlight) {
      // A previous row's answer can land while the next row is already
      // waiting. If the slug clearly belongs to that previous candidate and
      // not to the current one, hand it back instead of misattributing it.
      if (prevTimedOut && Date.now() - prevTimedOut.at < LATE_WINDOW_MS &&
          slugMatchesName(url, prevTimedOut.name) && !slugMatchesName(url, inFlight.name)) {
        emit('jbexport:late', { rowId: prevTimedOut.rowId, url, method });
        prevTimedOut = null;
        return;
      }
      inFlight.settle(url, method);
      return;
    }
    // A capture with no request in flight: Juicebox answered after the row's
    // wait expired. Give it to that row if nothing newer was clicked since.
    if (lastClicked && Date.now() - lastClicked.at < LATE_WINDOW_MS) {
      emit('jbexport:late', { rowId: lastClicked.rowId, url, method });
      lastClicked = null;
    }
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
    if (fetchLog) {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      fetchLog.push(`${(init && init.method) || 'GET'} ${u}`);
    }
    return originalFetch.apply(this, arguments);
  };

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
    inFlight = { rowId, requestId, name, settle: settleFn };
    prevTimedOut = lastClicked && !lastClicked.settled ? lastClicked : null;
    lastClicked = { rowId, name, at: Date.now(), settled: false };
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
    if (!sessionActive) { inFlight = null; lastClicked = null; }
  });

  document.addEventListener('jbexport:resolve', async (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    let result;
    try {
      result = await resolveRow(String(req.rowId), req.requestId, req.name || '');
    } catch (err) {
      inFlight = null;
      result = { url: '', method: 'error', clickedTag: '', anchorTarget: '' };
    }
    emit('jbexport:resolved', { requestId: req.requestId, ...result });
  });
})();
