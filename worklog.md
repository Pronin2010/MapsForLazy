# Orienteering App Worklog

---
Task ID: 1
Agent: Main Agent
Task: Build orienteering navigation web application

Work Log:
- Initialized Next.js project with fullstack-dev skill
- Installed leaflet, @types/leaflet, jszip, @mapbox/togeojson dependencies
- Created KMZ/KML parser utility (src/lib/kmz-parser.ts)
- Created geolocation hook with heading calculation (src/hooks/use-geolocation.ts)
- Created device orientation hook for compass (src/hooks/use-device-orientation.ts)
- Created main orienteering map component (src/components/orienteering-map.tsx)
- Updated page.tsx with dynamic import to avoid SSR issues with Leaflet
- Updated globals.css with position marker styles and Leaflet overrides
- Updated layout.tsx with proper viewport and metadata settings
- Fixed lint errors (setState in effect issues)
- Verified dev server compiles and serves correctly (HTTP 200)

Stage Summary:
- Full orienteering web application built and running at localhost:3000
- Features: KMZ/KML map loading, GPS tracking, compass heading, trail recording, 3 base map layers
- All lint checks pass

---
Task ID: 2
Agent: Main Agent
Task: Fix KMZ loading - add GroundOverlay (image) support

Work Log:
- Identified that user's KMZ contains GroundOverlay (raster image) not vector features
- Rewrote kmz-parser.ts with parseFullMapFile() that extracts both GeoJSON vectors AND image overlays
- Added multiple strategies for finding images in KMZ archives (exact match, case-insensitive, basename, extension-based)
- Added support for LatLonBox, direct coordinates, and LatLonQuad bounds parsing
- Updated orienteering-map.tsx to use parseFullMapFile() and render L.imageOverlay
- Added loading indicator during file parsing
- Added debug info panel (🔍 button) showing parsing details
- Added proper cleanup of overlay layers when re-loading files
- All lint checks pass, server compiles OK

Stage Summary:
- KMZ GroundOverlay images now display correctly on the map
- Debug info available to troubleshoot future file loading issues
- Both vector (GeoJSON) and raster (image overlay) layers supported

---
Task ID: 3
Agent: Main Agent
Task: Fix GroundOverlay rotation (KML <rotation> was ignored — rotated maps displayed north-up)

Work Log:
- Diagnosed: user's KMZ (Avangard_26-1.kmz) has <rotation>-309.21</rotation> in LatLonBox; parser ignored it and L.imageOverlay cannot rotate images
- Confirmed KML semantics: image fills LatLonBox, then rotates counterclockwise about box center (positive = counterclockwise per Google KML Reference)
- Added rotation parsing in parseGroundOverlays() with normalization into (-180, 180]
- Implemented applyOverlayRotation(): bakes rotation into the bitmap via canvas and recomputes bounds as the axis-aligned box of the rotated rectangle (WGS84 meters-per-degree at box center)
- Source format preserved: PNG stays PNG (alpha), others re-encoded as JPEG 0.92
- Graceful fallback: if image cannot be loaded/rotated (external URL, tainted canvas) overlay is shown unrotated as before, with debug info messages
- No changes needed in orienteering-map.tsx or map-storage.ts — rotated image + bounds flow through rendering and IndexedDB save/restore unchanged
- Verified: Avangard_26-1.kmz renders rotated +50.79° with bounds Ю=48.723969 С=48.735511 З=44.864896 В=44.881401 (matches reference math); no-rotation KMZ regression-tested (identical to old behavior); map restore after reload keeps rotation; lint passes

Stage Summary:
- Rotated orienteering maps now display with correct orientation
- Works offline (no extra requests), rotation persists in saved maps

---
Task ID: 4
Agent: Main Agent
Task: Map-up display mode — no dark corners, map sheet reads horizontally

Work Log:
- Diagnosed user feedback: after baking KML rotation the sheet displayed sideways (tilted ~51°) with black triangular corners (JPEG re-encode has no alpha)
- Parser: rotated bitmap is now encoded with transparency — WebP first, PNG fallback, white-margins JPEG as last resort; MapOverlay gained rotation field
- Added leaflet-rotate (0.2.8): map view rotates so the sheet is horizontal while staying geo-correct (GPS dot, trail and popups are compensated by the plugin)
- After loading a rotated overlay the view bearing is set to the KML rotation before fitBounds (plugin fits the rotated footprint)
- Toggle button (🗺️/🧭) switches between "map up" (default when rotation exists) and "north up", re-fitting bounds; hidden for maps without rotation
- rotation persists in IndexedDB (SavedOverlay.rotation), restored maps auto-open in map-up mode
- Plugin options: rotate:true, rotateControl:false (custom UI), shiftKeyRotate:false (no wheel hijack); type shim in src/types/leaflet-rotate.d.ts
- Verified in browser: sheet horizontal + no dark corners (WebP, basemap visible through corners); toggle works both ways; reload restores map-up mode; no-rotation KMZ regression-tested (no rotation, no toggle); lint passes

Stage Summary:
- Rotated orienteering maps now read horizontally with no dark padding around them
- Geographic accuracy preserved: view rotation is purely visual, GPS stays on the right spot
