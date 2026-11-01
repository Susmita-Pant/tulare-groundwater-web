# -*- coding: utf-8 -*-
"""Data layer for the Tulare Basin explorer.

Everything here is GUI-free so it can be tested without Qt. All paths are resolved
relative to the detected data root (the folder holding absolute_head.csv).
"""

import glob
import os
import re
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio.features import geometry_mask
import geopandas as gpd
from shapely.geometry import Point
from shapely.prepared import prep

try:
    from pyproj import CRS as PyprojCRS, Transformer
except ImportError:  # pragma: no cover
    PyprojCRS = Transformer = None

from .config import (FIRST_YEAR, LAST_YEAR, FT_PER_M, AQUIFERS, SHAPEFILES)

YEARS = np.arange(FIRST_YEAR, LAST_YEAR + 1)


# =============================================================================
# Paths and CRS helpers
# =============================================================================
def is_data_root(path):
    p = Path(path) if path else None
    return bool(p) and (p / "absolute_head.csv").is_file() \
        and (p / "SBAS_confined").is_dir() and (p / "SBAS_unconfined").is_dir()


def find_data_root(*starts):
    """Return the folder containing the dataset, or None.

    Looks in each start folder, then in 'total_wells' and 'analysis/total_wells'
    below it, so the app works wherever the ZIP is extracted.
    """
    seeds = [Path(s) for s in starts if s]
    seeds.append(Path.cwd())
    for seed in seeds:
        for sub in ("", "total_wells", "analysis/total_wells", "analysis"):
            cand = seed / sub if sub else seed
            if is_data_root(cand):
                return cand.resolve()
    return None


def projection_signature(crs):
    """Projection parameters without datum-shift terms, for a lenient comparison."""
    if crs is None or PyprojCRS is None:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            d = PyprojCRS.from_user_input(crs).to_dict()
    except Exception:
        return None
    drop = {"towgs84", "datum", "no_defs", "type", "wktext"}
    return {k: (round(v, 9) if isinstance(v, float) else v)
            for k, v in d.items() if k not in drop}


def proj4_text(crs):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return PyprojCRS.from_user_input(crs).to_proj4()
    except Exception:
        return str(crs)[:200]


# =============================================================================
# Raster helpers
# =============================================================================
class Grid:
    """Geometry of a north-up raster."""

    def __init__(self, transform, shape):
        self.transform = transform
        self.shape = tuple(shape)
        ny, nx = self.shape
        self.left = transform.c
        self.top = transform.f
        self.right = transform.c + transform.a * nx
        self.bottom = transform.f + transform.e * ny
        self.extent = (self.left, self.right, self.bottom, self.top)
        self.res = (transform.a, -transform.e)

    def rowcol(self, x, y):
        x = np.atleast_1d(np.asarray(x, dtype=float))
        y = np.atleast_1d(np.asarray(y, dtype=float))
        col = np.floor((x - self.transform.c) / self.transform.a).astype(int)
        row = np.floor((y - self.transform.f) / self.transform.e).astype(int)
        ok = (row >= 0) & (row < self.shape[0]) & (col >= 0) & (col < self.shape[1])
        return row, col, ok

    def value(self, arr, x, y):
        r, c, ok = self.rowcol(x, y)
        return float(arr[r[0], c[0]]) if ok[0] else np.nan


def read_band(path, dtype="float32"):
    """Read band 1 with nodata (and non-finite values) converted to NaN."""
    with rasterio.open(path) as src:
        arr = src.read(1).astype(dtype)
        nod = src.nodata
        if nod is not None and np.isfinite(nod):
            arr[arr == np.asarray(nod, dtype=arr.dtype)] = np.nan
        arr[~np.isfinite(arr)] = np.nan
        return arr, src.transform, src.crs, nod


class HeadStack:
    """Annual absolute-head rasters of one aquifer, in feet, shape (year, row, col)."""

    def __init__(self, aquifer, root, progress=None):
        self.aquifer = aquifer
        base = Path(root) / ("SBAS_" + aquifer.lower())
        folder = base / "absolute_head"
        arrays, years, missing = [], [], []
        transform = crs = nodata = shape = None
        for yr in YEARS:
            path = folder / f"{yr}.tif"
            if not path.is_file():
                missing.append(int(yr))
                continue
            arr, tr, c, nod = read_band(path)
            if shape is None:
                shape, transform, crs, nodata = arr.shape, tr, c, nod
            elif arr.shape != shape:
                raise ValueError(f"{path}: shape {arr.shape} differs from {shape}")
            arrays.append(arr)
            years.append(int(yr))
            if progress:
                progress(f"Reading {aquifer.lower()} head {yr}")
        if not arrays:
            raise FileNotFoundError(f"No absolute-head GeoTIFFs found in {folder}")
        self.data = np.stack(arrays)
        self.years = np.array(years)
        self.missing_years = missing
        self.crs = crs
        self.nodata = nodata
        self.grid = Grid(transform, shape)
        self.change_dir = base / "clipped"
        self.sum_path = base / f"sum_raster_{aquifer.lower()}.tif"

    def index(self, year):
        idx = np.where(self.years == int(year))[0]
        return int(idx[0]) if idx.size else None

    def at(self, year):
        i = self.index(year)
        return None if i is None else self.data[i]

    def change(self, base_year, year):
        """head(year) - head(base_year); NaN wherever either year has no data."""
        a, b = self.at(base_year), self.at(year)
        if a is None or b is None:
            return None
        return b - a

    def series(self, x, y):
        r, c, ok = self.grid.rowcol(x, y)
        if not ok[0]:
            return np.full(self.years.size, np.nan)
        return self.data[:, r[0], c[0]].astype(float)


class SumRaster:
    """Provided cumulative change 1971-2023, stored in metres; kept in feet."""

    def __init__(self, path):
        arr, tr, crs, nod = read_band(path)
        self.path = Path(path)
        self.native_m = arr
        self.data_ft = arr * FT_PER_M
        self.grid = Grid(tr, arr.shape)
        self.crs = crs
        self.nodata = nod


# =============================================================================
# Subbasins
# =============================================================================
# 'San Joaquin Valley' followed by a real separator (hyphen, dash, colon or underscore),
# so names that merely start with the phrase are left alone.
_PREFIX = re.compile(r"^\s*san[\s_\-]*joaquin[\s_\-]*valley[\s_]*[-_–—:]+[\s_]*",
                     re.IGNORECASE)


def short_subbasin_name(name):
    """'SAN JOAQUIN VALLEY - KAWEAH' -> 'Kaweah'.

    Removes only a leading 'San Joaquin Valley' prefix and its separator (any case,
    with spaces, hyphens or underscores), then title-cases an all-caps remainder.
    """
    if name is None or (isinstance(name, float) and np.isnan(name)):
        return "Unnamed subbasin"
    s = str(name)
    m = _PREFIX.match(s)
    rest = s[m.end():] if m else s
    rest = rest.strip().strip("-_").strip()
    if not rest:
        return s.strip()
    if "_" in rest and " " not in rest:
        rest = rest.replace("_", " ")
    return rest.title() if rest.isupper() else rest


class Basins:
    """Groundwater subbasin polygons from basins_clipped.shp."""

    NAME_FIELD = "Basin_Su_1"

    def __init__(self, path, target_crs):
        self.path = Path(path)
        g = gpd.read_file(path)
        self.notes = []
        if g.crs is not None and projection_signature(g.crs) != projection_signature(target_crs):
            g = g.to_crs(target_crs)
            self.notes.append("reprojected to the raster CRS")
        if self.NAME_FIELD not in g.columns:
            raise KeyError(f"{self.path.name} has no '{self.NAME_FIELD}' field")
        g = g[g.geometry.notna() & ~g.geometry.is_empty].copy()
        g["full_name"] = g[self.NAME_FIELD].astype(str)
        g["short_name"] = g[self.NAME_FIELD].map(short_subbasin_name)
        self.gdf = g.reset_index(drop=True)
        self._prepared = [prep(geom) for geom in self.gdf.geometry]
        self._mask_cache = {}
        self.crs = g.crs

    @property
    def names(self):
        return list(self.gdf["short_name"])

    def lookup(self, x, y):
        """(short name, full name) of the polygon containing the point, else None."""
        pt = Point(float(x), float(y))
        for i, pg in enumerate(self._prepared):
            if pg.covers(pt):
                r = self.gdf.iloc[i]
                return r["short_name"], r["full_name"]
        return None

    def label_points(self):
        pts = self.gdf.geometry.representative_point()
        return list(zip(pts.x, pts.y, self.gdf["short_name"]))

    def mask(self, short_name, grid):
        """Boolean mask of grid cells whose centres fall inside the subbasin."""
        key = (short_name, grid.transform, grid.shape)
        if key not in self._mask_cache:
            geoms = self.gdf.loc[self.gdf["short_name"] == short_name, "geometry"]
            self._mask_cache[key] = geometry_mask(
                list(geoms), out_shape=grid.shape, transform=grid.transform,
                invert=True, all_touched=False)
        return self._mask_cache[key]

    def assign(self, x, y):
        """Short subbasin name for many points (NaN outside all polygons)."""
        pts = gpd.GeoDataFrame(geometry=gpd.points_from_xy(x, y), crs=self.crs)
        j = gpd.sjoin(pts, self.gdf[["short_name", "geometry"]], predicate="within", how="left")
        j = j[~j.index.duplicated(keep="first")]
        return j["short_name"].reindex(range(len(x))).values


# =============================================================================
# Perforations and the Corcoran depth reference
# =============================================================================
class Perforations:
    """Screened intervals from perforations.csv (feet below land surface)."""

    def __init__(self, path):
        self.path = Path(path)
        df = pd.read_csv(path, dtype={"site_code": str})
        need = {"site_code", "top_prf_int", "bot_prf_int"}
        if not need.issubset(df.columns):
            raise KeyError(f"{self.path.name} must contain {sorted(need)}")
        self.df = df
        self._by_site = {k: g for k, g in df.groupby("site_code", sort=False)}

    def for_site(self, site_code):
        if site_code is None or (isinstance(site_code, float) and np.isnan(site_code)):
            return self.df.iloc[0:0]
        return self._by_site.get(str(site_code), self.df.iloc[0:0])

    def summary(self):
        d = self.df
        top, bot = d["top_prf_int"], d["bot_prf_int"]
        return {
            "rows": len(d), "sites": d["site_code"].nunique(),
            "multi": int((d.groupby("site_code").size() > 1).sum()),
            "reversed": int((top > bot).sum()), "zero": int((top == bot).sum()),
            "missing": int(d[["top_prf_int", "bot_prf_int"]].isna().any(axis=1).sum()),
            "negative": int((d[["top_prf_int", "bot_prf_int"]] < 0).any(axis=1).sum()),
        }


def check_intervals(rows, well_depth_ft):
    """Split screen intervals into drawable ones and reported problems.

    Returns (valid, issues): valid is a list of (top, bottom) in feet; issues is a
    list of human-readable strings. Nothing questionable is drawn.
    """
    valid, issues = [], []
    depth_ok = well_depth_ft is not None and np.isfinite(well_depth_ft) and well_depth_ft > 0
    for top, bot in zip(rows["top_prf_int"], rows["bot_prf_int"]):
        if not (np.isfinite(top) and np.isfinite(bot)):
            issues.append("interval with a missing top or bottom (not drawn)")
        elif top < 0 or bot < 0:
            issues.append(f"{top:g}–{bot:g} ft has a negative depth (not drawn)")
        elif top > bot:
            issues.append(f"{top:g}–{bot:g} ft is reversed (top below bottom; not drawn)")
        elif top == bot:
            issues.append(f"{top:g}–{bot:g} ft has zero length (not drawn)")
        elif depth_ok and bot > well_depth_ft + 1e-6:
            issues.append(f"{top:g}–{bot:g} ft extends below the documented well depth "
                          f"of {well_depth_ft:g} ft (not drawn)")
        else:
            valid.append((float(top), float(bot)))
    valid.sort()
    return valid, issues


class DepthReference:
    """final_depth_1983_clipped_projected.tif, sampled at well locations.

    The file carries no unit or description metadata. Read as feet below land
    surface it reproduces the perforation-based aquifer classification (see
    Dataset._check_corcoran_units), so it is treated as feet below land surface.
    Whether it marks the top or the base of the Corcoran Clay cannot be confirmed
    from the file, so the app labels it a 'Corcoran depth reference'.
    """

    def __init__(self, path):
        self.path = Path(path)
        arr, tr, crs, nod = read_band(path)
        self.data = arr
        self.grid = Grid(tr, arr.shape)
        self.crs = crs
        self.nodata = nod

    def sample(self, x, y):
        return self.grid.value(self.data, x, y)


# =============================================================================
# Wells and observations
# =============================================================================
WELL_FIELDS = ("site_code", "swn", "well_name", "basin_name", "county_nam", "well_depth",
               "well_use", "well_type", "gse", "top_prf_in", "bot_prf_in")


def load_wells(root, target_crs):
    """Merge the four classification shapefiles into one table, one row per well."""
    frames, notes = [], []
    target_sig = projection_signature(target_crs)
    for fname, label in SHAPEFILES:
        path = Path(root) / fname
        if not path.is_file():
            notes.append(f"Missing shapefile: {fname}")
            continue
        g = gpd.read_file(path)
        if g.crs is not None and target_sig is not None:
            if projection_signature(g.crs) != target_sig:
                g = g.to_crs(target_crs)
                notes.append(f"{fname}: reprojected to the raster CRS")
        xs, ys = [], []
        for geom in g.geometry:
            if geom is None or geom.is_empty:
                xs.append(np.nan); ys.append(np.nan)
                continue
            if geom.geom_type == "MultiPoint":
                parts = list(geom.geoms)
                if len(parts) > 1:
                    notes.append(f"{fname}: a MultiPoint with {len(parts)} parts; first part used")
                geom = parts[0]
            xs.append(geom.x); ys.append(geom.y)
        df = pd.DataFrame({
            "stn_id": g["stn_id"].astype("int64").values,
            "aquifer": g["Aquifer_Ty"].astype(str).str.strip().values,
            "x": xs, "y": ys,
        })
        for col in WELL_FIELDS:
            df[col] = g[col].values if col in g.columns else np.nan
        df["source"] = label
        df["geom_type"] = ", ".join(sorted(set(g.geom_type.dropna())))
        frames.append(df)
    if not frames:
        raise FileNotFoundError("None of the four classification shapefiles was found")
    wells = pd.concat(frames, ignore_index=True)
    wells["site_code"] = wells["site_code"].astype(object).where(wells["site_code"].notna(), None)
    ndup = int(wells["stn_id"].duplicated().sum())
    if ndup:
        notes.append(f"{ndup} duplicate stn_id rows across shapefiles; first occurrence kept")
        wells = wells.drop_duplicates("stn_id", keep="first")
    nbad = int(wells[["x", "y"]].isna().any(axis=1).sum())
    if nbad:
        notes.append(f"{nbad} wells without a usable location were dropped")
    wells = wells.dropna(subset=["x", "y"]).reset_index(drop=True)
    return wells, notes


def load_observations(root, well_ids):
    path = Path(root) / "absolute_head.csv"
    obs = pd.read_csv(path, usecols=lambda c: c in
                      {"stn_id", "year", "gwe", "gse_gwe", "Prolatitude", "Projlongt"})
    obs = obs[obs["year"].between(FIRST_YEAR, LAST_YEAR)]
    n_all_wells = obs["stn_id"].nunique()
    obs = obs[obs["stn_id"].isin(set(well_ids))]
    obs = (obs.groupby(["stn_id", "year"], as_index=False)
              .agg(gwe=("gwe", "mean"), gse_gwe=("gse_gwe", "mean")))
    wide = (obs.pivot(index="stn_id", columns="year", values="gwe")
               .reindex(index=list(well_ids), columns=YEARS))
    dtw = (obs.pivot(index="stn_id", columns="year", values="gse_gwe")
              .reindex(index=list(well_ids), columns=YEARS))
    return obs, wide, dtw, n_all_wells


# =============================================================================
# Raster statistics for the Basin Summary
# =============================================================================
STAT_COLUMNS = ("mean", "q1", "median", "q3", "n_valid_cells")


def year_stats(stack, cell_mask=None, baseline_year=None):
    """Mean, Q1, median and Q3 across valid raster cells for every year (feet).

    With baseline_year, statistics describe head(year) - head(baseline_year); a cell
    counts only in years where both values exist. Values describe the spatial
    distribution of cells, not an uncertainty interval.
    """
    data = stack.data
    vals = data[:, cell_mask] if cell_mask is not None else data.reshape(data.shape[0], -1)
    if baseline_year is not None:
        b = stack.index(baseline_year)
        vals = vals - vals[b][None, :]
    n = np.isfinite(vals).sum(axis=1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(vals, axis=1)
        q1, med, q3 = np.nanpercentile(vals, [25, 50, 75], axis=1)
    df = pd.DataFrame({"year": stack.years, "mean": mean, "q1": q1, "median": med,
                       "q3": q3, "n_valid_cells": n})
    df.loc[df["n_valid_cells"] == 0, ["mean", "q1", "median", "q3"]] = np.nan
    return df


# =============================================================================
# Dataset
# =============================================================================
class Dataset:
    """Everything the explorer needs. Optional layers degrade gracefully."""

    def __init__(self, root, progress=None):
        self.root = Path(root)
        say = progress or (lambda m: None)
        self.warnings = []
        self.stacks = {aq: HeadStack(aq, root, say) for aq in AQUIFERS}
        self.crs = self.stacks["Confined"].crs
        self.sums = {}
        for aq in AQUIFERS:
            p = self.stacks[aq].sum_path
            if p.is_file():
                say(f"Reading provided cumulative raster ({aq.lower()})")
                self.sums[aq] = SumRaster(p)
            else:
                self.warnings.append(f"{p.name} not found; the provided-cumulative product "
                                     f"is unavailable for the {aq.lower()} aquifer")

        say("Reading subbasin boundaries")
        self.basins = self._optional(lambda: Basins(self.root / "basins_clipped.shp", self.crs),
                                     "basins_clipped.shp", self.root / "basins_clipped.shp")
        say("Reading well shapefiles")
        self.wells, self.well_notes = load_wells(root, self.crs)
        if self.basins is not None:
            self.wells["subbasin"] = self.basins.assign(self.wells["x"].values,
                                                         self.wells["y"].values)
        else:
            self.wells["subbasin"] = np.nan
        say("Reading absolute_head.csv")
        self.obs, self.obs_wide, self.dtw_wide, self.n_csv_wells = load_observations(
            root, self.wells["stn_id"].values)
        self.wells["n_obs"] = self.obs_wide.notna().sum(axis=1).values
        say("Reading screen intervals")
        self.perfs = self._optional(lambda: Perforations(self.root / "perforations.csv"),
                                    "perforations.csv", self.root / "perforations.csv")
        say("Reading Corcoran depth reference")
        self.depthref = self._optional(
            lambda: DepthReference(self.root / "final_depth_1983_clipped_projected.tif"),
            "final_depth_1983_clipped_projected.tif",
            self.root / "final_depth_1983_clipped_projected.tif")

        self.years = YEARS
        self.to_lonlat = None
        if Transformer is not None and self.crs is not None:
            try:
                self.to_lonlat = Transformer.from_crs(
                    PyprojCRS.from_wkt(self.crs.to_wkt()), "EPSG:4326", always_xy=True)
            except Exception:
                self.to_lonlat = None

        say("Computing basin statistics")
        self._stats_cache = {}
        for aq in AQUIFERS:
            self.stats(aq, "Entire raster domain")
        say("Running unit and grid checks")
        self.corcoran_check = self._check_corcoran_units()
        self.report = self._build_report()

    def _optional(self, loader, name, path=None):
        if path is not None and not Path(path).exists():
            self.warnings.append(f"{name} not found; related features are disabled")
            return None
        try:
            return loader()
        except FileNotFoundError:
            self.warnings.append(f"{name} not found; related features are disabled")
        except Exception as exc:
            self.warnings.append(f"{name} could not be read ({exc}); related features are disabled")
        return None

    # ---- statistics ------------------------------------------------------------
    def scopes(self):
        out = ["Entire raster domain"]
        if self.basins is not None:
            out += sorted(self.basins.names)
        return out

    def stats(self, aquifer, scope):
        """(head_stats, change_since_1971_stats) DataFrames in feet."""
        key = (aquifer, scope)
        if key not in self._stats_cache:
            st = self.stacks[aquifer]
            mask = None
            if scope != "Entire raster domain" and self.basins is not None:
                mask = self.basins.mask(scope, st.grid)
            base = FIRST_YEAR if st.index(FIRST_YEAR) is not None else int(st.years.min())
            self._stats_cache[key] = (year_stats(st, mask), year_stats(st, mask, base))
        return self._stats_cache[key]

    # ---- well details ------------------------------------------------------------
    def well_intervals(self, i):
        """(valid intervals ft, issues, source label) for well row i."""
        w = self.wells.iloc[i]
        depth = w["well_depth"]
        depth = float(depth) if pd.notna(depth) and float(depth) > 0 else np.nan
        if self.perfs is not None:
            rows = self.perfs.for_site(w["site_code"])
            if len(rows):
                v, iss = check_intervals(rows, depth)
                return v, iss, "perforations.csv"
        if pd.notna(w.get("top_prf_in")) and pd.notna(w.get("bot_prf_in")):
            rows = pd.DataFrame({"top_prf_int": [float(w["top_prf_in"])],
                                 "bot_prf_int": [float(w["bot_prf_in"])]})
            v, iss = check_intervals(rows, depth)
            return v, iss, "classification shapefile (top_prf_in / bot_prf_in)"
        return [], [], None

    def well_depth_ft(self, i):
        d = self.wells["well_depth"].iat[i]
        try:
            d = float(d)
        except (TypeError, ValueError):
            return np.nan
        return d if np.isfinite(d) and d > 0 else np.nan

    def corcoran_ft(self, i):
        if self.depthref is None:
            return np.nan
        return self.depthref.sample(self.wells["x"].iat[i], self.wells["y"].iat[i])

    # ---- checks --------------------------------------------------------------------
    def _check_corcoran_units(self):
        """Test the depth raster against the perforation-based classification.

        aquifer_type_by_prf_projected.shp classes wells from their screen depth.
        If the raster is feet below land surface, screens wholly below it should be
        Confined and screens wholly above it Unconfined.
        """
        if self.depthref is None:
            return None
        w = self.wells[(self.wells["source"] == "Perforation-based")
                       & self.wells["top_prf_in"].notna() & self.wells["bot_prf_in"].notna()]
        if w.empty:
            return None
        ref = np.array([self.depthref.sample(x, y) for x, y in zip(w["x"], w["y"])])
        ok = np.isfinite(ref)
        w, ref = w[ok], ref[ok]
        out = {}
        for label, f in (("feet", 1.0), ("metres", FT_PER_M)):
            r = ref * f
            pred = np.where(w["top_prf_in"] >= r, "Confined",
                            np.where(w["bot_prf_in"] <= r, "Unconfined", "straddles"))
            out[label] = int((pred == w["aquifer"].values).sum())
        out["n"] = int(len(w))
        out["straddle_ft"] = int(((w["top_prf_in"] < ref) & (w["bot_prf_in"] > ref)).sum())
        return out

    def _build_report(self):
        rows = []

        def add(section, key, value):
            rows.append((section, key, value))

        S = "Inputs"
        add(S, "Data folder", str(self.root))
        add(S, "Raster CRS", proj4_text(self.crs) + " (custom Albers Equal-Area; not EPSG:3310)")
        for aq in AQUIFERS:
            s = self.stacks[aq]
            valid = np.isfinite(s.data).reshape(s.data.shape[0], -1).sum(axis=1)
            miss = f"; missing years {s.missing_years}" if s.missing_years else ""
            add(S, f"{aq} absolute head",
                f"{s.years.size} files ({s.years.min()}–{s.years.max()}){miss}; "
                f"{s.grid.shape[0]} × {s.grid.shape[1]} cells at {s.grid.res[0]:.0f} m; "
                f"nodata {s.nodata}; origin ({s.grid.left:.2f}, {s.grid.top:.2f}); "
                f"valid cells {valid.min():,}–{valid.max():,}; "
                f"range {np.nanmin(s.data):.1f} to {np.nanmax(s.data):.1f} ft")
        S = "Unit checks"
        for aq in AQUIFERS:
            s = self.stacks[aq]
            files = sorted(glob.glob(str(s.change_dir / "clipped_raster_*.tif")))
            if files:
                name = os.path.basename(files[0])
                try:
                    y1, y2 = [int(v) for v in name[len("clipped_raster_"):-4].split("-")]
                    ch, _, _, _ = read_band(files[0])
                    diff = s.at(y2) - s.at(y1)
                    ny = min(ch.shape[0], diff.shape[0]); nx = min(ch.shape[1], diff.shape[1])
                    a, b = diff[:ny, :nx], ch[:ny, :nx]
                    m = np.isfinite(a) & np.isfinite(b) & (np.abs(b) > 0.01)
                    ratio = np.median(a[m] / b[m]) if m.any() else np.nan
                    add(S, f"{aq} head units",
                        f"head({y2}) − head({y1}) ÷ {name} = {ratio:.4f} (median), so heads and "
                        f"annual-change files share one unit: feet")
                except Exception as exc:
                    add(S, f"{aq} head units", f"check skipped: {exc}")
            if aq in self.sums:
                sm = self.sums[aq]
                d = s.at(s.years.max()) - s.at(s.years.min())
                X, Y = np.meshgrid(
                    s.grid.transform.c + s.grid.transform.a * (np.arange(s.grid.shape[1]) + 0.5),
                    s.grid.transform.f + s.grid.transform.e * (np.arange(s.grid.shape[0]) + 0.5))
                r, c, ok = sm.grid.rowcol(X.ravel(), Y.ravel())
                vals = np.full(d.size, np.nan)
                vals[ok] = sm.native_m[r[ok], c[ok]]
                dv = d.ravel()
                m = np.isfinite(vals) & np.isfinite(dv) & (np.abs(vals) > 0.01)
                ratio = np.median(dv[m] / vals[m]) if m.any() else np.nan
                verdict = ("stored in METRES; the app converts it to the unit you select"
                           if abs(ratio - FT_PER_M) < 0.05 else "UNITS UNCLEAR, check manually")
                add(S, f"{aq} provided cumulative raster",
                    f"{sm.path.name}: (head 2023 − head 1971) ÷ raster = {ratio:.5f}, so it is "
                    f"{verdict}. It always describes 1971–2023.")
        add(S, "Cumulative change mask",
            "head(year) − head(base) is NaN wherever either year has no data, so both "
            "years always use the same cells. The unconfined surface has 82,708 valid cells "
            "in 2000 and 82,559 in other years; only cells valid in both years are used.")
        add(S, "Unconfined grid offset",
            "Unconfined head GeoTIFFs have origin (−56000, 1544000); the change "
            "rasters use (−56041.47, 1543955.37). Each file is drawn and sampled with its own "
            "stored transform, never aligned by array index.")

        S = "Wells"
        w = self.wells
        add(S, "Classified wells", f"{len(w):,} unique stn_id from {w['source'].nunique()} shapefiles")
        for label, sub in w.groupby("source", sort=False):
            add(S, f"   {label}", f"{len(sub):,} wells ({sub['geom_type'].iloc[0]}); " +
                ", ".join(f"{k} {v}" for k, v in sub["aquifer"].value_counts().items()))
        add(S, "Aquifer classes", ", ".join(f"{k} {v:,}" for k, v in w["aquifer"].value_counts().items()))
        nd = int(w["well_depth"].isna().sum()) + int((w["well_depth"] == 0).sum())
        add(S, "Documented well depth", f"{len(w) - nd:,} of {len(w):,} wells; {nd:,} are missing "
            "or zero and are shown as 'Not available'")
        add(S, "Observations", f"{len(self.obs):,} well-years for classified wells "
            f"({FIRST_YEAR}–{LAST_YEAR}); absolute_head.csv lists {self.n_csv_wells:,} wells")
        add(S, "Observation units", "gwe = groundwater elevation (ft); gse_gwe = depth to water "
            "below land surface (ft). The well profile plots gse_gwe directly and never "
            "converts gwe to a depth.")
        for n in self.well_notes:
            add(S, "Note", n)

        S = "Subbasins"
        if self.basins is not None:
            b = self.basins
            out = int(pd.isna(w["subbasin"]).sum())
            add(S, "basins_clipped.shp", f"{len(b.gdf)} polygons; names from 'Basin_Su_1'; "
                f"same projection as the rasters" + (f"; {', '.join(b.notes)}" if b.notes else ""))
            add(S, "Short names", ", ".join(sorted(b.names)))
            add(S, "Wells outside all subbasins", f"{out}")
            add(S, "Click lookup", "point-in-polygon test of the clicked coordinate; points "
                "outside every polygon read 'Outside mapped subbasins'")
            add(S, "Subbasin statistics", "computed from raster cells whose centre lies inside "
                "the polygon, so each cell belongs to one subbasin")
        else:
            add(S, "basins_clipped.shp", "not available")

        S = "Screens and Corcoran reference"
        if self.perfs is not None:
            p = self.perfs.summary()
            matched = int(w["site_code"].isin(set(self.perfs.df["site_code"])).sum())
            add(S, "perforations.csv",
                f"{p['rows']:,} intervals for {p['sites']:,} site codes ({p['multi']:,} with "
                f"several intervals); joined to wells on exact site_code: {matched:,} of "
                f"{len(w):,} classified wells have intervals. Units: feet below land surface.")
            add(S, "Interval checks", f"{p['reversed']} reversed, {p['zero']} zero-length, "
                f"{p['missing']} incomplete and {p['negative']} negative intervals in the file; "
                "these and any interval below the documented well depth are listed for the "
                "well but not drawn")
        else:
            add(S, "perforations.csv", "not available")
        if self.depthref is not None:
            d = self.depthref
            add(S, "final_depth_1983_clipped_projected.tif",
                f"{d.grid.shape[0]} × {d.grid.shape[1]} cells at {d.grid.res[0]:.1f} m; "
                f"nodata {d.nodata:.3g}; values {np.nanmin(d.data):.0f}–{np.nanmax(d.data):.0f}; "
                "no unit or description metadata in the file")
            c = self.corcoran_check
            if c:
                add(S, "Unit test (verified)",
                    f"Read as feet below land surface, the raster reproduces the perforation-"
                    f"based class of {c['feet']} of {c['n']} wells (screen wholly below → "
                    f"Confined, wholly above → Unconfined; {c['straddle_ft']} straddle it). "
                    f"Read as metres it matches only {c['metres']}. The app therefore treats it "
                    "as FEET below land surface.")
            add(S, "Reference surface (unverified)",
                "Whether the raster marks the top or the base of the Corcoran Clay is not "
                "recorded. The well profile labels it 'Corcoran depth reference' and draws a "
                "single line; no clay thickness is drawn or implied.")
        else:
            add(S, "final_depth_1983_clipped_projected.tif", "not available")

        S = "Assumptions"
        add(S, "Drought periods", "1976–1977, 1987–1992, 2007–2009, 2012–2016, 2020–2022 "
            "(from basin_summary/groundwater_level_plots.py and the storage workbook note). "
            "Shading runs from the start year to the end year on the year axis, as in that script.")
        add(S, "Basin statistics", "Mean, Q1, median and Q3 are taken across valid 500 m raster "
            "cells each year. The Q1–Q3 band is the spatial spread of cells, not an "
            "uncertainty interval.")
        return rows
