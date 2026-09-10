/* =============================================================================
 * app.js — MapLibre GL JS dashboard logic (FR-UI-01..08)
 * -----------------------------------------------------------------------------
 * Data flow:
 *   1. GET /api/v1/config/public → basemap tile URL, mode, freshness.
 *   2. Build the MapLibre map with a FULLY INLINE style (raster basemap +
 *      empty anomaly source + three class-colored circle layers) — no external
 *      style.json fetch is ever needed.
 *   3. GET summary + anomalies (whole observation window) → setData → render.
 *   4. Filters (class chips, min-FRP slider, date range) are applied as native
 *      MapLibre *expression* layer filters.
 *   5. Marker click → sidebar inspector with source metadata (FR-UI-04).
 * No secret or API key ever appears in this file (NFR-SEC-01/02).
 * ========================================================================== */

"use strict";

// -----------------------------------------------------------------------------
// Backend base URL — empty string uses relative paths against current origin
// -----------------------------------------------------------------------------
const API_BASE_URL = "";

// -----------------------------------------------------------------------------
// Dashboard state (module-level, read/written by every handler below)
// -----------------------------------------------------------------------------
const state = {
  config: null,          // public server config (tile URL, demo flag, window)
  summary: null,         // analytics summary payload (counts by class)
  geoJson: null,         // FeatureCollection of the full observation window
  visible: new Set([1, 2, 3]),   // classes currently shown on the map
  minFrp: 0,             // minimum FRP slider value (MW)
  dateFrom: "",          // 'YYYY-MM-DD' inclusive (UTC), "" = unbounded
  dateTo: "",            // 'YYYY-MM-DD' inclusive (UTC), "" = unbounded
};

// Class → visual metadata, kept in one table for DRY rendering
const CLASSES = {
  1: { color: "#f59e0b", short: "Industrial / flare" },    // orange (Class 1)
  2: { color: "#ef4444", short: "Wildfire" },              // red (Class 2)
  3: { color: "#9ca3af", short: "Noise / unclassified" },  // gray (Class 3)
};
const LAYER_IDS = ["anom-1", "anom-2", "anom-3"];  // one circle layer per class

let map = null;   // MapLibre instance — created in boot() once config is known

// DOM helpers (avoids repeating document.getElementById everywhere)
const $ = (id) => document.getElementById(id);
const setStatus = (msg, isError = false) => {
  const el = $("status");
  el.textContent = msg;
  el.className = isError ? "err" : "";
};

// -----------------------------------------------------------------------------
// API helper: fetch JSON from our own backend, surfacing HTTP errors cleanly
// -----------------------------------------------------------------------------
async function api(path, options) {
  // Always talk to the backend through the absolute API_BASE_URL prefix
  const resp = await fetch(`${API_BASE_URL}${path}`, options);
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Surface FastAPI {"detail": ...} bodies (incl. refresh 429/502)
    const detail = body.detail;
    const msg = typeof detail === "object"
      ? (detail.message || JSON.stringify(detail))
      : (detail || `HTTP ${resp.status}`);
    throw new Error(msg);
  }
  return body;
}

// Empty RFC-7946 FeatureCollection used until the first data arrives
function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

// -----------------------------------------------------------------------------
// Basemap selection — resilient: vector GL style by default (CartoDB Dark
// Matter when no key), inline OSM raster as a guaranteed local fallback so
// the map can never stay blank (bug fix: config 404 / style fetch failure).
// -----------------------------------------------------------------------------
// Free keyless DARK raster tiles: Esri World Dark Gray Canvas (no API key,
// no watermark). Raster tiles load as plain <img> requests — NOT subject to
// the style-JSON CORS block. CartoDB dark_all was considered but Carto now
// watermarks anonymous basemap requests ("API KEY REQUIRED" overlay).
// NOTE: literal host, no {s}/{r} tokens — templated placeholders in the host
// portion can leak to DNS as net::ERR_NAME_NOT_RESOLVED tile errors.
// Esri scheme is z/y/x (longitude/latitude reversed vs. OSM).
const ESRI_DARK_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const ESRI_SATELLITE_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_STREET_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const OSM_RASTER_FALLBACK = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
// Combined attribution covers every basemap offered by the switcher below
const BASEMAP_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, USGS &middot; ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Layer-switcher basemap registry: dark (default), high-res satellite, street
const BASEMAPS = {
  dark:      { label: "🌙 Dark (default)", url: ESRI_DARK_TILES },
  satellite: { label: "🛰 Satellite (Esri imagery)", url: ESRI_SATELLITE_TILES },
  street:    { label: "🧭 Street (Esri road map)", url: ESRI_STREET_TILES },
};

// Minimal basemap layer switcher — MapLibre has no built-in `L.control.layers`
// (that is Leaflet API); this custom control swaps the raster source tiles in
// place via setTiles(), i.e. no full style reload when the user switches.
class BasemapSwitcher {
  onAdd(m) {
    this._map = m;
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl agni-basemap";
    const sel = document.createElement("select");   // one option per basemap
    sel.setAttribute("aria-label", "Basemap layer");
    Object.entries(BASEMAPS).forEach(([key, bm]) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = bm.label;
      sel.appendChild(opt);
    });
    sel.value = "dark";  // default matches the keyless dark basemap
    sel.addEventListener("change", () => this._apply(sel.value));
    this._container.appendChild(sel);
    return this._container;
  }
  // Swap the raster basemap source to the selected tile URL (no style reload)
  _apply(key) {
    const url = BASEMAPS[key] && BASEMAPS[key].url;
    if (url && this._map.getSource("basemap")) this._map.getSource("basemap").setTiles([url]);
  }
  onRemove() {
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
  }
}

// Minimal local raster style (no network style fetch) — used when the vector
// style URL cannot be reached, guaranteeing a non-blank map offline.
function inlineRasterStyle(tiles) {
  return {
    version: 8,
    sources: { basemap: { type: "raster", tiles: [tiles], tileSize: 256 } },
    layers: [{ id: "basemap-layer", type: "raster", source: "basemap" }],
  };
}

// Add the anomaly source + one circle layer per class (idempotent: runs on
// every style load, whether the style came from a URL or from setStyle()).
function ensureAnomalyLayers() {
  if (map.getSource("anomalies")) return;  // already present for this style
  map.addSource("anomalies", { type: "geojson", data: emptyFC() });
  [1, 2, 3].forEach((klass) => {
    map.addLayer({
      id: `anom-${klass}`,
      type: "circle",
      source: "anomalies",
      filter: ["==", ["get", "class"], klass],  // replaced per filter change
      paint: {
        "circle-color": CLASSES[klass].color,
        "circle-opacity": 0.55,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#0b1220",
        // Marker diameter interpolates with FRP: 0 MW → 4px … 150 MW → 22px
        "circle-radius": [
          "interpolate", ["linear"], ["coalesce", ["get", "frp_mw"], 0],
          0, 4, 10, 7, 25, 11, 50, 16, 150, 22,
        ],
      },
    });
  });
}

async function boot() {
  // 1) Fetch the secret-free server config (basemap, India camera, freshness).
  //    On ANY failure (404/network) we keep going with safe local defaults so
  //    the dashboard still boots instead of sticking on LOADING.
  try {
    state.config = await api("/api/v1/config/public");
  } catch (err) {
    // Server unreachable → boot with safe local defaults (Carto dark tiles)
    state.config = {
      style_url: null,                    // no vector style → inline raster path
      tile_url: ESRI_DARK_TILES,          // keyless dark raster default
      attribution: BASEMAP_ATTRIBUTION,
      demo_mode: false,
      window_days: 5,
      default_center: [78.9629, 20.5937], // AGNI-AI India default camera
      default_zoom: 5,
    };
    setStatus(`Config endpoint unavailable — ${err.message} (fallback basemap)`, true);
  }

  // 2) Camera + style: use the server's vector GL style ONLY when a paid key
  //    is configured (MapTiler); otherwise build an inline raster style from
  //    the server tile URL — CartoDB Dark tiles by default (no CORS, no key).
  const [cx, cy] = state.config.default_center || [78.9629, 20.5937];
  const zoom = state.config.default_zoom != null ? state.config.default_zoom : 5;
  const style = state.config.style_url
    ? state.config.style_url
    : inlineRasterStyle(state.config.tile_url || ESRI_DARK_TILES);

  map = new maplibregl.Map({
    container: "map",
    center: [cx, cy],   // India subcontinent (SIH PS 26162) — [lon, lat]
    zoom,
    attributionControl: false,   // added manually below with provider text
    style,
  });

  // Provider attribution from the server config (OSM/MapTiler/CartoDB)
  map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: state.config.attribution,
  }));
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  // Keep the switcher on the map side; the fixed sidebar covers top-right.
  map.addControl(new BasemapSwitcher(), "top-left");

  // 3) Basemap resilience — never a blank map:
  //    (a) a vector style URL that fails to load → swap to the inline raster
  //        style (no basemap source exists yet);
  //    (b) 3+ tiles of the raster basemap fail (host DNS/CORS blocked) → swap
  //        the tile URL to the OSM raster fallback exactly once.
  let basemapErrors = 0;
  map.on("error", (e) => {
    if (e.sourceId === "basemap") basemapErrors += 1;  // count tile failures
    const msg = String((e.error && e.error.message) || "");
    const styleFailed = /style|fetch|network/i.test(msg) && !map.getSource("basemap");
    if (!state.styleFallbackDone && (styleFailed || basemapErrors >= 3)) {
      state.styleFallbackDone = true;  // swap exactly once per session
      try { map.setStyle(inlineRasterStyle(OSM_RASTER_FALLBACK)); } catch (_) { /* ignore */ }
    }
  });

  // 4) Wire interactions + data on every style load (once for events/filters)
  map.on("load", async () => {
    ensureAnomalyLayers();   // idempotent; needed for URL styles too
    if (!state.booted) {     // guard: do NOT rebind listeners on style swaps
      state.booted = true;
      // Cursor feedback while hovering an anomaly marker
      map.on("mousemove", (e) => {
        map.getCanvas().style.cursor =
          map.queryRenderedFeatures(e.point, { layers: LAYER_IDS }).length ? "pointer" : "";
      });
      // Marker click → sidebar inspector (FR-UI-04) AND a map popup with the
      // exact location metadata (MapLibre equivalent of Leaflet bindPopup)
      map.on("click", (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: LAYER_IDS })[0];
        const props = hit ? hit.properties : null;
        renderInspector(props);
        if (props) showAnomalyPopup(props);  // popup anchored on the marker
      });
      await loadData();   // summary + full-window anomaly layer
      bindFilters();      // wire the sidebar controls once the map is live
    }
  });
}

// -----------------------------------------------------------------------------
// Data loading: summary (chips) + anomalies (whole observation window)
// -----------------------------------------------------------------------------
async function loadData() {
  setStatus("Loading data…");
  try {
    // Summary first, then query the anomalies over the window it reports
    // (sequential: the window bounds must exist before building the URL).
    const summary = await api("/api/v1/stats/summary");  // KPI endpoint (SIH)
    const anomalies = await api(
      `/api/v1/thermal-anomalies?date_from=${summary.date_min}&date_to=${summary.date_max}`);
    state.summary = summary;
    state.geoJson = anomalies;

    // Feed the layer source and re-apply the current filters
    map.getSource("anomalies").setData(anomalies);
    applyFilters();

    // Default the date inputs to the window bounds (only while they are empty)
    if (!$("dfrom").value && summary.date_min) $("dfrom").value = summary.date_min;
    if (!$("dto").value && summary.date_max) $("dto").value = summary.date_max;
    state.dateFrom = $("dfrom").value;
    state.dateTo = $("dto").value;

    renderSummaryChips();   // per-class counts from the KPI endpoint
    renderMeta();           // freshness / sources / industrial-sites footer
    setStatus(summary.total_detections
      ? `Ready — ${summary.total_detections} detections across ${summary.window_days} days`
      : "No detections in the observation window");
  } catch (err) {
    // Data endpoints unreachable (e.g. backend not ready) — map stays usable
    setStatus(`Data unavailable — ${err.message}`, true);
  }
}

// -----------------------------------------------------------------------------
// Filtering — native MapLibre expression filters, replaced per change
// -----------------------------------------------------------------------------
function currentFilter(klass) {
  const conds = [["==", ["get", "class"], klass]];  // base: this layer's class
  if (!state.visible.has(klass)) conds.push(["==", 1, 0]);  // toggled OFF
  conds.push([">=", ["coalesce", ["get", "frp_mw"], -1], state.minFrp]);  // FRP floor
  // Date bounds compare ISO strings lexicographically (stable +00:00 format)
  if (state.dateFrom) conds.push([">=", ["get", "acq_date_utc"], `${state.dateFrom}T00:00:00`]);
  if (state.dateTo) conds.push(["<=", ["get", "acq_date_utc"], `${state.dateTo}T23:59:59`]);
  return ["all", ...conds];
}

function applyFilters() {
  if (!map) return;  // not booted yet
  // Replace the filter on each per-class layer (native expression evaluation)
  [1, 2, 3].forEach((k) => map.setFilter(`anom-${k}`, currentFilter(k)));
  // Empty-state overlay when nothing survives the combined filters (FR-UI-06)
  const shown = state.geoJson
    ? state.geoJson.features.filter((f) => featureMatches(f.properties)).length
    : 0;
  $("empty").style.display = shown ? "none" : "block";
}

// JS mirror of the MapLibre filter — used only for the empty-state counter
function featureMatches(p) {
  if (!state.visible.has(p.class)) return false;
  if ((p.frp_mw == null ? -1 : p.frp_mw) < state.minFrp) return false;
  if (state.dateFrom && p.acq_date_utc < `${state.dateFrom}T00:00:00`) return false;
  if (state.dateTo && p.acq_date_utc > `${state.dateTo}T23:59:59`) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Sidebar rendering
// -----------------------------------------------------------------------------
function renderSummaryChips() {
  // Per-class chip counters from the analytics summary endpoint (FR-API-02)
  [1, 2, 3].forEach((k) => {
    const c = state.summary.by_class[String(k)];
    document.querySelector(`.chip[data-class="${k}"]`)
      .querySelector(".n").textContent = c ? c.count : 0;
  });
}

function renderMeta() {
  const s = state.summary;
  $("meta").innerHTML =
    `Updated: <b>${fmtTime(s.updated_at_utc)}</b><br>` +
    `Industrial footprints: <b>${s.industrial_count}</b><br>` +
    `Observation window: <b>${s.window_days} days</b> (${s.date_min} → ${s.date_max})<br>` +
    `Sources: <b>${(s.sources || []).join(", ")}</b>`;
  // Mode badge: LIVE for real FIRMS data, DEMO for the synthetic dataset
  const badge = $("mode-badge");
  if (s.demo_mode) {
    badge.textContent = "DEMO DATA";
    badge.classList.remove("live");
  } else {
    badge.textContent = "LIVE · NASA FIRMS";
    badge.classList.add("live");
  }
}

// Inspector rows (label → formatter) — one table keeps rendering DRY
const INSP_ROWS = [
  ["Class", (p) => `${p.class} — ${p.class_label}`],
  ["Confidence", (p) => `${(p.confidence * 100).toFixed(0)}%`],
  ["FRP", (p) => `${p.frp_mw != null ? p.frp_mw.toFixed(1) : "—"} MW`],
  ["Brightness temp.", (p) => `${p.brightness_temp_k != null ? p.brightness_temp_k.toFixed(1) : "—"} K`],
  ["Acquired (UTC)", (p) => fmtTime(p.acq_date_utc)],
  ["Satellite", (p) => `${p.satellite} / ${p.instrument}`],
  ["Source", (p) => p.source],
  ["Day / Night", (p) => (p.daynight === "N" ? "Night" : "Day")],
  ["To nearest industry", (p) =>
    p.proximity_m != null ? `${Math.round(p.proximity_m).toLocaleString()} m` : "far (> search radius)"],
  ["Nearest site", (p) => p.industry_name || "—"],
  ["Persistence", (p) => `${p.persistence_days}/` +
    `${state.summary ? state.summary.window_days : "?"} days · score ${p.persistence_score.toFixed(2)}`],
];

function renderInspector(p) {
  const panel = $("inspector");
  if (!p) { panel.style.display = "none"; return; }  // clicked empty map area
  // Class-colored title line
  const meta = CLASSES[p.class] || {};
  $("insp-title").innerHTML =
    `<span style="color:${meta.color}">●</span> ${p.class_label} ` +
    `<small style="color:#8aa0c4">(class ${p.class})</small>`;
  // Key/value rows from the INSP_ROWS table above (FR-UI-04)
  $("insp-body").innerHTML = INSP_ROWS
    .map(([label, fmt]) => `<div class="kv"><b>${label}</b><span>${fmt(p)}</span></div>`)
    .join("");
  panel.style.display = "block";
}

// Format an ISO-8601 string for display (UTC, minute precision)
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// Format a decimal degree with the correct hemisphere suffix, 4-decimal exact
function fmtCoord(value, pos, neg) {
  const v = Number(value);
  return `${Math.abs(v).toFixed(4)}° ${v < 0 ? neg : pos}`;
}

// -----------------------------------------------------------------------------
// Marker popup (MapLibre `Popup`, the equivalent of Leaflet's bindPopup) —
// shows exact lat/lon (4 decimals), FRP, satellite/source, acquisition time,
// and the nearest OSM industrial site for the clicked anomaly.
// -----------------------------------------------------------------------------
function showAnomalyPopup(p) {
  const meta = CLASSES[p.class] || {};  // class color for the title dot
  // Anchor the popup on the EXACT marker coordinate (not the click point)
  const popup = new maplibregl.Popup({ offset: 28, closeButton: true, maxWidth: "300px" })
    .setLngLat([Number(p.longitude), Number(p.latitude)])
    .setHTML(
      `<div class="pop">` +
      `<div class="pop-title" style="color:${meta.color || "#fff"}">● ${p.class_label}</div>` +
      `<table class="pop-rows">` +
      `<tr><td>Latitude</td><td>${fmtCoord(p.latitude, "N", "S")}</td></tr>` +
      `<tr><td>Longitude</td><td>${fmtCoord(p.longitude, "E", "W")}</td></tr>` +
      `<tr><td>FRP</td><td>${p.frp_mw != null ? Number(p.frp_mw).toFixed(1) : "—"} MW</td></tr>` +
      `<tr><td>Satellite</td><td>${p.satellite} / ${p.instrument} · ${p.source}</td></tr>` +
      `<tr><td>Acquired (UTC)</td><td>${fmtTime(p.acq_date_utc)}</td></tr>` +
      `<tr><td>Nearest OSM site</td><td>${p.industry_name || "—"}</td></tr>` +
      `</table></div>`
    )
    .addTo(map);
  // Keep a single popup open at a time (each click replaces the last one)
  if (window.__agniPopup && window.__agniPopup !== popup) window.__agniPopup.remove();
  window.__agniPopup = popup;
}

// -----------------------------------------------------------------------------
// Control wiring (class chips, FRP slider, dates, refresh button)
// -----------------------------------------------------------------------------
function bindFilters() {
  // Class chips double as visibility toggles
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const klass = Number(chip.dataset.class);
      state.visible.has(klass) ? state.visible.delete(klass) : state.visible.add(klass);
      chip.classList.toggle("off");   // dim the disabled class chip
      applyFilters();
    });
  });

  // FRP slider (label shows the current floor in MW)
  $("frp").addEventListener("input", (e) => {
    state.minFrp = Number(e.target.value);
    $("frp-val").textContent = `${state.minFrp} MW`;
    applyFilters();
  });

  // Date range inputs → client-side expression filters
  $("dfrom").addEventListener("change", (e) => { state.dateFrom = e.target.value; applyFilters(); });
  $("dto").addEventListener("change", (e) => { state.dateTo = e.target.value; applyFilters(); });

  // Close button clears the inspector
  $("close-inspector").addEventListener("click", () => renderInspector(null));

  // Refresh: POST triggers re-ingestion; provider errors surface verbatim
  $("refresh").addEventListener("click", async () => {
    const btn = $("refresh");
    btn.disabled = true;
    setStatus("Refreshing data from providers…");
    try {
      await api("/api/v1/refresh", { method: "POST" });
      await loadData();
      setStatus("Data refreshed ✓");
    } catch (err) {
      setStatus(err.message, true);   // e.g. 429 "Refresh rate limit" + wait time
    } finally {
      btn.disabled = false;
    }
  });
}

// Boot the dashboard once the DOM is ready (errors surface in the status bar)
boot().catch((err) => setStatus(`Failed to load: ${err.message}`, true));
