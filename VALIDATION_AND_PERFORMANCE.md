# Validation, performance and limitations

Everything below was **actually run**: on Linux, in a real headless Chromium browser
(from the npm package `@sparticuz/chromium`), against the site served by
`python -m http.server`. The data were built from your **run_2** project folder
(desktop version 3).

**Not done:**
- **Windows or a public deployment:** the site was not tested on Windows or on a live
  GitHub Pages address. Do that in the next 10 minutes using README steps 1–3.
- **OpenStreetMap tiles:** they never loaded, because the test machine has no internet.

## 1. Scientific accuracy

### Data are stored losslessly
`build/build_web_data.py` uses the desktop v3 code (`build/tulare_explorer/`,
unchanged) and stores raster values as the original float32 numbers. A separate Node
check decoded the web files and compared them with the desktop arrays:

- 200 random cells, confined and unconfined 2015: **0 mismatches** (bit-exact)
- head change 1980 → 2010 at the same cells: **0 mismatches**
- full 53-year series of a cell from the block files: **0 mismatches**
- number of no-data cells in 2000: identical (87,854 confined; 91,923 unconfined)

### The website compared with the desktop code
`validation/make_reference.py` computes reference values with the desktop code;
`validation/browser_validation.js` drives the real website and compares.
**Result: 53 passed, 0 failed.** Full output: `validation/RESULTS_browser_validation.txt`.

| What was compared | Result |
|---|---|
| Clicked point → Albers coordinates (proj4js against pyproj) | within 2×10⁻⁷ m (cell centres) and 5×10⁻⁴ m (well) |
| Confined and unconfined 53-year hydrographs at 5 points (two subbasin cells, an unconfined-only cell, a well, a point outside the rasters) | **identical**, every year |
| Subbasin of each point | identical (Tulare Lake, Kern County, White Wolf, none, none) |
| Nearby wells within 3 km (ids and order) | identical |
| Provided 1971–2023 values at each point | identical |
| Map statistics (cell count, mean, median, min, max, number of declining cells) for absolute head confined 2015 and unconfined 1990, cumulative unconfined 1980→2010 and confined 1971→2023, and the provided confined change, in **feet and metres** (10 cases) | all match. For example, confined 1971→2015: mean −81.7 ft, median −84.3, min −142.9, max 29.0, 12,954 km², 97% declining, the same as the desktop v3 screenshot |
| Basin Summary statistics: 9 scopes × 2 aquifers × head and change × 4 statistics × 53 years | **7,632 / 7,632 identical** |
| Storage values and totals 2015–2023 | identical; 2023 combined total −11.57 km³ |
| A real mouse click on the map | selects the location under the cursor |
| Fixed-period product hides the year controls | yes |
| Eight Basin Summary panels | yes |
| JavaScript errors during the whole session | none |

### Downloads (files saved by the browser and reopened in Python)

| Download | Check | Result |
|---|---|---|
| Map values, unconfined change 1980→2010 in metres (`.asc` + `.prj`) | Read with rasterio/GDAL and compared with the desktop `change × 0.3048` | identical in **all 74,241 cells**, same no-data mask, same transform, Albers projection recognised |
| Point series (CSV) with a selected well | Compared with desktop series and observations | differences ≤ 5×10⁻⁵ m (the CSV is rounded to 4 decimals, as on the desktop) |
| Basin statistics, Kaweah, metres (CSV) | Compared with desktop `year_stats` | ≤ 5×10⁻⁵ m (4-decimal rounding); cell counts identical |
| Storage table (CSV) | Compared with desktop `summary_table()` | same columns; ≤ 5×10⁻⁷ km³ (6-decimal rounding) |

### Scientific communication
- **Head vs change:** absolute head and head change have separate titles and colour
  bars. Change maps say "negative = decline" and use a diverging colour scale centred
  on 0.
- **Interpolated vs observed:** the hydrograph legend separates *interpolated raster*
  lines from *observed* well dots.
- **Periods and units:** baseline years and periods appear in every title. Units (ft
  or m) appear on every axis, colour bar, table and download.
- **Storage vs subsidence:** storage is labelled as signed change in km³ since 2015.
  A note states that matrix compaction is a water-volume loss linked to subsidence,
  not ground-surface lowering.

## 2. Performance (measured)

Measured in the headless browser on this test machine, with a local server. Expect
similar or faster on a normal laptop, and add network time on the internet (see
download sizes).

| Action | Measured |
|---|---|
| First map on screen | **1.2 s** |
| Wells and observations ready | **1.7 s** |
| Year switch, year already loaded (measured inside the page) | **≈140 ms**, after the first few switches |
| Year switch including download of that year | ≈0.3–0.4 s* |
| Switch to the unconfined aquifer, first time | ≈0.45 s* |
| Map click → hydrograph + point details | **0.18–0.25 s** (≈0.5 s for a well with its profile) |
| Basin Summary first view / change of subbasin | 0.76 s / **0.15 s** |
| Storage tab first view | 0.32 s |
| JavaScript memory after the whole test session | **47 MB** |

\* These test timings include a deliberate 120 ms pause after each action.

### What a visitor downloads

| | Size |
|---|---|
| App code (HTML, CSS, JS, Leaflet, proj4, Plotly; compressed in transit) | 457 KB (Plotly is 354 KB of it) |
| Data for the first map | 580 KB |
| Wells and observations (just after the map) | 570 KB |
| **Total first visit** | **1.6 MB** |
| Each further year | 134 KB (confined) / 180 KB (unconfined), then cached |
| Each map click | about 104 KB per aquifer the first time in an area (32 × 32-cell block), then cached |
| Whole site | 38 MB in 316 files; largest file 1.07 MB |

### Optimisations used
- **Split, lossless raster files.** Year files for drawing maps; 32 × 32-cell
  "block" files with all 53 years for clicks. A click never downloads whole rasters.
- **Byte-shuffle and gzip.** Lossless; it cuts raster size by about 30% compared
  with plain gzip.
- **Pre-computed look-up image.** It maps each display pixel to its raster cell
  once, so redrawing a year is one loop over a reused image buffer.
- **Pre-computed results.** All Basin Summary statistics and fixed colour ranges are
  computed by the desktop functions at build time.
- **Caching in the browser.** Years, blocks and statistics stay in memory, with
  limits so memory stays low.
- **No server at all.** Nothing to sleep, overload or share between visitors.
  Each browser has its own state, so visitors cannot affect each other.

## 3. Genuine limitations

1. **Map drawing resolution.**
   - The raster is drawn through a 900-pixel-wide Web-Mercator image (needed for
     the OpenStreetMap background); at high zoom, cell edges can be offset by up to
     about one display pixel.
   - This affects only the picture. Every number in panels, plots and downloads
     comes from the original 500 m grid.
2. **Subbasin outlines** are converted to longitude/latitude (6 decimals, about
   0.1 m) for the web map. A click within a metre or so of a boundary could in
   principle fall on the other side, compared with the desktop.
3. **No GeoTIFF export.** The ESRI ASCII grid + `.prj` replaces it (same values; it
   opens in QGIS and ArcGIS).
4. **Map image (PNG)** contains the data layer, title and colour bar, not the
   background tiles.
5. **OpenStreetMap tiles** are a free, shared service. Not tested here (no
   internet). Very heavy traffic would need another tile provider.
6. **Browsers.** The site needs a current browser (Chrome, Edge, Firefox, Safari
   16.4 or newer) for built-in decompression; an older browser shows an explanatory
   message. It is designed for laptops and desktops; phones work but are cramped.
7. **Hosting limits.** GitHub Pages limits are quoted from my knowledge and could not
   be checked live; see the link in the README.
8. **Not tested on Windows.** Only Linux was tested; use README step 1 to check on
   Windows.

## 4. How to re-run the checks

```
python validation/make_reference.py --src "C:\path\to\analysis\total_wells"
cd docs && python -m http.server 8000          (leave running)
cd validation && npm install                    (first time only)
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
node browser_validation.js http://localhost:8000/ ..\screenshots
```

On Windows, set `CHROME_PATH` to your installed Chrome or Edge as shown. The
`@sparticuz/chromium` package used for the tests above is Linux-only.
