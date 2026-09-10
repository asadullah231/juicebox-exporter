// Juicebox Candidate Exporter — content script
// Runs on app.juicebox.ai. Reads candidate rows from the MUI X DataGrid
// results table and reports them to the popup. Never opens candidate
// profiles, never fetches anything beyond what's already rendered.

const ROW_SELECTOR = '.MuiDataGrid-row';
const SCROLLER_SELECTOR = '.MuiDataGrid-virtualScroller';
const GRID_SELECTOR = '[role="grid"], .MuiDataGrid-root';

function cleanText(value) {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

// The Company name isn't rendered in any grid cell — it only exists on the
// row's underlying React data model (profileDetails.job_company_name). We
// read it the same way React DevTools does: walk up the fiber tree from the
// DOM node looking for a memoizedProps shape that carries row data. This is
// inherently coupled to Juicebox's current React internals and may need
// updating if their component structure changes; it degrades gracefully to
// an empty string rather than throwing.
function getReactFiberKey(el) {
  return Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
}

function readProfileDetailsCompany(props) {
  // Confirmed shape (DOM audit, 30 Aug 2026): the row's own fiber (depth 0)
  // exposes profileDetails at props.children[2][0].props.row.profileDetails.
  // Walk defensively in case array/object indexing shifts slightly between
  // Juicebox releases.
  try {
    const row = props?.children?.[2]?.[0]?.props?.row;
    const details = row?.profileDetails;
    const name = details?.job_company_name || details?.job_company?.name;
    if (typeof name === 'string' && name.trim()) return cleanText(name);
  } catch (e) {
    // fall through to null
  }
  return '';
}

function extractCompanyFromFiber(rowEl) {
  try {
    const fiberKey = getReactFiberKey(rowEl);
    if (!fiberKey) return '';

    let fiber = rowEl[fiberKey];
    for (let depth = 0; fiber && depth < 10; depth += 1) {
      const props = fiber.memoizedProps;
      const found = readProfileDetailsCompany(props);
      if (found) return found;
      fiber = fiber.return;
    }
  } catch (e) {
    // Fiber shape changed or isn't accessible — fail silently, company is optional.
  }
  return '';
}

function isJuiceboxResultsPage() {
  return !!document.querySelector(GRID_SELECTOR);
}

function getExpectedTotal() {
  // "Matches (864)" heading — best-effort, used only for progress reporting.
  for (const el of document.querySelectorAll('h1, h2, h3, h4')) {
    const match = (el.textContent || '').match(/Matches\s*\((\d+)\)/i);
    if (match) return parseInt(match[1], 10);
  }
  const grid = document.querySelector(GRID_SELECTOR);
  const ariaCount = grid?.getAttribute('aria-rowcount');
  return ariaCount ? Math.max(0, parseInt(ariaCount, 10) - 1) : null;
}

// ---------------------------------------------------------------------------
// LinkedIn profile URL resolver
//
// What the DOM gives us: the LinkedIn icon in each row is an <a> whose href is
// a LinkedIn *people-search* URL (keywords=name+company), never the profile.
// The real /in/... URL only exists after Juicebox's own click handler runs
// (it's not in the row's React props up front; see extractCompanyFromFiber
// for the shape we walk). That handler runs in the page's JS world, which an
// isolated-world content script cannot observe (each world has its own
// `window`, so patching window.open here does nothing). So the actual
// click-and-capture lives in main-world.js ("world": "MAIN" in the manifest)
// and is driven from here over DOM CustomEvents, which ARE shared across
// worlds. main-world.js captures whichever mechanism Juicebox uses
// (window.open, an in-place href rewrite, or a native anchor navigation it
// blocks with preventDefault) and reports back the URL plus the mechanism.
//
// Rules enforced here, not in main-world.js, so they hold regardless of what
// the page does:
//   * only a canonical https://www.linkedin.com/in/<slug>/ is accepted;
//   * a people-search URL is never returned as the profile URL;
//   * results are cached per Juicebox row id across export runs, so a
//     re-export never clicks the same candidate twice;
//   * a row that can't be resolved yields '' (never a guessed slug).
// ---------------------------------------------------------------------------

const LINKEDIN_PROFILE_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)/i;

// Accepts only a real profile URL; normalises host, strips query/fragment,
// adds the trailing slash. Returns '' for anything else (search URLs, company
// pages, junk).
function canonicalLinkedInProfileUrl(url) {
  const m = LINKEDIN_PROFILE_RE.exec(String(url || '').trim());
  if (!m) return '';
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch (e) { /* keep raw */ }
  slug = slug.replace(/\/+$/, '');
  if (!slug) return '';
  return `https://www.linkedin.com/in/${slug}/`;
}

// Module-level: survives across export runs on the same page load.
// Map<juiceboxRowId, canonicalProfileUrl>. Only successes are cached so a
// transient failure (row unmounted mid-click, slow handler) can retry later.
const linkedinUrlCache = new Map();

// Per-run diagnostics so the popup can say exactly what happened during the
// click-resolve step instead of the user having to guess from the CSV.
const resolveDiag = {
  attempted: 0, viaWindowOpen: 0, viaHrefChange: 0, late: 0, none: 0, cached: 0,
  skippedNotMounted: 0, retried: 0, retryRecovered: 0, failByMethod: {}, sample: null,
};
let resolveSeq = 0;
// How the most recent extractActualLinkedInUrl() call ended ('window.open',
// 'timeout', 'row-not-mounted', ...). Lets the collector decide whether a
// miss is worth a second attempt without changing the function's contract.
let lastResolveMethod = '';
// Set once main-world.js has answered a row through Juicebox's own endpoint
// instead of a click. From then on rows are resolved a few at a time.
let apiMode = false;
const API_CONCURRENCY = 4;
// Diagnostic lines for the debug file the popup downloads when rows were
// left empty; mirrors what the page console shows. Capped so a huge run
// cannot grow it without bound.
const debugLog = [];
const DEBUG_LOG_MAX = 3000;
function debug(line) {
  console.log(line);
  if (debugLog.length < DEBUG_LOG_MAX) debugLog.push(line);
}
document.addEventListener('jbexport:log', (e) => {
  let data;
  try { data = JSON.parse(e.detail); } catch (err) { return; }
  if (data && data.line && debugLog.length < DEBUG_LOG_MAX) debugLog.push(String(data.line));
});
const MAX_RESOLVE_ATTEMPTS = 2;
// main-world.js waits up to 2.5s plus a 300ms grace; this must outlast that.
const RESOLVE_REPLY_TIMEOUT_MS = 3500;

// Asks main-world.js to click this row's LinkedIn icon and report what URL
// Juicebox produced. Resolves to the raw result object; never rejects.
function requestMainWorldResolve(rowId, name) {
  const requestId = `${Date.now()}-${resolveSeq++}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('jbexport:resolved', onResolved);
      clearTimeout(timer);
      resolve(result);
    };
    const onResolved = (e) => {
      let data;
      try { data = JSON.parse(e.detail); } catch (err) { return; }
      if (data.requestId === requestId) finish(data);
    };
    // If main-world.js never answers (not loaded, Juicebox changed markup),
    // give up on this row rather than stalling the whole export.
    const timer = setTimeout(() => finish({ url: '', method: 'timeout', clickedTag: '' }), RESOLVE_REPLY_TIMEOUT_MS);

    document.addEventListener('jbexport:resolved', onResolved);
    document.dispatchEvent(new CustomEvent('jbexport:resolve', {
      detail: JSON.stringify({ requestId, rowId, name }),
    }));
  });
}

// Resolves the candidate's real LinkedIn profile URL for a mounted grid row.
// Priority: (1) URL captured from Juicebox's own click behaviour,
// (2) a canonical /in/ URL already present in the DOM href, (3) ''.
// The row must still be mounted (virtualised grid) when this is called.
async function extractActualLinkedInUrl(rowEl) {
  const r = await resolveLinkedInUrlDetailed(rowEl);
  return r.url;
}

// Same as extractActualLinkedInUrl but also reports how the row ended, so
// parallel callers do not race on a shared "last method" variable.
async function resolveLinkedInUrlDetailed(rowEl) {
  const rowId = rowEl.getAttribute('data-id') || '';
  const nameEl = rowEl.querySelector('[data-field="full_name"] p');
  const candidate = cleanText(nameEl?.textContent) || rowId || '(unknown)';
  const anchor = rowEl.querySelector('[data-field="profiles"] a[aria-label="LinkedIn"]');
  const domUrl = anchor?.getAttribute('href') || '';

  // (2) DOM already has the real thing: no click needed.
  const fromDom = canonicalLinkedInProfileUrl(domUrl);
  if (fromDom) { lastResolveMethod = 'dom'; return { url: fromDom, method: 'dom' }; }

  // No LinkedIn icon at all: nothing to resolve.
  if (!anchor && !rowEl.querySelector('[data-field="profiles"] img[src*="linkedin" i]')) {
    lastResolveMethod = 'no-icon';
    return { url: '', method: 'no-icon' };
  }

  // Cache hit from an earlier run / pass.
  if (rowId && linkedinUrlCache.has(rowId)) {
    resolveDiag.cached += 1;
    lastResolveMethod = 'cache';
    return { url: linkedinUrlCache.get(rowId), method: 'cache' };
  }

  // (1) Ask the page's own handler.
  resolveDiag.attempted += 1;
  const result = rowId ? await requestMainWorldResolve(rowId, candidate) : { url: '', method: 'no-row-id', clickedTag: '' };
  const finalUrl = canonicalLinkedInProfileUrl(result.url);
  lastResolveMethod = result.method || 'none';
  if (typeof result.method === 'string' && result.method.startsWith('api')) apiMode = true;

  if (finalUrl) {
    if (result.method === 'window.open') resolveDiag.viaWindowOpen += 1;
    else if (result.method === 'api') resolveDiag.viaApi = (resolveDiag.viaApi || 0) + 1;
    else resolveDiag.viaHrefChange += 1;
    if (rowId) linkedinUrlCache.set(rowId, finalUrl);
  } else {
    resolveDiag.none += 1;
    resolveDiag.failByMethod[lastResolveMethod] = (resolveDiag.failByMethod[lastResolveMethod] || 0) + 1;
  }
  if (!resolveDiag.sample) {
    resolveDiag.sample = { clickedTag: result.clickedTag || '', method: result.method, anchorTarget: result.anchorTarget || '' };
  }

  debug(
    `[LinkedIn Resolver] Candidate: ${candidate} | DOM URL: ${domUrl || '(none)'} | ` +
    `Captured URL: ${result.url || '(none)'} via ${result.method}` +
    (result.waitedMs != null ? ` in ${result.waitedMs}ms (limit ${result.waitMs}ms)` : '') +
    ` | Final URL: ${finalUrl || '(empty)'}`
  );
  return { url: finalUrl, method: lastResolveMethod };
}

// MUI X DataGrid marks a selected row with aria-selected="true" and the
// Mui-selected class; the row checkbox lives in the "__check__" column (or,
// in some builds, inside the first data cell). Any of these counts, and any
// checkbox inside the row that is NOT checked is ignored, so a row is only
// "selected" when the grid itself says so.
// Every way a MUI DataGrid / MUI Checkbox / custom checkbox can show "checked".
// Juicebox's grid does not necessarily use MUI's own selection model, so the
// row-level markers alone are not enough: the checkbox cell itself is read too.
function isRowSelected(rowEl) {
  if (rowEl.getAttribute('aria-selected') === 'true') return true;
  if (rowEl.classList.contains('Mui-selected')) return true;
  for (const box of rowEl.querySelectorAll('input[type="checkbox"]')) {
    if (box.checked || box.getAttribute('aria-checked') === 'true') return true;
  }
  if (rowEl.querySelector('[role="checkbox"][aria-checked="true"], [aria-checked="true"]')) return true;
  if (rowEl.querySelector('.Mui-checked, .MuiCheckbox-root.Mui-checked, [data-checked="true"], [data-state="checked"]')) return true;
  // MUI Checkbox renders a different SVG icon when checked.
  if (rowEl.querySelector('svg[data-testid="CheckBoxIcon"], svg[data-testid="IndeterminateCheckBoxIcon"]')) return true;
  return false;
}

// One-time description of what a row's checkbox cell looks like, so a
// selection that the detector misses can be diagnosed from the debug file.
// Only tag names, classes and attributes are logged, never cell text.
let selectionShapeLogged = false;
function logSelectionShape(rowEl) {
  if (selectionShapeLogged) return;
  selectionShapeLogged = true;
  const cell = rowEl.querySelector('[data-field="__check__"]') ||
    rowEl.querySelector('input[type="checkbox"], [role="checkbox"]')?.closest('[role="cell"], [data-field]') ||
    rowEl.firstElementChild;
  const describe = (el, depth) => {
    if (!el || depth > 4) return '';
    const attrs = Array.from(el.attributes || [])
      .filter((a) => /^(class|role|aria-|data-|type|checked)/.test(a.name))
      .map((a) => `${a.name}="${String(a.value).slice(0, 60)}"`).join(' ');
    const kids = Array.from(el.children || []).slice(0, 4).map((k) => describe(k, depth + 1)).join('');
    return `<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>${kids}</${el.tagName.toLowerCase()}>`;
  };
  debug(`[LinkedIn Resolver] Selection check: row aria-selected="${rowEl.getAttribute('aria-selected')}" class="${rowEl.className}" | check cell: ${describe(cell, 0).slice(0, 900)}`);
}

function extractRow(rowEl) {
  const id = rowEl.getAttribute('data-id') || null;

  const nameEl = rowEl.querySelector('[data-field="full_name"] p');
  const name = cleanText(nameEl?.textContent);

  // What the DOM exposes (a people-search URL, or occasionally a real /in/
  // link). Kept separately: it feeds the "row has rendered" check and the
  // resolver's DOM shortcut, but is never exported as the profile URL.
  const linkedinEl = rowEl.querySelector('[data-field="profiles"] a[aria-label="LinkedIn"]');
  const domLinkedinUrl = linkedinEl?.getAttribute('href') || '';
  // Filled in by extractActualLinkedInUrl while the row is still mounted.
  const linkedinUrl = canonicalLinkedInProfileUrl(domLinkedinUrl);

  const titleEl = rowEl.querySelector('[data-field="job_title_info"] p');
  const jobTitle = cleanText(titleEl?.textContent);

  const locationEl = rowEl.querySelector('[data-field="location_info"]');
  const location = cleanText(locationEl?.textContent);

  const matchEl = rowEl.querySelector('[data-field="matchRate"] p');
  const matchPercent = cleanText(matchEl?.textContent);

  const selected = isRowSelected(rowEl);
  logSelectionShape(rowEl);

  // Company: main-world.js's fiber read (data-jb-company) first, then the
  // in-world fiber read (kept for completeness), then the search-keywords
  // fallback.
  const company = cleanText(rowEl.getAttribute('data-jb-company')) ||
    extractCompanyFromFiber(rowEl) ||
    companyFromSearchKeywords(name, domLinkedinUrl);

  return {
    id,
    key: id || `${name}|${jobTitle}|${location}`,
    name,
    linkedinUrl,
    domLinkedinUrl,
    rowEl,
    jobTitle,
    location,
    matchPercent,
    company,
    selected,
    // A row that only just mounted can render before MUI fills its cells in.
    // Treat it as "not yet ready" rather than a permanent miss so the scroll
    // loop gets another chance to pick it up on a later pass.
    hasAnyField: !!(name || domLinkedinUrl || jobTitle || location || matchPercent),
  };
}

function collectVisibleRows() {
  // Synchronous round-trip: main-world.js stamps data-jb-company on every
  // mounted row before the rows are read (see main-world.js).
  document.dispatchEvent(new CustomEvent('jbexport:annotate'));
  return Array.from(document.querySelectorAll(ROW_SELECTOR)).map(extractRow);
}

// Last resort for Company: the LinkedIn icon's people-search href carries
// "keywords=<name> <company>". Removing the candidate's name tokens from the
// front leaves the company, lowercased by Juicebox, so it is title-cased.
function companyFromSearchKeywords(name, searchUrl) {
  const m = /[?&]keywords=([^&#]*)/i.exec(String(searchUrl || ''));
  if (!m) return '';
  let kw;
  try { kw = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return ''; }
  const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = kw.trim().split(/\s+/);
  const nameTokens = fold(name).split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && i < nameTokens.length && fold(words[i]) === nameTokens[i]) i += 1;
  if (i === 0) return '';
  const rest = words.slice(i).join(' ').trim();
  if (!rest) return '';
  // Capitalise the first letter of each word; \b would split on accented
  // letters ("wörwag" -> "WöRwag"), so word starts are found explicitly.
  return rest.replace(/(^|[\s(\-\/])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scrolls the virtualized grid in steps, collecting rows as they render.
// Stops when the scroller can no longer move (end of list) or when no new
// unique, fully-rendered candidates appear for several consecutive steps.
// Rows of the export currently running, by Juicebox row id, so a late
// capture from main-world.js (Juicebox answering after the row's wait
// expired) can still be written onto the right candidate.
let liveRowsById = null;

document.addEventListener('jbexport:late', (e) => {
  let data;
  try { data = JSON.parse(e.detail); } catch (err) { return; }
  const url = canonicalLinkedInProfileUrl(data.url);
  if (!url || !data.rowId) return;
  linkedinUrlCache.set(String(data.rowId), url);
  const row = liveRowsById && liveRowsById.get(String(data.rowId));
  if (row && !row.linkedinUrl) {
    row.linkedinUrl = url;
    row.needsResolve = false;
    resolveDiag.none = Math.max(0, resolveDiag.none - 1);
    resolveDiag.late += 1;
    debug(`[LinkedIn Resolver] Candidate: ${row.name || data.rowId} | late capture via ${data.method} | Final URL: ${url}`);
  }
});

function setResolverSession(active) {
  document.dispatchEvent(new CustomEvent('jbexport:session', { detail: JSON.stringify({ active }) }));
}

async function collectAllCandidates(onProgress, shouldAbort, onlySelected) {
  const scroller = document.querySelector(SCROLLER_SELECTOR);
  if (!scroller) {
    throw new Error('SCROLLER_NOT_FOUND');
  }

  const runStartedAt = Date.now();
  Object.assign(resolveDiag, {
    attempted: 0, viaWindowOpen: 0, viaHrefChange: 0, viaApi: 0, late: 0, none: 0, cached: 0,
    skippedNotMounted: 0, retried: 0, retryRecovered: 0, failByMethod: {}, sample: null,
  });
  apiMode = false;

  const byKey = new Map();
  liveRowsById = new Map();
  debugLog.length = 0;
  selectionShapeLogged = false;
  debugLog.push(`[LinkedIn Resolver] Run started ${new Date().toISOString()} | onlySelected=${!!onlySelected} | ${location.href}`);

  // The element for a row *right now*. A snapshot taken by collectVisibleRows()
  // goes stale within a pass: each click takes up to a few seconds and
  // Juicebox re-renders the grid in between (rows get new DOM nodes), so the
  // node captured at snapshot time is often detached by the time its turn
  // comes. That was the real cause of whole runs of consecutive empty rows.
  const liveRowEl = (row) => {
    if (row.id) {
      const el = document.querySelector(ROW_SELECTOR + '[data-id="' + CSS.escape(String(row.id)) + '"]');
      if (el) return el;
    }
    return row.rowEl && row.rowEl.isConnected ? row.rowEl : null;
  };

  // Only misses that were never really asked get a second attempt. A
  // 'search-url' answer (Juicebox has no profile) and a full timeout are
  // final; clicking again just costs the same wait a second time.
  const retriable = (method) => method === 'row-not-mounted' || method === 'error' || method === 'no-row-id';

  // Resolves run one at a time on purpose: main-world.js can only attribute
  // one in-flight click at a time. Already-resolved rows (cache), rows whose
  // DOM href is already a real profile, and (in "Export Selected" mode)
  // unselected rows cost no click at all. A row that missed (not mounted,
  // Juicebox timed out) is kept as needsResolve and gets another attempt
  // whenever it is seen mounted again, up to MAX_RESOLVE_ATTEMPTS.
  // One resolve job: re-find the row at run time, ask, record the outcome.
  const runJob = async (job) => {
    if (shouldAbort()) return;
    const el = liveRowEl(job) || null;
    if (!el) {
      if (!job.retry) { resolveDiag.skippedNotMounted += 1; job.target.needsResolve = true; }
      return;
    }
    job.target.attempts += 1;
    if (job.retry) resolveDiag.retried += 1;
    const r = await resolveLinkedInUrlDetailed(el);
    if (r.url) {
      job.target.linkedinUrl = r.url;
      job.target.needsResolve = false;
      if (job.retry) resolveDiag.retryRecovered += 1;
    } else if (!job.target.linkedinUrl) {
      job.target.needsResolve = retriable(r.method);
    }
  };

  // Click resolves must be one at a time (main-world.js attributes a single
  // in-flight click). Endpoint resolves are tied to their own request, so
  // once apiMode is on they run a few at a time.
  const runJobs = async (jobs) => {
    let i = 0;
    while (i < jobs.length) {
      if (shouldAbort()) return;
      const width = apiMode ? API_CONCURRENCY : 1;
      await Promise.all(jobs.slice(i, i + width).map(runJob));
      i += width;
    }
  };

  const addRows = async (rows, opts) => {
    const retryOnly = !!(opts && opts.retryOnly);
    const jobs = [];
    for (const row of rows) {
      if (!row.hasAnyField) continue; // skeleton row mid-render, retry next pass

      const existing = byKey.get(row.key);
      if (existing) {
        // A row first seen unselected can show up selected later (the grid
        // re-renders the checkbox after its state settles). Pick it up and
        // resolve it now instead of leaving it out of the selected export.
        if (onlySelected && row.selected && !existing.selected) {
          existing.selected = true;
          if (!existing.linkedinUrl) { existing.needsResolve = true; existing.attempts = 0; }
        }
        if (existing.needsResolve && existing.attempts < MAX_RESOLVE_ATTEMPTS && liveRowEl(row)) {
          jobs.push({ target: existing, id: row.id, rowEl: row.rowEl, retry: true });
        }
        continue;
      }
      if (retryOnly) continue;

      const wantsResolve = !onlySelected || row.selected;
      row.attempts = 0;
      row.needsResolve = false;
      if (wantsResolve && !row.linkedinUrl) {
        jobs.push({ target: row, id: row.id, rowEl: row.rowEl, retry: false });
      }
      // Never let a DOM node or the search URL leak into the collected data.
      delete row.rowEl;
      delete row.domLinkedinUrl;
      byKey.set(row.key, row);
      if (row.id) liveRowsById.set(String(row.id), row);
    }
    await runJobs(jobs);
  };

  const pendingRetries = () =>
    Array.from(byKey.values()).filter((r) => r.needsResolve && r.attempts < MAX_RESOLVE_ATTEMPTS).length;

  setResolverSession(true);
  try {
    const rows = await scrollAndCollect(scroller, byKey, addRows, onProgress, shouldAbort);
    // Second pass over the list for rows that missed the first time. Only
    // those rows are clicked; everything else is skipped on sight.
    if (pendingRetries() > 0 && !shouldAbort()) {
      debug('[LinkedIn Resolver] Retry pass for ' + pendingRetries() + ' unresolved row(s)');
      await scrollAndCollect(
        scroller, byKey,
        (visible) => addRows(visible, { retryOnly: true }),
        onProgress, shouldAbort,
        { stopWhen: () => pendingRetries() === 0 }
      );
    }
    debug('[LinkedIn Resolver] Run summary: ' + JSON.stringify(resolveDiag) +
      ' | elapsed ' + Math.round((Date.now() - runStartedAt) / 1000) + 's');
    return rows;
  } finally {
    // Leave a short window for Juicebox's last late answer, then hand the
    // page back (window.open behaves normally again for the user).
    await sleep(600);
    setResolverSession(false);
    liveRowsById = null;
  }
}

async function scrollAndCollect(scroller, byKey, addRows, onProgress, shouldAbort, options) {
  const originalScrollTop = scroller.scrollTop;
  // A retry pass adds no new rows, so it must not stop on "nothing new";
  // it runs to the bottom or until stopWhen() says nothing is left to retry.
  const stopWhen = options && typeof options.stopWhen === 'function' ? options.stopWhen : null;
  const retryPass = !!stopWhen;

  scroller.scrollTop = 0;
  await sleep(150);
  await addRows(collectVisibleRows());
  onProgress(byKey.size, false);

  const stepSize = Math.max(scroller.clientHeight * 0.8, 300);
  let stagnantSteps = 0;
  const MAX_STAGNANT_STEPS = 6;
  const MAX_STEPS = 4000;
  // Generous: each uncached row can spend up to ~2.5s waiting on Juicebox's
  // click handler, so a full 500-row export can legitimately take a while.
  const MAX_DURATION_MS = 30 * 60 * 1000;
  const startedAt = Date.now();
  let steps = 0;

  while (steps < MAX_STEPS && Date.now() - startedAt < MAX_DURATION_MS) {
    if (shouldAbort()) {
      scroller.scrollTop = originalScrollTop;
      throw new Error('ABORTED');
    }

    const before = byKey.size;
    const prevScrollTop = scroller.scrollTop;
    scroller.scrollTop = prevScrollTop + stepSize;
    await sleep(220);

    // A second read after a short extra wait gives late-mounting cells
    // (skeleton rows) a chance to fill in before we move past them.
    await addRows(collectVisibleRows());
    await sleep(120);
    await addRows(collectVisibleRows());

    const after = byKey.size;
    onProgress(after, false);

    const scrollerStuck = Math.abs(scroller.scrollTop - prevScrollTop) < 1;
    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;

    stagnantSteps = after === before && !retryPass ? stagnantSteps + 1 : 0;

    if ((scrollerStuck && atBottom) || stagnantSteps >= MAX_STAGNANT_STEPS || (stopWhen && stopWhen())) {
      break;
    }

    steps += 1;
  }

  scroller.scrollTop = originalScrollTop;

  onProgress(byKey.size, true);
  return Array.from(byKey.values());
}

let activeExtraction = null;
// Cached so a popup reopened after being closed mid-run (or right after
// completion) can still retrieve the finished result instead of losing it.
let lastResult = null;

function buildExportPayload(rows, onlySelected, expectedTotal) {
  const filtered = onlySelected ? rows.filter((r) => r.selected) : rows;
  const candidates = filtered.map((r) => ({
    name: r.name,
    linkedinUrl: r.linkedinUrl,
    jobTitle: r.jobTitle,
    location: r.location,
    matchPercent: r.matchPercent,
    company: r.company,
  }));

  return {
    ok: true,
    candidates,
    totalFound: rows.length,
    selectedCount: rows.filter((r) => r.selected).length,
    onlySelected: !!onlySelected,
    expectedTotal,
    incomplete: expectedTotal != null && rows.length < expectedTotal,
    resolveDiag: { ...resolveDiag },
    debugLog: debugLog.slice(),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({
      isJuicebox: isJuiceboxResultsPage(),
      expectedTotal: getExpectedTotal(),
      extractionInProgress: !!activeExtraction,
      hasCachedResult: !!lastResult,
    });
    return true;
  }

  if (message.type === 'GET_LAST_RESULT') {
    if (!lastResult) {
      sendResponse({ ok: false, error: 'NO_CACHED_RESULT' });
    } else {
      // A popup re-attaching after a reopen doesn't know which button started
      // the run; fall back to what the run was started with.
      const onlySelected = message.onlySelected == null ? !!lastResult.onlySelected : !!message.onlySelected;
      sendResponse(buildExportPayload(lastResult.rows, onlySelected, lastResult.expectedTotal));
    }
    return true;
  }

  if (message.type === 'START_EXTRACTION') {
    if (activeExtraction) {
      sendResponse({ ok: false, error: 'ALREADY_RUNNING' });
      return true;
    }

    let aborted = false;
    activeExtraction = { abort: () => { aborted = true; } };

    (async () => {
      try {
        if (!isJuiceboxResultsPage()) {
          throw new Error('NOT_JUICEBOX_PAGE');
        }

        const expectedTotal = getExpectedTotal();
        const onlySelected = !!message.onlySelected;

        const rows = await collectAllCandidates(
          (count, done) => {
            chrome.runtime.sendMessage({
              type: 'EXTRACTION_PROGRESS',
              count,
              expectedTotal,
              done,
            }).catch(() => {});
          },
          () => aborted,
          onlySelected
        );

        lastResult = { rows, expectedTotal, onlySelected };
        sendResponse(buildExportPayload(rows, onlySelected, expectedTotal));
      } catch (err) {
        sendResponse({ ok: false, error: err.message || 'UNKNOWN_ERROR' });
      } finally {
        activeExtraction = null;
      }
    })();

    return true; // keep the message channel open for async sendResponse
  }

  if (message.type === 'ABORT_EXTRACTION') {
    if (activeExtraction) {
      activeExtraction.abort();
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
