# Software Requirements Specification (SRS)
## AI-Based Detection & Classification of Industrial Fires and Persistent Thermal Sources

| Field | Value |
|---|---|
| Document ID | SRS-FIRMS-INDUSTRY-001 |
| Version | 1.0 |
| Status | Approved for implementation |
| Classification | Internal |
| Primary data sources | NASA FIRMS (NRT), OpenStreetMap Overpass API, optional Copernicus/Sentinel-2 |
| Reference standard | IEEE Std 830-1998 (structure adapted) |

---

## 1. Introduction

### 1.1 Purpose
This document specifies the complete functional, non-functional, data, and external-interface
requirements for **AGNI-AI (Automated Geospatial Network for Industrial Heat Detection)** — a web
application, scoped to the India subcontinent (SIH 2026 · PS 26162 · NTRO), that automatically ingests
NASA FIRMS near-real-time (NRT) thermal-anomaly detections, matches them spatially against
OpenStreetMap (OSM) industrial footprints, scores their temporal persistence, and classifies each
anomaly as one of:

- **Class 1** — Gas Flare / Heavy Industrial Heat Source
- **Class 2** — Wildfire / Vegetation Fire
- **Class 3** — Thermal Anomaly / Agricultural Noise (unclassified thermal event)

The system exposes the classified layer through a REST API and renders it on an interactive,
high-performance WebGL map dashboard.

### 1.2 Scope
**In scope**

1. Real-time ingestion of FIRMS thermal-anomaly feeds (VIIRS S-NPP / NOAA-20 / NOAA-21 NRT, MODIS NRT).
2. Extraction of industrial land-use polygons (`industrial`, `landuse=industrial`, `power=plant`,
   `man_made=flare`) from OSM via the Overpass API within a configurable radius of detected anomalies.
3. Spatiotemporal analytics: nearest-industrial-site distance (ST_DWithin semantics), FRP statistics,
   and pixel-level temporal persistence scoring over a multi-day observation window.
4. Deterministic, explainable classification into the three classes above with a continuous confidence score.
5. A FastAPI REST backend exposing filtered anomaly layers and aggregate analytics.
6. A browser map dashboard (MapLibre GL JS) with class-coded symbology and metadata inspection.
7. A credential-isolated configuration module (`config_keys.py`) plus an `.env.example` template.

**Out of scope**

- Prediction/forecasting of fire spread.
- Sub-pixel thermal retrieval; FRP values are consumed as reported by FIRMS.
- Alerting/notification workflows, user accounts, and multi-tenant authorization.
- Backfill of full historical archives (only the NRT window is consumed; see §2.5).
- Sentinel-2 hotspot refinement is defined as an optional, interface-compatible extension (§4.4) and is
  not part of the core pipeline in v1.0.

### 1.3 Definitions and Acronyms

| Term | Definition |
|---|---|
| FIRMS | Fire Information for Resource Management System (NASA LANCE / EOSDIS). |
| NRT | Near Real Time — FIRMS products published ≤ ~60 min after satellite overpass. |
| Thermal anomaly / hotspot | A FIRMS detection pixel flagged as an active thermal event. |
| FRP | Fire Radiative Power, reported in megawatts (MW) per detection pixel. |
| BT | Brightness Temperature (K) at the detection pixel (VIIRS I-4 / MODIS channel 21/22). |
| ST_DWithin | PostGIS-style predicate: geometry A is within distance *d* of geometry B. |
| Persistence score | Fraction of days in the observation window on which the *same snapped pixel* reported a detection. |
| Snapped pixel | Detection coordinates quantized to the sensor native grid spacing (VIIRS ≈ 0.0034°, MODIS ≈ 0.01°) so that same-pixel detections from different overpasses compare equal. |
| AOI | Area Of Interest (bounding box, WGS-84). |
| OSM / Overpass | OpenStreetMap; its read-only query API. |
| EPSG:4326 | WGS-84 geographic CRS (degrees) — interchange/protocol CRS for GeoJSON & the APIs. |
| EPSG:326xx/327xx | UTM projected CRS (meters) — internal metric computation CRS. |
| GEOJson FeatureCollection | RFC 7946 encoding used between backend and frontend. |
| MAP_KEY | NASA FIRMS API credential identifier (official FIRMS nomenclature). |

### 1.4 References
1. NASA LANCE FIRMS — *API / area* documentation: `https://firms.modaps.eosdis.nasa.gov/api/area/`
2. NASA LANCE FIRMS — *Data availability* API: `https://firms.modaps.eosdis.nasa.gov/api/data_availability/`
3. OpenStreetMap Wiki — *Overpass API / Overpass QL*: `https://wiki.openstreetmap.org/wiki/Overpass_API`
4. RFC 7946 — *The GeoJSON Format*.
5. MapLibre GL JS documentation.
6. IEEE Std 830-1998 — *IEEE Recommended Practice for Software Requirements Specifications*.

### 1.5 System Overview
The system is a four-stage linear pipeline plus presentation layer:

```
NASA FIRMS (thermal pixels) ──► INGESTION ──► CLASSIFICATION ──► REST API ──► WEB MAP
OSM Overpass (industrial polygons) ──┘        (spatiotemporal scoring)
```

Ingestion is decoupled from classification through typed GeoDataFrames (EPSG:4326). Classification
outputs are serialized to GeoJSON and served by a FastAPI layer; a MapLibre GL JS frontend renders the
result. Full pipeline detail is specified in §5.

---

## 2. Overall Description

### 2.1 Product Perspective
The product is a self-contained web service (Python 3.10+, FastAPI, GeoPandas/Shapely) with a
static, CDN-loaded MapLibre frontend. It operates as an independent service and does not depend on a
legacy host. All external dependencies are network data providers, not software frameworks.

**Architecture layers**

| Layer | Module | Responsibility |
|---|---|---|
| Configuration | `config_keys.py` + `.env.example` | Sole owner of credentials, endpoints, operational defaults. |
| Ingestion | `ingestion.py` | FIRMS NRT fetch, OSM Overpass industrial-polygon fetch, CSV/JSON normalization, buffered spatial scoping. |
| Classification | `classifier.py` | Distance (ST_DWithin) computation, persistence scoring, class + confidence heuristics. |
| Service | `main.py` | FastAPI endpoints, in-memory state cache, refresh lifecycle, static hosting, offline demo mode. |
| Presentation | `index.html`, `app.js` | WebGL map dashboard, filters, summary, anomaly inspector. |

### 2.2 User Classes and Characteristics

| User class | Needs | Skill |
|---|---|---|
| Industrial safety / HSE analyst | Distinguish persistent flare & plant heat signatures from vegetation fires near their facilities. | GIS-literate; no programming. |
| Emergency operations (wildfire desk) | See candidate wildfire detections (Class 2) quickly, filtered by FRP/time. | Domain expert. |
| Data engineer / integrator | Stable REST contract, documented JSON schemas, clean GeoJSON. | Programmer. |
| Demo/decision maker | Offline demo mode with synthetic data, no credential setup. | Non-technical. |

### 2.3 Operating Environment
1. **Server**: Python ≥ 3.10, x86-64 Linux/macOS/Windows; 4 GB RAM, 2 vCPU minimum; outbound HTTPS to
   FIRMS and Overpass; process model: single Uvicorn worker (state is in-memory).
2. **Client**: any current Chromium/Firefox/Safari/Edge with WebGL 1.0+; no plugins; MapLibre GL JS
   v4.x served from pinned CDN; tiles from OSM (default) or MapTiler (optional key).
3. **Runtime data**: all transient state kept in memory; no database required in v1.0.

### 2.4 Design and Implementation Constraints
1. Credentials and third-party endpoints **must never** be hardcoded in business logic or frontend code;
   they are read exclusively from `config_keys.py` (backed by environment / `.env`).
2. Only lightweight, established geospatial primitives: GeoPandas, Shapely, pandas, requests, FastAPI.
3. Every function, loop, spatial operation, and API endpoint must carry an inline explanatory comment
   (block-level).
4. Code must be slim and DRY; no redundant setup, no duplicated transformation logic.
5. GeoJSON interchange **must** be EPSG:4326; all metric computation **must** run in a projected CRS
   (dynamic UTM zone) — never compute meters in EPSG:4326.
6. Classification must be deterministic and explainable (thresholds + weighted evidence), not an opaque
   ML black box; the term "AI-based" refers to automated spatiotemporal inference over fused data.
7. The system must be runnable in an offline demo mode without any API key.

### 2.5 Assumptions and Dependencies
1. **FIRMS NRT availability**: The NRT area API returns detections for the last N days (N ≤ 5 per the
   official day-range contract). A full 30-day persistence window is therefore *not* achievable with
   NRT alone; the window defaults to 5 days and is a documented, configurable constant
   (`PERSISTENCE_WINDOW_DAYS`). A 30-day target requires an SP/archive source or a local FIRMS dump.
2. **Rate limits**: FIRMS MAP_KEY quota is 5000 transactions / 10 minutes; public Overpass endpoints
   expect polite usage (recommended ≥ 10 s between calls). The system throttles and retries with
   exponential backoff.
3. **Cloud cover / overpass gaps**: missing detection on a given day does not prove absence of fire
   (cloud obscuration); persistence is therefore reported as a *lower-bound* indicator with this caveat.
4. **OSM completeness**: industrial footprints are as-complete-as-OSM; under-mapped regions lower the
   proximity signal (never breaks classification; absence degrades Class 1 recall only).
5. **Coordinate truth**: FIRMS CSV coordinates are WGS-84; VIIRS 375 m pixel centers may jitter by up to
   one pixel between overpasses — hence grid snapping (§1.3).
6. `MAP_KEY`, `OVERPASS_API_URL`, and tile configuration are provided by the operator via `.env`
   (see `.env.example`); an empty FIRMS key with `APP_DEMO_MODE=1` runs the offline demo.
7. Python wheel availability for GeoPandas ≥ 0.14 is assumed at deploy time.

---

## 3. Specific Requirements

### 3.1 Functional Requirements

#### 3.1.1 Data Ingestion (module `ingestion.py`)

| ID | Requirement |
|---|---|
| FR-ING-01 | The system shall retrieve FIRMS NRT thermal anomalies via `GET {FIRMS_BASE_URL}/api/area/csv/{MAP_KEY}/{source}/{area}/{day_range}` where `area` is `west,south,east,north` (WGS-84 degrees) per official FIRMS documentation, and `source` ∈ `{VIIRS_SNPP_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT, MODIS_NRT}`. |
| FR-ING-02 | The system shall fetch the most recent `PERSISTENCE_WINDOW_DAYS` (default 5, max 5 per API contract) days of data in one request; `day_range` shall never exceed 5 and shall never exceed the number of days the provider has data for. |
| FR-ING-03 | The system shall tolerate and normalize source CSV variance: numeric coercion of `frp`, `bright_ti4`/`bright_ti5` (→ `brightness_temp_k`), `latitude`, `longitude`; raw and numeric confidence (percent, or `low|nominal|high` → 30/60/90); `acq_date`+`acq_time` (HHMM) parsed to a UTC `datetime` column; rows with null lat/lon/date shall be dropped (never crash). |
| FR-ING-04 | The system shall construct an Overpass QL query fetching **polygon** footprints tagged `industrial=*`, `landuse=industrial`, `power=plant`, or `man_made=flare` (ways and relations, `out geom;`), restricted to an Overpass bbox `(south,west,north,east)` covering the union of anomaly locations buffered by `OSM_SEARCH_RADIUS_M` (default 2000 m). |
| FR-ING-05 | The Overpass bbox expansion shall convert meters to degrees correctly: latitude offset `R/111_320`, longitude offset `R/(111_320·cos(lat))`. |
| FR-ING-06 | Overpass responses shall be decoded from GeoJSON-format JSON to Shapely polygons (rings closed, ≥ 3 vertices, polygons made valid, deduplicated by OSM element id); each polygon shall retain its OSM `name` tag (nullable) for UI display. |
| FR-ING-07 | All outbound HTTP calls shall carry a connect/read timeout; transient failures (429/5xx) shall retry with exponential backoff capped at `MAX_RETRIES`; persistent failure shall raise a typed `IngestionError` that the service layer converts to HTTP 502 with a JSON error body — never a server crash. |
| FR-ING-08 | Ingestion outputs shall be typed GeoDataFrames in EPSG:4326: anomalies = point frame; industrial sites = polygon frame. Empty industrial results are a legal state (proximity signal = "far"). |
| FR-ING-09 | A `DEMO` ingestion mode shall generate a realistic synthetic dataset (industrial polygons + multi-day anomalies) when no MAP_KEY is configured, keeping the entire classification pipeline exercised end-to-end. |

#### 3.1.2 Spatial Proximity Buffering (ST_DWithin semantics)

| ID | Requirement |
|---|---|
| FR-PRX-01 | For every unique snapped anomaly pixel, the system shall compute `proximity_m` = Euclidean distance (m) to the **nearest** industrial polygon boundary, where points inside a polygon report `0`; computation shall run in a dynamic UTM zone (EPSG:326xx/327xx chosen from the dataset centroid) — meters are never computed in EPSG:4326. |
| FR-PRX-02 | When no industrial polygon exists within `OSM_SEARCH_RADIUS_M`, `proximity_m` shall be reported as `None` ("far"), with no null-pointer or join failures. |
| FR-PRX-03 | The system shall expose `near_industry_m` predicates consistent with ST_DWithin semantics: "within 500 m", "within 1500 m", "within 2000 m" booleans used by the classifier thresholds. |

#### 3.1.3 Temporal Persistence Calculation

| ID | Requirement |
|---|---|
| FR-PER-01 | Coordinates shall be snapped to the sensor grid (VIIRS 375 m ≈ 0.0034°, MODIS ≈ 0.01°; configurable per source) **before** persistence grouping, so sub-pixel overpass jitter does not split a recurring source. |
| FR-PER-02 | `persistence_score = (number of distinct observation days on which the snapped pixel was detected) / (number of days with data in the window)`, bounded to `[0,1]`. |
| FR-PER-03 | The system shall also record `persistence_days` (integer distinct-day count) so UI can show "3/5 days". |
| FR-PER-04 | Missing days caused by cloud cover or satellite schedule shall be documented as a lower-bound caveat (shown in UI tooltip/sidebar note). |
| FR-PER-05 | Persistence, proximity, and peak-FRP statistics are computed once per unique snapped pixel and joined back to every detection row, so repeated detections of the same pixel share identical context. |

#### 3.1.4 Classification Heuristics (module `classifier.py`)

Deterministic weighted-evidence rules. Component signals, all normalized to [0,1]:

| Signal | Formula | Meaning |
|---|---|---|
| `prox` | `clamp(1 − proximity_m / 2000, 0, 1)`; `None` → 0 | Closeness to industrial footprint |
| `persist` | persistence score §3.1.3 | Recurrence at the same pixel |
| `heat` | `clamp(frp_mw / 50, 0, 1)` | FRP intensity (50 MW ≈ saturating) |
| `E1` (industrial evidence) | `0.50·prox + 0.30·persist + 0.20·heat` | Weighted industrial signature |

| ID | Rule (applied per detection row, in order) |
|---|---|
| FR-CLS-01 | If `proximity_m ≤ 1500` **and** `E1 ≥ CLASS1_EVIDENCE_MIN (0.55)` → **Class 1** (Gas Flare / Heavy Industrial Heat Source), `confidence = E1`. Persistent flare pixels inside plant boundaries (prox≈1) with moderate FRP reach this via `persist`; transient high-FRP plant fires reach it via `prox`+`heat`. |
| FR-CLS-02 | Else if `frp_mw ≥ WILDFIRE_FRP_MIN_MW (6.0)` **or** `brightness_temp_k ≥ WILDFIRE_BT_MIN_K (330)` → **Class 2** (Wildfire / Vegetation Fire), `confidence = clamp(0.45 + 0.35·heat + 0.20·(1 − persist), 0, 0.95)`. |
| FR-CLS-03 | Else → **Class 3** (Thermal Anomaly / Agricultural Noise; gray "unclassified" bucket), `confidence = clamp(0.15 + 0.30·heat + 0.15·persist, 0, 0.6)` — low-FRP, low-persistence detections (typical ag burn / small source) can never exceed 0.6 confidence. |
| FR-CLS-04 | Class 1 takes precedence over Class 2 so an industrial-plant fire is not mislabeled wildfire; the classifier must be executed in rule order FR-CLS-01 → 02 → 03. |
| FR-CLS-05 | Every output row shall carry: `class` (1|2|3), `class_label`, `confidence` (0–1), `proximity_m`, `persistence_score`, `persistence_days`, `frp_mw`, `brightness_temp_k`, `acq_date_utc`, `source`, `satellite`, `daynight`, `industry_name` (nullable). |
| FR-CLS-06 | All thresholds (`CLASS1_EVIDENCE_MIN`, `WILDFIRE_FRP_MIN_MW`, `WILDFIRE_BT_MIN_K`, proximity radii) shall be module-level named constants overridable via environment for tuning, documented in `config_keys.py`. |
| FR-CLS-07 | All classification code paths shall tolerate empty anomaly frames, empty industrial frames, null FRP/BT, and null proximity without raising (empty-in → empty-out; null signals contribute 0 evidence). |

**Mapping to user classes:** Class 1 = persistent industrial/flare sources (typically **orange** on map),
Class 2 = vegetation/wildfire (typically **red**), Class 3 = unclassified thermal noise (typically **gray**).

#### 3.1.5 REST Endpoints (module `main.py`)

| ID | Endpoint | Behavior |
|---|---|---|
| FR-API-01 | `GET /api/v1/thermal-anomalies` | Returns RFC 7946 `FeatureCollection` of anomaly points in EPSG:4326. Query params (all optional): `date_from` (YYYY-MM-DD), `date_to` (YYYY-MM-DD), `classification` (int 1–3, repeatable or comma-separated), `min_frp` (MW), `max_results` (int, default 2000). Filters combine with AND; geometry `Point[lon, lat]`; each feature `properties` carries the FR-CLS-05 attribute set. |
| FR-API-02 | `GET /api/v1/analytics/summary` | JSON aggregate: `total_detections`, `unique_pixels`, `by_class{1,2,3} → {count, mean_frp_mw, mean_confidence, mean_proximity_m, mean_persistence}`, `industrial_sites_count`, `observation_window_days`, `date_min`, `date_max`, `sources[]`, `demo_mode`, `generated_at_utc`. |
| FR-API-03 | `GET /api/v1/config/public` | Non-secret client config: `tile_url`, `attribution`, `demo_mode`, `data_updated_at_utc`, `observation_window_days`. **Must never** expose MAP_KEY or any token. |
| FR-API-04 | `POST /api/v1/refresh` | Re-runs ingestion + classification synchronously, guarded by `REFRESH_MIN_INTERVAL_S` (default 60 s) → `429` if too soon; `202` with job timestamps on success; `502` typed error on provider failure. |
| FR-API-05 | `GET /healthz` | `{"status":"ok","state":"ready|refreshing|stale","data_updated_at_utc"}`; HTTP 200 even when stale, 503 only if never initialized. |
| FR-API-06 | `GET /` , `GET /app.js` | Serve the map dashboard (`web/` assets) with correct content types. |
| FR-API-07 | All error responses follow `{"detail": "<human message>"}` (FastAPI default); provider failures map to 502 with reason; validation errors to 422. |
| FR-API-08 | Endpoints shall be synchronous but non-blocking-safe: a `threading.Lock` guards cache reads/writes; refresh runs under the same lock so requests never observe a half-written dataset. |

#### 3.1.6 Interactive Mapping (UI)

| ID | Requirement |
|---|---|
| FR-UI-01 | The dashboard shall render anomalies as sized, colored circular markers on a zoomable/pannable WebGL map (MapLibre GL JS v4). Colors: Class 1 = orange `#F59E0B`, Class 2 = red `#EF4444`, Class 3 = gray `#9CA3AF`; marker radius scales with FRP (interpolated 3 px @ 0 MW → 18 px @ 100+ MW). |
| FR-UI-02 | A legend, class-count summary (from FR-API-02), and "last updated" label shall be always visible. |
| FR-UI-03 | Filter controls shall be provided: per-class visibility toggles (client-side layer filter), minimum-FRP slider, and date range (`date_from`/`date_to`) which trigger a server-side re-query (FR-API-01). |
| FR-UI-04 | Clicking any anomaly shall populate a sidebar inspector with: class + label + confidence, FRP (MW), brightness temperature (K), acquisition datetime (UTC), satellite/instrument, day/night, `proximity_m` to nearest industrial site with its OSM `name`, and persistence (`n/window days` + score), plus the cloud/overpass lower-bound caveat. |
| FR-UI-05 | A "Refresh data" button shall call FR-API-04; a status line shall surface 429/502 errors verbatim. |
| FR-UI-06 | Empty results (no anomalies matching filters) shall render a friendly empty state, not a blank/broken map. |
| FR-UI-07 | Tile source comes from FR-API-03 (OSM default; MapTiler when key configured); required OSM attribution shown. |
| FR-UI-08 | UI text must never embed keys or secrets; credentials never leave the server. |

### 3.2 Non-Functional Requirements

#### 3.2.1 Performance & Latency

| ID | Requirement |
|---|---|
| NFR-PERF-01 | Endpoint p95 latency ≤ 250 ms for both API endpoints on cached data (no provider calls on read paths). |
| NFR-PERF-02 | Full refresh cycle (ingest + classify + cache swap) ≤ 90 s for ≤ 10 000 detection rows and ≤ 5 000 OSM polygons on reference hardware (§2.3). |
| NFR-PERF-03 | Map must hold ≥ 10 000 point features at interactive frame rates (WebGL layer, vector GeoJSON source). |
| NFR-PERF-04 | Frontend bundle: zero build step, ≤ 1 CDN script + local `app.js`; total transfer ≤ ~300 KB gzip. |

#### 3.2.2 Security

| ID | Requirement |
|---|---|
| NFR-SEC-01 | All secrets (`MAP_KEY`, `MAPTILER_KEY`) exist only in environment/`.env`, read solely by `config_keys.py`; no secret ever appears in code, logs, GeoJSON, or API responses. |
| NFR-SEC-02 | The `config/public` endpoint and all GeoJSON payloads are audited secret-free (unit-tested property). |
| NFR-SEC-03 | Provider calls use HTTPS only; server binds `HOST`/`PORT` from config (default `127.0.0.1:8000`). |
| NFR-SEC-04 | Request validation via FastAPI/Pydantic types; bbox size limits prevent abuse (area request only issued from operator config, not user input). |

#### 3.2.3 Scalability & Reliability

| ID | Requirement |
|---|---|
| NFR-SCL-01 | Read endpoints are stateless w.r.t. data volume (cached GeoJSON); scale-out is achieved by adding read replicas over the same cache (documented deployment note). |
| NFR-SCL-02 | Provider failures never crash the service: last-good dataset remains served with `state:"stale"` until next successful refresh. |
| NFR-SCL-03 | Refresh is idempotent and concurrency-safe (single lock; duplicate `POST /refresh` within interval → 429). |
| NFR-SCL-04 | System logs structured one-line records (module, level, event, latency_ms) with secrets filtered. |

#### 3.2.4 Maintainability & Portability

| ID | Requirement |
|---|---|
| NFR-MNT-01 | Every module ≤ ~350 lines, one responsibility; shared config in one place (DRY). |
| NFR-MNT-02 | Python 3.10+; pinned-major dependencies (`requirements.txt`); pure-wheel GeoPandas deployment. |
| NFR-MNT-03 | Classification thresholds tunable via environment without code edits. |

### 3.3 Data Requirements (Dictionary)

| Field (canonical) | Type | Unit | Source | Nullable |
|---|---|---|---|---|
| latitude / longitude | float | deg WGS-84 | FIRMS | never (row dropped) |
| acq_date_utc | datetime | UTC | FIRMS (date+HHMM) | never |
| frp_mw | float | MW | FIRMS | yes |
| brightness_temp_k | float | K | FIRMS (VIIRS I-4 / MODIS ch21/22) | yes |
| confidence_raw | str | nominal / % | FIRMS | yes |
| confidence_pct | float | 0–100 | derived (nominal→30/60/90) | yes |
| daynight | str | D/N | FIRMS | yes |
| satellite, instrument, source | str | — | FIRMS | yes |
| snapped_lat / snapped_lon | float | deg | derived | never |
| proximity_m | float | m | derived (UTM) | yes (None = far) |
| persistence_days / persistence_score | int / float | days / [0,1] | derived | never |
| class | int | 1/2/3 | derived | never |
| class_label | str | enum | derived | never |
| confidence | float | [0,1] | derived | never |
| industry_name | str | — | OSM tag `name` | yes |
| geometry | Point | EPSG:4326 | derived | never |

**Cache semantics:** the in-memory cache holds the classified anomaly frame, the industrial polygon
frame, and a UTC timestamp; `REFRESH_TTL_MINUTES` (default 15) drives background auto-refresh.

---

## 4. External Interface Requirements

### 4.1 NASA FIRMS (NRT Area API)
- **Endpoint pattern**: `GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}`
- **AREA** format: `west,south,east,north` WGS-84 degrees (NOT Overpass order — see §4.2) or `world`.
- **DAY_RANGE**: 1–5 inclusive; requesting > 5 counts as multiple transactions per provider docs.
- **Sources**: `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `MODIS_NRT`
  (also `*_SP` standard processing with ~2–3 day latency).
- **Auth**: API key passed as a URL path element (`MAP_KEY`), never in query string.
- **Errors**: 400 bad request, 403 bad/expired key, 429 quota exceeded (`Retry-After` honored),
  5xx transient. See FR-ING-07 for handling.
- **Rate guidance**: quota 5000 transactions / 10 min; system additionally self-throttles ≥ 60 s
  between refresh cycles.
- **Output**: CSV with `latitude, longitude, bright_ti4, scan, track, acq_date, acq_time, satellite,
  instrument, confidence, version, bright_ti5, frp, daynight` (VIIRS); MODIS columns analogous.

### 4.2 OpenStreetMap Overpass API
- **Endpoint pattern**: `POST {OVERPASS_API_URL}/api/interpreter`, body `data=<overpass_ql>`.
- **Query contract**: `[out:json][timeout:60]; (way/relation with target tags)(s,w,n,e); out geom;`
- **bbox order**: `(south, west, north, east)` — latitude first, **opposite** of FIRMS area order;
  both orders are documented and unit-tested at the query-builder level.
- **Target tags**: `industrial=*`, `landuse=industrial`, `power=plant`, `man_made=flare`.
- **Etiquette**: ≥ 10 s spacing between calls, conservative bbox derived from buffered anomaly bounds,
  60 s timeout, backoff on 429/504.
- **Output**: JSON; `out geom` yields per-element `geometry: [{lat, lon}, …]` → Shapely polygons.
- **Fallback**: alternate public mirrors are configurable via `OVERPASS_API_URL`.

### 4.3 Map Tile API (basemap)
- **Default**: OSM raster tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png` — no key, OSM
  attribution mandatory (shown in UI).
- **Optional**: MapTiler raster `https://api.maptiler.com/maps/{style}/{z}/{x}/{y}.png?key={KEY}`
  when `MAPTILER_KEY` is configured.
- The chosen URL is delivered to the client exclusively through `GET /api/v1/config/public`
  (FR-API-03); the browser never holds the raw key (server injects it into the tile URL).

### 4.4 Copernicus / Sentinel-2 (optional, extension-ready)
- Sentinel-2 MSI provides 20 m thermal-adjacent SWIR contextual refinement for hotspot confirmation.
- v1.0 does not query it in the hot path; an interface-compatible adapter slot is reserved in
  `ingestion.py` (`fetch_sentinel_context(...)` stub documented as out-of-scope, raising
  `NotImplementedError` until enabled) so downstream verification (e.g., visual check of flare
  persistence on natural-color imagery) can be attached without pipeline changes.

---

## 5. System Data Flow Architecture

```
 D1  Operator config (.env) ──► config_keys.py ──► validated AppConfig
                                                      │
 D2  [DEMO mode? ──► synthetic frames]  ◄─────────────┤ (no MAP_KEY → offline demo)
        │                                             │
 D3  FIRMS area CSV ──► fetch_firms_nrt() ──► raw DataFrame
        │              (west,south,east,north, day_range≤5, retries, throttle)
        │   normalize: coerce numerics, UTC datetime, nominal→pct confidence,
        │   drop null-geometry rows ──► anomalies_gdf (EPSG:4326 points)
        │
 D4  Buffered bbox = bounds(anomalies) ⊕ OSM_SEARCH_RADIUS_M (deg-converted)
        │
 D5  Overpass QL (s,w,n,e) ──► fetch_osm_industrial_polygons() ──► Shapely polygons
        │              (rings closed, made valid, dedup by id, keep name) ──► industrial_gdf (EPSG:4326)
        │
 D6  classifier.attach_persistence(anomalies_gdf)
        │    grid-snap coords (source-dependent) → unique pixels →
        │    distinct-day count / window → persistence_score per pixel → join back to rows
        │
 D7  classifier.attach_proximity(anomalies_gdf, industrial_gdf)
        │    reproject to dynamic UTM → sjoin_nearest (ST_DWithin equivalent, meters)
        │    → proximity_m per unique pixel → join back → reproject result to EPSG:4326
        │
 D8  classifier.assign_classes(frame)  (rules FR-CLS-01..03)
        │    E1 evidence, class + class_label + confidence per row
        ▼
     classified_gdf (EPSG:4326) ──► cache (lock-protected) + generated_at_utc
        │
 D9  REST layer (main.py)            │   Web UI
   • /api/v1/thermal-anomalies ──────┼──► GeoJSON FeatureCollection
   • /api/v1/analytics/summary ──────┼──► JSON aggregates
   • /api/v1/config/public ──────────┼──► tile_url / demo flags
   • /api/v1/refresh ────────────────┘
        │
D10  app.js: fetch layer + summary → MapLibre WebGL circle layers (class-colored,
        FRP-scaled) → click ⇒ sidebar inspector (FRP, BT, proximity, persistence,
        confidence, industry name) ; filters ⇒ server re-query
        ▼
     Browser render: interactive WebGL map dashboard
```

**End-to-end latency budget:** D3–D8 refresh ≤ 90 s (NFR-PERF-02); read path D9–D10 ≤ 250 ms p95 on
cached data (NFR-PERF-01).

---

## Appendix A — Traceability Matrix (excerpt)

| Requirement | Module | Verified by |
|---|---|---|
| FR-ING-01..08 | `ingestion.py` | unit (query builder, normalization, retry) |
| FR-PRX-01..03 | `classifier.py` | unit (UTM distance vs known geometry) |
| FR-PER-01..05 | `classifier.py` | unit (snap + distinct-day) |
| FR-CLS-01..07 | `classifier.py` | unit (rule order, null frames) |
| FR-API-01..08 | `main.py` | API integration (demo mode) |
| FR-UI-01..08 | `web/` assets | browser smoke test |
| NFR-SEC-01..04 | `config_keys.py` + all | secret-scan audit |

*— End of SRS v1.0 —*
