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

function extractRow(rowEl) {
  const id = rowEl.getAttribute('data-id') || null;

  const nameEl = rowEl.querySelector('[data-field="full_name"] p');
  const name = cleanText(nameEl?.textContent);

  const linkedinEl = rowEl.querySelector('[data-field="profiles"] a[aria-label="LinkedIn"]');
  const linkedinUrl = linkedinEl?.getAttribute('href') || '';

  const titleEl = rowEl.querySelector('[data-field="job_title_info"] p');
  const jobTitle = cleanText(titleEl?.textContent);

  const locationEl = rowEl.querySelector('[data-field="location_info"]');
  const location = cleanText(locationEl?.textContent);

  const matchEl = rowEl.querySelector('[data-field="matchRate"] p');
  const matchPercent = cleanText(matchEl?.textContent);

  const checkboxEl = rowEl.querySelector('[data-field="full_name"] input[type="checkbox"]');
  const selected = !!checkboxEl?.checked;

  const company = extractCompanyFromFiber(rowEl);

  return {
    id,
    key: id || `${name}|${jobTitle}|${location}`,
    name,
    linkedinUrl,
    jobTitle,
    location,
    matchPercent,
    company,
    selected,
    // A row that only just mounted can render before MUI fills its cells in.
    // Treat it as "not yet ready" rather than a permanent miss so the scroll
    // loop gets another chance to pick it up on a later pass.
    hasAnyField: !!(name || linkedinUrl || jobTitle || location || matchPercent),
  };
}

function collectVisibleRows() {
  return Array.from(document.querySelectorAll(ROW_SELECTOR)).map(extractRow);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scrolls the virtualized grid in steps, collecting rows as they render.
// Stops when the scroller can no longer move (end of list) or when no new
// unique, fully-rendered candidates appear for several consecutive steps.
async function collectAllCandidates(onProgress, shouldAbort) {
  const scroller = document.querySelector(SCROLLER_SELECTOR);
  if (!scroller) {
    throw new Error('SCROLLER_NOT_FOUND');
  }

  const byKey = new Map();
  const addRows = (rows) => {
    for (const row of rows) {
      if (!row.hasAnyField) continue; // skeleton row mid-render, retry next pass
      if (!byKey.has(row.key)) {
        byKey.set(row.key, row);
      }
    }
  };

  const originalScrollTop = scroller.scrollTop;

  scroller.scrollTop = 0;
  await sleep(150);
  addRows(collectVisibleRows());
  onProgress(byKey.size, false);

  const stepSize = Math.max(scroller.clientHeight * 0.8, 300);
  let stagnantSteps = 0;
  const MAX_STAGNANT_STEPS = 6;
  const MAX_STEPS = 4000;
  const MAX_DURATION_MS = 10 * 60 * 1000;
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
    addRows(collectVisibleRows());
    await sleep(120);
    addRows(collectVisibleRows());

    const after = byKey.size;
    onProgress(after, false);

    const scrollerStuck = Math.abs(scroller.scrollTop - prevScrollTop) < 1;
    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;

    stagnantSteps = after === before ? stagnantSteps + 1 : 0;

    if ((scrollerStuck && atBottom) || stagnantSteps >= MAX_STAGNANT_STEPS) {
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
    expectedTotal,
    incomplete: expectedTotal != null && rows.length < expectedTotal,
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
      sendResponse(buildExportPayload(lastResult.rows, message.onlySelected, lastResult.expectedTotal));
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
          () => aborted
        );

        lastResult = { rows, expectedTotal };
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
