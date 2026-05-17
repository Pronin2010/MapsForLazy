'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseFullMapFile, parseFullMapFromURL, type ParsedMapResult } from '@/lib/kmz-parser';
import { useGeolocation } from '@/hooks/use-geolocation';
import { useDeviceOrientation } from '@/hooks/use-device-orientation';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { APP_VERSION, VERSION_HISTORY } from '@/lib/version';
import { saveMapData, loadMapData, blobUrlToBase64, type SavedMapData, type SavedOverlay } from '@/lib/map-storage';

// PWA install prompt event type
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Fix Leaflet default icon issue with bundlers
const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

L.Marker.prototype.options.icon = defaultIcon;

function getDirectionName(heading: number): string {
  const directions = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  const index = Math.round(heading / 45) % 8;
  return directions[index];
}

function CompassWidget({ heading }: { heading: number }) {
  return (
    <div className="relative w-16 h-16">
      <svg viewBox="0 0 64 64" className="w-full h-full">
        <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
        <text x="32" y="10" textAnchor="middle" className="text-[7px] fill-red-500 font-bold">С</text>
        <text x="32" y="60" textAnchor="middle" className="text-[7px] fill-muted-foreground">Ю</text>
        <text x="6" y="34" textAnchor="middle" className="text-[7px] fill-muted-foreground">З</text>
        <text x="58" y="34" textAnchor="middle" className="text-[7px] fill-muted-foreground">В</text>
        <g transform={`rotate(${heading}, 32, 32)`}>
          <polygon points="32,8 29,32 35,32" fill="#EF4444" />
          <polygon points="32,56 29,32 35,32" fill="#9CA3AF" />
          <circle cx="32" cy="32" r="2" fill="white" />
        </g>
      </svg>
    </div>
  );
}

export default function OrienteeringMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const positionMarkerRef = useRef<L.Marker | null>(null);
  const headingMarkerRef = useRef<L.Polyline | null>(null);
  const accuracyCircleRef = useRef<L.Circle | null>(null);
  const kmlLayerRef = useRef<L.GeoJSON | null>(null);
  const overlayLayersRef = useRef<L.ImageOverlay[]>([]);
  const trailLineRef = useRef<L.Polyline | null>(null);
  const trailPointsRef = useRef<L.LatLng[]>([]);
  const autoCenterRef = useRef(true);

  const [kmlLoaded, setKmlLoaded] = useState(false);
  const [kmlName, setKmlName] = useState<string>('');
  const [showTrail, setShowTrail] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showMapType, setShowMapType] = useState(false);
  const [activeMapType, setActiveMapType] = useState<string>('Схема');
  const [mapUrl, setMapUrl] = useState('');
  const [savedMaps, setSavedMaps] = useState<Array<{ name: string; url: string }>>([]);

  const geo = useGeolocation();
  const orientation = useDeviceOrientation();

  // Switch base map type
  const switchMapType = useCallback((type: string) => {
    const map = mapRef.current;
    if (!map) return;
    const baseLayers = (map as any)._baseLayers;
    if (!baseLayers || !baseLayers[type]) return;

    // Remove current base layer
    const currentLayer = (map as any)._currentBaseLayer;
    if (currentLayer) {
      map.removeLayer(currentLayer);
    }

    // Add new base layer
    baseLayers[type].addTo(map);
    (map as any)._currentBaseLayer = baseLayers[type];
    setActiveMapType(type);
    setShowMapType(false);
  }, []);

  // Load saved maps from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('orienteering-saved-maps');
      if (saved) {
        setSavedMaps(JSON.parse(saved));
      }
    } catch {}
  }, []);

  // PWA install prompt
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      toast({ title: 'Приложение установлено!', description: 'Найдите его на главном экране' });
    }
    setInstallPrompt(null);
  }, [installPrompt]);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [55.7558, 37.6173],
      zoom: 14,
      zoomControl: false,
      attributionControl: true,
    });

    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    });

    const topoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
      maxZoom: 17,
    });

    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri',
      maxZoom: 19,
    });

    osmLayer.addTo(map);

    const baseMaps = {
      'Схема': osmLayer,
      'Топо': topoLayer,
      'Спутник': satelliteLayer,
    };

    // No Leaflet built-in controls — we use custom UI to avoid overlaps
    // Store base layers in ref for custom layer switching
    (map as any)._baseLayers = baseMaps;
    (map as any)._currentBaseLayer = osmLayer;

    map.on('dragstart', () => {
      autoCenterRef.current = false;
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Restore last opened map on startup
  useEffect(() => {
    const restoreMap = async () => {
      try {
        const saved = await loadMapData();
        if (!saved) return;

        console.log('[Storage] Restoring map:', saved.fileName);

        // Reconstruct ParsedMapResult from saved data
        let geoJson = null;
        let featureCount = 0;
        try {
          if (saved.geoJson) {
            geoJson = JSON.parse(saved.geoJson);
            featureCount = geoJson?.features?.length || 0;
          }
        } catch (e) {
          console.warn('[Storage] Failed to parse saved GeoJSON:', e);
        }

        const result: ParsedMapResult = {
          geoJson,
          overlays: (saved.overlays || []).map((o) => ({
            imageUrl: o.imageBase64,
            bounds: o.bounds,
            name: o.name,
          })),
          featureCount,
          overlayCount: (saved.overlays || []).length,
          debugInfo: [`Восстановлена карта: ${saved.fileName}`],
        };

        // Wait for map to be ready (with timeout)
        let attempts = 0;
        const waitForMap = () => {
          if (mapRef.current) {
            try {
              applyMapResult(result, saved.fileName);
            } catch (err) {
              console.warn('[Storage] Failed to apply restored map:', err);
            }
          } else if (attempts < 30) {
            attempts++;
            setTimeout(waitForMap, 100);
          }
        };
        waitForMap();
      } catch (err) {
        console.warn('[Storage] Failed to restore map:', err);
      }
    };

    // Delay restore slightly to avoid race conditions
    const timer = setTimeout(restoreMap, 300);
    return () => clearTimeout(timer);
  }, []);

  // Capture orientation events
  useEffect(() => {
    const handler = (e: DeviceOrientationEvent) => {
      (window as any).lastOrientationEvent = e;
    };
    window.addEventListener('deviceorientation', handler);
    return () => window.removeEventListener('deviceorientation', handler);
  }, []);

  // Compute compass heading
  const currentCompassHeading = (() => {
    if (orientation.alpha !== null) {
      const event = (window as any).lastOrientationEvent;
      const heading = event?.webkitCompassHeading ?? (360 - orientation.alpha);
      return ((heading % 360) + 360) % 360;
    }
    return null;
  })();

  // Update position marker
  useEffect(() => {
    if (!mapRef.current || !geo.latitude || !geo.longitude) return;

    const map = mapRef.current;
    const latlng = L.latLng(geo.latitude, geo.longitude);

    if (!positionMarkerRef.current) {
      const positionIcon = L.divIcon({
        className: 'position-marker',
        html: `<div class="position-dot">
          <div class="position-dot-inner"></div>
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      positionMarkerRef.current = L.marker(latlng, {
        icon: positionIcon,
        zIndexOffset: 1000,
      }).addTo(map);

      accuracyCircleRef.current = L.circle(latlng, {
        radius: geo.accuracy || 10,
        color: '#4285F4',
        fillColor: '#4285F4',
        fillOpacity: 0.1,
        weight: 1,
      }).addTo(map);
    } else {
      positionMarkerRef.current.setLatLng(latlng);
      if (accuracyCircleRef.current) {
        accuracyCircleRef.current.setLatLng(latlng);
        accuracyCircleRef.current.setRadius(geo.accuracy || 10);
      }
    }

    if (autoCenterRef.current) {
      map.setView(latlng, map.getZoom());
    }

    trailPointsRef.current.push(latlng);
    if (trailPointsRef.current.length > 5000) {
      trailPointsRef.current = trailPointsRef.current.slice(-3000);
    }

    if (showTrail && trailPointsRef.current.length >= 2) {
      if (!trailLineRef.current) {
        trailLineRef.current = L.polyline(trailPointsRef.current, {
          color: '#4285F4',
          weight: 3,
          opacity: 0.7,
        }).addTo(map);
      } else {
        trailLineRef.current.setLatLngs(trailPointsRef.current);
      }
    }
  }, [geo.latitude, geo.longitude, geo.accuracy, showTrail]);

  // Update heading indicator
  useEffect(() => {
    if (!mapRef.current || !positionMarkerRef.current) return;

    const heading = currentCompassHeading ?? geo.heading;

    if (heading === null) {
      if (headingMarkerRef.current) {
        headingMarkerRef.current.remove();
        headingMarkerRef.current = null;
      }
      return;
    }

    const markerLatLng = positionMarkerRef.current.getLatLng();
    const arrowLength = 0.0008;
    const headingRad = (heading * Math.PI) / 180;

    const endLat = markerLatLng.lat + arrowLength * Math.cos(headingRad);
    const endLng = markerLatLng.lng + arrowLength * Math.sin(headingRad);

    if (!headingMarkerRef.current) {
      headingMarkerRef.current = L.polyline(
        [markerLatLng, L.latLng(endLat, endLng)],
        {
          color: '#EA4335',
          weight: 4,
          opacity: 0.9,
          lineCap: 'round',
        }
      ).addTo(mapRef.current);
    } else {
      headingMarkerRef.current.setLatLngs([markerLatLng, L.latLng(endLat, endLng)]);
    }
  }, [currentCompassHeading, geo.heading, geo.latitude]);

  // Trail visibility
  useEffect(() => {
    if (trailLineRef.current && mapRef.current) {
      if (showTrail) {
        if (!mapRef.current.hasLayer(trailLineRef.current)) {
          trailLineRef.current.addTo(mapRef.current);
        }
      } else {
        trailLineRef.current.remove();
      }
    }
  }, [showTrail]);

  // Apply parsed map result to the Leaflet map
  const applyMapResult = useCallback((result: ParsedMapResult, fileName: string) => {
    console.log('[Map Parser]', result.debugInfo.join('\n'));
    setDebugInfo(result.debugInfo);

    // Remove existing layers
    if (kmlLayerRef.current) {
      kmlLayerRef.current.remove();
      kmlLayerRef.current = null;
    }
    overlayLayersRef.current.forEach((layer) => layer.remove());
    overlayLayersRef.current = [];

    const map = mapRef.current;
    if (!map) {
      toast({ title: 'Ошибка', description: 'Карта не инициализирована', variant: 'destructive' });
      return;
    }

    let hasContent = false;
    const allBounds: L.LatLngBounds[] = [];

    // Add image overlays (GroundOverlay)
    if (result.overlays.length > 0) {
      for (const overlay of result.overlays) {
        const bounds = L.latLngBounds(
          L.latLng(overlay.bounds.south, overlay.bounds.west),
          L.latLng(overlay.bounds.north, overlay.bounds.east)
        );

        const imageOverlay = L.imageOverlay(overlay.imageUrl, bounds, {
          opacity: 0.85,
          interactive: true,
        }).addTo(map);

        overlayLayersRef.current.push(imageOverlay);
        allBounds.push(bounds);
        hasContent = true;
      }
    }

    // Add vector features (GeoJSON)
    if (result.geoJson) {
      const layer = L.geoJSON(result.geoJson, {
        style: () => ({
          color: '#E67E22',
          weight: 2,
          opacity: 0.8,
          fillColor: '#E67E22',
          fillOpacity: 0.15,
        }),
        pointToLayer: (_feature, latlng) => {
          return L.marker(latlng, { icon: defaultIcon });
        },
        onEachFeature: (feature, layer) => {
          if (feature.properties) {
            const name = feature.properties.name || feature.properties.title || '';
            const desc = feature.properties.description || '';
            if (name || desc) {
              layer.bindPopup(`<strong>${name}</strong>${desc ? '<br/>' + desc : ''}`);
            }
          }
        },
      });

      layer.addTo(map);
      kmlLayerRef.current = layer;

      if (layer.getBounds().isValid()) {
        allBounds.push(layer.getBounds());
      }
      hasContent = true;
    }

    // Fit map to show all loaded content
    if (allBounds.length > 0) {
      const combinedBounds = allBounds.reduce((acc, b) => acc.extend(b), allBounds[0]);
      map.fitBounds(combinedBounds.pad(0.1));
    }

    setKmlLoaded(true);
    setKmlName(fileName);

    if (hasContent) {
      const parts: string[] = [];
      if (result.overlays.length > 0) parts.push(`${result.overlays.length} слой(ёв) изображения`);
      if (result.featureCount > 0) parts.push(`${result.featureCount} векторных объектов`);
      toast({
        title: 'Карта загружена',
        description: `${fileName}: ${parts.join(', ')}`,
      });
    } else {
      toast({
        title: 'Файл загружен, но данных нет',
        description: 'KMZ не содержит отображаемых элементов.',
        variant: 'destructive',
      });
    }

    // Persist map data to IndexedDB for restore on next launch (caller must call persistMapResult)
  }, []);

  // Save parsed map to IndexedDB
  const persistMapResult = useCallback(async (result: ParsedMapResult, fileName: string, mapType: 'file' | 'url', mapUrl?: string) => {
    try {
      // Convert overlay blob URLs to base64
      const savedOverlays: SavedOverlay[] = [];
      for (const overlay of result.overlays) {
        let imageBase64 = overlay.imageUrl;
        // If it's a blob URL, convert to base64
        if (overlay.imageUrl.startsWith('blob:')) {
          imageBase64 = await blobUrlToBase64(overlay.imageUrl);
        }
        savedOverlays.push({
          imageBase64,
          bounds: overlay.bounds,
          name: overlay.name,
        });
      }

      const data: SavedMapData = {
        id: 'last',
        fileName,
        mapType,
        mapUrl,
        savedAt: Date.now(),
        geoJson: result.geoJson ? JSON.stringify(result.geoJson) : '',
        overlays: savedOverlays,
      };

      await saveMapData(data);
      console.log('[Storage] Map saved:', fileName);
    } catch (err) {
      console.warn('[Storage] Failed to save map:', err);
    }
  }, []);

  // File upload handler
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    try {
      const result = await parseFullMapFile(file);
      applyMapResult(result, file.name);
      persistMapResult(result, file.name, 'file');
    } catch (err: any) {
      toast({
        title: 'Ошибка загрузки',
        description: err.message || 'Не удалось загрузить файл карты',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }

    e.target.value = '';
  }, [applyMapResult]);

  // URL-based map loading
  const handleLoadFromUrl = useCallback(async () => {
    if (!mapUrl.trim()) return;

    setIsLoading(true);
    try {
      const result = await parseFullMapFromURL(mapUrl.trim());
      const name = mapUrl.split('/').pop() || 'URL карта';
      applyMapResult(result, name);
      // Also persist with URL info
      persistMapResult(result, name, 'url', mapUrl.trim());

      // Save to recent maps
      const newMap = { name: mapUrl.split('/').pop() || 'Карта', url: mapUrl.trim() };
      const updated = [newMap, ...savedMaps.filter(m => m.url !== newMap.url)].slice(0, 10);
      setSavedMaps(updated);
      try { localStorage.setItem('orienteering-saved-maps', JSON.stringify(updated)); } catch {}

      setShowUrlDialog(false);
      setMapUrl('');
    } catch (err: any) {
      toast({
        title: 'Ошибка загрузки',
        description: err.message || 'Не удалось загрузить карту по ссылке',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [mapUrl, savedMaps, applyMapResult]);

  // Center on position
  const centerOnPosition = useCallback(() => {
    if (!mapRef.current || !geo.latitude || !geo.longitude) return;
    autoCenterRef.current = true;
    mapRef.current.setView(L.latLng(geo.latitude, geo.longitude), mapRef.current.getZoom(), {
      animate: true,
    });
  }, [geo.latitude, geo.longitude]);

  // Request compass
  const requestCompass = useCallback(async () => {
    const granted = await orientation.requestPermission();
    if (granted) {
      toast({ title: 'Компас активирован', description: 'Направление движения будет отображаться' });
    } else {
      toast({ title: 'Компас недоступен', description: 'Разрешите доступ к компасу в настройках', variant: 'destructive' });
    }
  }, [orientation]);

  const displayHeading = currentCompassHeading ?? geo.heading;

  const mapTypes = ['Схема', 'Топо', 'Спутник'];
  const mapTypeIcons: Record<string, string> = { 'Схема': '🗺️', 'Топо': '⛰️', 'Спутник': '🛰️' };

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black">
      {/* Map container */}
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-[2000] bg-black/50 flex flex-col items-center justify-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary border-t-transparent" />
          <p className="text-white text-sm">Загрузка карты...</p>
        </div>
      )}

      {/* ============ TOP BAR ============ */}
      <div className="absolute top-0 left-0 right-0 z-[1000] p-2 pointer-events-none">
        <div className="flex items-center justify-between pointer-events-auto gap-2">
          {/* App icon + version — compact */}
          <button
            className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border hover:bg-accent transition-colors shrink-0 relative"
            onClick={() => setShowChangelog(true)}
            title="История версий"
          >
            <span className="text-lg">🧭</span>
            <span className="absolute -bottom-1 -right-1 text-[8px] font-mono bg-primary text-primary-foreground px-1 py-0 rounded-md leading-tight">
              {APP_VERSION}
            </span>
          </button>
          {kmlLoaded && (
            <div className="bg-background/90 backdrop-blur-sm rounded-lg px-2 py-1 shadow border border-border shrink-0">
              <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{kmlName}</p>
            </div>
          )}

          {/* Right action buttons — compact row */}
          <div className="flex gap-1.5 shrink-0">
            {/* Map type button */}
            <div className="relative">
              <button
                className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border active:scale-95 transition-transform"
                onClick={() => setShowMapType(!showMapType)}
              >
                <span className="text-sm">{mapTypeIcons[activeMapType] || '🗺️'}</span>
              </button>

              {/* Map type dropdown */}
              {showMapType && (
                <div className="absolute top-12 right-0 bg-background/95 backdrop-blur-sm rounded-xl shadow-xl border border-border overflow-hidden min-w-[120px]">
                  {mapTypes.map((type) => (
                    <button
                      key={type}
                      className={`w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 transition-colors ${
                        type === activeMapType
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-foreground hover:bg-muted'
                      }`}
                      onClick={() => switchMapType(type)}
                    >
                      <span>{mapTypeIcons[type]}</span>
                      <span>{type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Load from URL button */}
            <button
              className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border active:scale-95 transition-transform"
              onClick={() => setShowUrlDialog(true)}
            >
              <span className="text-sm">🌐</span>
            </button>

            {/* File upload button */}
            <label className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border cursor-pointer active:scale-95 transition-transform">
              <span className="text-sm">📂</span>
              <input
                type="file"
                accept=".kmz,.kml"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>
        </div>
      </div>

      {/* ============ PWA Install banner ============ */}
      {installPrompt && (
        <div className="absolute top-16 left-2 right-2 z-[1001] pointer-events-auto">
          <div className="bg-background/95 backdrop-blur-sm rounded-xl p-3 shadow-lg border border-border flex items-center gap-3">
            <div className="text-xl">📲</div>
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">Установить приложение</p>
              <p className="text-xs text-muted-foreground">Работает офлайн, как нативное</p>
            </div>
            <Button size="sm" onClick={handleInstall} className="rounded-lg">
              Установить
            </Button>
          </div>
        </div>
      )}

      {/* ============ Compass widget (left side, below top bar) ============ */}
      {displayHeading !== null && (
        <div className="absolute top-16 left-2 z-[1000]">
          <div className="bg-background/90 backdrop-blur-sm rounded-xl p-2 shadow-lg border border-border">
            <CompassWidget heading={displayHeading} />
          </div>
        </div>
      )}

      {/* ============ Zoom buttons (right side, below top bar) ============ */}
      <div className="absolute top-16 right-2 z-[1000] flex flex-col gap-1 pointer-events-auto">
        <button
          className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border text-lg font-bold text-foreground active:scale-95 transition-transform"
          onClick={() => mapRef.current?.zoomIn()}
        >
          +
        </button>
        <button
          className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border text-lg font-bold text-foreground active:scale-95 transition-transform"
          onClick={() => mapRef.current?.zoomOut()}
        >
          −
        </button>
      </div>

      {/* ============ GPS info panel (left side, above bottom bar) ============ */}
      <div className="absolute bottom-20 left-2 z-[1000] pointer-events-auto">
        <div className="bg-background/90 backdrop-blur-sm rounded-xl p-2.5 shadow-lg border border-border min-w-[170px]">
          <div className="flex items-center gap-2 mb-1.5">
            <div
              className={`w-2.5 h-2.5 rounded-full ${
                geo.isTracking
                  ? geo.accuracy && geo.accuracy < 20
                    ? 'bg-green-500'
                    : geo.accuracy && geo.accuracy < 50
                    ? 'bg-yellow-500'
                    : 'bg-orange-500'
                  : geo.error
                  ? 'bg-red-500'
                  : 'bg-gray-400'
              }`}
            />
            <span className="text-xs text-muted-foreground">
              {geo.isTracking
                ? `GPS: ±${Math.round(geo.accuracy || 0)}м`
                : geo.error
                ? 'GPS: ошибка'
                : 'GPS: выключен'}
            </span>
          </div>

          {geo.latitude && geo.longitude && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>
                {geo.latitude.toFixed(6)}, {geo.longitude.toFixed(6)}
              </p>
              {geo.altitude !== null && <p>Высота: {Math.round(geo.altitude)}м</p>}
              {geo.speed !== null && geo.speed > 0 && (
                <p>Скорость: {(geo.speed * 3.6).toFixed(1)} км/ч</p>
              )}
              {displayHeading !== null && (
                <p>
                  Направление: {Math.round(displayHeading)}° {getDirectionName(displayHeading)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ============ Control buttons (right side, above bottom bar) ============ */}
      <div className="absolute bottom-20 right-2 z-[1000] flex flex-col gap-1.5 pointer-events-auto">
        {geo.isTracking && (
          <button
            className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border active:scale-95 transition-transform"
            onClick={centerOnPosition}
            title="Моё местоположение"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
          </button>
        )}

        {geo.isTracking && (
          <button
            className={`rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border active:scale-95 transition-transform ${
              showTrail
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background/90 backdrop-blur-sm border-border'
            }`}
            onClick={() => setShowTrail(!showTrail)}
            title="Трек маршрута"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}

        {!orientation.hasPermission && orientation.isAvailable && (
          <button
            className="bg-background/90 backdrop-blur-sm rounded-xl w-10 h-10 flex items-center justify-center shadow-lg border border-border active:scale-95 transition-transform"
            onClick={requestCompass}
            title="Включить компас"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
          </button>
        )}
      </div>

      {/* ============ Bottom bar ============ */}
      <div className="absolute bottom-2 left-2 right-2 z-[1000] pointer-events-auto">
        {!geo.isTracking ? (
          <Button
            className="w-full h-12 rounded-xl text-sm font-semibold shadow-lg active:scale-[0.98] transition-transform"
            onClick={geo.startTracking}
            disabled={!geo.hasSupport}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 mr-2">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
            Включить геолокацию
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 h-10 rounded-xl text-sm font-medium bg-background/90 backdrop-blur-sm shadow-lg active:scale-[0.98] transition-transform"
              onClick={centerOnPosition}
            >
              📍 Моё местоположение
            </Button>
            <Button
              variant="destructive"
              className="h-10 rounded-xl text-sm font-medium shadow-lg px-4 active:scale-[0.98] transition-transform"
              onClick={geo.stopTracking}
            >
              Стоп
            </Button>
          </div>
        )}
      </div>

      {/* ============ URL Load Dialog ============ */}
      {showUrlDialog && (
        <div className="absolute inset-0 z-[2000] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-background rounded-2xl shadow-2xl border border-border w-full max-w-md overflow-hidden">
            <div className="p-5">
              <h2 className="text-lg font-bold text-foreground mb-1">Загрузить карту по ссылке</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Вставьте прямую ссылку на KMZ или KML файл
              </p>

              <input
                type="url"
                value={mapUrl}
                onChange={(e) => setMapUrl(e.target.value)}
                placeholder="https://example.com/map.kmz"
                className="w-full h-12 px-4 rounded-xl border border-input bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleLoadFromUrl();
                }}
                autoFocus
              />

              {/* Saved / recent maps */}
              {savedMaps.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Недавние карты:</p>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {savedMaps.map((m, i) => (
                      <button
                        key={i}
                        className="w-full text-left px-3 py-2 rounded-lg bg-muted/50 hover:bg-muted text-xs text-foreground truncate transition-colors"
                        onClick={() => {
                          setMapUrl(m.url);
                        }}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Tips */}
              <div className="mt-4 p-3 rounded-xl bg-muted/30 border border-border">
                <p className="text-xs text-muted-foreground">
                  <strong>💡 Откуда взять ссылку:</strong>
                </p>
                <ul className="text-xs text-muted-foreground mt-1 space-y-0.5 list-disc list-inside">
                  <li>Google Диск — &quot;Доступ по ссылке&quot;, скопируйте URL</li>
                  <li>Dropbox — замените dl=0 на dl=1 в конце</li>
                  <li>Яндекс.Диск — скопируйте публичную ссылку</li>
                  <li>Любой веб-сервер с прямым доступом к файлу</li>
                </ul>
              </div>
            </div>

            <div className="flex gap-2 p-4 pt-0">
              <Button
                variant="outline"
                className="flex-1 rounded-xl h-11"
                onClick={() => { setShowUrlDialog(false); setMapUrl(''); }}
              >
                Отмена
              </Button>
              <Button
                className="flex-1 rounded-xl h-11"
                onClick={handleLoadFromUrl}
                disabled={!mapUrl.trim() || isLoading}
              >
                {isLoading ? 'Загрузка...' : 'Загрузить'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Changelog screen ============ */}
      {showChangelog && (
        <div className="absolute inset-0 z-[2000] bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-background rounded-t-2xl sm:rounded-2xl shadow-2xl border border-border w-full sm:max-w-md max-h-[85vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-5 pb-3 border-b border-border">
              <div>
                <h2 className="text-lg font-bold text-foreground">История версий</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Текущая версия: v{APP_VERSION}</p>
              </div>
              <button
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
                onClick={() => setShowChangelog(false)}
              >
                ✕
              </button>
            </div>

            {/* Version list */}
            <div className="flex-1 overflow-y-auto p-5 pt-3 space-y-5">
              {VERSION_HISTORY.map((v, i) => (
                <div key={v.version} className="relative">
                  {/* Version badge */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-md ${
                      i === 0
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      v{v.version}
                    </span>
                    <span className="text-xs text-muted-foreground">{v.date}</span>
                    {i === 0 && (
                      <span className="text-[10px] font-medium bg-green-500/15 text-green-600 px-2 py-0.5 rounded-md">
                        текущая
                      </span>
                    )}
                  </div>

                  {/* Changes list */}
                  <ul className="space-y-1.5 ml-1">
                    {v.changes.map((change, j) => (
                      <li key={j} className="flex items-start gap-2 text-sm text-foreground/80">
                        <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
                        <span>{change}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Divider */}
                  {i < VERSION_HISTORY.length - 1 && (
                    <div className="mt-4 border-b border-border" />
                  )}
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="p-4 pt-2 border-t border-border">
              <Button
                variant="outline"
                className="w-full rounded-xl h-11"
                onClick={() => setShowChangelog(false)}
              >
                Закрыть
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
