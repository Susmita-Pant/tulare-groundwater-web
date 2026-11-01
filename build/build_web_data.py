# -*- coding: utf-8 -*-
"""
Build the web app's data folder from the original Tulare Basin project data.

    python build/build_web_data.py --src "C:/path/to/analysis/total_wells"

Every number shipped to the browser is computed by the same version 3 science
code the desktop app uses (build/tulare_explorer/data.py and storage.py), and
raster values are stored LOSSLESSLY as the original float32 bits:

* head_<aq>_<year>.bin.gz   one year of heads for every cell that is valid in any
                            year (year files: used to draw maps)
* blk_<aq>_<r>_<c>.bin.gz   all 53 years for a 32 × 32-cell block (used when a
                            point is clicked, so a click downloads only ~100 KB)
* sum_<aq>.bin.gz           provided 1971–2023 cumulative change (metres, as stored)
* look_<grid>.bin.gz        display look-up: which raster cell each pixel of the
                            Web-Mercator display image shows (drawing only;
                            analysis always uses the original grid)
* stats.json                Basin Summary statistics for every scope (year_stats)
* limits.json               fixed colour ranges, exactly as the desktop computes them
* wells.json / obs.json     well metadata, screens, Corcoran reference, observations
* basins.geojson            subbasin outlines (WGS84 for the web map)
* storage.json              2015–2023 regional storage totals from the workbook
* report.json               the desktop Data Report rows plus web notes
* meta.json                 grids, CRS, years, colour maps, file index

Float arrays are byte-shuffled before gzip (lossless; it only reorders bytes so
gzip compresses better). The browser un-shuffles them.
"""

import argparse
import gzip
import json
import math
import sys
import time
import warnings
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tulare_explorer.config import (FIRST_YEAR, LAST_YEAR, FT_PER_M, AQUIFERS,  # noqa: E402
                                    CLASS_COLORS, SURFACE_COLORS, DROUGHT_PERIODS, PRODUCTS)
from tulare_explorer.data import Dataset, find_data_root, proj4_text  # noqa: E402
from tulare_explorer.storage import StorageData, COMPONENTS  # noqa: E402

BLOCK = 32
DISPLAY_WIDTH = 900          # pixels across the display image (drawing only)
CMAPS = ["viridis", "cividis", "YlGnBu", "magma", "Blues", "RdBu", "PuOr", "BrBG", "coolwarm"]


# --------------------------------------------------------------------------- helpers
def shuffle_f32(arr):
    """Lossless byte-shuffle of little-endian float32 values."""
    b = np.ascontiguousarray(arr, dtype="<f4").view(np.uint8).reshape(-1, 4)
    return b.T.copy().tobytes()


def write_gz(path, payload):
    # mtime=0 keeps the files byte-identical between builds (clean Git diffs)
    with open(path, "wb") as fh, gzip.GzipFile(fileobj=fh, mode="wb", compresslevel=9, mtime=0) as f:
        f.write(payload)
    return path.stat().st_size


def robust_limits(values, robust=True, symmetric=False):
    """Identical to tulare_explorer.widgets.robust_limits in the desktop app."""
    v = np.asarray(values)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return (-1.0, 1.0)
    lo, hi = (np.percentile(v, [2, 98]) if robust else (v.min(), v.max()))
    if symmetric:
        m = max(abs(lo), abs(hi)) or 1.0
        return (-float(m), float(m))
    if hi <= lo:
        hi = lo + 1.0
    return (float(lo), float(hi))


def clean(v):
    """JSON-safe scalar."""
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        return None if not math.isfinite(float(v)) else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        return s if s and s.lower() not in ("nan", "none") else None
    return v


def write_json(path, obj):
    """Write gzip-compressed JSON (the browser decompresses it)."""
    return write_gz(path, json.dumps(obj, separators=(",", ":"), allow_nan=False).encode())


def grid_meta(grid):
    t = grid.transform
    return {"a": t.a, "c": t.c, "e": t.e, "f": t.f, "rows": grid.shape[0], "cols": grid.shape[1]}


# --------------------------------------------------------------------------- main
def build(src, out):
    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*"):
        if old.is_file():
            old.unlink()
    say = lambda m: print("  ", m) if not m.startswith("Reading ") or m.endswith("1971") else None  # noqa: E731
    print("Loading the project with the version 3 science code ...")
    ds = Dataset(src, say)
    storage = StorageData(src, say)
    from pyproj import CRS, Transformer
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        data_crs = CRS.from_wkt(ds.crs.to_wkt())
        proj_str = data_crs.to_proj4()
    to_ll = Transformer.from_crs(data_crs, "EPSG:4326", always_xy=True)
    merc_to_data = Transformer.from_crs("EPSG:3857", data_crs, always_xy=True)
    data_to_merc = Transformer.from_crs(data_crs, "EPSG:3857", always_xy=True)
    merc_to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    sizes = {}
    meta = {"version": "3.0-web", "first_year": FIRST_YEAR, "last_year": LAST_YEAR,
            "years": list(range(FIRST_YEAR, LAST_YEAR + 1)), "ft_per_m": FT_PER_M,
            "proj4": proj_str, "block": BLOCK, "aquifers": {}, "grids": {}, "display": {},
            "class_colors": CLASS_COLORS, "surface_colors": SURFACE_COLORS,
            "drought_periods": DROUGHT_PERIODS, "products": PRODUCTS}

    # ---------------------------------------------------------------- head rasters
    for aq in AQUIFERS:
        key = aq.lower()
        st = ds.stacks[aq]
        flat = st.data.reshape(st.data.shape[0], -1)          # float32 (year, cell)
        cells = np.where(np.isfinite(flat).any(axis=0))[0].astype("<i4")
        sizes[f"cells_{key}"] = write_gz(out / f"cells_{key}.bin.gz", cells.tobytes())
        meta["grids"][key] = grid_meta(st.grid)
        for k, yr in enumerate(st.years):
            sizes[f"head_{key}_{yr}"] = write_gz(out / f"head_{key}_{yr}.bin.gz",
                                                 shuffle_f32(flat[k, cells]))
        R, C = st.grid.shape
        nblk = 0
        block_ids = []
        for br in range(0, math.ceil(R / BLOCK)):
            for bc in range(0, math.ceil(C / BLOCK)):
                sub = st.data[:, br * BLOCK:(br + 1) * BLOCK, bc * BLOCK:(bc + 1) * BLOCK]
                if not np.isfinite(sub).any():
                    continue
                full = np.full((st.data.shape[0], BLOCK, BLOCK), np.nan, dtype="<f4")
                full[:, :sub.shape[1], :sub.shape[2]] = sub
                # cell-major: for each cell of the block, its 53 years
                payload = full.reshape(st.data.shape[0], -1).T
                sizes[f"blk_{key}_{br}_{bc}"] = write_gz(out / f"blk_{key}_{br}_{bc}.bin.gz",
                                                         shuffle_f32(payload))
                nblk += 1
                block_ids.append(f"{br}_{bc}")
        meta["aquifers"][key] = {"name": aq, "grid": key, "n_cells": int(cells.size),
                                 "years": [int(y) for y in st.years], "blocks": nblk, "block_ids": block_ids,
                                 "nodata_source": None if st.nodata is None else float(st.nodata)}
        print(f"   {aq}: {cells.size:,} cells, {st.years.size} year files, {nblk} blocks")

    # ---------------------------------------------------------------- provided sums
    for aq in AQUIFERS:
        key = aq.lower()
        sm = ds.sums.get(aq)
        if sm is None:
            continue
        gkey = f"sum_{key}"
        meta["grids"][gkey] = grid_meta(sm.grid)
        sizes[gkey] = write_gz(out / f"{gkey}.bin.gz", shuffle_f32(sm.native_m.ravel()))
        meta["aquifers"][key]["sum_grid"] = gkey
        meta["aquifers"][key]["sum_units_stored"] = "m"

    # ---------------------------------------------------------------- display look-ups
    seen = {}
    for gkey, g in meta["grids"].items():
        sig = tuple(round(g[k], 6) for k in ("a", "c", "e", "f", "rows", "cols"))
        if sig in seen:                      # identical grid: reuse its look-up
            meta["display"][gkey] = dict(meta["display"][seen[sig]], look=seen[sig])
            continue
        seen[sig] = gkey
        left, top = g["c"], g["f"]
        right, bottom = left + g["a"] * g["cols"], top + g["e"] * g["rows"]
        mx0, my0, mx1, my1 = data_to_merc.transform_bounds(left, bottom, right, top, densify_pts=51)
        W = DISPLAY_WIDTH
        H = int(round(W * (my1 - my0) / (mx1 - mx0)))
        xs = mx0 + (np.arange(W) + 0.5) * (mx1 - mx0) / W
        ys = my1 - (np.arange(H) + 0.5) * (my1 - my0) / H
        X, Y = np.meshgrid(xs, ys)
        ax, ay = merc_to_data.transform(X.ravel(), Y.ravel())
        col = np.floor((ax - g["c"]) / g["a"]).astype(np.int64)
        row = np.floor((ay - g["f"]) / g["e"]).astype(np.int64)
        ok = (row >= 0) & (row < g["rows"]) & (col >= 0) & (col < g["cols"])
        flatidx = np.where(ok, row * g["cols"] + col, -1).astype("<i4")
        sizes[f"look_{gkey}"] = write_gz(out / f"look_{gkey}.bin.gz", flatidx.tobytes())
        lon0, lat0 = merc_to_ll.transform(mx0, my0)
        lon1, lat1 = merc_to_ll.transform(mx1, my1)
        meta["display"][gkey] = {"width": W, "height": H, "south": lat0, "west": lon0,
                                 "north": lat1, "east": lon1, "look": gkey}

    # ---------------------------------------------------------------- colour limits
    print("Computing fixed colour ranges (as the desktop does) ...")
    limits = {}
    for aq in AQUIFERS:
        key = aq.lower()
        st = ds.stacks[aq]
        lim = {"head": {"robust": robust_limits(st.data, True, False),
                        "minmax": robust_limits(st.data, False, False)},
               "cumulative": {}}
        for b_i, base in enumerate(st.years):
            vals = st.data - st.data[b_i][None]
            lim["cumulative"][str(int(base))] = {"robust": robust_limits(vals, True, True),
                                                 "minmax": robust_limits(vals, False, True)}
        limits[key] = lim
    sizes["limits"] = write_json(out / "limits.json.gz", limits)

    # ---------------------------------------------------------------- basin statistics
    print("Computing Basin Summary statistics for every scope ...")
    stats = {"scopes": ds.scopes(), "data": {}}
    for scope in ds.scopes():
        stats["data"][scope] = {}
        for aq in AQUIFERS:
            head, change = ds.stats(aq, scope)
            stats["data"][scope][aq.lower()] = {
                q: {c: [clean(v) for v in df[c].tolist()] for c in
                    ("year", "mean", "q1", "median", "q3", "n_valid_cells")}
                for q, df in (("head", head), ("change", change))}
    sizes["stats"] = write_json(out / "stats.json.gz", stats)

    # ---------------------------------------------------------------- wells
    print("Exporting wells and observations ...")
    w = ds.wells
    lon, lat = to_ll.transform(w["x"].values, w["y"].values)
    wells = []
    for i in range(len(w)):
        r = w.iloc[i]
        ivs, issues, src_lab = ds.well_intervals(i)
        wells.append({
            "id": int(r["stn_id"]), "i": i, "x": round(float(r["x"]), 3), "y": round(float(r["y"]), 3),
            "lat": round(float(lat[i]), 6), "lon": round(float(lon[i]), 6),
            "aquifer": r["aquifer"], "source": r["source"], "site": clean(r["site_code"]),
            "name": clean(r["well_name"]), "use": clean(r["well_use"]), "type": clean(r["well_type"]),
            "county": clean(r["county_nam"]), "basin": clean(r["basin_name"]),
            "subbasin": clean(r["subbasin"]) if isinstance(r["subbasin"], str) else None,
            "depth_ft": clean(ds.well_depth_ft(i)), "gse": clean(r["gse"]),
            "intervals": [[a, b] for a, b in ivs], "issues": issues, "interval_source": src_lab,
            "corcoran_ft": clean(ds.corcoran_ft(i)), "n_obs": int(r["n_obs"]),
        })
    sizes["wells"] = write_json(out / "wells.json.gz", wells)
    obs = {}
    for sid, g in ds.obs.sort_values(["stn_id", "year"]).groupby("stn_id"):
        obs[str(int(sid))] = [g["year"].astype(int).tolist(),
                              [clean(v) for v in g["gwe"].tolist()],
                              [clean(v) for v in g["gse_gwe"].tolist()]]
    raw = json.dumps(obs, separators=(",", ":")).encode()
    sizes["obs"] = write_gz(out / "obs.json.gz", raw)

    # ---------------------------------------------------------------- subbasins
    if ds.basins is not None:
        g = ds.basins.gdf.to_crs("EPSG:4326")
        feats = []
        lp = ds.basins.label_points()
        for k, row in g.iterrows():
            geom = json.loads(json.dumps(row.geometry.__geo_interface__))

            def rnd(c):
                return [rnd(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 6), round(c[1], 6)]
            geom["coordinates"] = rnd(geom["coordinates"])
            llx, lly = to_ll.transform(lp[k][0], lp[k][1])
            feats.append({"type": "Feature", "geometry": geom,
                          "properties": {"short_name": row["short_name"], "full_name": row["full_name"],
                                         "label_lat": round(lly, 6), "label_lon": round(llx, 6)}})
        sizes["basins"] = write_json(out / "basins.json.gz", {"type": "FeatureCollection", "features": feats})

    # ---------------------------------------------------------------- storage
    st_tab = storage.table
    storage_json = {"baseline": 2015, "years": [int(y) for y in st_tab.index],
                    "components": {k: {"label": c.label, "short": c.short, "system": c.system,
                                       "sheet": c.sheet, "column": c.column,
                                       "values": [clean(v) for v in st_tab[k].tolist()]}
                                   for k, c in COMPONENTS.items() if k in st_tab.columns}}
    sizes["storage"] = write_json(out / "storage.json.gz", storage_json)

    # ---------------------------------------------------------------- report
    rows = [list(r) for r in ds.report] + [list(r) for r in storage.report_rows()]
    rows += [["Warnings", "Warning", m] for m in ds.warnings]
    rows += [
        ["Web version", "Data build", f"Built with build/build_web_data.py from the original project "
         f"files using the version 3 science code; {time.strftime('%Y-%m-%d')}"],
        ["Web version", "Raster values", "Stored losslessly as the original float32 values (byte-shuffled, "
         "gzip). Clicks read the exact original raster cell."],
        ["Web version", "Map drawing", f"Rasters are drawn on the Web-Mercator basemap through a "
         f"{DISPLAY_WIDTH}-pixel-wide look-up image (nearest cell). This affects drawing only; every "
         "value shown in panels, plots and downloads comes from the original grid."],
        ["Web version", "Subbasin outlines", "Converted to WGS84 longitude/latitude (6 decimals, about "
         "0.1 m) for the web map; the click lookup uses these converted outlines."],
    ]
    sizes["report"] = write_json(out / "report.json.gz", rows)

    # ---------------------------------------------------------------- colour maps
    import matplotlib
    lut = {}
    for name in CMAPS:
        cm = matplotlib.colormaps[name].resampled(256)
        lut[name] = [[int(round(255 * c)) for c in cm(i)[:3]] for i in range(256)]
    meta["cmaps"] = lut
    meta["counts"] = {"wells": len(wells), "obs_rows": int(len(ds.obs)),
                      "classes": {k: int(v) for k, v in w["aquifer"].value_counts().items()}}
    meta["crs_text"] = proj4_text(ds.crs)
    prj = Path(src) / "final_classified_wells_inside_clay.prj"
    meta["prj_wkt"] = prj.read_text().strip() if prj.is_file() else None
    meta["build_seconds"] = round(time.time() - t0, 1)
    sizes["meta"] = write_json(out / "meta.json.gz", meta)
    total = sum(p.stat().st_size for p in out.glob("*"))
    print(f"Done in {time.time() - t0:.0f} s: {len(list(out.glob('*')))} files, {total / 1e6:.1f} MB "
          f"in {out}")
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=None, help="the 'total_wells' folder of the original project")
    ap.add_argument("--out", default=str(HERE.parent / "docs" / "data"))
    a = ap.parse_args()
    root = find_data_root(a.src) if a.src else find_data_root(HERE.parent)
    if root is None:
        sys.exit("Could not find the project data. Pass --src pointing to the 'total_wells' folder.")
    build(root, Path(a.out))
