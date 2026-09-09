const statusEl = document.getElementById('status');
const progressTrack = document.getElementById('progressTrack');
const progressFill = document.getElementById('progressFill');
const exportAllBtn = document.getElementById('exportAllBtn');
const exportSelectedBtn = document.getElementById('exportSelectedBtn');
const cancelBtn = document.getElementById('cancelBtn');
const mergeToggle = document.getElementById('mergeToggle');
const mergeFileRow = document.getElementById('mergeFileRow');
const mergeFileInput = document.getElementById('mergeFileInput');

let currentTabId = null;
let extracting = false;
let hasCachedResult = false;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status-line' + (kind ? ` ${kind}` : '');
}

function setProgressActive(active) {
  progressTrack.classList.toggle('active', active);
}

function setButtonsEnabled(enabled) {
  exportAllBtn.disabled = !enabled;
  exportSelectedBtn.disabled = !enabled;
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Splits a display name into first and last name: first word is the first
// name, everything after it is the last name (so "Hans-Werner Bracher" ->
// "Hans-Werner" / "Bracher" and "Maria de la Cruz" -> "Maria" / "de la Cruz").
// A single-word name goes into First Name with an empty Last Name. Common
// trailing credentials (", MBA", "(she/her)") are stripped first.
function splitName(name) {
  const cleaned = String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .split(',')[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(' ');
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function buildCsv(candidates) {
  const header = ['Name', 'First Name', 'Last Name', 'LinkedIn Profile URL', 'Job Title', 'Company', 'Location', 'Match %'];
  const lines = [header.map(csvEscape).join(',')];
  for (const c of candidates) {
    const split = splitName(c.name);
    lines.push([
      csvEscape(c.name),
      csvEscape(c.firstName || split.firstName),
      csvEscape(c.lastName || split.lastName),
      csvEscape(c.linkedinUrl),
      csvEscape(c.jobTitle),
      csvEscape(c.company),
      csvEscape(c.location),
      csvEscape(c.matchPercent),
    ].join(','));
  }
  return lines.join('\r\n');
}

// Minimal RFC 4180 CSV parser: handles quoted fields, embedded commas,
// escaped quotes ("") and both \n and \r\n line endings. Good enough for
// re-reading a file this same extension wrote.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

function candidatesFromCsvText(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (label) => header.indexOf(label);
  const iName = idx('name');
  const iFirst = idx('first name');
  const iLast = idx('last name');
  const iLinkedin = idx('linkedin profile url');
  const iTitle = idx('job title');
  const iCompany = idx('company');
  const iLocation = idx('location');
  const iMatch = idx('match %');

  return rows.slice(1).map((r) => ({
    name: iName >= 0 ? (r[iName] || '') : '',
    firstName: iFirst >= 0 ? (r[iFirst] || '') : '',
    lastName: iLast >= 0 ? (r[iLast] || '') : '',
    linkedinUrl: iLinkedin >= 0 ? (r[iLinkedin] || '') : '',
    jobTitle: iTitle >= 0 ? (r[iTitle] || '') : '',
    company: iCompany >= 0 ? (r[iCompany] || '') : '',
    location: iLocation >= 0 ? (r[iLocation] || '') : '',
    matchPercent: iMatch >= 0 ? (r[iMatch] || '') : '',
  }));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FILE_READ_ERROR'));
    reader.readAsText(file);
  });
}

// A Juicebox LinkedIn link is a people-search URL (no stable per-person
// identity), so dedup falls back to name+company for those; a real /in/
// profile URL is used directly since it uniquely identifies the person.
function dedupKey(c) {
  const url = (c.linkedinUrl || '').trim().toLowerCase();
  if (url && !url.includes('/search/results/')) return `url:${url}`;
  return `nc:${(c.name || '').trim().toLowerCase()}|${(c.company || '').trim().toLowerCase()}`;
}

// New scroll results take priority over the previously exported file on a
// dedup collision, since a re-run is assumed to be fresher/more complete.
function mergeCandidates(previous, fresh) {
  const byKey = new Map();
  for (const c of previous) byKey.set(dedupKey(c), c);
  for (const c of fresh) byKey.set(dedupKey(c), c);
  return Array.from(byKey.values());
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function downloadCsv(csvText) {
  const blob = new Blob(['﻿' + csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const filename = `juicebox-candidates-${todayStamp()}.csv`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Companion file for a run that left LinkedIn cells empty: the resolver's
// per-row lines plus the mechanism check, so the cause can be read from the
// file instead of the page console.
function downloadDebugLog(lines) {
  if (!lines || !lines.length) return;
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `juicebox-debug-${todayStamp()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function messageForError(error) {
  switch (error) {
    case 'NOT_JUICEBOX_PAGE':
      return 'Open a Juicebox search results page to export candidates.';
    case 'SCROLLER_NOT_FOUND':
      return 'Could not find the candidate results table on this page. Try reloading Juicebox.';
    case 'ALREADY_RUNNING':
      return 'An export is already in progress.';
    case 'ABORTED':
      return 'Export cancelled.';
    case 'NO_CACHED_RESULT':
      return 'No finished export found. Click Export CSV to start a new one.';
    default:
      return 'Lost connection to the page. Reload Juicebox and try again.';
  }
}

async function checkPage() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('https://app.juicebox.ai/')) {
      setStatus('Open a Juicebox search results page to export candidates.', 'error');
      setButtonsEnabled(false);
      return;
    }
    currentTabId = tab.id;

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);
    if (!response || !response.isJuicebox) {
      setStatus('Open a Juicebox search results page to export candidates.', 'error');
      setButtonsEnabled(false);
      return;
    }

    if (response.extractionInProgress) {
      // Popup was closed mid-export and reopened; the content script is
      // still scrolling in the page. Re-attach and wait for it to finish —
      // START_EXTRACTION will report ALREADY_RUNNING, so poll for the
      // cached result instead once progress reports "done".
      setStatus('Export already in progress on this page…');
      setButtonsEnabled(false);
      setProgressActive(true);
      cancelBtn.style.display = 'block';
      extracting = true;
      chrome.runtime.onMessage.addListener(function waitForDone(msg) {
        if (msg.type !== 'EXTRACTION_PROGRESS') return;
        handleProgress(msg);
        if (msg.done) {
          chrome.runtime.onMessage.removeListener(waitForDone);
          extracting = false;
          // undefined = "whatever mode the run was started in" (content.js
          // remembers whether it was Export CSV or Export Selected).
          runExtraction(undefined, true);
        }
      });
      return;
    }

    if (response.hasCachedResult) {
      hasCachedResult = true;
      setStatus('A finished export is available. Click Export CSV to download it.', 'success');
      setButtonsEnabled(true);
      return;
    }

    const total = response.expectedTotal;
    setStatus(total ? `Ready. ${total} candidates listed on this search.` : 'Ready to export.');
    setButtonsEnabled(true);
  } catch (err) {
    setStatus('Open a Juicebox search results page to export candidates.', 'error');
    setButtonsEnabled(false);
  }
}

function handleProgress(msg) {
  if (msg.type !== 'EXTRACTION_PROGRESS') return;
  progressFill.classList.remove('indeterminate');
  if (msg.expectedTotal) {
    const pct = Math.min(100, Math.round((msg.count / msg.expectedTotal) * 100));
    progressFill.style.width = `${pct}%`;
    setStatus(msg.done
      ? `Collected ${msg.count} of ~${msg.expectedTotal} candidates.`
      : `Loading more candidates… ${msg.count} found so far.`);
  } else {
    progressFill.classList.add('indeterminate');
    setStatus(`Loading more candidates… ${msg.count} found so far.`);
  }
}

async function runExtraction(onlySelected, useCachedIfAvailable) {
  if (extracting || !currentTabId) return;
  extracting = true;
  setButtonsEnabled(false);
  cancelBtn.style.display = 'block';
  setProgressActive(true);
  setStatus('Detecting candidates…');

  chrome.runtime.onMessage.addListener(handleProgress);

  try {
    const messageType = useCachedIfAvailable ? 'GET_LAST_RESULT' : 'START_EXTRACTION';
    const response = await chrome.tabs.sendMessage(currentTabId, {
      type: messageType,
      onlySelected,
    });

    if (!response || !response.ok) {
      setStatus(messageForError(response && response.error), 'error');
      return;
    }

    const selectedMode = !!response.onlySelected;
    if (response.candidates.length === 0) {
      setStatus(selectedMode
        ? `No selected candidates found (scanned ${response.totalFound}). Tick the row checkboxes and try again.`
        : 'No candidates found on this page.', 'error');
      return;
    }

    hasCachedResult = true;

    let finalCandidates = response.candidates;
    let mergedCount = 0;
    if (mergeToggle.checked && mergeFileInput.files[0]) {
      setStatus('Merging with previous export…');
      try {
        const prevText = await readFileAsText(mergeFileInput.files[0]);
        const prevCandidates = candidatesFromCsvText(prevText);
        finalCandidates = mergeCandidates(prevCandidates, response.candidates);
        mergedCount = prevCandidates.length;
      } catch (e) {
        setStatus('Could not read the previous CSV — exporting this search only.', 'error');
      }
    }

    setStatus('Exporting CSV…');
    downloadCsv(buildCsv(finalCandidates));

    // Surface what the click-resolve step actually did, so a CSV full of
    // search links can be diagnosed from the popup instead of guessed at.
    const d = response.resolveDiag;
    if (d && (d.attempted > 0 || d.cached > 0)) {
      const s = d.sample || {};
      console.log('[LinkedIn Resolver] Run summary:', d);
      const resolved = d.viaWindowOpen + d.viaHrefChange + (d.viaApi || 0) + (d.late || 0);
      const fails = d.failByMethod
        ? Object.entries(d.failByMethod).map(([k, v]) => `${v} ${k}`).join(', ')
        : '';
      const diagLine =
        `LinkedIn profiles: ${resolved}/${d.attempted} resolved` +
        (d.late ? ` (${d.late} arrived late)` : '') +
        (d.cached ? ` + ${d.cached} from cache` : '') +
        (d.retryRecovered ? `, ${d.retryRecovered} recovered on retry` : '') +
        (d.none ? `, ${d.none} left empty${fails ? ` (${fails})` : ''}` : '') +
        (d.skippedNotMounted ? `, ${d.skippedNotMounted} not mounted at first sight` : '') +
        (s.method ? ` (via ${s.method})` : '') + '.';
      setTimeout(() => setStatus(`${statusEl.textContent} ${diagLine}`, d.none === 0 ? 'success' : 'error'), 0);
      if (d.none > 0) setTimeout(() => downloadDebugLog(response.debugLog), 400);
    }

    if (mergedCount > 0) {
      setStatus(
        `Export completed: ${response.candidates.length} from this search + ${mergedCount} from the previous ` +
        `file, merged to ${finalCandidates.length} unique candidates.`,
        'success'
      );
    } else if (selectedMode) {
      setStatus(
        `Export completed: ${response.candidates.length} selected candidates (of ${response.totalFound} scanned).`,
        'success'
      );
    } else if (response.incomplete) {
      setStatus(
        `Export completed with ${response.candidates.length} candidates. ` +
        `Juicebox stopped loading additional results (expected ~${response.expectedTotal}).`,
        'success'
      );
    } else {
      setStatus(`Export completed: ${response.candidates.length} candidates found.`, 'success');
    }
  } catch (err) {
    setStatus('Lost connection to the page. Reload Juicebox and try again.', 'error');
  } finally {
    extracting = false;
    setButtonsEnabled(true);
    cancelBtn.style.display = 'none';
    setProgressActive(false);
    progressFill.style.width = '0%';
    chrome.runtime.onMessage.removeListener(handleProgress);
  }
}

// The cache is only reused right after a popup reopen mid-run (see
// checkPage's "extractionInProgress" branch) — a manual button click
// always re-scrolls, so selection/data changes since the last run are
// never silently served stale.
exportAllBtn.addEventListener('click', () => runExtraction(false, false));
exportSelectedBtn.addEventListener('click', () => runExtraction(true, false));
cancelBtn.addEventListener('click', async () => {
  if (currentTabId) {
    await chrome.tabs.sendMessage(currentTabId, { type: 'ABORT_EXTRACTION' }).catch(() => {});
  }
});

mergeToggle.addEventListener('change', () => {
  mergeFileRow.classList.toggle('active', mergeToggle.checked);
  if (!mergeToggle.checked) mergeFileInput.value = '';
});

checkPage();
