// JB Export — main-world helper.
//
// Runs in the page's own JS world (manifest: "world": "MAIN"), not the
// extension's isolated world. That matters for one reason: Juicebox produces
// a candidate's real LinkedIn profile URL inside its own click handler, and
// whatever that handler does (window.open, rewriting the anchor href, a
// native anchor navigation) happens against the page's `window`/DOM. A
// content script in the isolated world has a different `window` object, so
// overriding window.open there captures nothing, even though the identical
// code works when pasted into the DevTools console (which runs in the page's
// world). Hence this file.
//
// It does not assume the mechanism. During one click it watches all of:
//   * window.open(url)                    -> "window.open"
//   * the anchor's href being rewritten   -> "href-change"
//   * a native navigation on the anchor   -> blocked with preventDefault in
//     the capture phase (propagation is NOT stopped, so Juicebox's own React
//     handler still runs), and the href it was about to follow is read
//   * window.location assignment          -> cannot be intercepted; reported
//     as "none" and the page is left alone (see README limitations)
// and reports back which one fired.
//
// Protocol with content.js (DOM events are shared across worlds, JS objects
// are not, so payloads are JSON strings):
//   content.js  -> document 'jbexport:resolve'  detail: {"requestId","rowId"}
//   this script -> document 'jbexport:resolved' detail: {"requestId","url","method","clickedTag","anchorTarget"}
(() => {
  if (window.__jbExportMainWorldReady) return;
  window.__jbExportMainWorldReady = true;

  const PROFILE_RE = /linkedin\.com\/in\//i;
  const SEARCH_RE = /linkedin\.com\/search\//i;

  // Poll until `check()` returns a truthy value or the timeout elapses. Keeps
  // per-row latency at "as soon as Juicebox answers" instead of a fixed wait.
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

  let loggedMechanismOnce = false;

  async function resolveRow(rowId) {
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
    let captured = '';
    let method = 'none';

    const originalOpen = window.open;
    window.open = (url) => {
      const u = String(url || '');
      if (PROFILE_RE.test(u)) { captured = u; method = 'window.open'; }
      return null; // never actually open a tab
    };

    const stopNav = (e) => {
      const a = e.target && e.target.closest && e.target.closest('a');
      if (!a || !cell.contains(a)) return;
      // Block only the browser's own navigation (target=_blank on a stale
      // search URL is where stray "Search | LinkedIn" tabs came from).
      e.preventDefault();
      const h = a.getAttribute('href') || '';
      if (!captured && PROFILE_RE.test(h)) { captured = h; method = 'anchor-navigation'; }
    };
    document.addEventListener('click', stopNav, true);

    try {
      clickTarget.click();
      await waitFor(() => {
        if (captured) return captured;
        const h = anchor ? anchor.getAttribute('href') || '' : '';
        if (h && h !== hrefBefore && PROFILE_RE.test(h) && !SEARCH_RE.test(h)) {
          captured = h; method = 'href-change';
          return h;
        }
        return '';
      }, 1500, 50);
    } finally {
      window.open = originalOpen;
      document.removeEventListener('click', stopNav, true);
    }

    if (!loggedMechanismOnce) {
      loggedMechanismOnce = true;
      console.info(
        `[LinkedIn Resolver] Mechanism check: clicked <${clickTarget.tagName.toLowerCase()}>, ` +
        `anchor target="${anchorTarget}", href before click was ${SEARCH_RE.test(hrefBefore) ? 'a people-search URL' : (hrefBefore || '(none)')}, ` +
        `observed: ${method}`
      );
    }

    return { url: captured, method, clickedTag: clickTarget.tagName, anchorTarget };
  }

  document.addEventListener('jbexport:resolve', async (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    let result;
    try {
      result = await resolveRow(String(req.rowId));
    } catch (err) {
      result = { url: '', method: 'error', clickedTag: '', anchorTarget: '' };
    }
    document.dispatchEvent(new CustomEvent('jbexport:resolved', {
      detail: JSON.stringify({ requestId: req.requestId, ...result }),
    }));
  });
})();
