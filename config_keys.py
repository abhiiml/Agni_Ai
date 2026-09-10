"""
config_keys.py — Central configuration & credential isolation for AGNI-AI.
Ref: SRS-FIRMS-INDUSTRY-001 §2.1, §2.4, §3.1.4, §3.2.2 (NFR-SEC-01..03).

All credentials, endpoints, coordinate bounding boxes, and classification
thresholds are isolated here. No secret is ever hardcoded in business logic.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class AppConfig:
    """Application runtime configuration backed by environment variables."""

    # Credentials (NFR-SEC-01: isolated, never logged or leaked to client)
    map_key: str = os.getenv("MAP_KEY", "").strip()
    maptiler_key: str = os.getenv("MAPTILER_KEY", "").strip()

    # External Provider Endpoints (§4.1, §4.2)
    firms_base_url: str = os.getenv(
        "FIRMS_BASE_URL", "https://firms.modaps.eosdis.nasa.gov"
    ).rstrip("/")
    overpass_api_url: str = os.getenv(
        "OVERPASS_API_URL", "https://overpass-api.de/api/interpreter"
    )

    # Spatial Bounds: India Subcontinent (west, south, east, north in WGS-84)
    aoi_wsen: str = os.getenv("AOI", "68.0,6.0,97.0,37.0")

    # Pipeline Operation Parameters
    persistence_window_days: int = int(os.getenv("PERSISTENCE_WINDOW_DAYS", "5"))
    osm_search_radius_m: float = float(os.getenv("OSM_SEARCH_RADIUS_M", "2000.0"))

    # Classification Thresholds (FR-CLS-01..07)
    class1_evidence_min: float = float(os.getenv("CLASS1_EVIDENCE_MIN", "0.55"))
    wildfire_frp_min_mw: float = float(os.getenv("WILDFIRE_FRP_MIN_MW", "6.0"))
    wildfire_bt_min_k: float = float(os.getenv("WILDFIRE_BT_MIN_K", "330.0"))

    # Refresh & Cache Policies (§3.1.5, §3.3)
    refresh_ttl_minutes: int = int(os.getenv("REFRESH_TTL_MINUTES", "15"))
    refresh_min_interval_s: int = int(os.getenv("REFRESH_MIN_INTERVAL_S", "60"))

    # Demo Mode Flag (SRS §2.4 constraint 7: runs offline without API keys)
    demo_mode: bool = (
        os.getenv("APP_DEMO_MODE", "").lower() in ("1", "true", "yes")
        or not os.getenv("MAP_KEY", "").strip()
    )

    # UI Presentation Defaults (FR-UI-01..07)
    default_center: Tuple[float, float] = (78.9629, 20.5937)  # lon, lat
    default_zoom: int = 5
    default_tile_url: str = (
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
    )
    basemap_attribution: str = (
        "Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, USGS &middot; "
        "&copy; OpenStreetMap contributors"
    )

    # Server Network Binding
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))

    @property
    def aoi_tuple(self) -> Tuple[float, float, float, float]:
        """Returns (west, south, east, north) floats."""
        parts = [float(p.strip()) for p in self.aoi_wsen.split(",")]
        return parts[0], parts[1], parts[2], parts[3]


# Global singleton configuration
CONFIG = AppConfig()
