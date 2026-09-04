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
- **LinkedIn profile URL.** The LinkedIn icon's `href` in the DOM is a
  LinkedIn *people-search* URL (`/search/results/people/?keywords=name+company`),
  not the candidate's profile. The real `/in/<slug>/` URL only exists after
  Juicebox's own click handler runs. So `extractActualLinkedInUrl(rowEl)` in
  `content.js`:
  1. uses the DOM href directly if it is already a canonical `/in/` URL;
  2. otherwise returns a cached result for that Juicebox row id, if any
     (`Map<rowId, url>`, kept for the life of the page, so a re-export or a
     row seen on a second scroll pass never triggers a second click);
  3. otherwise asks `main-world.js` to click the icon once and report what
     Juicebox produced, then validates the result: only
     `https://www.linkedin.com/in/<slug>/` is accepted (query/fragment
     stripped, `xx.linkedin.com` normalised to `www`). A people-search URL is
     never accepted and a slug is never guessed from the name.
  4. If nothing canonical came back, the field is left **empty**.
- `main-world.js` is declared with `"world": "MAIN"` in the manifest and does
  the click. It has to live in the page's JS world because Juicebox's handler
  runs there: content scripts get an isolated world with a separate `window`,
  so patching `window.open` from `content.js` captures nothing (the same code
  works when pasted into the DevTools console, which runs in the page's
  world). During one click it watches for `window.open(url)`, an in-place
  rewrite of the anchor's `href`, and a native anchor navigation (blocked
  with a capture-phase `preventDefault` that does not stop propagation, so
  Juicebox's React handler still runs), polls every 50ms until one fires (max
  2.5s), and reports which mechanism it saw. `content.js` drives it over DOM
  `CustomEvent`s (shared across worlds; JSON-string payloads).
- Juicebox's handler is asynchronous and sometimes answers more than a
  second after the click. The hooks therefore stay installed for the whole
  export session (not per click), no tab can open during a session, and a
  URL that arrives after a row's wait expired is still attributed to that
  row as long as no newer row has been clicked (`jbexport:late`). Without
  this, late answers opened real tabs and landed on the *next* candidate
  (an off-by-one seen in a real 499-row export). Outside a session the
  page's `window.open` behaves normally for the user's own clicks.
- Each click looks the row up again by its `data-id` at the moment of the
  click, never from the snapshot taken when the pass started. Juicebox
  re-renders the grid between clicks (rows get fresh DOM nodes), so a
  snapshot node is often detached a few rows in; using it silently skipped
  the rest of every batch (the "4 resolved, 11 empty, repeat" pattern seen
  in real exports). Rows that still miss (not mounted, Juicebox timed out)
  are kept as pending and get one more attempt: whenever they are seen
  mounted again during the scroll, and then in a dedicated retry pass over
  the list at the end that only clicks pending rows.
- When a late answer lands while the next row is already waiting, the slug
  is compared against both candidates' names (accent-folded tokens of 3+
  letters). If it matches only the earlier candidate it goes to that row;
  otherwise it goes to the current one. This is validation of a captured
  URL, not slug guessing: no URL is ever built from a name.
- Resolves run one row at a time while the row is mounted. Cached rows, rows
  whose DOM href is already a profile, and (in **Export Selected** mode)
  unselected rows cost no click. Expect anywhere from 0.1s to 2.5s per
  uncached row on top of the normal scroll time, depending on how fast
  Juicebox answers.
- **Export Selected** uses the grid's own selection state
  (`aria-selected="true"` / `Mui-selected` on the row, or a checked row
  checkbox), scans the whole list so selected rows anywhere are included,
  and reports `N selected candidates (of M scanned)`.
- The popup summarises the run (`N/M resolved, K from cache, R recovered on
  retry, J left empty (x timeout, y row-not-mounted), via window.open`), and
  the page console logs a `Run summary` JSON line plus one
  `[LinkedIn Resolver] Candidate: ... | DOM URL: ... | Captured URL: ... |
  Final URL: ...` line per click plus a one-time mechanism check.
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
- GitHub icons have no discoverable href in the DOM (click-handler driven) —
  not exported, per spec.
- If Juicebox has no LinkedIn match for a candidate, or its click handler
  produces something other than a `/in/` profile URL, the LinkedIn column is
  left empty for that row. The old people-search URL is deliberately not
  exported in its place.
- If Juicebox ever switches to navigating via `window.location` instead of
  `window.open`/anchor, the resolver cannot intercept that and will report
  `none` for every row (the page itself is never navigated away by the
  extension). The one-time `[LinkedIn Resolver] Mechanism check` console line
  shows what was observed.

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
