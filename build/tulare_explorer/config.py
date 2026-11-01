# -*- coding: utf-8 -*-
"""Shared constants, colours and styling for the Tulare Basin explorer."""

import matplotlib

FIRST_YEAR, LAST_YEAR = 1971, 2023
M_PER_FT = 0.3048
FT_PER_M = 1.0 / M_PER_FT

AQUIFERS = ("Confined", "Unconfined")
CLASSES = ("Confined", "Semi-confined", "Unconfined")

# Aquifer-class colours (wells and the matching surface lines). Distinct, colour-blind
# friendly hues; markers always get a dark edge so they stand out on any raster ramp.
CLASS_COLORS = {"Confined": "#1E5AA8", "Semi-confined": "#14A44D", "Unconfined": "#EE7A12"}
SURFACE_COLORS = {"Confined": "#1E5AA8", "Unconfined": "#EE7A12"}
MARKER_EDGE = "#14202B"

SHAPEFILES = [
    ("final_classified_wells_inside_clay.shp", "Inside clay"),
    ("outside_classification_5km_updated.shp", "Outside clay, 5 km zone"),
    ("_classified_outside_buffer.shp", "Outside buffer"),
    ("aquifer_type_by_prf_projected.shp", "Perforation-based"),
]

# The three surface products. Annual change and the vertical head difference were
# removed in version 2.
PRODUCTS = [
    ("head", "Absolute groundwater head"),
    ("cumulative", "Cumulative head change (base year → selected year)"),
    ("sum", "Provided cumulative head change (1971–2023)"),
]

# Drought periods, as used in basin_summary/groundwater_level_plots.py and noted in
# the storage workbook. Shading spans start year to end year on the year axis,
# matching that script.
DROUGHT_PERIODS = [(1976, 1977), (1987, 1992), (2007, 2009), (2012, 2016), (2020, 2022)]
DROUGHT_COLOR = "#8C8C8C"
DROUGHT_ALPHA = 0.18

# Palette
INK = "#1F2A33"
MUTED = "#5B6B76"
ACCENT = "#1D6A8F"
PANEL = "#F3F5F6"
LINE = "#D5DCE1"
SELECT = "#D7263D"
BASIN_LINE = "#3B3B3B"
LOSS_COLOR = "#B2182B"

STYLESHEET = f"""
QWidget {{ font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
           font-size: 9.5pt; color: {INK}; }}
QMainWindow, QWidget#controlPanel, QScrollArea {{ background: {PANEL}; }}
QGroupBox {{ background: #FFFFFF; border: 1px solid {LINE}; border-radius: 4px;
             margin-top: 16px; padding: 10px 8px 8px 8px; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 8px; padding: 0 4px;
                    color: {ACCENT}; }}
QPushButton {{ background: {ACCENT}; color: #FFFFFF; border: none;
               border-radius: 3px; padding: 5px 10px; }}
QPushButton:hover {{ background: #17587A; }}
QPushButton:pressed {{ background: #124660; }}
QPushButton:disabled {{ background: #A9BAC4; }}
QPushButton#secondary {{ background: #FFFFFF; color: {ACCENT};
                         border: 1px solid {ACCENT}; }}
QPushButton#secondary:hover {{ background: #E8F1F6; }}
QTabWidget::pane {{ border: 1px solid {LINE}; background: #FFFFFF; }}
QTabBar::tab {{ background: {PANEL}; border: 1px solid {LINE}; border-bottom: none;
                padding: 6px 14px; margin-right: 2px; color: {MUTED}; }}
QTabBar::tab:selected {{ background: #FFFFFF; color: {INK}; }}
QTabBar::tab:disabled {{ color: #B0BAC0; }}
QSlider::groove:horizontal {{ height: 4px; background: {LINE}; border-radius: 2px; }}
QSlider::sub-page:horizontal {{ background: {ACCENT}; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: #FFFFFF; border: 2px solid {ACCENT};
                              width: 12px; margin: -6px 0; border-radius: 7px; }}
QSlider::handle:horizontal:disabled {{ border-color: #A9BAC4; }}
QTextBrowser {{ background: #FFFFFF; border: 1px solid {LINE}; }}
QStatusBar {{ color: {MUTED}; }}
QLabel#hint {{ color: {MUTED}; }}
QLabel#fixedPeriod {{ color: {ACCENT}; font-size: 11pt; }}
QFrame#card {{ background: #FFFFFF; border: 1px solid {LINE}; border-radius: 4px; }}
QLabel#cardTitle {{ color: {MUTED}; }}
QLabel#cardValue {{ font-size: 15pt; color: {INK}; }}
QLabel#cardNote {{ color: {MUTED}; font-size: 8.5pt; }}
"""


def apply_rcparams():
    matplotlib.rcParams.update({
        "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9,
        "axes.edgecolor": "#8A979F", "axes.labelcolor": INK,
        "xtick.color": MUTED, "ytick.color": MUTED, "axes.titleweight": "normal",
        "axes.spines.top": False, "axes.spines.right": False,
        "legend.frameon": False, "legend.fontsize": 8,
    })
