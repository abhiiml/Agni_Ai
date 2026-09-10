# AGNI-AI — Automated Geospatial Network for Industrial Heat Detection

India-wide detection & classification of industrial fires, gas flares, and
persistent thermal anomalies by fusing **NASA FIRMS** (VIIRS/MODIS NRT) thermal
pixels with **OpenStreetMap** industrial footprints (Overpass API) and
spatiotemporal scoring. *(SIH 2026 · Problem Statement 26162 · NTRO)*

| Class | Label | Color | Signature |
|---|---|---|---|
| 1 | Industrial / flare | Orange | Inside / <1.5 km of an OSM industrial polygon with weighted evidence (proximity · persistence · FRP) |
| 2 | Wildfire / vegetation | Red | High FRP / brightness, moving front, non-industrial |
| 3 | Unclassified / noise | Gray | Low FRP, isolated (e.g. crop-residue burns) |

## Quick start (offline demo — no API key)

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows (`.venv/bin/pip` on macOS/Linux)
APP_DEMO_MODE=1 .venv/Scripts/python main.py       # or: copy .env.example -> .env and leave MAP_KEY empty
# open http://127.0.0.1:8000
```

The demo builds a deterministic synthetic India dataset (Jamnagar / Dahej /
Paradip / Visakhapatnam industrial zones, a central-India wildfire front,
Punjab stubble-burn noise) and runs it through the **real** ingestion +
classification code paths.

## Live mode

1. `cp .env.example .env` (or export env vars)
2. Set `MAP_KEY` — free NASA FIRMS key: https://firms.modaps.eosdis.nasa.gov/api/map_key/
3. Optional: `MAPTILER_KEY` for better basemap tiles (else free OSM tiles)
4. Run `python main.py` — the service fetches FIRMS NRT for the India bbox,
   queries OSM industrial polygons near detected pixels, classifies, and
   serves the layer. Data auto-refreshes every `REFRESH_TTL_MINUTES` (15).

## API

| Endpoint | Description |
|---|---|
| `GET /api/v1/thermal-anomalies` | GeoJSON layer; filters `date_from`, `date_to`, `classification` (`1,2,3`), `min_frp`, `max_results` |
| `GET /api/v1/stats/summary` | KPI aggregates (per-class counts, mean FRP/confidence/persistence/proximity, sources) |
| `GET /api/v1/analytics/summary` | Alias of the above (SRS FR-API-02 contract) |
| `POST /api/v1/refresh` | Force re-ingestion (rate-limited, `429` if too soon) |
| `GET /api/v1/config/public` | Secret-free client config (tile URL, mode, freshness) |
| `GET /healthz` | Liveness |

## India geographic constraint (CRITICAL)

- FIRMS AOI (provider order `west,south,east,north`): **`68.0,6.0,97.0,37.0`** (`INDIA_FIRMS_BBOX`)
- Overpass QL bbox (order `south,west,north,east`): **`(6.0,68.0,37.0,97.0)`** (`INDIA_OSM_BBOX`)
- Override `AOI` only with a *smaller* sub-region of India — never wider.
- Dashboard default view: `[78.9629, 20.5937]` (lon, lat), zoom 5.

## Modules

| File | Role |
|---|---|
| `config_keys.py` | **Only** place for secrets/endpoints; native `.env` loader; India bboxes |
| `ingestion.py` | FIRMS NRT fetcher (retry/backoff, CSV normalization) + Overpass QL industrial-polygon extractor |
| `classifier.py` | Grid-snapped 30-day-window persistence, UTM-projected ST_DWithin proximity, deterministic class + confidence rules |
| `demo.py` | Offline synthetic India dataset (feeds the real normalizers) |
| `main.py` | FastAPI service, lock-protected cache, refresh lifecycle, static hosting |
| `index.html` / `app.js` | MapLibre GL JS dashboard (KPI cards, filters, inspector) |
| `SRS_DOCUMENT.md` | IEEE-830-style specification |

### Notes / caveats
- FIRMS NRT area API returns at most 5 days per call, so `PERSISTENCE_WINDOW_DAYS`
  defaults to 5; the score is normalized over days actually present in the window
  (see SRS §2.5 for the 30-day/archive discussion).
- All thresholds are tunable via `.env` (`CLASS1_EVIDENCE_MIN`,
  `WILDFIRE_FRP_MIN_MW`, `WILDFIRE_BT_MIN_K`, `OSM_SEARCH_RADIUS_M`, …).
