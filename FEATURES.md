# Feature inventory: desktop version 3 → web version

Classification as requested: **Essential** (must keep), **Useful** (keep if practical),
**Optional** (may be simplified).

## Map and hydrograph

| Desktop v3 feature | Class | Web version |
|---|---|---|
| Three products: absolute head; cumulative change base → year; provided 1971–2023 change | Essential | ✅ Kept, same titles and colour-bar labels |
| Confined / unconfined aquifer selection | Essential | ✅ Kept |
| Year slider 1971–2023, number box, Play animation with speed | Essential | ✅ Kept. Play preloads the year files in the background |
| Base year can never be later than the selected year | Essential | ✅ Kept (same rule) |
| Fixed-period product hides the time controls and shows "Fixed period: 1971–2023" | Essential | ✅ Kept |
| Units feet / metres (exact float32 conversion) | Essential | ✅ Kept, shared with the Basin summary |
| Colour maps; clip to 2nd–98th percentile; fixed range across years | Useful | ✅ Kept. Fixed ranges are pre-computed with the desktop formula |
| Surface opacity | Useful | ✅ Kept |
| OpenStreetMap background | Useful | ✅ Kept and **on by default**: on the web the network is always available and the background helps orientation. "None" is available |
| Subbasin outlines and short names | Essential | ✅ Kept |
| Wells by class (blue / green / orange), match classes to aquifer, only observed wells, colour by observed value, marker size | Essential | ✅ Kept, plus a hover label with the well number |
| Click map → hydrograph of both surfaces + nearby observed wells (radius) + drought shading + year and base-year lines | Essential | ✅ Kept. Uses the exact original raster cell |
| Click a well → its observed record highlighted, map ring | Essential | ✅ Kept |
| Point details: location, lat/lon, subbasin, mapped value, both aquifers' head / change / provided value, nearby wells table | Essential | ✅ Kept. Well numbers in the table are clickable |
| Well profile schematic (casing, valid screens, Corcoran reference, depth to water) + metadata card | Essential | ✅ Kept, redrawn in SVG with the same rules and texts |
| Map statistics line (mean, median, min, max, area, wells shown, area with decline) | Useful | ✅ Kept |
| Scale bar | Useful | ✅ Kept |
| North arrow | Optional | ⚪ Omitted: web maps are always north-up |
| Matplotlib zoom/pan toolbar | Essential (function) | 🔄 Replaced by standard web-map zoom and pan (mouse wheel, drag, + / −) |
| Save map figure (PNG/PDF/SVG) | Useful | 🔄 Map image as PNG with title and colour bar. The background tiles are not included, for licence and technical reasons |
| Save field as GeoTIFF | Useful | 🔄 Saved as an **ESRI ASCII grid + `.prj`**, which opens in QGIS and ArcGIS. Values are identical to the original grid (tested on all 74,241 cells). GeoTIFF writing is not reliable in a browser |
| Save point series (CSV) | Essential | ✅ Kept, same columns |

## Basin summary

| Desktop v3 feature | Class | Web version |
|---|---|---|
| Eight panels: Mean, Q1, Median, Q3 × absolute head and change since 1971 | Essential | ✅ Kept |
| Confined (solid blue) and unconfined (dashed orange) in every panel; shared y-axis per row; drought shading | Essential | ✅ Kept |
| Spatial scope: entire domain or one subbasin (cell centres inside the polygon) | Essential | ✅ Kept. All scopes are pre-computed with the desktop function `year_stats` |
| Units box synced with the map tab | Useful | ✅ Kept |
| Save statistics (CSV) | Essential | ✅ Kept, same columns |
| Save figure | Useful | ✅ Camera icon on the chart (PNG) |

## Storage change (desktop v3: regional totals 2015–2023 only)

| Desktop v3 feature | Class | Web version |
|---|---|---|
| Cards: confined water expansion, matrix compaction, confined total, unconfined (Sy range), combined total | Essential | ✅ Kept |
| Time series 2015–2023 with Sy 0.1–0.3 range; click to choose a year; hover values | Essential | ✅ Kept |
| Selected-year component chart with Sy whiskers; table of all years | Essential | ✅ Kept |
| Year slider and Play | Useful | ✅ Kept |
| Save table (CSV); save plots | Essential | ✅ Kept |
| No pixel-level storage (professor's request in v3) | Essential | ✅ Respected. Only workbook totals are used |

## Other

| Feature | Web version |
|---|---|
| Data report | ✅ Kept: the desktop checks run during the data build, plus notes about the web version |
| Side panel only on the map tab | ✅ Kept |
| "How to use" guide | ➕ New: collapsible four-step guide in the header |
| Loading, no-data and error messages | ➕ New: loading screen, "Loading…" chip, "No data" in tables, a clear message if the data cannot load |
| Laptop and narrow screens | ➕ New: the layout reflows below about 1250 px and 760 px |

## Not carried over

- **`tulare_well_validation.py`:** not part of the v3 explorer you asked to convert.
- **Desktop exception handler and Spyder-specific code:** not needed in a browser.
