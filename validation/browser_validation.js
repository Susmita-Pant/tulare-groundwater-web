/* Drives the real web app in headless Chromium and compares what it shows with
 * reference values computed by the desktop version 3 code (reference.json).
 *
 *   node validation/browser_validation.js http://localhost:8000/ [screenshot_dir]
 *
 * Needs: npm install puppeteer-core @sparticuz/chromium   (or set CHROME_PATH)
 */
const fs = require("fs"), path = require("path");
const puppeteer = require("puppeteer-core");
const URL = process.argv[2] || "http://localhost:8000/";
const SHOTS = process.argv[3] || null;
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference.json")));
const results = []; let failed = 0;
const check = (name, ok, detail = "") => { results.push(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failed++; };
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));

(async () => {
  let exe = process.env.CHROME_PATH, args = ["--window-size=1600,1000"];
  if (!exe) { const chromium = require("@sparticuz/chromium"); exe = await chromium.executablePath(); args = [...chromium.args, ...args]; }
  const browser = await puppeteer.launch({ executablePath: exe, args, headless: true, defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET/.test(m.text())) errors.push(m.text()); });
  const shot = async (n) => { if (SHOTS) { await new Promise((r) => setTimeout(r, 700)); await page.screenshot({ path: path.join(SHOTS, n) }); } };
  const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 120)));
  const setCtl = async (id, value) => {
    await page.evaluate((id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event(el.type === "range" ? "input" : "change")); }, id, String(value));
    await page.waitForFunction(() => document.getElementById("busy").style.display === "none", { timeout: 30000 }); await settle();
  };

  // ---------------------------------------------------------------- load
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.TulareApp && TulareApp.ready, { timeout: 60000 });
  const timing = await page.evaluate(() => TulareApp.timing);
  results.push(`TIMING first map ${timing.firstMap.toFixed(0)} ms, wells+observations ready ${timing.wellsReady.toFixed(0)} ms (local server)`);
  await shot("01_start.png");

  // ---------------------------------------------------------------- points (exact cells)
  for (const [name, P] of Object.entries(ref.points)) {
    const t = Date.now();
    process.stderr.write(`point ${name}\n`);
    const got = await page.evaluate(async (P) => {
      if (P.well_index !== null) await TulareApp.selectWell(P.well_index);
      else await TulareApp.selectPoint({ lat: P.lat, lng: P.lon }, null);
      const c = TulareApp.click;
      if (!c || !c.series) throw new Error("selection did not complete: " + JSON.stringify(Object.keys(c || {})));
      const toNum = (a) => Array.from(a, (v) => (Number.isFinite(v) ? v : null));
      const near = (() => { const R = 3000, out = []; for (const w of TulareApp.wells) { if (!w.n_obs) continue; const d = Math.hypot(w.x - c.x, w.y - c.y); if (d <= R) out.push([w.id, d]); } return out.sort((a, b) => a[1] - b[1]).slice(0, 40).map((v) => v[0]); })();
      const sums = {};
      for (const aq of ["confined", "unconfined"]) { const g = TulareApp.meta.grids["sum_" + aq]; const col = Math.floor((c.x - g.c) / g.a), row = Math.floor((c.y - g.f) / g.e);
        const ok = row >= 0 && row < g.rows && col >= 0 && col < g.cols; sums[aq] = ok && TulareApp.sums[aq] ? TulareApp.sums[aq][row * g.cols + col] : null; }
      return { x: c.x, y: c.y, confined: toNum(c.series.confined), unconfined: toNum(c.series.unconfined), basin: c.basin ? c.basin.short_name : null,
               near, sums, info: document.getElementById("sub-point").innerText };
    }, P);
    const ms = Date.now() - t;
    const dxy = Math.hypot(got.x - P.x, got.y - P.y);
    check(`${name}: click position → Albers`, dxy < 0.01, `${dxy.toExponential(2)} m from the desktop coordinate`);
    for (const aq of ["confined", "unconfined"]) {
      const bad = P[aq].filter((v, j) => (v === null ? got[aq][j] !== null : Math.fround(v) !== got[aq][j])).length;
      check(`${name}: ${aq} 53-year hydrograph equals the desktop series`, bad === 0, `${bad} of 53 differ`);
    }
    check(`${name}: subbasin`, got.basin === P.subbasin, `${got.basin} vs ${P.subbasin}`);
    check(`${name}: nearby wells (≤ 3 km)`, JSON.stringify(got.near) === JSON.stringify(P.nearby_ids), `${got.near.length} wells`);
    for (const aq of ["confined", "unconfined"]) {
      const r = P.sum_ft[aq], g = got.sums[aq];
      check(`${name}: provided 1971–2023 ${aq} value`, r === null ? g === null || Number.isNaN(g) : Math.abs(g - r) < 1e-4, `${g} vs ${r}`);
    }
    results.push(`TIMING ${name}: click → hydrograph + details ${ms} ms`);
  }
  await shot("02_point_hydrograph.png");

  // ---------------------------------------------------------------- map products
  for (const [key, R] of Object.entries(ref.maps)) {
    const [prod, aq, yr, base] = key.split("|");
    for (const units of ["ft", "m"]) {
      await setCtl("units", units);
      await setCtl("product", prod); await setCtl("aquifer", aq);
      if (yr !== "None") await setCtl("yearNum", yr);
      if (base !== "None") await setCtl("base", base);
      const t = Date.now();
      await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 10)); });
      const sm = await page.evaluate(() => { const s = TC.summary(TulareApp.current.disp); return { ...s, title: TulareApp.current.title }; });
      const E = R[units];
      const ok = sm.n === E.n && sm.negative === E.negative && rel(sm.mean, E.mean) < 2e-6 && sm.min === Math.fround(E.min) && sm.max === Math.fround(E.max) && Math.abs(sm.median - E.median) < 1e-4;
      check(`map ${prod} ${aq} ${yr !== "None" ? yr : ""}${base !== "None" ? " base " + base : ""} (${units}): cells, mean, median, min, max, declines`, ok,
        `n ${sm.n}/${E.n}, mean ${sm.mean.toFixed(4)}/${E.mean.toFixed(4)}, median ${sm.median.toFixed(4)}/${E.median.toFixed(4)}`);
    }
  }
  await setCtl("units", "ft");
  // year-switch timing (cached and uncached)
  await setCtl("product", "head"); await setCtl("aquifer", "confined");
  const sw = [];
  for (const y of [2001, 2002, 2003, 2004, 2005]) { const t = Date.now(); await setCtl("yearNum", y); sw.push(Date.now() - t); }
  results.push(`TIMING year switch (first time, includes download): ${sw.join(", ")} ms`);
  const sw2 = [];
  for (const y of [2001, 2002, 2003]) { const t = Date.now(); await setCtl("yearNum", y); sw2.push(Date.now() - t); }
  results.push(`TIMING year switch (already loaded): ${sw2.join(", ")} ms`);
  { const t = Date.now(); await setCtl("aquifer", "unconfined"); results.push(`TIMING aquifer switch to unconfined (first time): ${Date.now() - t} ms`); }
  await setCtl("aquifer", "confined");

  // well profile screenshot
  await setCtl("product", "head"); await setCtl("yearNum", 2004);
  await page.evaluate(async (i) => { await TulareApp.selectWell(i); }, ref.points.well.well_index);
  await settle(); await shot("03_well_profile.png");
  const wp = await page.evaluate(() => document.getElementById("sub-well").innerText);
  check("well profile and card shown for a clicked well", /schematic/.test(wp) && /Station ID/.test(wp));

  // real mouse click on the map selects the cell under the cursor
  const mc = await page.evaluate(() => { const ll = L.latLng(36.0, -119.6); const p = TulareApp.map.latLngToContainerPoint(ll); const r = document.getElementById("map").getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
  await page.mouse.click(mc.x, mc.y); await page.waitForFunction(() => TulareApp.click && Math.abs(TulareApp.click.lat - 36.0) < 0.01, { timeout: 15000 }); await settle();
  const mclick = await page.evaluate(() => ({ lat: TulareApp.click.lat, lon: TulareApp.click.lon, sel: TulareApp.sel }));
  check("real mouse click on the map selects that location", Math.abs(mclick.lat - 36.0) < 0.01 && Math.abs(mclick.lon + 119.6) < 0.01, `${mclick.lat.toFixed(4)}, ${mclick.lon.toFixed(4)}`);

  // cumulative screenshot
  await setCtl("product", "cumulative"); await setCtl("yearNum", 2015); await setCtl("base", 1971); await shot("04_cumulative.png");
  await setCtl("product", "sum"); await shot("05_provided_sum.png");
  const fixedVisible = await page.evaluate(() => !document.getElementById("fixedPeriod").hidden && document.getElementById("timeBox").hidden);
  check("provided 1971–2023 product hides year controls and shows the fixed period", fixedVisible);
  await setCtl("product", "head");

  // ---------------------------------------------------------------- basin summary
  { const t = Date.now(); await page.click('[data-tab="summary"]'); await page.waitForFunction(() => document.querySelector("#summaryPlot .main-svg"), { timeout: 30000 }); await settle();
    results.push(`TIMING Basin summary first draw: ${Date.now() - t} ms`); }
  await shot("06_basin_summary.png");
  let statBad = 0, statN = 0;
  const webStats = await page.evaluate(() => TulareApp.stats.data);
  for (const [scope, S] of Object.entries(ref.stats)) for (const aq of ["confined", "unconfined"]) for (const q of ["head", "change"]) for (const k of ["mean", "q1", "median", "q3"]) {
    S[aq][q][k].forEach((v, i) => { statN++; const w = webStats[scope][aq][q][k][i]; if (v === null ? w !== null : w !== v) statBad++; });
  }
  check("Basin summary statistics equal the desktop values (all scopes, both aquifers, head and change)", statBad === 0, `${statN - statBad}/${statN} values identical`);
  const scopes = await page.evaluate(() => Array.from(document.getElementById("scope").options).map((o) => o.value));
  { const t = Date.now(); await page.select("#scope", scopes[2]); await page.waitForFunction((s) => document.querySelector("#summaryPlot").innerText.includes(s), { timeout: 15000 }, scopes[2]); results.push(`TIMING Basin summary scope switch: ${Date.now() - t} ms`); }
  await shot("07_basin_summary_subbasin.png");
  const panels = await page.evaluate(() => document.querySelectorAll("#summaryPlot .cartesianlayer .subplot").length);
  check("Basin summary has eight panels", panels === 8, `${panels}`);

  // ---------------------------------------------------------------- storage
  { const t = Date.now(); await page.click('[data-tab="storage"]'); await page.waitForFunction(() => document.querySelector("#sBar .main-svg"), { timeout: 30000 }); await settle(); results.push(`TIMING Storage tab first draw: ${Date.now() - t} ms`); }
  await shot("08_storage.png");
  const sto = await page.evaluate(() => { const S = TulareApp.storage, o = {}; S.years.forEach((y, i) => { const g = (k) => S.components[k].values[i]; o[y] = { water: g("water"), matrix: g("matrix"), sy: g("sy"), sy01: g("sy01"), sy03: g("sy03"), confined_total: g("water") + g("matrix"), combined: g("water") + g("matrix") + g("sy") }; }); return { o, cards: document.getElementById("sCards").innerText }; });
  let sbad = 0; for (const [y, R] of Object.entries(ref.storage)) for (const k of ["water", "matrix", "sy", "sy01", "sy03", "confined_total", "combined"]) if (Math.abs(sto.o[y][k] - R[k]) > 1e-12) sbad++;
  check("Storage values and totals equal the desktop values (2015–2023)", sbad === 0, `${sbad} differences`);
  check("Storage cards show 2023 combined total −11.57 km³", /-11\.57 km³/.test(sto.cards));
  await page.click('[data-ssub="table"]'); await settle(); await shot("09_storage_table.png");

  // ---------------------------------------------------------------- report + help
  await page.click('[data-tab="report"]'); await page.waitForFunction(() => document.getElementById("report").dataset.done === "1"); await shot("10_data_report.png");
  await page.click('[data-tab="map"]'); await page.click("#helpBtn"); await settle(); await shot("11_how_to_use.png");
  await page.click("#helpBtn");

  // ---------------------------------------------------------------- narrow screen
  await page.setViewport({ width: 1100, height: 900 }); await settle(); await shot("12_laptop_1100px.png");

  check("no JavaScript errors during the session", errors.length === 0, errors.slice(0, 3).join(" | "));
  const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null));
  if (mem) results.push(`MEMORY JavaScript heap after the full session: ${mem} MB`);
  await browser.close();
  console.log(results.join("\n"));
  console.log(`\n${results.filter((r) => r.startsWith("[PASS")).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
