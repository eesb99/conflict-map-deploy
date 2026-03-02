# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OSINT Intelligence Dashboard -- a static single-page web app visualizing geopolitical conflict events (Feb 28 - Mar 2, 2026) on an interactive 3D globe. Built with Three.js and vanilla JavaScript, no build system or backend.

## Running Locally

Serve the project root with any static HTTP server:

    python3 -m http.server 8000
    # Then open http://localhost:8000

Opening `index.html` directly via `file://` will fail due to CORS restrictions on the TopoJSON data file.

## Architecture

Three files make up the entire application:

- **index.html** (~2000 lines) -- HTML structure, inline CSS overrides, and all application JavaScript
- **style.css** -- Base theme (dark navy/teal palette via CSS custom properties in `:root`)
- **countries-50m.json** -- TopoJSON world map geometry for globe rendering

### Inline JavaScript Structure (index.html)

The JS is organized in commented sections (`// ====== SECTION ======`):

1. **Data arrays** -- `EVENTS` (50 strike/event objects), `ARCS` (23 missile trajectories), `AIRPORTS` (9 no-fly zones), `ME_IDS` (16 Middle East country ISO codes)
2. **Three.js scene setup** -- Camera, renderer, `rotGroup` (rotating globe parent)
3. **Globe rendering** -- `drawCountryLines(topoData)` parses TopoJSON and draws country borders/fills; `ll2v(lat, lon, r)` converts geographic coordinates to 3D vectors
4. **Markers & arcs** -- `buildMarkers()`, `buildArcs()`, `buildAirportOverlays()`, `buildHormuzZone()`
5. **2D Canvas panels** -- Gauge chart, Hormuz Strait mini-map, oil price chart (Brent vs WTI)
6. **Interaction** -- Mouse drag rotation, scroll zoom, click-to-select events, timeline filter (Feb 28 / Mar 1 / Mar 2), category filter sidebar
7. **Animation loop** -- `animate(time)` handles rendering, arc pulse animation, auto-rotation

### Key Data Model

Event objects:
    { id, lat, lon, name, desc, category, date, color, hex, dates }

Categories: `us-israel`, `iran`, `lebanon`, `hezbollah`, `other`

Arc objects:
    { from: [lat, lon], to: [lat, lon], color, date }

### CDN Dependencies

- Three.js 0.160.0 (`unpkg.com/three@0.160.0`)
- TopoJSON Client 3.x (`cdn.jsdelivr.net/npm/topojson-client@3`)
- Google Fonts: Inter, JetBrains Mono

## Deployment

Pure static site -- deploy to GitHub Pages, Netlify, Vercel, or any static host. No build step required. Just push to the configured branch.

## Testing

No automated tests. Manual verification:
1. Globe renders with highlighted Middle East countries
2. Event markers appear as colored spheres; clicking shows details
3. Timeline buttons (Feb 28 / Mar 1 / Mar 2) filter events and arcs
4. Category filters in sidebar work
5. Canvas charts (gauge, Hormuz map, oil price) render in sidebar
6. Mobile responsive: tab toggle between globe and sidebar views
