/* Tulare Basin groundwater explorer: core logic (no user interface).
 *
 * Works in the browser (window.TC) and in Node (module.exports) so that the
 * calculations can be tested on their own. All formulas mirror the desktop
 * version 3 code (tulare_explorer/data.py and the main window).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TC = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const M_PER_FT = 0.3048;
  const F32_M_PER_FT = Math.fround(M_PER_FT);

  // ------------------------------------------------------------ decoding
  async function gunzip(buf) {
    if (typeof DecompressionStream === "undefined") {
      if (typeof require === "function") return require("zlib").gunzipSync(Buffer.from(buf)).buffer;
      throw new Error("This browser cannot decompress data. Please use a recent Chrome, Edge, Firefox or Safari.");
    }
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }

  /** Undo the build's lossless byte-shuffle and return the original float32 values. */
  function unshuffleF32(buf) {
    const src = new Uint8Array(buf);
    const n = src.length / 4;
    const out = new Uint8Array(src.length);
    for (let k = 0; k < 4; k++) {
      const off = k * n;
      for (let i = 0; i < n; i++) out[i * 4 + k] = src[off + i];
    }
    return new Float32Array(out.buffer);
  }

  // ------------------------------------------------------------ grids
  /** Same rule as Grid.rowcol in data.py: floor((x - c) / a), floor((y - f) / e). */
  function rowcol(g, x, y) {
    const col = Math.floor((x - g.c) / g.a);
    const row = Math.floor((y - g.f) / g.e);
    const ok = row >= 0 && row < g.rows && col >= 0 && col < g.cols;
    return { row, col, ok, index: ok ? row * g.cols + col : -1 };
  }

  /** Expand a year file (values for 'cells' only) to a full grid with NaN elsewhere. */
  function expand(cells, values, size) {
    const full = new Float32Array(size).fill(NaN);
    for (let i = 0; i < cells.length; i++) full[cells[i]] = values[i];
    return full;
  }

  /** head(year) - head(base) in float32, NaN wherever either is missing (desktop HeadStack.change). */
  function difference(a, b) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = b[i] - a[i];
    return out;
  }

  /** Unit conversion that reproduces numpy's float32 * 0.3048. */
  function toUnits(v, metres) {
    return metres ? Math.fround(v * F32_M_PER_FT) : v;
  }

  // ------------------------------------------------------------ statistics
  function finiteSorted(arr) {
    const v = [];
    for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) v.push(arr[i]);
    return Float64Array.from(v).sort();
  }

  /** numpy.percentile (default "linear" method) on a sorted array. */
  function percentileSorted(s, p) {
    if (!s.length) return NaN;
    const pos = (p / 100) * (s.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  /** Same as robust_limits in the desktop app. */
  function robustLimits(arr, robust, symmetric) {
    const s = finiteSorted(arr);
    if (!s.length) return [-1, 1];
    let lo = robust ? percentileSorted(s, 2) : s[0];
    let hi = robust ? percentileSorted(s, 98) : s[s.length - 1];
    if (symmetric) {
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return [-m, m];
    }
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }

  function summary(arr) {
    const s = finiteSorted(arr);
    if (!s.length) return null;
    let sum = 0, neg = 0;
    for (const v of s) { sum += v; if (v < 0) neg++; }
    return { n: s.length, mean: sum / s.length, median: percentileSorted(s, 50),
             min: s[0], max: s[s.length - 1], negative: neg };
  }

  // ------------------------------------------------------------ geometry
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(x, y, poly) {
    if (!pointInRing(x, y, poly[0])) return false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(x, y, poly[h])) return false;
    return true;
  }

  /** Subbasin feature containing lon/lat, or null. */
  function findBasin(features, lon, lat) {
    for (const f of features) {
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const p of polys) if (pointInPolygon(lon, lat, p)) return f.properties;
    }
    return null;
  }

  // ------------------------------------------------------------ CSV
  function csv(rows, header) {
    const esc = (v) => {
      if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [header.map(esc).join(",")].concat(rows.map((r) => r.map(esc).join(","))).join("\n") + "\n";
  }

  return { M_PER_FT, gunzip, unshuffleF32, rowcol, expand, difference, toUnits,
           finiteSorted, percentileSorted, robustLimits, summary, pointInPolygon, findBasin, csv };
});
