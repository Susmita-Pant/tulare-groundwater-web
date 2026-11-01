# -*- coding: utf-8 -*-
"""Regional groundwater storage change, 2015–2023, from the storage workbook.

Version 3 shows only regional totals; no pixel-level storage rasters are read or
displayed.

Source: basin_summary/storage_depletion_2015_2023.xlsx
  sheet 'expansion_of_water_confined_por'  column 'Storage Loss(km^3)'
  sheet 'compact. of_aquife_matrix_confi'  column 'Storage Loss(km^3)'
  sheet 'unconfined_storage_loss'          columns 'Lower Range(Sy=0.1) (km^3)',
                                           'Actual Value(km^3)',
                                           'Upper Range (Sy=0.3) (km^3)'

Sign convention: every value is SIGNED STORAGE CHANGE in km³ since 2015
(2015 = 0). Negative = storage decrease (depletion); positive = gain. All
components share the 2015 baseline, so they can be added directly.
"""

import re
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd

WORKBOOK = Path("basin_summary") / "storage_depletion_2015_2023.xlsx"
BASELINE = 2015


class Component:
    def __init__(self, key, label, short, sheet, column, system):
        self.key, self.label, self.short = key, label, short
        self.sheet, self.column, self.system = sheet, column, system


COMPONENTS = OrderedDict((c.key, c) for c in [
    Component("water", "Confined: water expansion (compressibility)", "Confined water expansion",
              "expansion_of_water_confined_por", "Storage Loss(km^3)", "Confined"),
    Component("matrix", "Confined: aquifer-matrix compaction", "Confined matrix compaction",
              "compact. of_aquife_matrix_confi", "Storage Loss(km^3)", "Confined"),
    Component("sy", "Unconfined: spatially varying Sy", "Unconfined, spatial Sy",
              "unconfined_storage_loss", "Actual Value(km^3)", "Unconfined"),
    Component("sy01", "Unconfined: Sy = 0.1 (lower scenario)", "Unconfined, Sy 0.1",
              "unconfined_storage_loss", "Lower Range(Sy=0.1) (km^3)", "Unconfined"),
    Component("sy03", "Unconfined: Sy = 0.3 (upper scenario)", "Unconfined, Sy 0.3",
              "unconfined_storage_loss", "Upper Range (Sy=0.3) (km^3)", "Unconfined"),
])


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


class StorageData:
    """Annual regional storage change since 2015 for each component."""

    def __init__(self, root, progress=None):
        say = progress or (lambda m: None)
        self.root = Path(root)
        self.path = self.root / WORKBOOK
        self.notes = []
        say("Reading storage workbook (2015–2023)")
        if not self.path.is_file():
            raise FileNotFoundError(f"{WORKBOOK} not found")
        self.table = self._read()
        self.years = [int(y) for y in self.table.index]
        self._check()

    def _read(self):
        xl = pd.ExcelFile(self.path)
        sheets = {_norm(s): s for s in xl.sheet_names}
        out = {}
        for key, c in COMPONENTS.items():
            sheet = c.sheet if c.sheet in xl.sheet_names else sheets.get(_norm(c.sheet))
            if sheet is None:
                self.notes.append(f"Worksheet '{c.sheet}' not found; {c.label} unavailable")
                continue
            df = pd.read_excel(xl, sheet)
            df = df.loc[:, [col for col in df.columns if not str(col).startswith("Unnamed")]]
            cols = {_norm(col): col for col in df.columns}
            col = c.column if c.column in df.columns else cols.get(_norm(c.column))
            date = "Date" if "Date" in df.columns else cols.get("date")
            if col is None or date is None:
                self.notes.append(f"Column '{c.column}' or 'Date' missing in '{sheet}'")
                continue
            yrs = pd.to_numeric(df[date], errors="coerce")
            vals = pd.to_numeric(df[col], errors="coerce")
            s = pd.Series(vals.values, index=yrs.values).dropna()
            s.index = s.index.astype(int)
            out[key] = s.groupby(level=0).first()
        table = pd.DataFrame(out).sort_index()
        table.index.name = "year"
        return table

    def _check(self):
        """Record facts about the workbook for the Data Report."""
        self.checks = []
        t = self.table
        if BASELINE in t.index:
            zero = t.loc[BASELINE].abs().max()
            self.checks.append(f"All components are 0 in {BASELINE} (max |value| {zero:.2e} km³), "
                               f"confirming a common {BASELINE} baseline"
                               if zero < 1e-9 else
                               f"WARNING: values in {BASELINE} are not all 0 (max {zero:.4f} km³)")
        else:
            self.checks.append(f"WARNING: no {BASELINE} row in the workbook")
        if {"sy01", "sy", "sy03"}.issubset(t.columns):
            lo = t[["sy01", "sy03"]].min(axis=1)
            hi = t[["sy01", "sy03"]].max(axis=1)
            inside = ((t["sy"] >= lo - 1e-9) & (t["sy"] <= hi + 1e-9)).all()
            self.checks.append("Spatial-Sy values lie between the Sy 0.1 and Sy 0.3 scenarios "
                               "in every year" if inside else
                               "Note: spatial-Sy values fall outside the Sy 0.1–0.3 range in some years")
        missing = [COMPONENTS[k].short for k in COMPONENTS if k not in t.columns]
        if missing:
            self.checks.append("Missing components: " + ", ".join(missing))

    # ------------------------------------------------------------------ access
    def has(self, key):
        return key in self.table.columns

    def value(self, key, year):
        try:
            v = self.table.at[int(year), key]
        except KeyError:
            return np.nan
        return float(v) if pd.notna(v) else np.nan

    def series(self, key):
        return self.table[key].dropna() if key in self.table else pd.Series(dtype=float)

    def confined_total(self, year):
        return self.value("water", year) + self.value("matrix", year)

    def combined_total(self, year, unconfined="sy"):
        return self.confined_total(year) + self.value(unconfined, year)

    def summary_table(self):
        """One row per year: every component plus confined and combined totals."""
        t = self.table.copy()
        out = pd.DataFrame(index=t.index)
        out["confined_water_expansion_km3"] = t.get("water")
        out["confined_matrix_compaction_km3"] = t.get("matrix")
        out["confined_total_km3"] = t.get("water") + t.get("matrix")
        out["unconfined_spatial_sy_km3"] = t.get("sy")
        out["unconfined_sy_0_1_km3"] = t.get("sy01")
        out["unconfined_sy_0_3_km3"] = t.get("sy03")
        out["combined_total_spatial_sy_km3"] = out["confined_total_km3"] + t.get("sy")
        out["combined_total_sy_0_1_km3"] = out["confined_total_km3"] + t.get("sy01")
        out["combined_total_sy_0_3_km3"] = out["confined_total_km3"] + t.get("sy03")
        out["baseline_year"] = BASELINE
        out["sign_convention"] = "signed storage change since 2015; negative = storage decrease"
        return out.reset_index()

    def report_rows(self):
        S = "Storage change"
        rows = [
            (S, "Source", f"{WORKBOOK} (regional totals only; no pixel-level storage data "
                          "are read or shown)"),
            (S, "Period and baseline", f"{min(self.years)}–{max(self.years)}; every component "
                                       f"is change since {BASELINE} (= 0 in {BASELINE})"),
            (S, "Sign convention", "Signed storage change in km³: negative = storage decrease "
                                   "(depletion), positive = gain"),
            (S, "Components", "; ".join(f"{c.label} ← sheet '{c.sheet}', column '{c.column}'"
                                        for k, c in COMPONENTS.items() if self.has(k))),
            (S, "Totals", "Confined total = water expansion + matrix compaction. Combined total = "
                          "confined total + unconfined (spatial Sy); its range uses the Sy 0.1 and "
                          "Sy 0.3 scenarios. All share the 2015 baseline, so they add directly."),
        ]
        last = max(self.years)
        rows.append((S, f"{last} values", "; ".join(
            f"{COMPONENTS[k].short} {self.value(k, last):+.4f} km³" for k in COMPONENTS if self.has(k))))
        rows += [(S, "Check", c) for c in self.checks]
        rows += [(S, "Note", n) for n in self.notes]
        return rows
