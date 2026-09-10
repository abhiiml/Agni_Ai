"""
classifier.py — Spatiotemporal Proximity, Persistence, and Classification Heuristics.
Ref: SRS-FIRMS-INDUSTRY-001 §3.1.2 (FR-PRX-01..03), §3.1.3 (FR-PER-01..05),
     §3.1.4 (FR-CLS-01..07), §3.3 (Data Dictionary).

Deterministic, explainable rule-based scoring:
  - Metric distance evaluated in dynamic UTM projection (EPSG:326xx/327xx).
  - Persistence quantized to sensor grid (VIIRS 0.0034°, MODIS 0.0100°).
  - Industrial evidence E1 = 0.50*prox + 0.30*persist + 0.20*heat.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from config_keys import CONFIG, AppConfig

CLASS_LABELS: Dict[int, str] = {
    1: "Gas Flare / Heavy Industrial Heat Source",
    2: "Wildfire / Vegetation Fire",
    3: "Thermal Anomaly / Agricultural Noise",
}


def get_snap_step(source: Optional[str]) -> float:
    """FR-PER-01: Grid quantization step based on sensor native resolution."""
    if source and source.upper().startswith("VIIRS"):
        return 0.0034  # VIIRS 375m native pixel spacing
    return 0.0100      # MODIS 1km native pixel spacing


def get_utm_epsg(lon: float, lat: float) -> int:
    """FR-PRX-01: Derives UTM EPSG code (EPSG:326xx North, EPSG:327xx South)."""
    zone = int(math.floor((lon + 180.0) / 6.0)) + 1
    return 32600 + zone if lat >= 0 else 32700 + zone


def project_wgs84_to_utm(lat: float, lon: float, central_lon: float) -> Tuple[float, float]:
    """
    FR-PRX-01: Transverse Mercator forward projection for metric Euclidean computation.
    """
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = 2 * f - f * f
    e_prime2 = e2 / (1.0 - e2)
    k0 = 0.9996

    lat_rad = math.radians(lat)
    lon_rad = math.radians(lon)
    lon0_rad = math.radians(central_lon)

    sin_lat = math.sin(lat_rad)
    cos_lat = math.cos(lat_rad)
    tan_lat = math.tan(lat_rad)

    n = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    t = tan_lat * tan_lat
    c = e_prime2 * cos_lat * cos_lat
    A = (lon_rad - lon0_rad) * cos_lat

    m0 = 1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0
    m1 = 3.0 * e2 / 8.0 + 3.0 * e2 * e2 / 32.0 + 45.0 * e2 * e2 * e2 / 1024.0
    m2 = 15.0 * e2 * e2 / 256.0 + 45.0 * e2 * e2 * e2 / 1024.0
    m3 = 35.0 * e2 * e2 * e2 / 3072.0

    M = a * (
        m0 * lat_rad
        - m1 * math.sin(2.0 * lat_rad)
        + m2 * math.sin(4.0 * lat_rad)
        - m3 * math.sin(6.0 * lat_rad)
    )

    x = k0 * n * (
        A
        + (1.0 - t + c) * (A ** 3) / 6.0
        + (5.0 - 18.0 * t + t * t + 72.0 * c - 58.0 * e_prime2) * (A ** 5) / 120.0
    ) + 500000.0

    y = k0 * (
        M
        + n * tan_lat * (
            (A ** 2) / 2.0
            + (5.0 - t + 9.0 * c + 4.0 * c * c) * (A ** 4) / 24.0
            + (61.0 - 58.0 * t + t * t + 600.0 * c - 330.0 * e_prime2) * (A ** 6) / 720.0
        )
    )
    if lat < 0:
        y += 10000000.0

    return x, y


def distance_point_to_plant_utm(
    pt_x: float, pt_y: float, plant: Dict[str, Any], central_lon: float
) -> float:
    """
    Computes Euclidean distance (meters) in UTM from point to polygon bounding/vertices.
    Inside polygon = 0.
    """
    # If explicit coordinates exist
    coords = plant.get("coordinates")
    if coords and len(coords) >= 3:
        utm_poly = [project_wgs84_to_utm(p[1], p[0], central_lon) for p in coords]
        # Point-in-polygon ray casting
        inside = False
        n_vert = len(utm_poly)
        j = n_vert - 1
        for i in range(n_vert):
            xi, yi = utm_poly[i]
            xj, yj = utm_poly[j]
            if ((yi > pt_y) != (yj > pt_y)) and (pt_x < (xj - xi) * (pt_y - yi) / (yj - yi + 1e-12) + xi):
                inside = not inside
            j = i
        if inside:
            return 0.0

        # Minimum distance to segment
        min_dist = float("inf")
        for i in range(n_vert):
            x1, y1 = utm_poly[i]
            x2, y2 = utm_poly[(i + 1) % n_vert]
            dx, dy = x2 - x1, y2 - y1
            l2 = dx * dx + dy * dy
            if l2 == 0:
                d = math.hypot(pt_x - x1, pt_y - y1)
            else:
                t = max(0.0, min(1.0, ((pt_x - x1) * dx + (pt_y - y1) * dy) / l2))
                proj_x = x1 + t * dx
                proj_y = y1 + t * dy
                d = math.hypot(pt_x - proj_x, pt_y - proj_y)
            if d < min_dist:
                min_dist = d
        return min_dist

    # Fallback to bbox
    minx, maxx = plant["minx"], plant["maxx"]
    miny, maxy = plant["miny"], plant["maxy"]
    utm_min = project_wgs84_to_utm(miny, minx, central_lon)
    utm_max = project_wgs84_to_utm(maxy, maxx, central_lon)
    ux_min, ux_max = min(utm_min[0], utm_max[0]), max(utm_min[0], utm_max[0])
    uy_min, uy_max = min(utm_min[1], utm_max[1]), max(utm_min[1], utm_max[1])

    if ux_min <= pt_x <= ux_max and uy_min <= pt_y <= uy_max:
        return 0.0

    closest_x = max(ux_min, min(ux_max, pt_x))
    closest_y = max(uy_min, min(uy_max, pt_y))
    return math.hypot(pt_x - closest_x, pt_y - closest_y)


def classify_anomalies(
    raw_rows: List[Dict[str, Any]],
    industrial_sites: List[Dict[str, Any]],
    cfg: AppConfig = CONFIG,
) -> List[Dict[str, Any]]:
    """
    FR-CLS-01..07: Applies full deterministic classification pipeline.
    """
    if not raw_rows:
        return []

    # 1. Grid snapping & observation-day tracking
    pixel_day_sets: Dict[str, set] = {}
    for row in raw_rows:
        step = get_snap_step(row.get("source"))
        snapped_lat = round(row["latitude"] / step) * step
        snapped_lon = round(row["longitude"] / step) * step
        row["snapped_lat"] = round(snapped_lat, 5)
        row["snapped_lon"] = round(snapped_lon, 5)
        key = f"{row['snapped_lat']:.5f},{row['snapped_lon']:.5f}"
        if key not in pixel_day_sets:
            pixel_day_sets[key] = set()
        pixel_day_sets[key].add(row["acq_date"])

    all_days = {r["acq_date"] for r in raw_rows}
    denom_window = max(1, min(cfg.persistence_window_days, len(all_days)))

    # Dataset centroid for dynamic UTM projection
    mid_lon = sum(r["longitude"] for r in raw_rows) / len(raw_rows)
    mid_lat = sum(r["latitude"] for r in raw_rows) / len(raw_rows)
    utm_zone = int(math.floor((mid_lon + 180.0) / 6.0)) + 1
    central_lon = (utm_zone - 1) * 6 - 180 + 3

    classified: List[Dict[str, Any]] = []

    for row in raw_rows:
        key = f"{row['snapped_lat']:.5f},{row['snapped_lon']:.5f}"
        distinct_days = len(pixel_day_sets.get(key, {row["acq_date"]}))
        persistence_score = min(1.0, distinct_days / denom_window)

        # UTM projection for metric distance
        ux, uy = project_wgs84_to_utm(row["latitude"], row["longitude"], central_lon)

        # Proximity to nearest industrial plant
        min_dist = float("inf")
        closest_plant: Optional[Dict[str, Any]] = None
        for plant in industrial_sites:
            d = distance_point_to_plant_utm(ux, uy, plant, central_lon)
            if d < min_dist:
                min_dist = d
                closest_plant = plant

        in_range = min_dist <= cfg.osm_search_radius_m
        proximity_m = round(min_dist, 1) if in_range else None
        industry_name = closest_plant["name"] if in_range and closest_plant else None

        # Normalized feature signals [0, 1]
        frp_mw = float(row.get("frp") or 0.0)
        bt_k = float(row.get("bright_ti4") or 0.0)
        heat = min(1.0, max(0.0, frp_mw / 50.0))
        persist = persistence_score
        prox = max(0.0, 1.0 - (proximity_m / 2000.0)) if proximity_m is not None else 0.0

        # E1 industrial evidence
        e1 = 0.50 * prox + 0.30 * persist + 0.20 * heat

        # Rules in strict precedence order
        # FR-CLS-01: Class 1
        is_class1 = (proximity_m is not None and proximity_m <= 1500.0) and (e1 >= cfg.class1_evidence_min)

        # FR-CLS-02: Class 2
        is_class2 = not is_class1 and (
            frp_mw >= cfg.wildfire_frp_min_mw or bt_k >= cfg.wildfire_bt_min_k
        )

        # FR-CLS-03: Class 3
        if is_class1:
            klass = 1
            conf = min(1.0, max(0.0, e1))
        elif is_class2:
            klass = 2
            conf = min(0.95, max(0.0, 0.45 + 0.35 * heat + 0.20 * (1.0 - persist)))
        else:
            klass = 3
            conf = min(0.60, max(0.0, 0.15 + 0.30 * heat + 0.15 * persist))

        time_int = int(row.get("acq_time") or 0)
        hh = f"{time_int // 100:02d}"
        mm = f"{time_int % 100:02d}"
        acq_date_utc = f"{row['acq_date']}T{hh}:{mm}:00Z"

        classified.append({
            "class": klass,
            "class_label": CLASS_LABELS[klass],
            "confidence": round(conf, 3),
            "proximity_m": proximity_m,
            "persistence_score": round(persistence_score, 2),
            "persistence_days": distinct_days,
            "frp_mw": frp_mw,
            "brightness_temp_k": bt_k,
            "acq_date_utc": acq_date_utc,
            "source": row.get("source", "VIIRS_SNPP_NRT"),
            "satellite": row.get("satellite", "VIIRS"),
            "instrument": row.get("instrument", "VIIRS"),
            "daynight": row.get("daynight", "D"),
            "confidence_pct": row.get("confidence_pct", 60.0),
            "confidence_raw": str(row.get("confidence", "nominal")),
            "industry_name": industry_name,
            "latitude": round(row["latitude"], 5),
            "longitude": round(row["longitude"], 5),
            "snapped_lat": row["snapped_lat"],
            "snapped_lon": row["snapped_lon"],
        })

    classified.sort(key=lambda x: x["acq_date_utc"], reverse=True)
    return classified
