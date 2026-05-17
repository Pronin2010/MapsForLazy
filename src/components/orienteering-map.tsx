'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseFullMapFile, type ParsedMapResult } from '@/lib/kmz-parser';
import { useGeolocation } from '@/hooks/use-geolocation';
import { useDeviceOrientation } from '@/hooks/use-device-orientation';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';

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

  const geo = useGeolocation();
  const orientation = useDeviceOrientation();

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

    L.control.layers(baseMaps, {}, { position: 'topright' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('dragstart', () => {
      autoCenterRef.current = false;
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
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

  // File upload handler - full parsing with overlay support
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setDebugInfo([]);

    try {
      const result: ParsedMapResult = await parseFullMapFile(file);

      // Log debug info
      console.log('[KMZ Parser]', result.debugInfo.join('\n'));
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
      setKmlName(file.name);

      if (hasContent) {
        const parts: string[] = [];
        if (result.overlays.length > 0) parts.push(`${result.overlays.length} слой(ёв) изображения`);
        if (result.featureCount > 0) parts.push(`${result.featureCount} векторных объектов`);
        toast({
          title: 'Карта загружена',
          description: `${file.name}: ${parts.join(', ')}`,
        });
      } else {
        toast({
          title: 'Файл загружен, но данных нет',
          description: 'KMZ не содержит отображаемых элементов. Откройте отладку для деталей.',
          variant: 'destructive',
        });
      }
    } catch (err: any) {
      console.error('[KMZ Parser Error]', err);
      toast({
        title: 'Ошибка загрузки',
        description: err.message || 'Не удалось загрузить файл карты',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }

    e.target.value = '';
  }, []);

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

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-[1000] p-3 pointer-events-none">
        <div className="flex items-center justify-between pointer-events-auto">
          <div className="bg-background/90 backdrop-blur-sm rounded-xl px-4 py-2 shadow-lg border border-border">
            <h1 className="text-sm font-bold text-foreground">🧭 Ориентирование</h1>
            {kmlLoaded && (
              <p className="text-xs text-muted-foreground truncate max-w-[150px]">{kmlName}</p>
            )}
          </div>

          <div className="flex gap-2">
            {/* Debug toggle */}
            {debugInfo.length > 0 && (
              <button
                className="bg-background/90 backdrop-blur-sm rounded-xl px-3 py-2 shadow-lg border border-border text-xs text-muted-foreground"
                onClick={() => {
                  const info = debugInfo.join('\n');
                  toast({ title: 'Отладка', description: info });
                }}
              >
                🔍
              </button>
            )}

            <label className="bg-background/90 backdrop-blur-sm rounded-xl px-4 py-2 shadow-lg border border-border cursor-pointer hover:bg-accent transition-colors active:scale-95">
              <span className="text-sm font-medium text-foreground">📂 Карта</span>
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

      {/* PWA Install banner */}
      {installPrompt && (
        <div className="absolute top-20 left-3 right-3 z-[1001] pointer-events-auto">
          <div className="bg-background/95 backdrop-blur-sm rounded-xl p-4 shadow-lg border border-border flex items-center gap-3">
            <div className="text-2xl">📲</div>
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

      {/* GPS info panel */}
      <div className="absolute bottom-28 left-3 z-[1000] pointer-events-auto">
        <div className="bg-background/90 backdrop-blur-sm rounded-xl p-3 shadow-lg border border-border min-w-[180px]">
          <div className="flex items-center gap-2 mb-2">
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

      {/* Control buttons */}
      <div className="absolute bottom-28 right-3 z-[1000] flex flex-col gap-2 pointer-events-auto">
        {geo.isTracking && (
          <Button
            variant="outline"
            size="icon"
            className="bg-background/90 backdrop-blur-sm rounded-xl shadow-lg h-12 w-12 active:scale-95 transition-transform"
            onClick={centerOnPosition}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
          </Button>
        )}

        {geo.isTracking && (
          <Button
            variant={showTrail ? 'default' : 'outline'}
            size="icon"
            className="bg-background/90 backdrop-blur-sm rounded-xl shadow-lg h-12 w-12 active:scale-95 transition-transform"
            onClick={() => setShowTrail(!showTrail)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </Button>
        )}

        {!orientation.hasPermission && orientation.isAvailable && (
          <Button
            variant="outline"
            size="icon"
            className="bg-background/90 backdrop-blur-sm rounded-xl shadow-lg h-12 w-12 active:scale-95 transition-transform"
            onClick={requestCompass}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
          </Button>
        )}
      </div>

      {/* Bottom bar */}
      <div className="absolute bottom-3 left-3 right-3 z-[1000] pointer-events-auto">
        {!geo.isTracking ? (
          <Button
            className="w-full h-14 rounded-xl text-base font-semibold shadow-lg active:scale-[0.98] transition-transform"
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
              className="flex-1 h-12 rounded-xl font-medium bg-background/90 backdrop-blur-sm shadow-lg active:scale-[0.98] transition-transform"
              onClick={centerOnPosition}
            >
              📍 Моё местоположение
            </Button>
            <Button
              variant="destructive"
              className="h-12 rounded-xl font-medium shadow-lg px-4 active:scale-[0.98] transition-transform"
              onClick={geo.stopTracking}
            >
              Стоп
            </Button>
          </div>
        )}
      </div>

      {/* Compass widget */}
      {displayHeading !== null && (
        <div className="absolute top-16 left-3 z-[1000]">
          <div className="bg-background/90 backdrop-blur-sm rounded-xl p-3 shadow-lg border border-border">
            <CompassWidget heading={displayHeading} />
          </div>
        </div>
      )}
    </div>
  );
}
