"""
main.py — FastAPI REST Backend & Presentation Serving for AGNI-AI.
Ref: SRS-FIRMS-INDUSTRY-001 §3.1.5 (FR-API-01..08), §3.2.1, §3.2.2.

Provides:
  - GET /api/v1/thermal-anomalies (RFC 7946 GeoJSON FeatureCollection)
  - GET /api/v1/analytics/summary (and /api/v1/stats/summary)
  - GET /api/v1/config/public (Non-secret client config)
  - POST /api/v1/refresh (Rate-limited refresh endpoint)
  - GET /healthz (Service readiness & status)
  - Static file hosting for MapLibre WebGL UI
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from classifier import classify_anomalies
from config_keys import CONFIG, AppConfig
from ingestion import (
    build_overpass_bbox,
    fetch_firms_nrt,
    fetch_osm_industrial_polygons,
)

# -----------------------------------------------------------------------------
# FastAPI Application Setup
# -----------------------------------------------------------------------------
app = FastAPI(
    title="AGNI-AI REST API",
    description="Automated Geospatial Network for Industrial Heat Detection (SIH 2026 · PS 26162 · NTRO)",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------------------
# In-Memory Cache & State (FR-API-08: lock protected)
# -----------------------------------------------------------------------------
_cache_lock = threading.Lock()
_state: Dict[str, Any] = {
    "anomalies": [],
    "industrial_sites": [],
    "industrial_sites_count": 0,
    "updated_at_utc": None,
    "sources": [],
    "window_days": CONFIG.persistence_window_days,
    "demo_mode": CONFIG.demo_mode,
    "status": "initializing",
    "last_error": None,
    "last_refresh_timestamp": 0.0,
}


def run_pipeline() -> bool:
    """Synchronously runs ingestion, spatial buffering, and classification."""
    global _state
    try:
        raw_rows = fetch_firms_nrt(CONFIG)
        bbox = build_overpass_bbox(raw_rows, CONFIG.osm_search_radius_m)
        polygons = fetch_osm_industrial_polygons(bbox, CONFIG)
        classified = classify_anomalies(raw_rows, polygons, CONFIG)

        with _cache_lock:
            _state["anomalies"] = classified
            _state["industrial_sites"] = polygons
            _state["industrial_sites_count"] = len(polygons)
            _state["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
            _state["sources"] = sorted(list({c["source"] for c in classified}))
            _state["window_days"] = CONFIG.persistence_window_days
            _state["demo_mode"] = CONFIG.demo_mode
            _state["status"] = "ready"
            _state["last_error"] = None
            _state["last_refresh_timestamp"] = time.time()
        return True
    except Exception as exc:
        with _cache_lock:
            _state["status"] = "stale" if _state["anomalies"] else "initializing"
            _state["last_error"] = str(exc)
        return False


# Initial boot pipeline execution
run_pipeline()


# -----------------------------------------------------------------------------
# REST Endpoints
# -----------------------------------------------------------------------------
@app.get("/api/v1/config/public")
def get_public_config():
    """
    FR-API-03: Returns non-sensitive client configuration.
    Must never leak MAP_KEY or internal credentials (NFR-SEC-01..02).
    """
    tile_url = (
        f"https://api.maptiler.com/maps/streets-v2/{{z}}/{{x}}/{{y}}.png?key={CONFIG.maptiler_key}"
        if CONFIG.maptiler_key
        else CONFIG.default_tile_url
    )
    style_url = (
        f"https://api.maptiler.com/maps/streets-v2/style.json?key={CONFIG.maptiler_key}"
        if CONFIG.maptiler_key
        else None
    )

    with _cache_lock:
        return {
            "tile_url": tile_url,
            "style_url": style_url,
            "attribution": CONFIG.basemap_attribution,
            "demo_mode": _state["demo_mode"],
            "aoi": CONFIG.aoi_wsen,
            "window_days": _state["window_days"],
            "observation_window_days": _state["window_days"],
            "default_center": list(CONFIG.default_center),
            "default_zoom": CONFIG.default_zoom,
            "data_updated_at_utc": _state["updated_at_utc"],
            "status": _state["status"],
        }


@app.get("/api/v1/analytics/summary")
@app.get("/api/v1/stats/summary")
def get_analytics_summary():
    """
    FR-API-02: Returns JSON aggregate summary across anomaly classes.
    """
    with _cache_lock:
        if not _state["anomalies"] and _state["status"] == "initializing":
            raise HTTPException(
                status_code=status.HTTP(503),
                detail="Data layer not ready yet. Initial ingestion in progress.",
            )

        df = _state["anomalies"]
        by_class: Dict[str, Any] = {}

        for k in (1, 2, 3):
            sub = [d for d in df if d["class"] == k]
            count = len(sub)
            mean_frp = sum(d["frp_mw"] for d in sub) / count if count else 0.0
            mean_conf = sum(d["confidence"] for d in sub) / count if count else 0.0
            sub_prox = [d["proximity_m"] for d in sub if d["proximity_m"] is not None]
            mean_prox = sum(sub_prox) / len(sub_prox) if sub_prox else None
            mean_persist = sum(d["persistence_score"] for d in sub) / count if count else 0.0

            by_class[str(k)] = {
                "count": count,
                "mean_frp_mw": round(mean_frp, 2),
                "mean_confidence": round(mean_conf, 3),
                "mean_proximity_m": round(mean_prox, 1) if mean_prox is not None else None,
                "mean_persistence": round(mean_persist, 3),
            }

        dates = sorted([d["acq_date_utc"][:10] for d in df]) if df else []
        unique_pixels = {f"{d['snapped_lat']},{d['snapped_lon']}" for d in df}

        return {
            "total_detections": len(df),
            "unique_pixels": len(unique_pixels),
            "by_class": by_class,
            "industrial_sites_count": _state["industrial_sites_count"],
            "industrial_count": _state["industrial_sites_count"],
            "observation_window_days": _state["window_days"],
            "window_days": _state["window_days"],
            "date_min": dates[0] if dates else None,
            "date_max": dates[-1] if dates else None,
            "sources": _state["sources"],
            "demo_mode": _state["demo_mode"],
            "generated_at_utc": _state["updated_at_utc"],
            "updated_at_utc": _state["updated_at_utc"],
            "status": _state["status"],
        }


@app.get("/api/v1/thermal-anomalies")
def get_thermal_anomalies(
    date_from: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    classification: Optional[str] = Query(None, description="Comma-separated class IDs (1,2,3)"),
    min_frp: Optional[float] = Query(None, description="Minimum Fire Radiative Power (MW)"),
    max_results: int = Query(2000, ge=1, le=10000, description="Max feature count"),
):
    """
    FR-API-01: Returns RFC 7946 GeoJSON FeatureCollection of classified thermal anomalies.
    """
    with _cache_lock:
        if not _state["anomalies"] and _state["status"] == "initializing":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Data layer not ready yet.",
            )
        records = list(_state["anomalies"])

    # Apply filters with AND semantics
    if date_from:
        records = [r for r in records if r["acq_date_utc"][:10] >= date_from]
    if date_to:
        records = [r for r in records if r["acq_date_utc"][:10] <= date_to]
    if classification:
        allowed = {int(c.strip()) for c in classification.split(",") if c.strip().isdigit()}
        records = [r for r in records if r["class"] in allowed]
    if min_frp is not None:
        records = [r for r in records if r["frp_mw"] >= min_frp]

    records = records[:max_results]

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [r["longitude"], r["latitude"]],
            },
            "properties": {
                "class": r["class"],
                "class_label": r["class_label"],
                "confidence": r["confidence"],
                "proximity_m": r["proximity_m"],
                "persistence_score": r["persistence_score"],
                "persistence_days": r["persistence_days"],
                "frp_mw": r["frp_mw"],
                "brightness_temp_k": r["brightness_temp_k"],
                "acq_date_utc": r["acq_date_utc"],
                "source": r["source"],
                "satellite": r["satellite"],
                "instrument": r["instrument"],
                "daynight": r["daynight"],
                "confidence_pct": r["confidence_pct"],
                "confidence_raw": r["confidence_raw"],
                "industry_name": r["industry_name"],
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "snapped_lat": r["snapped_lat"],
                "snapped_lon": r["snapped_lon"],
            },
        }
        for r in records
    ]

    return {"type": "FeatureCollection", "features": features}


@app.post("/api/v1/refresh", status_code=status.HTTP_202_ACCEPTED)
def refresh_data(response: Response):
    """
    FR-API-04: Triggers pipeline refresh guarded by REFRESH_MIN_INTERVAL_S.
    """
    with _cache_lock:
        elapsed = time.time() - _state["last_refresh_timestamp"]
        if elapsed < CONFIG.refresh_min_interval_s:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Refresh rate limit exceeded. Retry in {int(CONFIG.refresh_min_interval_s - elapsed)}s",
            )

    success = run_pipeline()
    if not success:
        with _cache_lock:
            err = _state["last_error"] or "Provider ingestion failure"
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=err)

    with _cache_lock:
        return {
            "status": "ok",
            "refreshed_at_utc": _state["updated_at_utc"],
            "total_detections": len(_state["anomalies"]),
        }


@app.get("/healthz")
def healthz():
    """
    FR-API-05: Health and readiness check.
    """
    with _cache_lock:
        return {
            "status": "ok",
            "state": _state["status"],
            "data_updated_at_utc": _state["updated_at_utc"],
        }


@app.get("/favicon.ico")
def favicon():
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔥</text></svg>'
    return Response(content=svg, media_type="image/svg+xml")


@app.get("/")
def get_index():
    """FR-API-06: Serves map dashboard."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    index_path = os.path.join(base_dir, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path, media_type="text/html")
    return HTMLResponse("<h1>AGNI-AI</h1><p>Dashboard not found.</p>")


# Mount static root so app.js and assets are served directly
_base_dir = os.path.dirname(os.path.abspath(__file__))
app.mount("/", StaticFiles(directory=_base_dir, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=CONFIG.host, port=CONFIG.port, reload=False)
