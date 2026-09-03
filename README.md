# JB Export

Chrome extension (Manifest V3) that exports Name, LinkedIn URL, Job Title,
Company, Location, and Match % from a Juicebox.ai search results page to a
CSV file. Everything runs locally in the browser — no external servers, no
candidate profile pages are opened.

## Install

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder: `D:\Projects\juicebox-exporter`

## Use

1. Open a Juicebox search results page (`app.juicebox.ai/project/.../search`)
2. Click the extension icon
3. Click **Export CSV** (or **Export Selected** if you've checked specific rows)
4. Wait while it scrolls through the results — progress updates show the
   running count
5. The CSV downloads automatically as `juicebox-candidates-YYYY-MM-DD.csv`

## How it works

- The results table is a Material-UI X DataGrid. Rows are read via stable
  `data-field` attributes (`full_name`, `profiles`, `job_title_info`,
  `location_info`, `matchRate`), not auto-generated CSS class hashes.
- The grid virtualizes rows — only ~17-28 are in the DOM at once. The content
  script scrolls `.MuiDataGrid-virtualScroller` in steps, collecting and
  deduplicating rows (by `data-id`) after each step, until scrolling reaches
  the bottom or several steps in a row produce no new candidates.
- The LinkedIn URL is read directly from the `href` on the LinkedIn icon's
  anchor tag. Juicebox's own link is a LinkedIn people-search URL (keyed on
  name + company), not a direct `/in/...` profile URL — that's what's in the
  DOM, so that's what gets exported.
- Company has no grid cell at all — Juicebox doesn't render it as a column.
  It only exists on each row's underlying React data (`job_company_name`),
  so it's read by walking the DOM node's React fiber (`__reactFiber$...`)
  up to a parent whose `memoizedProps` carries the row's profile data. This
  is coupled to Juicebox's current React internals and returns an empty
  string (rather than throwing) if their component structure changes.
- If Juicebox stops loading before reaching the "Matches (N)" total shown at
  the top, the popup reports exactly how many candidates were actually
  collected rather than silently producing a short CSV.

## Limitations discovered during the DOM audit

- Juicebox's grid only ever renders up to ~500 "evaluated" candidates even
  when the header shows a larger "Matches" total (e.g. 864) — the extra
  candidates are not reachable by scrolling at all, since Juicebox hasn't
  loaded them into the page. This is a Juicebox-side cap, not something the
  extension can bypass by scrolling harder.
- LinkedIn links are search-result URLs, not canonical profile URLs.
- GitHub icons have no discoverable href in the DOM (click-handler driven) —
  not exported, per spec.

## Getting past the 500-candidate cap

Since the ~500 cap is per-search, narrow the Juicebox search filters (e.g.
split one broad search into several by city or another filter) so each
individual search returns under 500, then export each one and merge them:

1. Run a filtered search, export its CSV as usual.
2. Change the filter (e.g. next city) and export again.
3. On this second (and later) export, check **"Merge with a previous
   export"** in the popup and pick the earlier CSV file.
4. The extension combines both sets and removes duplicates before
   downloading — by LinkedIn URL when it's a real `/in/...` profile link, or
   by name + company when it's a Juicebox search link (since those aren't a
   stable per-person identifier). Repeat per filter segment to build up one
   combined file.
