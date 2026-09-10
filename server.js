import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==============================================================================
// Configuration
// ==============================================================================
const PORT = 3000;
const HOST = "0.0.0.0";

const AOI = process.env.AOI || "68.0,6.0,97.0,37.0";
const MAP_KEY = (process.env.MAP_KEY || "").trim();
const MAPTILER_KEY = (process.env.MAPTILER_KEY || "").trim();
const FIRMS_BASE_URL = process.env.FIRMS_BASE_URL || "https://firms.modaps.eosdis.nasa.gov";
const OVERPASS_API_URL = process.env.OVERPASS_API_URL || "https://overpass-api.de/api/interpreter";
const PERSISTENCE_WINDOW_DAYS = parseInt(process.env.PERSISTENCE_WINDOW_DAYS || "5", 10);
const OSM_SEARCH_RADIUS_M = parseFloat(process.env.OSM_SEARCH_RADIUS_M || "2000.0");
const CLASS1_EVIDENCE_MIN = parseFloat(process.env.CLASS1_EVIDENCE_MIN || "0.55");
const WILDFIRE_FRP_MIN_MW = parseFloat(process.env.WILDFIRE_FRP_MIN_MW || "6.0");
const WILDFIRE_BT_MIN_K = parseFloat(process.env.WILDFIRE_BT_MIN_K || "330.0");
const REFRESH_TTL_MINUTES = parseInt(process.env.REFRESH_TTL_MINUTES || "15", 10);
const REFRESH_MIN_INTERVAL_S = parseInt(process.env.REFRESH_MIN_INTERVAL_S || "60", 10);

const isExplicitDemo = ["1", "true", "yes"].includes((process.env.APP_DEMO_MODE || "").toLowerCase());
const demoMode = isExplicitDemo || !MAP_KEY;

const DEFAULT_CENTER_LON = 78.9629;
const DEFAULT_CENTER_LAT = 20.5937;
const DEFAULT_ZOOM = 5;

const ESRI_DARK_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const BASEMAP_ATTRIBUTION =
  "Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, USGS &middot; &copy; OpenStreetMap contributors";

// ==============================================================================
// Industrial Plant Knowledge Base (India Subcontinent)
// ==============================================================================
const PLANTS = [
  { minx: 69.930, miny: 22.290, maxx: 69.995, maxy: 22.350, name: "Jamnagar Petrochem Hub (demo)" },
  { minx: 72.700, miny: 21.650, maxx: 72.830, maxy: 21.720, name: "Dahej PCPIR Zone (demo)" },
  { minx: 86.550, miny: 20.180, maxx: 86.660, maxy: 20.300, name: "Paradip Refinery Hub (demo)" },
  { minx: 83.250, miny: 17.660, maxx: 83.320, maxy: 17.720, name: "Visakhapatnam Industrial Belt (demo)" },
];

const SAT_TO_SOURCE = {
  NPP: "VIIRS_SNPP_NRT",
  "NOAA-20": "VIIRS_NOAA20_NRT",
  "NOAA-21": "VIIRS_NOAA21_NRT",
  Aqua: "MODIS_NRT",
  Terra: "MODIS_NRT",
};

const CLASS_LABELS = {
  1: "Gas Flare / Heavy Industrial Heat Source",
  2: "Wildfire / Vegetation Fire",
  3: "Thermal Anomaly / Agricultural Noise",
};

// ==============================================================================
// Deterministic Random Generator (Mulberry32)
// ==============================================================================
function createRng(seed = 42) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ==============================================================================
// Dynamic UTM Projection (EPSG:326xx) & Metric Geodesy (FR-PRX-01..03)
// ==============================================================================
function projectWgs84ToUtm(lat, lon, centralLon) {
  const a = 6378137.0;
  const f = 1.0 / 298.257223563;
  const e2 = 2 * f - f * f;
  const e_prime2 = e2 / (1.0 - e2);
  const k0 = 0.9996;

  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const lon0Rad = (centralLon * Math.PI) / 180;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);

  const n = a / Math.sqrt(1.0 - e2 * sinLat * sinLat);
  const t = tanLat * tanLat;
  const c = e_prime2 * cosLat * cosLat;
  const A = (lonRad - lon0Rad) * cosLat;

  const m0 = 1.0 - e2 / 4.0 - (3.0 * e2 * e2) / 64.0 - (5.0 * e2 * e2 * e2) / 256.0;
  const m1 = (3.0 * e2) / 8.0 + (3.0 * e2 * e2) / 32.0 + (45.0 * e2 * e2 * e2) / 1024.0;
  const m2 = (15.0 * e2 * e2) / 256.0 + (45.0 * e2 * e2 * e2) / 1024.0;
  const m3 = (35.0 * e2 * e2) / 3072.0;

  const M =
    a *
    (m0 * latRad -
      m1 * Math.sin(2.0 * latRad) +
      m2 * Math.sin(4.0 * latRad) -
      m3 * Math.sin(6.0 * latRad));

  const x =
    k0 *
      n *
      (A +
        ((1.0 - t + c) * Math.pow(A, 3)) / 6.0 +
        ((5.0 - 18.0 * t + t * t + 72.0 * c - 58.0 * e_prime2) * Math.pow(A, 5)) / 120.0) +
    500000.0;

  let y =
    k0 *
    (M +
      n *
        tanLat *
        (Math.pow(A, 2) / 2.0 +
          ((5.0 - t + 9.0 * c + 4.0 * c * c) * Math.pow(A, 4)) / 24.0 +
          ((61.0 - 58.0 * t + t * t + 600.0 * c - 330.0 * e_prime2) * Math.pow(A, 6)) / 720.0));
  if (lat < 0) y += 10000000.0;

  return [x, y];
}

function distancePointToPlantUtm(ptX, ptY, plant, centralLon) {
  if (plant.coordinates && plant.coordinates.length >= 3) {
    const utmPoly = plant.coordinates.map((p) => projectWgs84ToUtm(p[1], p[0], centralLon));
    let inside = false;
    const nVert = utmPoly.length;
    let j = nVert - 1;
    for (let i = 0; i < nVert; i++) {
      const xi = utmPoly[i][0];
      const yi = utmPoly[i][1];
      const xj = utmPoly[j][0];
      const yj = utmPoly[j][1];
      if (yi > ptY !== yj > ptY && ptX < ((xj - xi) * (ptY - yi)) / (yj - yi + 1e-12) + xi) {
        inside = !inside;
      }
      j = i;
    }
    if (inside) return 0.0;

    let minDist = Infinity;
    for (let i = 0; i < nVert; i++) {
      const x1 = utmPoly[i][0];
      const y1 = utmPoly[i][1];
      const x2 = utmPoly[(i + 1) % nVert][0];
      const y2 = utmPoly[(i + 1) % nVert][1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      let d;
      if (l2 === 0) {
        d = Math.hypot(ptX - x1, ptY - y1);
      } else {
        const t = Math.max(0, Math.min(1, ((ptX - x1) * dx + (ptY - y1) * dy) / l2));
        const projX = x1 + t * dx;
        const projY = y1 + t * dy;
        d = Math.hypot(ptX - projX, ptY - projY);
      }
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  // Fallback to bounding box projection
  const [minUx, minUy] = projectWgs84ToUtm(plant.miny, plant.minx, centralLon);
  const [maxUx, maxUy] = projectWgs84ToUtm(plant.maxy, plant.maxx, centralLon);
  const uxMin = Math.min(minUx, maxUx);
  const uxMax = Math.max(minUx, maxUx);
  const uyMin = Math.min(minUy, maxUy);
  const uyMax = Math.max(minUy, maxUy);

  if (ptX >= uxMin && ptX <= uxMax && ptY >= uyMin && ptY <= uyMax) {
    return 0.0;
  }

  const closestX = Math.max(uxMin, Math.min(uxMax, ptX));
  const closestY = Math.max(uyMin, Math.min(uyMax, ptY));
  return Math.hypot(ptX - closestX, ptY - closestY);
}

function getSnapStep(source) {
  return source && source.toUpperCase().startsWith("VIIRS") ? 0.0034 : 0.0100;
}

// ==============================================================================
// Synthetic / Demo Anomaly Generation
// ==============================================================================
function buildDemoAnomalies(windowDays = PERSISTENCE_WINDOW_DAYS) {
  const rng = createRng(42);
  const now = new Date();
  const dates = [];

  for (let i = 0; i < windowDays; i++) {
    const d = new Date(now.getTime() - (windowDays - 1 - i) * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const rawRows = [];

  // (1) Persistent flare pixels inside Jamnagar and Paradip
  const targetPlants = [PLANTS[0], PLANTS[2]];
  for (const plant of targetPlants) {
    const cx = (plant.minx + plant.maxx) / 2.0;
    const cy = (plant.miny + plant.maxy) / 2.0;
    const lonOffsets = [-0.0034, 0.0, 0.0034];

    for (const lonOff of lonOffsets) {
      const plon = cx + lonOff;
      const plat = cy;
      if (plon <= plant.minx || plon >= plant.maxx || plat <= plant.miny || plat >= plant.maxy) {
        continue;
      }

      for (const dStr of dates) {
        const dayNum = parseInt(dStr.slice(-2), 10);
        const sat = dayNum % 2 === 0 ? "NPP" : "NOAA-20";
        const inst = sat.startsWith("NOAA") || sat === "NPP" ? "VIIRS" : "MODIS";
        const src = SAT_TO_SOURCE[sat] || "VIIRS_SNPP_NRT";
        const acqTimes = [213, 232, 305, 418, 445];
        const acqTime = acqTimes[Math.floor(rng() * acqTimes.length)];

        rawRows.push({
          latitude: plat + (rng() * 0.0002 - 0.0001),
          longitude: plon + (rng() * 0.0002 - 0.0001),
          bright_ti4: Math.round((345.0 + rng() * 15.0) * 10) / 10,
          frp: Math.round((9.0 + rng() * 17.0) * 10) / 10,
          acq_date: dStr,
          acq_time: acqTime,
          satellite: sat,
          instrument: inst,
          source: src,
          confidence: rng() > 0.5 ? "high" : "nominal",
          daynight: rng() > 0.3 ? "N" : "D",
        });
      }
    }
  }

  // (2) Transient fire inside plant D (Visakhapatnam) on the last day only
  const p4 = PLANTS[3];
  const p4cx = (p4.minx + p4.maxx) / 2.0;
  const p4cy = (p4.miny + p4.maxy) / 2.0;
  for (const sat of ["NPP", "NOAA-20"]) {
    const inst = "VIIRS";
    const src = SAT_TO_SOURCE[sat];
    rawRows.push({
      latitude: p4cy,
      longitude: p4cx,
      bright_ti4: 370.0,
      frp: 28.0,
      acq_date: dates[dates.length - 1],
      acq_time: 1855,
      satellite: sat,
      instrument: inst,
      source: src,
      confidence: "high",
      daynight: "D",
    });
  }

  // (3) Wildfire front marching north-east across Madhya Pradesh
  const sats = ["NPP", "NOAA-20", "NOAA-21", "Aqua", "Terra"];
  for (let i = 0; i < dates.length; i++) {
    const dStr = dates[i];
    const fx = 78.300 + i * 0.090;
    const fy = 20.550 + i * 0.040;
    const offsets = [
      [0.0, 0.0],
      [0.006, 0.0],
      [0.0, 0.004],
      [0.006, 0.004],
    ];

    for (const [dx, dy] of offsets) {
      const lat = fy + dy + (rng() * 0.002 - 0.001);
      const lon = fx + dx + (rng() * 0.002 - 0.001);
      const sat = sats[(i + Math.floor(dx * 1000)) % sats.length];
      const inst = sat === "Aqua" || sat === "Terra" ? "MODIS" : "VIIRS";
      const src = SAT_TO_SOURCE[sat];
      const acqTimes = [215, 322, 420, 1600, 1715];
      const acqTime = acqTimes[Math.floor(rng() * acqTimes.length)];

      rawRows.push({
        latitude: lat,
        longitude: lon,
        bright_ti4: Math.round((348.0 + rng() * 20.0) * 10) / 10,
        frp: Math.round((14.0 + rng() * 41.0) * 10) / 10,
        acq_date: dStr,
        acq_time: acqTime,
        satellite: sat,
        instrument: inst,
        source: src,
        confidence: "high",
        daynight: i > 2 ? "D" : "N",
      });
    }
  }

  // (4) Agricultural noise pixels (Punjab/Haryana stubble belt)
  for (let j = 0; j < 12; j++) {
    const lon = 74.90 + rng() * 1.40;
    const lat = 29.90 + rng() * 1.30;
    const dStr = dates[Math.floor(rng() * dates.length)];
    const satChoices = ["NPP", "Terra", "Aqua"];
    const sat = satChoices[Math.floor(rng() * satChoices.length)];
    const inst = sat === "NPP" ? "VIIRS" : "MODIS";
    const src = SAT_TO_SOURCE[sat];
    const acqTimes = [1510, 1620, 1730, 1905];

    rawRows.push({
      latitude: lat,
      longitude: lon,
      bright_ti4: Math.round((309.0 + rng() * 13.0) * 10) / 10,
      frp: Math.round((0.8 + rng() * 3.4) * 100) / 100,
      acq_date: dStr,
      acq_time: acqTimes[Math.floor(rng() * acqTimes.length)],
      satellite: sat,
      instrument: inst,
      source: src,
      confidence: String(Math.floor(15 + rng() * 30)),
      daynight: "D",
    });
  }

  return rawRows;
}

// ==============================================================================
// OSM Overpass Industrial Footprint Ingestion (FR-ING-04..06)
// ==============================================================================
async function fetchOverpassIndustrial(points, radiusM = OSM_SEARCH_RADIUS_M) {
  if (!points || !points.length) return PLANTS;
  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2.0;

  const dLat = radiusM / 111320.0;
  const cosLat = Math.cos((midLat * Math.PI) / 180.0);
  const dLon = radiusM / (111320.0 * Math.max(0.1, cosLat));

  const south = Math.max(-90.0, minLat - dLat);
  const north = Math.min(90.0, maxLat + dLat);
  const west = Math.max(-180.0, minLon - dLon);
  const east = Math.min(180.0, maxLon + dLon);

  const query = `[out:json][timeout:60]; (
    way["industrial"](${south},${west},${north},${east});
    way["landuse"="industrial"](${south},${west},${north},${east});
    way["power"="plant"](${south},${west},${north},${east});
    way["man_made"="flare"](${south},${west},${north},${east});
    relation["industrial"](${south},${west},${north},${east});
    relation["landuse"="industrial"](${south},${west},${north},${east});
    relation["power"="plant"](${south},${west},${north},${east});
    relation["man_made"="flare"](${south},${west},${north},${east});
  ); out geom;`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const resp = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "AGNI-AI/1.0 (SIH PS 26162 NTRO)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) {
      const data = await resp.json();
      const polys = [];
      for (const elem of data.elements || []) {
        if (elem.geometry && elem.geometry.length >= 3) {
          const coords = elem.geometry.map((g) => [g.lon, g.lat]);
          const tags = elem.tags || {};
          const name = tags.name || tags.description || tags.operator || "Industrial Facility (OSM)";
          const xs = coords.map((c) => c[0]);
          const ys = coords.map((c) => c[1]);
          polys.push({
            id: elem.id,
            name,
            coordinates: coords,
            minx: Math.min(...xs),
            maxx: Math.max(...xs),
            miny: Math.min(...ys),
            maxy: Math.max(...ys),
          });
        }
      }
      if (polys.length) return polys;
    }
  } catch (e) {
    console.warn("Overpass fetch fallback to demo plants:", e.message);
  }
  return PLANTS;
}

// ==============================================================================
// Classification Pipeline (FR-CLS-01..07)
// ==============================================================================
function classifyDataset(rawRows, windowDays = PERSISTENCE_WINDOW_DAYS, industrialSites = PLANTS) {
  if (!rawRows || !rawRows.length) {
    return [];
  }

  // 1) Snapping & Persistence
  const pixelDaySets = new Map();

  for (const row of rawRows) {
    const step = getSnapStep(row.source);
    const snappedLat = Math.round(row.latitude / step) * step;
    const snappedLon = Math.round(row.longitude / step) * step;
    row.snapped_lat = snappedLat;
    row.snapped_lon = snappedLon;
    const key = `${snappedLat.toFixed(6)},${snappedLon.toFixed(6)}`;
    if (!pixelDaySets.has(key)) {
      pixelDaySets.set(key, new Set());
    }
    pixelDaySets.get(key).add(row.acq_date);
  }

  // 2) Unique Days in Window
  const allDaysInWindow = new Set(rawRows.map((r) => r.acq_date)).size;
  const denomWindow = Math.max(1, Math.min(windowDays, allDaysInWindow));

  // 3) Dynamic UTM Central Meridian from Dataset Centroid
  const midLon = rawRows.reduce((acc, r) => acc + r.longitude, 0) / rawRows.length;
  const utmZone = Math.floor((midLon + 180.0) / 6.0) + 1;
  const centralLon = (utmZone - 1) * 6 - 180 + 3;

  // 4) Proximity to Nearest Industrial Plant & Classification
  const classifiedRows = [];

  for (const row of rawRows) {
    const key = `${row.snapped_lat.toFixed(6)},${row.snapped_lon.toFixed(6)}`;
    const persistenceDays = pixelDaySets.get(key) ? pixelDaySets.get(key).size : 1;
    const persistenceScore = Math.min(1.0, persistenceDays / denomWindow);

    // Compute metric distance in UTM
    const [ux, uy] = projectWgs84ToUtm(row.latitude, row.longitude, centralLon);
    let minDistance = Infinity;
    let closestPlant = null;
    for (const plant of industrialSites) {
      const dist = distancePointToPlantUtm(ux, uy, plant, centralLon);
      if (dist < minDistance) {
        minDistance = dist;
        closestPlant = plant;
      }
    }

    const inRange = minDistance <= OSM_SEARCH_RADIUS_M;
    const proximityM = inRange ? Math.min(minDistance, 3000.0) : null;
    const industryName = inRange && closestPlant ? closestPlant.name : null;

    // Numerical normalization
    const frpMw = row.frp != null ? Number(row.frp) : 0;
    const brightnessTempK = row.bright_ti4 != null ? Number(row.bright_ti4) : 0;

    const heat = Math.min(1.0, Math.max(0.0, frpMw / 50.0));
    const persist = persistenceScore;
    const prox = proximityM != null ? Math.max(0.0, 1.0 - proximityM / 2000.0) : 0.0;

    // E1 industrial evidence
    const e1 = 0.5 * prox + 0.3 * persist + 0.2 * heat;

    // Rule FR-CLS-01: Class 1
    const nearIndustry = proximityM != null && proximityM <= 1500.0;
    const isClass1 = nearIndustry && e1 >= CLASS1_EVIDENCE_MIN;

    // Rule FR-CLS-02: Class 2
    const isClass2 = !isClass1 && (frpMw >= WILDFIRE_FRP_MIN_MW || brightnessTempK >= WILDFIRE_BT_MIN_K);

    // Rule FR-CLS-03: Class 3
    const klass = isClass1 ? 1 : isClass2 ? 2 : 3;

    // Confidence
    let confidence;
    if (isClass1) {
      confidence = Math.min(1.0, Math.max(0.0, e1));
    } else if (isClass2) {
      confidence = Math.min(0.95, Math.max(0.0, 0.45 + 0.35 * heat + 0.2 * (1.0 - persist)));
    } else {
      confidence = Math.min(0.6, Math.max(0.0, 0.15 + 0.3 * heat + 0.15 * persist));
    }
    confidence = Math.round(confidence * 1000) / 1000;

    // Parse acq_time into UTC ISO string
    const timeStr = String(row.acq_time || 0).padStart(4, "0");
    const hh = timeStr.slice(0, 2);
    const mm = timeStr.slice(2, 4);
    const acqDateUtc = `${row.acq_date}T${hh}:${mm}:00Z`;

    // Map confidence percent for display
    let confidencePct = 60;
    if (row.confidence === "high") confidencePct = 90;
    else if (row.confidence === "low") confidencePct = 30;
    else if (!isNaN(Number(row.confidence))) confidencePct = Number(row.confidence);

    classifiedRows.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      confidence,
      frp_mw: frpMw,
      brightness_temp_k: brightnessTempK,
      acq_date_utc: acqDateUtc,
      source: row.source,
      satellite: row.satellite,
      instrument: row.instrument,
      daynight: row.daynight || "D",
      confidence_pct: confidencePct,
      confidence_raw: String(row.confidence || "nominal"),
      proximity_m: proximityM != null ? Math.round(proximityM * 10) / 10 : null,
      persistence_days: persistenceDays,
      persistence_score: Math.round(persistenceScore * 100) / 100,
      industry_name: industryName,
      latitude: Math.round(row.latitude * 100000) / 100000,
      longitude: Math.round(row.longitude * 100000) / 100000,
      snapped_lat: row.snapped_lat,
      snapped_lon: row.snapped_lon,
    });
  }

  // Sort descending by acquisition date
  classifiedRows.sort((a, b) => (b.acq_date_utc > a.acq_date_utc ? 1 : -1));
  return classifiedRows;
}

// Convert classified array to GeoJSON FeatureCollection
function toGeoJson(rows) {
  const features = rows.map((r) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [r.longitude, r.latitude],
    },
    properties: {
      class: r.class,
      class_label: r.class_label,
      confidence: r.confidence,
      frp_mw: r.frp_mw,
      brightness_temp_k: r.brightness_temp_k,
      acq_date_utc: r.acq_date_utc,
      source: r.source,
      satellite: r.satellite,
      instrument: r.instrument,
      daynight: r.daynight,
      confidence_pct: r.confidence_pct,
      confidence_raw: r.confidence_raw || "nominal",
      proximity_m: r.proximity_m,
      persistence_days: r.persistence_days,
      persistence_score: r.persistence_score,
      industry_name: r.industry_name,
      latitude: r.latitude,
      longitude: r.longitude,
      snapped_lat: r.snapped_lat,
      snapped_lon: r.snapped_lon,
    },
  }));
  return { type: "FeatureCollection", features };
}

// ==============================================================================
// State & Pipeline In-Memory Cache
// ==============================================================================
// Pre-initialize synchronously so serverless cold-starts are immediately ready
const initialDemoRows = buildDemoAnomalies(PERSISTENCE_WINDOW_DAYS);
const initialClassified = classifyDataset(initialDemoRows, PERSISTENCE_WINDOW_DAYS, PLANTS);

const state = {
  anomalies: initialClassified,
  industrial_sites: PLANTS,
  industrial_sites_count: PLANTS.length,
  industrial_count: PLANTS.length,
  updated_at_utc: new Date().toISOString(),
  window_days: PERSISTENCE_WINDOW_DAYS,
  observation_window_days: PERSISTENCE_WINDOW_DAYS,
  sources: Array.from(new Set(initialClassified.map((c) => c.source))).sort(),
  demo_mode: demoMode,
  status: "ready",
  last_error: null,
};

let lastRefreshAttempt = 0;

async function refreshPipeline() {
  lastRefreshAttempt = Date.now();
  try {
    let rows;
    let industrialSites = PLANTS;

    if (!demoMode && MAP_KEY) {
      try {
        // Attempt live FIRMS fetch across all 4 NRT sources
        const firmsSources = [
          "VIIRS_SNPP_NRT",
          "VIIRS_NOAA20_NRT",
          "VIIRS_NOAA21_NRT",
          "MODIS_NRT",
        ];
        const fetchedRows = [];
        for (const src of firmsSources) {
          const url = `${FIRMS_BASE_URL}/api/area/csv/${MAP_KEY}/${src}/${AOI}/${PERSISTENCE_WINDOW_DAYS}`;
          const res = await fetch(url);
          if (res.ok) {
            const csv = await res.text();
            const lines = csv.trim().split("\n");
            if (lines.length > 1) {
              const headers = lines[0].split(",").map((h) => h.trim());
              for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(",").map((v) => v.trim());
                const row = {};
                headers.forEach((h, idx) => (row[h] = vals[idx]));
                if (row.latitude && row.longitude) {
                  fetchedRows.push({
                    latitude: parseFloat(row.latitude),
                    longitude: parseFloat(row.longitude),
                    bright_ti4: parseFloat(row.bright_ti4 || row.brightness || 0),
                    frp: parseFloat(row.frp || 0),
                    acq_date: row.acq_date,
                    acq_time: parseInt(row.acq_time || "0", 10),
                    satellite: row.satellite || "VIIRS",
                    instrument: row.instrument || "VIIRS",
                    source: src,
                    confidence: row.confidence || "nominal",
                    daynight: row.daynight || "D",
                  });
                }
              }
            }
          }
        }
        if (fetchedRows.length > 0) {
          rows = fetchedRows;
          industrialSites = await fetchOverpassIndustrial(rows, OSM_SEARCH_RADIUS_M);
        } else {
          rows = buildDemoAnomalies(PERSISTENCE_WINDOW_DAYS);
        }
      } catch (err) {
        console.warn("Live fetch fallback to demo:", err.message);
        rows = buildDemoAnomalies(PERSISTENCE_WINDOW_DAYS);
      }
    } else {
      rows = buildDemoAnomalies(PERSISTENCE_WINDOW_DAYS);
    }

    const classified = classifyDataset(rows, PERSISTENCE_WINDOW_DAYS, industrialSites);
    state.anomalies = classified;
    state.industrial_sites = industrialSites;
    state.industrial_sites_count = industrialSites.length;
    state.industrial_count = industrialSites.length;
    state.updated_at_utc = new Date().toISOString();
    state.sources = Array.from(new Set(classified.map((c) => c.source))).sort();
    state.window_days = PERSISTENCE_WINDOW_DAYS;
    state.observation_window_days = PERSISTENCE_WINDOW_DAYS;
    state.status = "ready";
    state.last_error = null;
    return { ok: true, count: classified.length };
  } catch (err) {
    console.error("Refresh pipeline failed:", err);
    state.status = state.anomalies.length ? "stale" : "initializing";
    state.last_error = err.message;
    return { ok: false, message: err.message };
  }
}

// ==============================================================================
// Express Application & Routes
// ==============================================================================
const app = express();

app.use(cors());
app.use(express.json());

// Public configuration endpoint
app.get("/api/v1/config/public", (req, res) => {
  const styleUrl = MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
    : null;
  const tileUrl = MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`
    : ESRI_DARK_TILES;
  const attribution = MAPTILER_KEY
    ? '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; OpenStreetMap contributors'
    : BASEMAP_ATTRIBUTION;

  res.json({
    style_url: styleUrl,
    tile_url: tileUrl,
    attribution,
    demo_mode: state.demo_mode,
    aoi: AOI,
    window_days: state.window_days,
    observation_window_days: state.window_days,
    default_center: [DEFAULT_CENTER_LON, DEFAULT_CENTER_LAT],
    default_zoom: DEFAULT_ZOOM,
    data_updated_at_utc: state.updated_at_utc,
    status: state.status,
  });
});

// Analytics Summary endpoint (FR-API-02)
const getAnalyticsSummary = (req, res) => {
  if (!state.anomalies.length && state.status === "initializing") {
    return res.status(503).json({
      detail: {
        message: "Data layer not ready yet",
        reason: state.last_error || "initial refresh in progress",
      },
    });
  }

  const df = state.anomalies;
  const byClass = {};

  for (const klass of [1, 2, 3]) {
    const sub = df.filter((d) => d.class === klass);
    const count = sub.length;
    const meanFrp = count ? sub.reduce((acc, c) => acc + (c.frp_mw || 0), 0) / count : 0;
    const meanConf = count ? sub.reduce((acc, c) => acc + (c.confidence || 0), 0) / count : 0;
    const subWithProx = sub.filter((c) => c.proximity_m != null);
    const meanProx = subWithProx.length
      ? subWithProx.reduce((acc, c) => acc + c.proximity_m, 0) / subWithProx.length
      : null;
    const meanPersist = count ? sub.reduce((acc, c) => acc + (c.persistence_score || 0), 0) / count : 0;

    byClass[String(klass)] = {
      count,
      mean_frp_mw: Math.round(meanFrp * 100) / 100,
      mean_confidence: Math.round(meanConf * 1000) / 1000,
      mean_proximity_m: meanProx != null ? Math.round(meanProx * 10) / 10 : null,
      mean_persistence: Math.round(meanPersist * 1000) / 1000,
    };
  }

  let dateMin = null;
  let dateMax = null;
  const uniquePixels = new Set();

  if (df.length) {
    const dates = df.map((d) => d.acq_date_utc.slice(0, 10)).sort();
    dateMin = dates[0];
    dateMax = dates[dates.length - 1];
    df.forEach((d) => uniquePixels.add(`${d.snapped_lat},${d.snapped_lon}`));
  }

  res.json({
    by_class: byClass,
    sources: state.sources,
    updated_at_utc: state.updated_at_utc,
    generated_at_utc: state.updated_at_utc,
    industrial_count: state.industrial_count,
    industrial_sites_count: state.industrial_sites_count || state.industrial_count,
    window_days: state.window_days,
    observation_window_days: state.window_days,
    demo_mode: state.demo_mode,
    status: state.status,
    total_detections: df.length,
    unique_pixels: uniquePixels.size,
    date_min: dateMin,
    date_max: dateMax,
  });
};

app.get("/api/v1/stats/summary", getAnalyticsSummary);
app.get("/api/v1/analytics/summary", getAnalyticsSummary);

// Filtered Thermal Anomalies endpoint (GeoJSON, FR-API-01)
app.get("/api/v1/thermal-anomalies", (req, res) => {
  if (!state.anomalies.length && state.status === "initializing") {
    return res.status(503).json({
      detail: {
        message: "Data layer not ready yet",
        reason: state.last_error || "initial refresh in progress",
      },
    });
  }

  let filtered = [...state.anomalies];
  const { date_from, date_to, classification, min_frp, max_results } = req.query;

  if (date_from) {
    filtered = filtered.filter((d) => d.acq_date_utc.slice(0, 10) >= date_from);
  }
  if (date_to) {
    filtered = filtered.filter((d) => d.acq_date_utc.slice(0, 10) <= date_to);
  }
  if (classification) {
    const classes = new Set(
      String(classification)
        .split(",")
        .map((c) => parseInt(c.trim(), 10))
        .filter((c) => !isNaN(c))
    );
    filtered = filtered.filter((d) => classes.has(d.class));
  }
  if (min_frp != null && min_frp !== "") {
    const minVal = parseFloat(min_frp);
    if (!isNaN(minVal)) {
      filtered = filtered.filter((d) => d.frp_mw >= minVal);
    }
  }

  const limit = max_results ? parseInt(max_results, 10) : 2000;
  if (!isNaN(limit) && limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  res.json(toGeoJson(filtered));
});

// Refresh Endpoint (FR-API-04)
app.post("/api/v1/refresh", async (req, res) => {
  const elapsedS = (Date.now() - lastRefreshAttempt) / 1000;
  if (elapsedS < REFRESH_MIN_INTERVAL_S) {
    return res.status(429).json({
      detail: {
        message: "Refresh rate limit",
        retry_after_s: Math.round(REFRESH_MIN_INTERVAL_S - elapsedS),
      },
    });
  }

  const result = await refreshPipeline();
  if (!result.ok) {
    return res.status(502).json({
      detail: { message: result.message || "Refresh failed" },
    });
  }

  res.status(202).json({
    status: "ok",
    refreshed_at_utc: state.updated_at_utc,
    total_detections: state.anomalies.length,
  });
});

// Health check endpoint
app.get("/healthz", (req, res) => {
  if (!state.anomalies.length && state.status === "initializing") {
    return res.status(503).json({ status: "initializing" });
  }
  res.json({
    status: "ok",
    state: state.status,
    data_updated_at_utc: state.updated_at_utc,
  });
});

// Favicon handler to avoid 404
app.get("/favicon.ico", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔥</text></svg>`
  );
});

// Static assets & frontend hosting with no-cache headers
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.resolve(__dirname, "index.html"));
});

app.use(express.static(path.resolve(__dirname)));

// Start background refresh & listen on 0.0.0.0:3000
refreshPipeline().then(() => {
  console.log(`[AGNI-AI] Initialized with ${state.anomalies.length} anomaly detections.`);
});

const isDirectRun = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isDirectRun && !process.env.VERCEL) {
  const timer = setInterval(() => {
    if (!demoMode && MAP_KEY) {
      refreshPipeline();
    }
  }, REFRESH_TTL_MINUTES * 60 * 1000);
  timer.unref();

  app.listen(PORT, HOST, () => {
    console.log(`[AGNI-AI] Server running on http://${HOST}:${PORT}`);
  });
}

export default app;
