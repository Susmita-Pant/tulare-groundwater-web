/* Tulare Basin Groundwater Explorer: web version of desktop version 3.
 * Every value comes from the original data (see build/build_web_data.py).
 * Rasters are drawn on the Web-Mercator map through a look-up image (drawing only);
 * all numbers in panels, plots and downloads come from the original 500 m grid.
 */
(() => {
"use strict";
const DATA = "data/";
const $ = (id) => document.getElementById(id);
const CLASSES = ["Confined", "Semi-confined", "Unconfined"];
const AQ = { confined: "Confined", unconfined: "Unconfined" };
const COLORS = { Confined: "#1E5AA8", "Semi-confined": "#14A44D", Unconfined: "#EE7A12" };
const INK = "#1F2A33", MUTED = "#5B6B76", SELECT = "#D7263D", MARKER_EDGE = "#14202B", LOSS = "#B2182B";
const DROUGHT = "rgba(140,140,140,0.18)";
const PLOT_CFG = { displaylogo: false, responsive: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
  toImageButtonOptions: { format: "png", scale: 2 } };

const App = { meta: null, cells: {}, looks: {}, years: new Map(), blocks: new Map(), sums: {},
  limits: null, stats: null, wells: null, obsG: null, obsD: null, basins: null, storage: null,
  click: null, sel: null, current: null, inflight: new Map(), timing: {} };
window.TulareApp = App;          // exposed for the automated browser tests

// ================================================================ loading helpers
function busy(on, text) {
  const el = $("busy");
  if (el) { el.style.display = on ? "block" : "none"; if (text) el.textContent = text; }
}
async function fetchBuf(name) {
  if (App.inflight.has(name)) return App.inflight.get(name);
  const p = (async () => {
    const r = await fetch(DATA + name);
    if (!r.ok) throw new Error(`Could not load ${name} (HTTP ${r.status})`);
    const buf = await r.arrayBuffer();
    return name.endsWith(".gz") ? await TC.gunzip(buf) : buf;
  })();
  App.inflight.set(name, p);
  try { return await p; } finally { App.inflight.delete(name); }
}
async function fetchJSON(name) { return JSON.parse(new TextDecoder().decode(await fetchBuf(name))); }
function plotlyReady() {
  return new Promise((res) => { const t = () => (window.Plotly ? res(window.Plotly) : setTimeout(t, 30)); t(); });
}
function lru(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

// ================================================================ raster data access
function grid(key) { return App.meta.grids[key]; }
async function cells(aq) {
  if (!App.cells[aq]) App.cells[aq] = new Int32Array(await fetchBuf(`cells_${aq}.bin.gz`));
  return App.cells[aq];
}
async function look(gkey) {
  const lk = App.meta.display[gkey].look;
  if (!App.looks[lk]) App.looks[lk] = new Int32Array(await fetchBuf(`look_${lk}.bin.gz`));
  return App.looks[lk];
}
/** Full-grid float32 heads (ft) for one aquifer and year, cached. */
async function yearGrid(aq, year) {
  const key = aq + ":" + year;
  if (App.years.has(key)) return App.years.get(key);
  const [c, buf] = await Promise.all([cells(aq), fetchBuf(`head_${aq}_${year}.bin.gz`)]);
  const g = grid(aq);
  const full = TC.expand(c, TC.unshuffleF32(buf), g.rows * g.cols);
  lru(App.years, key, full, 120);
  return full;
}
/** Provided 1971–2023 change, converted from metres to feet exactly as the desktop does. */
async function sumGridFt(aq) {
  if (!App.sums[aq]) {
    const m = TC.unshuffleF32(await fetchBuf(`sum_${aq}.bin.gz`));
    const fr = Math.fround(App.meta.ft_per_m);
    const ft = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) ft[i] = m[i] * fr;
    App.sums[aq] = ft;
  }
  return App.sums[aq];
}
/** 53-year head series (ft) at Albers x,y from the cell-block files (exact cell values). */
async function seriesAt(aq, x, y) {
  const g = grid(aq), B = App.meta.block, n = App.meta.years.length;
  const rc = TC.rowcol(g, x, y);
  const out = new Array(n).fill(NaN);
  if (!rc.ok) return out;
  const br = Math.floor(rc.row / B), bc = Math.floor(rc.col / B), id = `${br}_${bc}`;
  if (!App.meta.aquifers[aq].block_ids.includes(id)) return out;
  const key = aq + ":" + id;
  let blk = App.blocks.get(key);
  if (!blk) { blk = TC.unshuffleF32(await fetchBuf(`blk_${aq}_${id}.bin.gz`)); lru(App.blocks, key, blk, 60); }
  const local = (rc.row - br * B) * B + (rc.col - bc * B);
  for (let j = 0; j < n; j++) out[j] = blk[local * n + j];
  return out;
}
function prefetchYears(aq) {
  const yrs = App.meta.years.slice();
  let i = 0;
  const next = () => { if (i < yrs.length) yearGrid(aq, yrs[i++]).then(next, next); };
  for (let k = 0; k < 4; k++) next();
}

// ================================================================ state
const st = () => ({
  product: $("product").value, aquifer: $("aquifer").value, year: +$("year").value, base: +$("base").value,
  metres: $("units").value === "m", cmap: $("cmap").value, robust: $("robust").checked,
  fixed: $("fixedRange").checked, opacity: +$("opacity").value / 100,
});
const unitLabel = () => ($("units").value === "m" ? "m" : "ft");
const uf = () => ($("units").value === "m" ? TC.M_PER_FT : 1);

/** Current field in feet + its grid key and titles (desktop HeadExplorer.field). */
async function field() {
  const s = st(), aq = s.aquifer, name = AQ[aq];
  if (s.product === "head") {
    return { arr: await yearGrid(aq, s.year), gkey: aq, period: `${s.year}`,
             title: `${name} aquifer: absolute groundwater head, ${s.year}` };
  }
  if (s.product === "cumulative") {
    const [a, b] = await Promise.all([yearGrid(aq, s.base), yearGrid(aq, s.year)]);
    return { arr: TC.difference(a, b), gkey: aq, period: `${s.base}–${s.year}`,
             title: `${name} aquifer: cumulative head change, ${s.base} → ${s.year}` };
  }
  return { arr: await sumGridFt(aq), gkey: `sum_${aq}`, period: "1971–2023",
           title: `${name} aquifer: provided cumulative head change, 1971–2023 (fixed period)` };
}
/** Colour limits in feet (desktop _limits_ft). */
function limitsFt(arr) {
  const s = st(), sym = s.product !== "head";
  if (!s.fixed || s.product === "sum") return TC.robustLimits(arr, s.robust, sym);
  const L = App.limits[s.aquifer];
  const m = s.robust ? "robust" : "minmax";
  return s.product === "head" ? L.head[m] : L.cumulative[String(s.base)][m];
}

// ================================================================ map
let map, osm, overlay = null, overlayKey = null, canvas = null, basinLayer, labelLayer, wellLayer, pickLayer;
const cbar = L.control({ position: "topright" });
const legend = L.control({ position: "bottomleft" });

function initMap() {
  map = L.map("map", { zoomControl: true, preferCanvas: true, attributionControl: true, zoomSnap: 0.25 });
  App.map = map;
  osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 15, minZoom: 6,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  osm.addTo(map);
  L.control.scale({ metric: true, imperial: false, position: "bottomright" }).addTo(map);
  map.createPane("raster"); map.getPane("raster").style.zIndex = 350;
  map.createPane("basins"); map.getPane("basins").style.zIndex = 420;
  App.wellRenderer = L.canvas({ padding: 0.5, tolerance: 8 });
  wellLayer = L.layerGroup().addTo(map);
  pickLayer = L.layerGroup().addTo(map);
  const busyEl = L.DomUtil.create("div", "busy"); busyEl.id = "busy"; busyEl.textContent = "Loading…";
  $("map").appendChild(busyEl);
  cbar.onAdd = () => { const d = L.DomUtil.create("div", "cbar"); d.id = "cbar"; return d; };
  cbar.addTo(map);
  legend.onAdd = () => { const d = L.DomUtil.create("div", "legend"); d.id = "legend"; return d; };
  legend.addTo(map);
  map.on("click", (e) => {
    const i = nearestWellOnScreen(e.containerPoint, 12);
    if (i !== null) selectWell(i); else selectPoint(e.latlng, null);
  });
  const d = App.meta.display.confined;
  map.fitBounds([[d.south, d.west], [d.north, d.east]], { padding: [10, 10] });
}

async function drawRaster() {
  const t0 = performance.now();
  busy(true, "Loading map…");
  const f = await field();
  const s = st(), u = uf(), metres = s.metres;
  let disp = f.arr;
  if (metres) { disp = new Float32Array(f.arr.length); for (let i = 0; i < f.arr.length; i++) disp[i] = TC.toUnits(f.arr[i], true); }
  let [lo, hi] = f.arr.length ? limitsFt(f.arr) : [-1, 1];
  lo *= u; hi *= u;
  const D = App.meta.display[f.gkey], lk = await look(f.gkey);
  if (overlayKey !== f.gkey) {
    if (overlay) map.removeLayer(overlay);
    canvas = document.createElement("canvas");
    canvas.width = D.width; canvas.height = D.height; canvas.className = "raster";
    overlay = L.svgOverlay(canvas, [[D.south, D.west], [D.north, D.east]], { pane: "raster", interactive: false });
    overlay.addTo(map); overlayKey = f.gkey;
  }
  const ctx = canvas.getContext("2d");
  if (!App.img || App.img.width !== D.width || App.img.height !== D.height) App.img = ctx.createImageData(D.width, D.height);
  const img = App.img, px = img.data;
  px.fill(0);
  const lut = App.meta.cmaps[s.cmap], span = hi - lo || 1;
  for (let p = 0; p < lk.length; p++) {
    const idx = lk[p];
    if (idx < 0) continue;
    const v = disp[idx];
    if (v !== v) continue;                     // NaN: transparent
    let k = Math.floor(((v - lo) / span) * 256);
    k = k < 0 ? 0 : k > 255 ? 255 : k;
    const c = lut[k], o = p * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  App.timing.renderPixels = performance.now() - t0;
  canvas.style.opacity = s.opacity;
  const label = s.product === "head" ? `Groundwater head (${unitLabel()})`
    : `Head change ${f.period} (${unitLabel()}); negative = decline`;
  App.current = { ...f, disp, lo, hi, label, stats: TC.summary(disp) };
  drawColorbar(lut, lo, hi, label);
  $("mapTitle").textContent = f.title;
  const tw = performance.now();
  drawWells();                     // also refreshes the statistics line
  App.timing.drawWells = performance.now() - tw;
  busy(false);
  App.timing.lastRaster = performance.now() - t0;
}

function drawColorbar(lut, lo, hi, label) {
  const el = $("cbar");
  const c = document.createElement("canvas"); c.width = 16; c.height = 200;
  const x = c.getContext("2d");
  for (let i = 0; i < 200; i++) { const k = Math.floor((1 - i / 199) * 255); x.fillStyle = `rgb(${lut[k]})`; x.fillRect(0, i, 16, 1); }
  const ticks = niceTicks(lo, hi, 6);
  const tickHtml = ticks.map((t) => `<div style="position:absolute;top:${(1 - (t - lo) / (hi - lo)) * 200 - 7}px;left:22px">${fmt(t, Math.abs(hi - lo) < 10 ? 1 : 0)}</div>`).join("");
  el.innerHTML = `<div style="font-size:11.5px;max-width:150px;margin-bottom:4px;color:${INK}">${label}</div>
    <div style="position:relative;height:200px;width:70px"><img src="${c.toDataURL()}" style="width:16px;height:200px;border:1px solid #999">${tickHtml}</div>`;
}
function niceTicks(lo, hi, n) {
  const span = hi - lo; if (!(span > 0)) return [lo];
  const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = []; for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(+t.toFixed(10));
  return out;
}
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "No data");
const fmtS = (v, d = 1) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + fmt(v, d) : "No data");

function updateStats() {
  const c = App.current; if (!c) return;
  const sm = c.stats, u = unitLabel(), g = App.meta.grids[c.gkey];
  if (!sm) { $("mapStats").textContent = c.title; return; }
  const cellKm2 = Math.abs(g.a * g.e) / 1e6, area = sm.n * cellKm2;
  let t = `Mean ${fmt(sm.mean)} ${u} · median ${fmt(sm.median)} · min ${fmt(sm.min)} · max ${fmt(sm.max)} · area ${fmt(area, 0)} km² · wells shown ${App.wellsShown || 0}`;
  if (st().product !== "head") t += ` · area with decline ${fmt(sm.negative * cellKm2, 0)} km² (${fmt(100 * sm.negative / sm.n, 0)}%)`;
  $("mapStats").textContent = t;
}

// ================================================================ subbasins
function drawBasins() {
  if (basinLayer) map.removeLayer(basinLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  basinLayer = labelLayer = null;
  if (!App.basins || !$("basins").checked) { $("basinNames").disabled = true; drawLegend(); return; }
  $("basinNames").disabled = false;
  basinLayer = L.geoJSON(App.basins, { pane: "basins", interactive: false,
    style: { color: "#3B3B3B", weight: 1.3, opacity: 0.85, fill: false } }).addTo(map);
  if ($("basinNames").checked) {
    labelLayer = L.layerGroup(App.basins.features.map((f) =>
      L.tooltip({ permanent: true, direction: "center", className: "basin-label", interactive: false })
        .setLatLng([f.properties.label_lat, f.properties.label_lon]).setContent(f.properties.short_name))).addTo(map);
  }
  drawLegend();
}

// ================================================================ wells
function activeClasses() { return CLASSES.filter((c) => document.querySelector(`[data-cls="${c}"]`).checked); }
function syncClasses() {
  if (!$("matchClasses").checked) return;
  const want = $("aquifer").value === "confined" ? ["Confined", "Semi-confined"] : ["Unconfined"];
  for (const c of CLASSES) document.querySelector(`[data-cls="${c}"]`).checked = want.includes(c);
}
/** Observed value (ft) of the mapped quantity for well i (desktop observed_values). */
function observedFt(i) {
  const s = st(), G = App.obsG, Y0 = App.meta.first_year, row = G[i];
  const at = (y) => row[y - Y0];
  if (s.product === "head") return at(s.year);
  if (s.product === "cumulative") return at(s.year) - at(s.base);
  return at(App.meta.last_year) - at(Y0);
}
function drawWells() {
  wellLayer.clearLayers();
  App.wellsShown = 0;
  if (!App.wells || !$("showWells").checked) { drawLegend(); updateStatsLight(); return; }
  const cls = new Set(activeClasses()), only = $("onlyObserved").checked, byVal = $("wellColor").value === "value";
  const r = +$("msize").value, c = App.current, u = uf();
  const lut = App.meta.cmaps[st().cmap];
  App.visibleWells = [];
  for (const w of App.wells) {
    if (!cls.has(w.aquifer)) continue;
    const ov = App.obsG ? observedFt(w.i) : NaN;
    if ((only || byVal) && !(ov === ov)) continue;
    let fill = COLORS[w.aquifer];
    if (byVal && c) {
      let k = Math.floor(((ov * u - c.lo) / (c.hi - c.lo || 1)) * 256); k = Math.max(0, Math.min(255, k));
      fill = `rgb(${lut[k]})`;
    }
    const m = L.circleMarker([w.lat, w.lon], { renderer: App.wellRenderer, radius: r, color: MARKER_EDGE, weight: 0.8, fillColor: fill,
      fillOpacity: 1, bubblingMouseEvents: false });
    m.bindTooltip(`Well ${w.id} · ${w.aquifer}${w.name ? " · " + w.name : ""}`, { direction: "top", offset: [0, -4] });
    m.on("click", () => selectWell(w.i));
    m.addTo(wellLayer);
    App.visibleWells.push(w.i);
  }
  App.wellsShown = App.visibleWells.length;
  drawLegend(); updateStatsLight();
}
function updateStatsLight() { if (App.current) updateStats(); }
function drawLegend() {
  const el = $("legend"); if (!el) return;
  let h = "";
  if ($("showWells").checked && $("wellColor").value === "class")
    h += activeClasses().map((c) => `<div><i style="background:${COLORS[c]}"></i>${c} wells</div>`).join("");
  if ($("showWells").checked && $("wellColor").value === "value") h += `<div>Wells coloured by observed value</div>`;
  if (App.basins && $("basins").checked) h += `<div><span class="ln"></span>Subbasin boundary</div>`;
  el.innerHTML = h; el.style.display = h ? "block" : "none";
}

// ================================================================ selection
function toAlbers(lat, lon) { const p = proj4("EPSG:4326", App.meta.proj4, [lon, lat]); return { x: p[0], y: p[1] }; }
function basinAt(lat, lon) { return App.basins ? TC.findBasin(App.basins.features, lon, lat) : null; }

async function selectPoint(latlng, wellIdx) {
  const t0 = performance.now();
  const { x, y } = wellIdx !== null && wellIdx !== undefined ? App.wells[wellIdx] : toAlbers(latlng.lat, latlng.lng);
  const lat = wellIdx != null ? App.wells[wellIdx].lat : latlng.lat, lon = wellIdx != null ? App.wells[wellIdx].lon : latlng.lng;
  App.click = { x, y, lat, lon }; App.sel = wellIdx ?? null;
  pickLayer.clearLayers();
  if (App.sel !== null) {
    L.circleMarker([lat, lon], { radius: 13, color: "#fff", weight: 5, fill: false, interactive: false }).addTo(pickLayer);
    L.circleMarker([lat, lon], { radius: 13, color: SELECT, weight: 2.6, fill: false, interactive: false }).addTo(pickLayer);
  } else {
    L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(pickLayer);
  }
  busy(true, "Loading hydrograph…");
  const [sc, su] = await Promise.all([seriesAt("confined", x, y), seriesAt("unconfined", x, y),
    sumGridFt("confined"), sumGridFt("unconfined")]);
  App.click.series = { confined: sc, unconfined: su };
  App.click.basin = basinAt(lat, lon);
  await drawHydrograph();
  fillInfo();
  drawProfile();
  showSub(App.sel !== null ? "well" : "point");
  busy(false);
  App.timing.lastClick = performance.now() - t0;
}
function selectWell(i) { return selectPoint(null, i); }
/** Visible well whose dot is within 'tol' screen pixels of the click (like the desktop tolerance). */
function nearestWellOnScreen(pt, tol) {
  if (!App.wells || !$("showWells").checked || !App.visibleWells) return null;
  let best = null, bd = tol + (+$("msize").value);
  for (const i of App.visibleWells) {
    const w = App.wells[i], q = map.latLngToContainerPoint([w.lat, w.lon]);
    const d = Math.hypot(q.x - pt.x, q.y - pt.y);
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}
App.selectPoint = selectPoint; App.selectWell = selectWell;

function nearby(x, y) {
  const R = +$("radius").value * 1000, out = [];
  for (const w of App.wells) {
    if (!w.n_obs) continue;
    const d = Math.hypot(w.x - x, w.y - y);
    if (d <= R) out.push([w.i, d]);
  }
  return out.sort((a, b) => a[1] - b[1]).slice(0, 40);
}

// ================================================================ hydrograph
function droughtShapes(xref = "x", yref = "y domain", x0 = -Infinity, x1 = Infinity) {
  return App.meta.drought_periods.filter(([a, b]) => b >= x0 && a <= x1).map(([a, b]) => ({ type: "rect", xref, yref,
    x0: Math.max(a, x0), x1: Math.min(b, x1), y0: 0, y1: 1, fillcolor: DROUGHT, line: { width: 0 }, layer: "below" }));
}
async function drawHydrograph() {
  const Plotly = await plotlyReady();
  const c = App.click, u = uf(), years = App.meta.years, ul = unitLabel();
  const traces = [];
  for (const aq of ["confined", "unconfined"]) {
    const s = c.series[aq];
    if (s.some((v) => v === v))
      traces.push({ x: years, y: s.map((v) => (v === v ? v * u : null)), mode: "lines", name: `${AQ[aq]} surface (interpolated raster)`,
        line: { color: COLORS[AQ[aq]], width: 2.4 }, hovertemplate: `%{x}: %{y:.1f} ${ul}<extra>${AQ[aq]} surface</extra>` });
  }
  const near = nearby(c.x, c.y), byCls = {};
  for (const [i] of near) {
    if (i === App.sel) continue;
    const w = App.wells[i], o = App.obs[w.id]; if (!o) continue;
    const t = (byCls[w.aquifer] ||= { x: [], y: [], text: [] });
    o[0].forEach((yr, k) => { if (o[1][k] !== null) { t.x.push(yr); t.y.push(o[1][k] * u); t.text.push(`Well ${w.id}`); } });
  }
  for (const [cls, t] of Object.entries(byCls))
    traces.push({ ...t, mode: "markers", name: `Nearby ${cls.toLowerCase()} wells, observed (≤ ${$("radius").value} km)`,
      marker: { color: COLORS[cls], size: 5, opacity: 0.55 }, hovertemplate: `%{text}<br>%{x}: %{y:.1f} ${ul}<extra>observed</extra>` });
  if (App.sel !== null) {
    const w = App.wells[App.sel], o = App.obs[w.id];
    if (o) traces.push({ x: o[0], y: o[1].map((v) => (v === null ? null : v * u)), mode: "lines+markers",
      name: `Well ${w.id} (${w.aquifer}), observed`, line: { color: SELECT, width: 1.4 },
      marker: { size: 6, color: SELECT, line: { color: "#fff", width: 0.7 } }, connectgaps: true,
      hovertemplate: `%{x}: %{y:.1f} ${ul}<extra>Well ${w.id} observed</extra>` });
  }
  traces.push({ x: [null], y: [null], mode: "markers", name: "Drought period", marker: { symbol: "square", size: 12, color: "rgba(140,140,140,0.35)" }, hoverinfo: "skip" });
  const s = st();
  const shapes = droughtShapes().concat([{ type: "line", xref: "x", yref: "y domain", x0: s.year, x1: s.year, y0: 0, y1: 1, line: { color: SELECT, width: 1, dash: "dot" } }]);
  if (s.product === "cumulative") shapes.push({ type: "line", xref: "x", yref: "y domain", x0: s.base, x1: s.base, y0: 0, y1: 1, line: { color: MUTED, width: 1, dash: "dash" } });
  const b = c.basin ? c.basin.short_name : (App.basins ? "outside mapped subbasins" : "");
  const layout = { title: { x: 0.01, xanchor: "left", text: `Hydrograph at E ${(c.x / 1000).toFixed(1)} km, N ${(c.y / 1000).toFixed(1)} km${b ? " (" + b + ")" : ""}`, font: { size: 13.5 } },
    margin: { l: 58, r: 12, t: 38, b: 10 }, xaxis: { range: [App.meta.first_year - 1, App.meta.last_year + 1], title: { text: "Year" }, gridcolor: "#eceff1" },
    yaxis: { title: { text: `Groundwater head (${ul})` }, gridcolor: "#eceff1", zeroline: false },
    legend: { orientation: "h", y: -0.22, font: { size: 11 } }, shapes, hovermode: "closest",
    paper_bgcolor: "#fff", plot_bgcolor: "#fff", font: { family: "Segoe UI, Helvetica Neue, Arial", color: INK, size: 12 } };
  const el = $("hydro"); const ph = el.querySelector(".empty"); if (ph) ph.remove();
  await Plotly.react(el, traces, layout, { ...PLOT_CFG, toImageButtonOptions: { ...PLOT_CFG.toImageButtonOptions, filename: "hydrograph" } });
}
async function moveYearLines() {
  if (!App.click || !window.Plotly) return;
  const s = st(), el = $("hydro");
  if (!el.layout) return;
  const shapes = el.layout.shapes.filter((sh) => sh.type === "rect");
  shapes.push({ type: "line", xref: "x", yref: "y domain", x0: s.year, x1: s.year, y0: 0, y1: 1, line: { color: SELECT, width: 1, dash: "dot" } });
  if (s.product === "cumulative") shapes.push({ type: "line", xref: "x", yref: "y domain", x0: s.base, x1: s.base, y0: 0, y1: 1, line: { color: MUTED, width: 1, dash: "dash" } });
  Plotly.relayout(el, { shapes });
}

// ================================================================ point details
function fillInfo() {
  const c = App.click; if (!c) return;
  const s = st(), u = uf(), ul = unitLabel(), Y0 = App.meta.first_year;
  const yi = s.year - Y0, bi = s.base - Y0;
  let h = `<div class="info"><b>Location</b><br>E ${fmt(c.x, 0)} m, N ${fmt(c.y, 0)} m (Albers) &nbsp;|&nbsp; ${c.lat.toFixed(5)}° N, ${Math.abs(c.lon).toFixed(5)}° W<br>Subbasin: `;
  h += !App.basins ? `<span class="hint">subbasin layer not loaded</span>` : c.basin ? `<b>${c.basin.short_name}</b> <span class="hint">(${c.basin.full_name})</span>` : "<b>Outside mapped subbasins</b>";
  const cur = App.current;
  let mv = NaN;
  if (cur) { const rc = TC.rowcol(App.meta.grids[cur.gkey], c.x, c.y); if (rc.ok) mv = cur.disp[rc.index]; }
  h += `<h4>Mapped value <span class="hint">(${cur ? cur.title : ""})</span></h4>${Number.isFinite(mv) ? fmt(mv) + " " + ul : "No data"}`;
  h += `<h4>Surfaces at this point <span class="hint">(${ul}; “No data” where the raster has none)</span></h4><table><tr class="hint"><td></td><td>Head ${s.year}</td><td>${s.product === "cumulative" ? `Change ${s.base}–${s.year}` : `Change 1971–${s.year}`}</td><td>Provided 1971–2023</td></tr>`;
  for (const aq of ["confined", "unconfined"]) {
    const ser = c.series[aq], hd = ser[yi], ch = ser[yi] - (s.product === "cumulative" ? ser[bi] : ser[0]);
    const sm = App.sums[aq] ? (() => { const rc = TC.rowcol(App.meta.grids["sum_" + aq], c.x, c.y); return rc.ok ? App.sums[aq][rc.index] : NaN; })() : NaN;
    h += `<tr><td style="color:${COLORS[AQ[aq]]}">${AQ[aq]}</td><td align=right>${fmt(hd * u)}</td><td align=right>${fmtS(ch * u)}</td><td align=right>${fmtS(sm * u)}</td></tr>`;
  }
  h += `</table>`;
  const near = nearby(c.x, c.y);
  if (near.length) {
    h += `<h4>Nearby wells with data</h4><table><tr class="hint"><td>Station</td><td>Class</td><td>Distance</td><td>Years</td></tr>`;
    for (const [i, d] of near.slice(0, 12)) { const w = App.wells[i];
      h += `<tr><td><a href="#" data-well="${i}">${w.id}</a></td><td style="color:${COLORS[w.aquifer]}">${w.aquifer}</td><td align=right>${(d / 1000).toFixed(2)} km</td><td align=right>${w.n_obs}</td></tr>`; }
    h += `</table>` + (near.length > 12 ? `<div class="hint">and ${near.length - 12} more</div>` : "");
  } else h += `<p class="hint">No wells with data within ${$("radius").value} km.</p>`;
  $("sub-point").innerHTML = h + "</div>";
  $("sub-point").querySelectorAll("[data-well]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); selectWell(+a.dataset.well); }));
}

// ================================================================ well profile (desktop well_profile.py)
const PCOL = { casing: "#9AA5AD", fill: "#EEF1F3", screen: "#1D8A7A", corc: "#8C5A2B", water: "#1E88E5", ground: "#7A5C3E" };
function drawProfile() {
  const el = $("sub-well");
  if (App.sel === null) { el.innerHTML = `<div class="hint pad">No well selected yet. Click on (or right next to) a coloured well dot on the map to see its construction schematic and details. Tip: zoom in where wells are crowded.</div>`; return; }
  const w = App.wells[App.sel], s = st(), u = uf(), ul = unitLabel();
  const G = App.obsD[w.i], dtw = G ? G[s.year - App.meta.first_year] : NaN;
  const depth = w.depth_ft ?? NaN, corc = w.corcoran_ft ?? NaN, ivs = w.intervals;
  const cands = [depth, corc, dtw].filter(Number.isFinite).concat(ivs.map((v) => v[1]));
  const W = 300, H = 440, L0 = 58, R0 = 290, T0 = 34, B0 = 352;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Helvetica Neue, Arial" font-size="10.5">`;
  svg += `<defs><pattern id="hatch" width="6" height="4" patternUnits="userSpaceOnUse"><rect width="6" height="4" fill="${PCOL.screen}"/><line x1="0" y1="2" x2="6" y2="2" stroke="#fff" stroke-width="0.9"/></pattern></defs>`;
  svg += `<text x="${W / 2}" y="16" text-anchor="middle" font-size="12.5" fill="${COLORS[w.aquifer]}">Well ${w.id} schematic</text>`;
  if (!cands.length) {
    svg += `<text x="${W / 2}" y="150" text-anchor="middle" fill="${MUTED}">No documented depth, screen intervals,</text><text x="${W / 2}" y="166" text-anchor="middle" fill="${MUTED}">Corcoran reference or depth-to-water</text><text x="${W / 2}" y="182" text-anchor="middle" fill="${MUTED}">observation for this well.</text></svg>`;
  } else {
    const ymax = Math.max(...cands) * 1.12, pad = 0.07 * ymax;
    const Y = (d) => T0 + ((d + pad) / (ymax + pad)) * (B0 - T0);
    const X = (f) => L0 + f * (R0 - L0);
    const xl = X(0.42), xr = X(0.58), legend = [];
    svg += `<rect x="${L0}" y="${T0}" width="${R0 - L0}" height="${Y(0) - T0}" fill="#F4F7FA"/>`;
    for (const t of niceTicks(0, ymax * u, 6)) { const yy = Y(t / u); svg += `<line x1="${L0}" x2="${R0}" y1="${yy}" y2="${yy}" stroke="#e5e9ec"/><text x="${L0 - 5}" y="${yy + 3.5}" text-anchor="end" fill="${MUTED}">${fmt(t, 0)}</text>`; }
    svg += `<line x1="${L0}" x2="${R0}" y1="${Y(0)}" y2="${Y(0)}" stroke="${PCOL.ground}" stroke-width="2.4"/><text x="${X(0.03)}" y="${Y(0) - 5}" fill="${PCOL.ground}" font-size="10">Land surface (0)</text>`;
    const bottom = Number.isFinite(depth) ? depth : ivs.length ? Math.max(...ivs.map((v) => v[1])) : null;
    if (bottom !== null) {
      svg += `<rect x="${xl}" y="${Y(0)}" width="${xr - xl}" height="${Y(bottom) - Y(0)}" fill="${PCOL.fill}" stroke="${PCOL.casing}" stroke-width="1.4" ${Number.isFinite(depth) ? "" : 'stroke-dasharray="4 3"'}/>`;
      if (Number.isFinite(depth)) { svg += `<line x1="${xl - 8}" x2="${xr + 8}" y1="${Y(depth)}" y2="${Y(depth)}" stroke="${INK}" stroke-width="2"/><text x="${X(0.5)}" y="${Y(depth) + 13}" text-anchor="middle" fill="${INK}">Total depth ${fmt(depth * u, 0)} ${ul}</text>`; legend.push(["casing", "Well casing"]); }
      else { svg += `<text x="${X(0.5)}" y="${Y(bottom) + 13}" text-anchor="middle" fill="${MUTED}" font-style="italic">Total depth not documented</text>`; legend.push(["casingd", "Casing (to deepest screen; depth not documented)"]); }
    } else svg += `<text x="${X(0.5)}" y="${Y(0) + 26}" text-anchor="middle" fill="${MUTED}" font-style="italic">Well depth and screens not documented</text>`;
    for (const [a, b] of ivs) svg += `<rect x="${xl}" y="${Y(a)}" width="${xr - xl}" height="${Math.max(1, Y(b) - Y(a))}" fill="url(#hatch)" stroke="#fff" stroke-width="0.6"/><text x="${xl - 5}" y="${(Y(a) + Y(b)) / 2 + 3.5}" text-anchor="end" fill="${PCOL.screen}" font-size="9.5" stroke="#fff" stroke-width="2.5" paint-order="stroke">${fmt(a * u, 0)}–${fmt(b * u, 0)}</text>`;
    if (ivs.length) legend.push(["screen", `Screened interval${ivs.length > 1 ? "s" : ""} (${ivs.length})`]);
    if (Number.isFinite(corc)) { svg += `<line x1="${X(0.03)}" x2="${X(0.97)}" y1="${Y(corc)}" y2="${Y(corc)}" stroke="${PCOL.corc}" stroke-width="1.6" stroke-dasharray="6 3"/><text x="${X(0.97)}" y="${Y(corc) - 4}" text-anchor="end" fill="${PCOL.corc}" font-size="9.5" stroke="#fff" stroke-width="2.5" paint-order="stroke">Corcoran ref. ${fmt(corc * u, 0)} ${ul}</text>`; legend.push(["corc", "Corcoran depth reference (1983 raster)"]); }
    if (Number.isFinite(dtw)) { svg += `<line x1="${X(0.3)}" x2="${X(0.7)}" y1="${Y(dtw)}" y2="${Y(dtw)}" stroke="${PCOL.water}" stroke-width="1.6"/><path d="M ${X(0.5) - 5} ${Y(dtw) - 9} L ${X(0.5) + 5} ${Y(dtw) - 9} L ${X(0.5)} ${Y(dtw) - 1} Z" fill="${PCOL.water}"/><text x="${X(0.71)}" y="${Y(dtw) + 12}" fill="${PCOL.water}" font-size="9.5" stroke="#fff" stroke-width="2.5" paint-order="stroke">Water ${s.year}: ${fmt(dtw * u)} ${ul}</text>`; legend.push(["water", `Observed depth to water (${s.year})`]); }
    svg += `<text transform="translate(14 ${(T0 + B0) / 2}) rotate(-90)" text-anchor="middle" fill="${INK}">Depth below land surface (${ul})</text>`;
    svg += `<text x="${(L0 + R0) / 2}" y="${B0 + 14}" text-anchor="middle" fill="${MUTED}" font-size="9.5">Not a geologic cross-section</text>`;
    legend.forEach(([k, t], j) => {
      const yy = B0 + 30 + j * 15, sx = L0 - 30;
      const sym = k === "casing" ? `<rect x="${sx}" y="${yy - 7}" width="16" height="8" fill="${PCOL.casing}" opacity=".6"/>`
        : k === "casingd" ? `<line x1="${sx}" x2="${sx + 16}" y1="${yy - 3}" y2="${yy - 3}" stroke="${PCOL.casing}" stroke-dasharray="4 3" stroke-width="1.4"/>`
        : k === "screen" ? `<rect x="${sx}" y="${yy - 8}" width="16" height="9" fill="url(#hatch)"/>`
        : k === "corc" ? `<line x1="${sx}" x2="${sx + 16}" y1="${yy - 3}" y2="${yy - 3}" stroke="${PCOL.corc}" stroke-dasharray="6 3" stroke-width="1.6"/>`
        : `<line x1="${sx}" x2="${sx + 16}" y1="${yy - 3}" y2="${yy - 3}" stroke="${PCOL.water}" stroke-width="1.6"/>`;
      svg += sym + `<text x="${sx + 22}" y="${yy}" font-size="9.5" fill="${INK}">${t}</text>`;
    });
    svg += "</svg>";
  }
  el.innerHTML = `<div class="profile"><div>${svg}</div><div class="info">${wellCard(w, dtw, s.year)}</div></div>`;
}
const na = (v) => (v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v)) ? "Not available" : v);
function wellCard(w, dtw, year) {
  const u = uf(), ul = unitLabel();
  let scr = w.intervals.length ? w.intervals.map(([a, b]) => `${fmt(a * u, 0)}–${fmt(b * u, 0)} ${ul}`).join("<br>") + `<br><span class="hint">source: ${w.interval_source}</span>` : "Not available";
  scr += w.issues.map((i) => `<br><span style="color:${LOSS}">⚠ ${i}</span>`).join("");
  const o = App.obs[w.id], yrs = o ? o[0] : [];
  const sub = !App.basins ? "Not available (subbasin layer not loaded)" : w.subbasin ? `${w.subbasin} <span class="hint">(${(App.basins.features.find((f) => f.properties.short_name === w.subbasin) || { properties: {} }).properties.full_name || ""})</span>` : "Outside mapped subbasins";
  const rows = [
    ["Well name", na(w.name)], ["Station ID", w.id], ["Site code", na(w.site)],
    ["Aquifer class", `<span style="color:${COLORS[w.aquifer]}">${w.aquifer}</span> <span class="hint">(${w.source} shapefile)</span>`],
    ["Use", na(w.use)], ["Well type", na(w.type)],
    ["Documented depth", Number.isFinite(w.depth_ft) ? `${fmt(w.depth_ft * u, 0)} ${ul}` : "Not available"],
    ["Screen intervals", scr], ["County", na(w.county)], ["Named basin", na(w.basin)], ["Spatial subbasin", sub],
    ["Corcoran reference", Number.isFinite(w.corcoran_ft) ? `${fmt(w.corcoran_ft * u, 0)} ${ul} below land surface <span class="hint">(top/base not recorded in the raster)</span>` : "Not available at this location"],
    ["Depth to water", Number.isFinite(dtw) ? `${fmt(dtw * u)} ${ul} in ${year}` : `No observation in ${year}`],
    ["Observed years", yrs.length ? `${yrs.length} years (${yrs[0]}–${yrs[yrs.length - 1]})` : "Not available"],
  ];
  return `<h4 style="color:${COLORS[w.aquifer]};margin-top:0">Well ${w.id}</h4><table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>`;
}
function showSub(which) {
  document.querySelectorAll(".subtab[data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === which));
  $("sub-point").classList.toggle("active", which === "point");
  $("sub-well").classList.toggle("active", which === "well");
}

// ================================================================ controls
function updateTimeControls() {
  const p = $("product").value;
  $("fixedPeriod").hidden = p !== "sum";
  $("timeBox").hidden = p === "sum";
  $("baseRow").hidden = p !== "cumulative";
  const div = p !== "head", cm = $("cmap"), cur = cm.value;
  const names = div ? ["RdBu", "PuOr", "BrBG", "coolwarm"] : ["viridis", "cividis", "YlGnBu", "magma", "Blues"];
  cm.innerHTML = names.map((n) => `<option>${n}</option>`).join("");
  if (names.includes(cur)) cm.value = cur;
  if (p === "sum") stopPlay();
}
function setYear(y) {
  y = Math.max(App.meta.first_year, Math.min(App.meta.last_year, y));
  $("year").value = y; $("yearNum").value = y;
  $("base").max = y;
  if (+$("base").value > y) $("base").value = y;
}
let playTimer = null;
function stopPlay() { clearTimeout(playTimer); playTimer = null; $("play").textContent = "▶ Play"; }
async function playStep() {
  if (!playTimer) return;
  const s = st();
  let y = s.year + 1;
  if (y > App.meta.last_year) y = s.product === "cumulative" ? s.base : App.meta.first_year;
  setYear(y);
  await refreshYear();
  if (playTimer) playTimer = setTimeout(playStep, +$("speed").value);
}
async function refreshYear() { await drawRaster(); moveYearLines(); if (App.click) { fillInfo(); if (App.sel !== null) drawProfile(); } }
async function refreshAll() { await drawRaster(); if (App.click) { await drawHydrograph(); fillInfo(); drawProfile(); } }

function bindControls() {
  $("product").addEventListener("change", () => { updateTimeControls(); syncClasses(); refreshAll(); });
  $("aquifer").addEventListener("change", () => { syncClasses(); refreshAll(); });
  $("year").addEventListener("input", () => { setYear(+$("year").value); refreshYear(); });
  $("yearNum").addEventListener("change", () => { setYear(+$("yearNum").value); refreshYear(); });
  $("base").addEventListener("change", () => { const v = Math.min(+$("base").value, +$("year").value); $("base").value = Math.max(App.meta.first_year, v); refreshYear(); });
  $("play").addEventListener("click", () => {
    if (playTimer) return stopPlay();
    prefetchYears($("aquifer").value);
    $("play").textContent = "❚❚ Pause"; playTimer = setTimeout(playStep, 50);
  });
  $("units").addEventListener("change", () => { $("unitsSummary").value = $("units").value; refreshAll(); summaryDirty = true; });
  $("unitsSummary").addEventListener("change", () => { $("units").value = $("unitsSummary").value; refreshAll(); drawSummary(); });
  for (const id of ["cmap", "robust", "fixedRange"]) $(id).addEventListener("change", () => refreshAll());
  $("opacity").addEventListener("input", () => { if (canvas) canvas.style.opacity = +$("opacity").value / 100; });
  $("basemap").addEventListener("change", () => { if ($("basemap").value === "osm") osm.addTo(map); else map.removeLayer(osm); });
  $("basins").addEventListener("change", drawBasins);
  $("basinNames").addEventListener("change", drawBasins);
  for (const id of ["showWells", "onlyObserved", "wellColor", "msize"]) $(id).addEventListener("change", drawWells);
  $("matchClasses").addEventListener("change", () => { syncClasses(); drawWells(); });
  document.querySelectorAll("[data-cls]").forEach((c) => c.addEventListener("change", drawWells));
  $("radius").addEventListener("change", () => { if (App.click) { drawHydrograph(); fillInfo(); } });
  document.querySelectorAll(".subtab[data-sub]").forEach((b) => b.addEventListener("click", () => showSub(b.dataset.sub)));
  $("helpBtn").addEventListener("click", () => { const h = $("help"); h.hidden = !h.hidden; $("helpBtn").textContent = h.hidden ? "How to use ▾" : "How to use ▴"; setTimeout(() => map.invalidateSize(), 50); });
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("dlPoint").addEventListener("click", downloadPoint);
  $("dlMapPng").addEventListener("click", downloadMapPng);
  $("dlGrid").addEventListener("click", downloadGrid);
  $("dlStats").addEventListener("click", downloadStats);
  $("dlStorage").addEventListener("click", downloadStorage);
  $("scope").addEventListener("change", drawSummary);
}

// ================================================================ tabs
let summaryDirty = true;
async function showTab(t) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  document.querySelectorAll(".tabpanel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t));
  if (t !== "map") stopPlay();
  if (t === "map") setTimeout(() => map.invalidateSize(), 30);
  if (t === "summary") await drawSummary();
  if (t === "storage") await drawStorage();
  if (t === "report") await drawReport();
  window.dispatchEvent(new Event("resize"));
}

// ================================================================ basin summary (8 panels)
const STATS = [["mean", "Mean"], ["q1", "Q1 (25th percentile)"], ["median", "Median (Q2)"], ["q3", "Q3 (75th percentile)"]];
async function ensureStats() {
  if (!App.stats) App.stats = await fetchJSON("stats.json.gz");
  const sel = $("scope");
  if (!sel.options.length) sel.innerHTML = App.stats.scopes.map((s) => `<option>${s}</option>`).join("");
}
async function drawSummary() {
  const t0 = performance.now();
  await ensureStats();
  const Plotly = await plotlyReady();
  const scope = $("scope").value, u = uf(), ul = unitLabel(), D = App.stats.data[scope];
  const traces = [], shapes = [], ann = [], layout = {};
  const gx = 0.045, gy = 0.16;
  // shared y range per row (desktop: sharey="row"), from all four statistics of both aquifers
  const rowRange = {};
  for (const q of ["head", "change"]) {
    let lo = Infinity, hi = -Infinity;
    for (const aq of ["confined", "unconfined"]) for (const [k] of STATS) for (const v of D[aq][q][k]) if (v !== null) { lo = Math.min(lo, v * u); hi = Math.max(hi, v * u); }
    const pad = 0.05 * (hi - lo || 1); rowRange[q] = [lo - pad, hi + pad];
  }
  STATS.forEach(([key, label], c) => {
    [["head", 0], ["change", 1]].forEach(([q, r]) => {
      const n = r * 4 + c + 1, xa = n === 1 ? "x" : "x" + n, ya = n === 1 ? "y" : "y" + n;
      const x0 = c / 4 + (c ? gx / 2 : 0), x1 = (c + 1) / 4 - (c < 3 ? gx / 2 : 0);
      const y1 = r === 0 ? 1 : 0.5 - gy / 2, y0 = r === 0 ? 0.5 + gy / 2 : 0;
      layout["xaxis" + (n === 1 ? "" : n)] = { domain: [x0, x1], anchor: ya, matches: n === 1 ? undefined : "x", range: [1971, 2023], gridcolor: "#eceff1",
        title: r === 1 ? { text: "Year", font: { size: 11.5 } } : undefined, showticklabels: true };
      layout["yaxis" + (n === 1 ? "" : n)] = { domain: [y0, y1], anchor: xa, gridcolor: "#eceff1", zeroline: false,
        range: rowRange[q], autorange: false,
        title: c === 0 ? { text: r === 0 ? `Absolute head (${ul})` : `Change since 1971 (${ul})`, font: { size: 12 } } : undefined };
      for (const aq of ["confined", "unconfined"]) {
        const d = D[aq][q];
        traces.push({ x: d.year, y: d[key].map((v) => (v === null ? null : v * u)), xaxis: xa, yaxis: ya, mode: "lines",
          name: `${AQ[aq]} aquifer`, legendgroup: aq, showlegend: n === 1,
          line: { color: COLORS[AQ[aq]], width: 2, dash: aq === "confined" ? "solid" : "dash" },
          hovertemplate: `%{x}: %{y:.1f} ${ul}<extra>${AQ[aq]} · ${label}</extra>` });
      }
      shapes.push(...droughtShapes(xa, ya + " domain"));
      if (r === 1) shapes.push({ type: "line", xref: xa + " domain", yref: ya, x0: 0, x1: 1, y0: 0, y1: 0, line: { color: MUTED, width: 0.8 } });
      ann.push({ text: label, x: (x0 + x1) / 2, y: y1 + 0.012, xref: "paper", yref: "paper", xanchor: "center", yanchor: "bottom", showarrow: false, font: { size: 12.5 } });
    });
  });
  traces.push({ x: [null], y: [null], mode: "markers", name: "Drought period", marker: { symbol: "square", size: 12, color: "rgba(140,140,140,0.35)" }, hoverinfo: "skip" });
  ann.push({ text: `Groundwater head statistics, 1971–2023: ${scope}`, x: 0.5, y: 1.09, xref: "paper", yref: "paper", showarrow: false, font: { size: 15 } });
  Object.assign(layout, { annotations: ann, shapes, margin: { l: 62, r: 14, t: 64, b: 44 }, hovermode: "closest",
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: -0.1 }, paper_bgcolor: "#fff", plot_bgcolor: "#fff",
    font: { family: "Segoe UI, Helvetica Neue, Arial", color: INK, size: 11.5 } });
  await Plotly.react($("summaryPlot"), traces, layout, { ...PLOT_CFG, toImageButtonOptions: { format: "png", scale: 2, filename: `basin_summary_${scope.replace(/\W+/g, "_")}` } });
  const nc = Math.max(...D.confined.head.n_valid_cells), nu = Math.max(...D.unconfined.head.n_valid_cells);
  const sc = scope === "Entire raster domain" ? "all valid raster cells" : `raster cells whose centre lies inside the ${scope} subbasin`;
  $("summaryNote").textContent = `Top row: absolute head. Bottom row: head(year) − head(1971); negative = decline. Each statistic is taken across ${sc} every year (${nc.toLocaleString()} confined, ${nu.toLocaleString()} unconfined cells of 500 m), so Q1 and Q3 describe the spread of values across the area, not uncertainty. Solid blue = confined, dashed orange = unconfined; grey bands = drought periods.`;
  summaryDirty = false;
  App.timing.lastSummary = performance.now() - t0;
}

// ================================================================ storage (desktop v3 storage tab)
const CONF = COLORS.Confined, UNC = COLORS.Unconfined, MATRIX = "#0B2E59", TOTAL = "#3A3F44";
async function ensureStorage() {
  if (!App.storage) App.storage = await fetchJSON("storage.json.gz");
  return App.storage;
}
function sv(k, y) { const S = App.storage, i = S.years.indexOf(y); const c = S.components[k]; return c && i >= 0 && c.values[i] !== null ? c.values[i] : NaN; }
const confTot = (y) => sv("water", y) + sv("matrix", y);
const combTot = (y, k = "sy") => confTot(y) + sv(k, y);
const km3 = (v, d = 3) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)} km³` : "Not available");
async function drawStorage() {
  await ensureStorage();
  const Plotly = await plotlyReady();
  const S = App.storage, yrs = S.years, y = +$("sYear").value;
  // cards
  const card = (t, v, n, d = 3) => `<div class="scard"><div class="t">${t}</div><div class="v ${v < 0 ? "loss" : ""}">${typeof v === "number" ? km3(v, d) : v}</div><div class="n">${n}</div></div>`;
  const lo = sv("sy01", y), hi = sv("sy03", y), [a, b] = [Math.min(lo, hi), Math.max(lo, hi)];
  const ta = Math.min(combTot(y, "sy01"), combTot(y, "sy03")), tb = Math.max(combTot(y, "sy01"), combTot(y, "sy03"));
  $("sCards").innerHTML = `<div class="scard"><div class="t">Selected year</div><div class="v">${y}</div><div class="n">change ${S.baseline}–${y}</div></div>` +
    card("Confined: water expansion", sv("water", y), `since ${S.baseline}`) + card("Confined: matrix compaction", sv("matrix", y), `since ${S.baseline}`) +
    card("Confined total", confTot(y), "water + matrix") +
    card("Unconfined (spatial Sy)", sv("sy", y), `range ${a >= 0 ? "+" : ""}${a.toFixed(2)} to ${b >= 0 ? "+" : ""}${b.toFixed(2)} (Sy 0.1–0.3)`, 2) +
    card("Combined total", combTot(y), `range ${ta >= 0 ? "+" : ""}${ta.toFixed(2)} to ${tb >= 0 ? "+" : ""}${tb.toFixed(2)}`, 2);
  // time series
  const V = (k) => yrs.map((yy) => sv(k, yy));
  const ts = [
    { x: yrs, y: V("sy01"), mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip", xaxis: "x", yaxis: "y" },
    { x: yrs, y: V("sy03"), mode: "lines", fill: "tonexty", fillcolor: "rgba(238,122,18,0.2)", line: { width: 0 }, name: "Sy 0.1–0.3 scenario range", hoverinfo: "skip", xaxis: "x", yaxis: "y" },
    { x: yrs, y: V("sy"), mode: "lines+markers", name: "Unconfined: spatially varying Sy", line: { color: UNC, width: 2.4 }, marker: { size: 6 }, xaxis: "x", yaxis: "y", hovertemplate: "%{x}: %{y:+.3f} km³<extra>Unconfined (spatial Sy)</extra>" },
    { x: yrs, y: V("water"), mode: "lines+markers", name: "Confined: water expansion", line: { color: CONF, width: 2 }, marker: { size: 6 }, xaxis: "x2", yaxis: "y2", hovertemplate: "%{x}: %{y:+.3f} km³<extra>Water expansion</extra>" },
    { x: yrs, y: V("matrix"), mode: "lines+markers", name: "Confined: matrix compaction", line: { color: MATRIX, width: 2, dash: "dash" }, marker: { size: 6, symbol: "square" }, xaxis: "x2", yaxis: "y2", hovertemplate: "%{x}: %{y:+.3f} km³<extra>Matrix compaction</extra>" },
    { x: yrs, y: yrs.map(confTot), mode: "lines", name: "Confined total", line: { color: TOTAL, width: 2.6 }, xaxis: "x2", yaxis: "y2", hovertemplate: "%{x}: %{y:+.3f} km³<extra>Confined total</extra>" },
    { x: [null], y: [null], mode: "markers", name: "Drought period", marker: { symbol: "square", size: 12, color: "rgba(140,140,140,0.35)" }, hoverinfo: "skip" },
  ];
  const sh = [...droughtShapes("x", "y domain", 2015, 2023), ...droughtShapes("x2", "y2 domain", 2015, 2023),
    { type: "line", xref: "x", yref: "y domain", x0: y, x1: y, y0: 0, y1: 1, line: { color: "#1D6A8F", width: 1.4 } },
    { type: "line", xref: "x2", yref: "y2 domain", x0: y, x1: y, y0: 0, y1: 1, line: { color: "#1D6A8F", width: 1.4 } },
    { type: "line", xref: "x domain", yref: "y", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: MUTED, width: 0.8 } },
    { type: "line", xref: "x2 domain", yref: "y2", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: MUTED, width: 0.8 } }];
  const base = { paper_bgcolor: "#fff", plot_bgcolor: "#fff", font: { family: "Segoe UI, Helvetica Neue, Arial", color: INK, size: 11.5 } };
  await Plotly.react($("sSeries"), ts, { ...base, shapes: sh, hovermode: "x unified", margin: { l: 60, r: 12, t: 30, b: 40 },
    xaxis: { domain: [0, 1], anchor: "y", matches: "x2", showticklabels: false, gridcolor: "#eceff1" },
    yaxis: { domain: [0.56, 1], title: { text: "Signed change (km³)" }, gridcolor: "#eceff1", zeroline: false },
    xaxis2: { domain: [0, 1], anchor: "y2", dtick: 1, title: { text: "Year (click to select)" }, gridcolor: "#eceff1" },
    yaxis2: { domain: [0, 0.44], title: { text: "Signed change (km³)" }, gridcolor: "#eceff1", zeroline: false },
    annotations: [{ text: `<span style="color:${UNC}">Unconfined storage change since ${S.baseline}</span>`, x: 0.5, y: 1.04, xref: "paper", yref: "paper", showarrow: false, font: { size: 13 } },
      { text: `<span style="color:${CONF}">Confined storage change since ${S.baseline}</span>`, x: 0.5, y: 0.475, xref: "paper", yref: "paper", showarrow: false, font: { size: 13 } }],
    legend: { orientation: "h", y: -0.14, font: { size: 10.5 } } }, { ...PLOT_CFG, toImageButtonOptions: { format: "png", scale: 2, filename: `storage_change_2015_2023_time_series` } });
  const sEl = $("sSeries");
  if (!sEl._bound) { sEl.on("plotly_click", (ev) => { const xx = Math.round(ev.points[0].x); if (yrs.includes(xx)) setStorageYear(xx); }); sEl._bound = true; }
  // bar chart
  const rows = [
    ["Confined<br>water expansion", sv("water", y), CONF, null], ["Confined<br>matrix compaction", sv("matrix", y), MATRIX, null],
    ["Confined total", confTot(y), CONF, null], ["Unconfined<br>(spatial Sy)", sv("sy", y), UNC, [sv("sy01", y), sv("sy03", y)]],
    ["Combined total", combTot(y), TOTAL, [combTot(y, "sy01"), combTot(y, "sy03")]]].reverse();
  const lab = (r) => `${r[0]}<br><b>${r[1] >= 0 ? "+" : ""}${r[1].toFixed(2)} km³</b>`;
  const bar = { type: "bar", orientation: "h", y: rows.map(lab), x: rows.map((r) => r[1]), marker: { color: rows.map((r) => r[2]), pattern: { shape: rows.map((r) => (r[0] === "Confined total" ? "/" : "")) } },
    error_x: { type: "data", symmetric: false, color: INK, thickness: 1.3, width: 6,
      array: rows.map((r) => (r[3] ? Math.max(...r[3]) - r[1] : 0)), arrayminus: rows.map((r) => (r[3] ? r[1] - Math.min(...r[3]) : 0)) },
    hovertemplate: "%{y}: %{x:+.3f} km³<extra></extra>" };
  await Plotly.react($("sBar"), [bar], { ...base, title: { text: `Storage change, ${S.baseline}–${y}`, font: { size: 13.5 } }, margin: { l: 140, r: 30, t: 40, b: 50 },
    xaxis: { title: { text: "Signed storage change (km³); negative = decrease" }, zeroline: true, zerolinecolor: MUTED, gridcolor: "#eceff1" },
    annotations: [{ text: "Whiskers: Sy = 0.1 to Sy = 0.3", x: 1, y: 0, xref: "paper", yref: "paper", xanchor: "right", yanchor: "bottom", showarrow: false, font: { size: 10.5, color: MUTED } }] },
    { ...PLOT_CFG, toImageButtonOptions: { format: "png", scale: 2, filename: `storage_change_${S.baseline}_${y}_components` } });
  // table
  const cols = [["Year", (yy) => yy], ["Confined water", (yy) => sv("water", yy)], ["Confined matrix", (yy) => sv("matrix", yy)], ["Confined total", confTot],
    ["Unconfined (spatial Sy)", (yy) => sv("sy", yy)], ["Unconfined Sy 0.1", (yy) => sv("sy01", yy)], ["Unconfined Sy 0.3", (yy) => sv("sy03", yy)], ["Combined total", (yy) => combTot(yy)]];
  $("sTable").innerHTML = `<tr>${cols.map(([h], i) => `<th>${h}${i ? " (km³)" : ""}</th>`).join("")}</tr>` + yrs.map((yy) =>
    `<tr data-y="${yy}" class="${yy === y ? "sel" : ""}">${cols.map(([, f], i) => { const v = f(yy); return i ? `<td class="${v < 0 ? "neg" : ""}">${v >= 0 ? "+" : ""}${v.toFixed(4)}</td>` : `<td>${v}</td>`; }).join("")}</tr>`).join("");
  $("sTable").querySelectorAll("tr[data-y]").forEach((tr) => tr.addEventListener("click", () => setStorageYear(+tr.dataset.y)));
}
function setStorageYear(y) { $("sYear").value = y; $("sYearNum").value = y; drawStorage(); }
let sTimer = null;
function bindStorage() {
  $("sYear").addEventListener("input", () => setStorageYear(+$("sYear").value));
  $("sYearNum").addEventListener("change", () => setStorageYear(Math.max(2015, Math.min(2023, +$("sYearNum").value))));
  $("sPlay").addEventListener("click", () => {
    if (sTimer) { clearInterval(sTimer); sTimer = null; $("sPlay").textContent = "▶ Play"; return; }
    $("sPlay").textContent = "❚❚ Pause";
    sTimer = setInterval(() => { let y = +$("sYear").value + 1; if (y > 2023) y = 2015; setStorageYear(y); }, 900);
  });
  document.querySelectorAll(".subtab[data-ssub]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".subtab[data-ssub]").forEach((x) => x.classList.toggle("active", x === b));
    $("ssub-bar").classList.toggle("active", b.dataset.ssub === "bar");
    $("ssub-table").classList.toggle("active", b.dataset.ssub === "table");
    window.dispatchEvent(new Event("resize"));
  }));
}

// ================================================================ data report
async function drawReport() {
  if ($("report").dataset.done) return;
  const rows = await fetchJSON("report.json.gz");
  let h = `<h2 style="font-weight:500;margin:4px 0">Files, grids, units and checks</h2><p class="hint">Produced by the same checks the desktop application runs, during the web data build.</p>`;
  let sec = null;
  for (const [s, k, v] of rows) { if (s !== sec) { h += (sec ? "</table>" : "") + `<h3>${s}</h3><table>`; sec = s; } h += `<tr><td class="k">${k}</td><td>${v}</td></tr>`; }
  $("report").innerHTML = h + "</table>"; $("report").dataset.done = "1";
}

// ================================================================ downloads
function save(name, text, type = "text/csv") {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function downloadPoint() {
  const c = App.click; if (!c) return alert("Click a point on the map first.");
  const u = uf(), ul = unitLabel(), Y = App.meta.years;
  const head = ["year", "easting_m", "northing_m", "subbasin", `confined_surface_head_${ul}`, `unconfined_surface_head_${ul}`];
  let o = null, wid = null;
  if (App.sel !== null) { wid = App.wells[App.sel].id; o = App.obs[wid]; head.push(`well_${wid}_observed_gwe_${ul}`, `well_${wid}_depth_to_water_${ul}`); }
  const r4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : "");
  const rows = Y.map((yy, j) => {
    const row = [yy, c.x.toFixed(4), c.y.toFixed(4), c.basin ? c.basin.short_name : "Outside mapped subbasins",
      r4(c.series.confined[j] * u), r4(c.series.unconfined[j] * u)];
    if (o) { const k = o[0].indexOf(yy); row.push(k >= 0 && o[1][k] !== null ? r4(o[1][k] * u) : "", k >= 0 && o[2][k] !== null ? r4(o[2][k] * u) : ""); }
    return row;
  });
  save(`point_E${Math.round(c.x)}_N${Math.round(c.y)}.csv`, TC.csv(rows, head));
}
function slug() {
  const s = st(), aq = s.aquifer, ul = unitLabel();
  if (s.product === "cumulative") return `${aq}_cumulative_change_${s.base}_${s.year}_${ul}`;
  if (s.product === "sum") return `${aq}_provided_cumulative_change_1971_2023_${ul}`;
  return `${aq}_absolute_head_${s.year}_${ul}`;
}
function downloadGrid() {
  const c = App.current; if (!c) return;
  const g = App.meta.grids[c.gkey];
  const lines = [`ncols ${g.cols}`, `nrows ${g.rows}`, `xllcorner ${g.c}`, `yllcorner ${g.f + g.e * g.rows}`, `cellsize ${g.a}`, `NODATA_value -9999`];
  for (let r = 0; r < g.rows; r++) {
    const vals = new Array(g.cols);
    for (let k = 0; k < g.cols; k++) { const v = c.disp[r * g.cols + k]; vals[k] = v === v ? String(+v.toPrecision(9)) : "-9999"; }
    lines.push(vals.join(" "));
  }
  save(slug() + ".asc", lines.join("\n") + "\n", "text/plain");
  if (App.meta.prj_wkt) setTimeout(() => save(slug() + ".prj", App.meta.prj_wkt, "text/plain"), 400);
}
function downloadMapPng() {
  const c = App.current; if (!c || !canvas) return;
  const W = canvas.width + 170, H = canvas.height + 60, out = document.createElement("canvas");
  out.width = W; out.height = H; const x = out.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = INK; x.font = "16px Segoe UI, Arial"; x.textAlign = "center"; x.fillText(c.title, canvas.width / 2 + 10, 26);
  x.drawImage(canvas, 10, 40);
  const lut = App.meta.cmaps[st().cmap], bx = canvas.width + 30, by = 60, bh = canvas.height - 60;
  for (let i = 0; i < bh; i++) { const k = Math.floor((1 - i / (bh - 1)) * 255); x.fillStyle = `rgb(${lut[k]})`; x.fillRect(bx, by + i, 18, 1); }
  x.strokeStyle = "#999"; x.strokeRect(bx, by, 18, bh); x.textAlign = "left"; x.font = "12px Segoe UI, Arial"; x.fillStyle = INK;
  for (const t of niceTicks(c.lo, c.hi, 7)) x.fillText(fmt(t, Math.abs(c.hi - c.lo) < 10 ? 1 : 0), bx + 24, by + (1 - (t - c.lo) / (c.hi - c.lo)) * bh + 4);
  x.save(); x.translate(W - 12, by + bh / 2); x.rotate(-Math.PI / 2); x.textAlign = "center"; x.fillText(c.label, 0, 0); x.restore();
  x.fillStyle = MUTED; x.font = "11px Segoe UI, Arial"; x.textAlign = "left"; x.fillText("Tulare Basin Groundwater Explorer · Web-Mercator display of the original 500 m grid", 10, H - 8);
  out.toBlob((b) => save(slug() + ".png", b), "image/png");
}
async function downloadStats() {
  await ensureStats();
  const scope = $("scope").value, u = uf(), ul = unitLabel(), D = App.stats.data[scope], rows = [];
  const basis = scope === "Entire raster domain" ? "valid 500 m raster cells (all cells)" : "valid 500 m raster cells with centre inside the subbasin polygon";
  for (const aq of ["confined", "unconfined"]) for (const [q, qn, b] of [["head", "absolute_head", ""], ["change", "cumulative_change_since_1971", 1971]]) {
    const d = D[aq][q];
    d.year.forEach((yy, i) => rows.push([scope, AQ[aq], qn, yy, ...["mean", "q1", "median", "q3"].map((k) => (d[k][i] === null ? "" : (d[k][i] * u).toFixed(4))), d.n_valid_cells[i], ul, b, basis]));
  }
  save(`basin_head_statistics_${scope.toLowerCase().replace(/\W+/g, "_")}_${ul}.csv`, TC.csv(rows,
    ["scope", "aquifer", "quantity", "year", "mean", "q1_25th_percentile", "median_q2_50th_percentile", "q3_75th_percentile", "n_valid_cells", "units", "baseline_year", "statistic_basis"]));
}
async function downloadStorage() {
  await ensureStorage();
  const S = App.storage, f = (v) => (Number.isFinite(v) ? v.toFixed(6) : "");
  const rows = S.years.map((y) => [y, f(sv("water", y)), f(sv("matrix", y)), f(confTot(y)), f(sv("sy", y)), f(sv("sy01", y)), f(sv("sy03", y)),
    f(combTot(y)), f(combTot(y, "sy01")), f(combTot(y, "sy03")), S.baseline, "signed storage change since 2015; negative = storage decrease"]);
  save("storage_change_2015_2023.csv", TC.csv(rows, ["year", "confined_water_expansion_km3", "confined_matrix_compaction_km3", "confined_total_km3",
    "unconfined_spatial_sy_km3", "unconfined_sy_0_1_km3", "unconfined_sy_0_3_km3", "combined_total_spatial_sy_km3", "combined_total_sy_0_1_km3",
    "combined_total_sy_0_3_km3", "baseline_year", "sign_convention"]));
}

// ================================================================ start-up
async function start() {
  const t0 = performance.now();
  try {
    $("loadingText").textContent = "Loading map data…";
    App.meta = await fetchJSON("meta.json.gz");
    proj4.defs("TULARE_ALBERS", App.meta.proj4);
    App.meta.proj4 = "TULARE_ALBERS";
    [App.limits, App.basins] = await Promise.all([fetchJSON("limits.json.gz"), fetchJSON("basins.json.gz").catch(() => null)]);
    initMap(); bindControls(); bindStorage(); updateTimeControls(); syncClasses();
    await drawRaster();
    drawBasins();
    $("loading").classList.add("gone");
    App.timing.firstMap = performance.now() - t0;
    // background: wells, then observations
    App.wells = await fetchJSON("wells.json.gz");
    const obs = await fetchJSON("obs.json.gz");
    App.obs = obs;
    const n = App.meta.years.length, Y0 = App.meta.first_year;
    App.obsG = []; App.obsD = [];
    for (const w of App.wells) {
      const g = new Float64Array(n).fill(NaN), d = new Float64Array(n).fill(NaN), o = obs[w.id];
      if (o) o[0].forEach((yy, k) => { if (o[1][k] !== null) g[yy - Y0] = o[1][k]; if (o[2][k] !== null) d[yy - Y0] = o[2][k]; });
      App.obsG[w.i] = g; App.obsD[w.i] = d;
    }
    drawWells();
    App.timing.wellsReady = performance.now() - t0;
    App.ready = true;
    // warm caches quietly
    setTimeout(() => { ensureStats(); ensureStorage(); cells("unconfined"); }, 1500);
  } catch (e) {
    console.error(e);
    $("loadingText").innerHTML = `<b>Sorry, the app could not load.</b><br>${e.message}<br><br>If you opened index.html directly from your disk, run a local web server instead (see README).`;
    document.querySelector(".spinner").style.display = "none";
  }
}
start();
})();
