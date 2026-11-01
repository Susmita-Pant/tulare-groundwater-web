# -*- coding: utf-8 -*-
"""Reference values from the DESKTOP version 3 code, for the web-app validation.

    python validation/make_reference.py --src <total_wells folder>

Writes validation/reference.json, which validation/browser_validation.js compares
against what the web app shows.
"""
import argparse, json, sys, warnings
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "build"))
from tulare_explorer.data import Dataset, find_data_root          # noqa: E402
from tulare_explorer.storage import StorageData                   # noqa: E402
from tulare_explorer.config import FIRST_YEAR, M_PER_FT           # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("--src", required=True); a = ap.parse_args()
root = find_data_root(a.src)
ds = Dataset(root); S = StorageData(root)
from pyproj import CRS, Transformer
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    to_ll = Transformer.from_crs(CRS.from_wkt(ds.crs.to_wkt()), "EPSG:4326", always_xy=True)

def f(v): return None if v is None or not np.isfinite(v) else float(v)

# test points: cell centres (exactly), a well, and a point outside the rasters
C, U = ds.stacks["Confined"], ds.stacks["Unconfined"]
pts = {}
def cell_centre(g, r, c): return g.transform.c + g.transform.a * (c + 0.5), g.transform.f + g.transform.e * (r + 0.5)
pts["tulare_lake_cell"] = cell_centre(C.grid, 150, 180)
pts["kern_cell"] = cell_centre(C.grid, 300, 220)
pts["unconfined_only_east"] = cell_centre(U.grid, 120, 330)
wi = int(np.where((ds.wells["source"] == "Perforation-based") & (ds.wells["n_obs"] > 20))[0][0])
pts["well"] = (float(ds.wells["x"].iat[wi]), float(ds.wells["y"].iat[wi]))
pts["outside"] = (-50000.0, 1330000.0)

ref = {"points": {}, "maps": {}, "stats": {}, "storage": {}}
for name, (x, y) in pts.items():
    lon, lat = to_ll.transform(x, y)
    sub = ds.basins.lookup(x, y) if ds.basins is not None else None
    d = np.hypot(ds.wells["x"].values - x, ds.wells["y"].values - y)
    near = np.where((d <= 3000) & (ds.wells["n_obs"].values > 0))[0]
    near = near[np.argsort(d[near])][:40]
    sums = {}
    for aq in ("Confined", "Unconfined"):
        sm = ds.sums[aq]; sums[aq.lower()] = f(sm.grid.value(sm.data_ft, x, y))
    ref["points"][name] = {"x": x, "y": y, "lat": lat, "lon": lon,
        "subbasin": sub[0] if sub else None,
        "confined": [f(v) for v in C.series(x, y)], "unconfined": [f(v) for v in U.series(x, y)],
        "sum_ft": sums, "nearby_ids": [int(ds.wells["stn_id"].iat[i]) for i in near],
        "well_index": wi if name == "well" else None}

def mapstats(arr, grid):
    v = arr[np.isfinite(arr)]
    return {"mean": float(v.mean()), "median": float(np.median(v)), "min": float(v.min()), "max": float(v.max()),
            "n": int(v.size), "negative": int((v < 0).sum()), "area_km2": float(v.size * grid.res[0] * grid.res[1] / 1e6)}
cases = [("head", "Confined", 2015, None), ("head", "Unconfined", 1990, None),
         ("cumulative", "Unconfined", 2010, 1980), ("cumulative", "Confined", 2023, 1971), ("sum", "Confined", None, None)]
for prod, aq, yr, base in cases:
    st = ds.stacks[aq]
    if prod == "head": arr, g = st.at(yr), st.grid
    elif prod == "cumulative": arr, g = st.change(base, yr), st.grid
    else: arr, g = ds.sums[aq].data_ft, ds.sums[aq].grid
    key = f"{prod}|{aq.lower()}|{yr}|{base}"
    ref["maps"][key] = {"ft": mapstats(arr, g), "m": mapstats(arr * M_PER_FT, g)}
for scope in ds.scopes():
    ref["stats"][scope] = {aq.lower(): {q: {c: [f(v) for v in df[c]] for c in ("mean", "q1", "median", "q3")}
                           for q, df in zip(("head", "change"), ds.stats(aq, scope))} for aq in ("Confined", "Unconfined")}
for y in S.years:
    ref["storage"][str(y)] = {"confined_total": S.confined_total(y), "combined": S.combined_total(y),
                              "combined_lo": S.combined_total(y, "sy01"), "combined_hi": S.combined_total(y, "sy03"),
                              **{k: S.value(k, y) for k in ("water", "matrix", "sy", "sy01", "sy03")}}
(HERE / "reference.json").write_text(json.dumps(ref))
print("reference.json written:", len(ref["points"]), "points,", len(ref["maps"]), "map cases,", len(ref["stats"]), "scopes")
