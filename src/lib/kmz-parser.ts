import JSZip from 'jszip';
import { kml } from '@mapbox/togeojson';
import type { GeoJsonObject, FeatureCollection } from 'geojson';

/**
 * Parse a KMZ file (ZIP containing KML) and return GeoJSON
 */
export async function parseKMZ(file: File): Promise<GeoJsonObject> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const kmlFile = Object.keys(zip.files).find(
    (name) => name.toLowerCase().endsWith('.kml') && !name.startsWith('__MACOSX')
  );

  if (!kmlFile) {
    throw new Error('KML файл не найден внутри KMZ архива');
  }

  const kmlContent = await zip.files[kmlFile].async('text');
  return parseKMLString(kmlContent);
}

/**
 * Parse a KML file and return GeoJSON
 */
export async function parseKML(file: File): Promise<GeoJsonObject> {
  const text = await file.text();
  return parseKMLString(text);
}

function parseKMLString(kmlString: string): GeoJsonObject {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlString, 'text/xml');

  const errorNode = xmlDoc.querySelector('parsererror');
  if (errorNode) {
    throw new Error('Ошибка парсинга KML файла');
  }

  const geoJson = kml(xmlDoc);
  return geoJson as GeoJsonObject;
}

/**
 * Auto-detect file type and parse accordingly
 */
export async function parseMapFile(file: File): Promise<GeoJsonObject> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.kmz')) {
    return parseKMZ(file);
  } else if (name.endsWith('.kml')) {
    return parseKML(file);
  } else {
    throw new Error('Неподдерживаемый формат файла. Используйте KMZ или KML.');
  }
}

export interface MapOverlay {
  imageUrl: string;
  bounds: { south: number; west: number; north: number; east: number };
  name: string;
  /**
   * Applied KML rotation in degrees, normalized to (-180, 180], positive =
   * counterclockwise sheet tilt in a north-up view. Undefined when no rotation.
   */
  rotation?: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось загрузить изображение'));
    img.src = url;
  });
}

/**
 * Meters per degree of latitude/longitude at the given latitude (WGS84 series).
 * Accurate to well under a meter per kilometer for local maps.
 */
function metersPerDegree(lat: number): { mLat: number; mLon: number } {
  const rad = (lat * Math.PI) / 180;
  const mLat =
    111132.954 - 559.822 * Math.cos(2 * rad) + 1.175 * Math.cos(4 * rad);
  const mLon =
    111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad) + 0.118 * Math.cos(5 * rad);
  return { mLat, mLon };
}

/**
 * KML semantics: the image is scaled to fill the LatLonBox, then rotated
 * counterclockwise about the box center by `rotation` degrees. L.imageOverlay
 * cannot rotate, so we bake the rotation into the bitmap via canvas and replace
 * the bounds with the axis-aligned box of the rotated rectangle. Returns null
 * when rotation is not applicable (e.g. tainted canvas for external images).
 */
async function applyOverlayRotation(
  imageUrl: string,
  bounds: { south: number; west: number; north: number; east: number },
  rotationDeg: number
): Promise<{ imageUrl: string; bounds: { south: number; west: number; north: number; east: number }; encoded: string } | null> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;

  const rad = (rotationDeg * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));

  // Bitmap: rotate counterclockwise about its center, expand canvas to fit
  const canvasW = Math.round(w * cosA + h * sinA);
  const canvasH = Math.round(w * sinA + h * cosA);
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.translate(canvasW / 2, canvasH / 2);
  // Canvas y-axis points down, so a negative angle rotates counterclockwise
  ctx.rotate(-rad);
  ctx.drawImage(img, -w / 2, -h / 2);

  // Corners around the rotated sheet must stay transparent, otherwise they
  // show up as dark triangles over the basemap. Prefer WebP, then PNG;
  // only as a last resort emit an opaque JPEG with white margins.
  const toBlob = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

  let resultUrl = '';
  let encoded = '';

  const webpBlob = await toBlob('image/webp', 0.9);
  if (webpBlob && webpBlob.type === 'image/webp') {
    resultUrl = URL.createObjectURL(webpBlob);
    encoded = 'webp';
  } else {
    const pngBlob = await toBlob('image/png');
    if (pngBlob && pngBlob.size < 10 * 1024 * 1024) {
      resultUrl = URL.createObjectURL(pngBlob);
      encoded = 'png';
    }
  }

  if (!resultUrl) {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const jpegBlob = await toBlob('image/jpeg', 0.92);
    if (!jpegBlob) return null;
    resultUrl = URL.createObjectURL(jpegBlob);
    encoded = 'jpeg';
  }

  // Bounds: rotate the LatLonBox corners about the box center in local meters
  const { mLat, mLon } = metersPerDegree((bounds.north + bounds.south) / 2);
  const lonC = (bounds.east + bounds.west) / 2;
  const halfW = ((bounds.east - bounds.west) / 2) * mLon;
  const halfH = ((bounds.north - bounds.south) / 2) * mLat;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of [
    [halfW, halfH],
    [-halfW, halfH],
    [halfW, -halfH],
    [-halfW, -halfH],
  ]) {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }

  return {
    imageUrl: resultUrl,
    encoded,
    bounds: {
      south: (bounds.north + bounds.south) / 2 + minY / mLat,
      north: (bounds.north + bounds.south) / 2 + maxY / mLat,
      west: lonC + minX / mLon,
      east: lonC + maxX / mLon,
    },
  };
}

export interface ParsedMapResult {
  geoJson: GeoJsonObject | null;
  overlays: MapOverlay[];
  featureCount: number;
  overlayCount: number;
  debugInfo: string[];
}

/**
 * Load and parse a map from a URL (KMZ or KML)
 * Uses a server-side proxy to avoid CORS issues
 */
export async function parseFullMapFromURL(url: string): Promise<ParsedMapResult> {
  const debugInfo: string[] = [];
  debugInfo.push(`Загрузка по URL: ${url}`);

  // Use our proxy API to fetch the file
  const proxyUrl = `/api/map-proxy?url=${encodeURIComponent(url)}`;

  const response = await fetch(proxyUrl);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Ошибка загрузки: ${response.status}`);
  }

  const contentType = response.headers.get('X-Content-Type') || '';
  const contentLength = response.headers.get('X-Content-Length') || '?';
  debugInfo.push(`Тип: ${contentType}, размер: ${contentLength}`);

  const urlLower = url.toLowerCase();

  if (urlLower.endsWith('.kmz') || contentType.includes('application/vnd.google-earth.kmz') || contentType.includes('application/zip')) {
    const arrayBuffer = await response.arrayBuffer();
    debugInfo.push(`Получено байт: ${arrayBuffer.byteLength}`);
    const file = new File([arrayBuffer], 'map.kmz', { type: 'application/vnd.google-earth.kmz' });
    return parseFullKMZ(file, debugInfo);
  } else if (urlLower.endsWith('.kml') || contentType.includes('application/vnd.google-earth.kml') || contentType.includes('text/xml')) {
    const text = await response.text();
    debugInfo.push(`Получено символов: ${text.length}`);
    const file = new File([text], 'map.kml', { type: 'application/vnd.google-earth.kml+xml' });
    return parseFullKML(file, debugInfo);
  } else {
    // Try to detect by content
    const arrayBuffer = await response.arrayBuffer();
    const firstBytes = new Uint8Array(arrayBuffer.slice(0, 4));

    // Check if it's a ZIP (KMZ)
    if (firstBytes[0] === 0x50 && firstBytes[1] === 0x4b) {
      debugInfo.push('Определён формат: KMZ (ZIP)');
      const file = new File([arrayBuffer], 'map.kmz', { type: 'application/vnd.google-earth.kmz' });
      return parseFullKMZ(file, debugInfo);
    } else {
      debugInfo.push('Определён формат: KML (XML)');
      const text = new TextDecoder().decode(arrayBuffer);
      const file = new File([text], 'map.kml', { type: 'application/vnd.google-earth.kml+xml' });
      return parseFullKML(file, debugInfo);
    }
  }
}

/**
 * Full parse of a map file - extracts both vector features AND image overlays
 */
export async function parseFullMapFile(file: File): Promise<ParsedMapResult> {
  const name = file.name.toLowerCase();
  const debugInfo: string[] = [];

  debugInfo.push(`Файл: ${file.name}, размер: ${(file.size / 1024).toFixed(1)} КБ`);

  if (name.endsWith('.kmz')) {
    return parseFullKMZ(file, debugInfo);
  } else if (name.endsWith('.kml')) {
    return parseFullKML(file, debugInfo);
  } else {
    throw new Error('Неподдерживаемый формат файла. Используйте KMZ или KML.');
  }
}

async function parseFullKML(file: File, debugInfo: string[]): Promise<ParsedMapResult> {
  const text = await file.text();
  debugInfo.push('KML файл прочитан');

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');

  const errorNode = xmlDoc.querySelector('parsererror');
  if (errorNode) {
    throw new Error('Ошибка парсинга KML файла');
  }

  const geoJson = kml(xmlDoc) as FeatureCollection;
  const featureCount = geoJson.features?.length || 0;
  debugInfo.push(`Векторных объектов: ${featureCount}`);

  const overlays = await parseGroundOverlays(xmlDoc, null, debugInfo);

  return {
    geoJson: featureCount > 0 ? (geoJson as GeoJsonObject) : null,
    overlays,
    featureCount,
    overlayCount: overlays.length,
    debugInfo,
  };
}

async function parseFullKMZ(file: File, debugInfo: string[]): Promise<ParsedMapResult> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const allFilesList = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
  debugInfo.push(`Файлы в архиве (${allFilesList.length}): ${allFilesList.join(', ')}`);

  const kmlFileName = allFilesList.find(
    (name) => name.toLowerCase().endsWith('.kml') && !name.startsWith('__MACOSX')
  );

  if (!kmlFileName) {
    throw new Error('KML файл не найден внутри KMZ архива');
  }

  debugInfo.push(`Найден KML: ${kmlFileName}`);

  const kmlContent = await zip.files[kmlFileName].async('text');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlContent, 'text/xml');

  const errorNode = xmlDoc.querySelector('parsererror');
  if (errorNode) {
    throw new Error('Ошибка парсинга KML внутри KMZ');
  }

  const geoJson = kml(xmlDoc) as FeatureCollection;
  const featureCount = geoJson.features?.length || 0;
  debugInfo.push(`Векторных объектов: ${featureCount}`);

  const overlays = await parseGroundOverlays(xmlDoc, zip, debugInfo);

  return {
    geoJson: featureCount > 0 ? (geoJson as GeoJsonObject) : null,
    overlays,
    featureCount,
    overlayCount: overlays.length,
    debugInfo,
  };
}

async function parseGroundOverlays(
  xmlDoc: Document,
  zip: JSZip | null,
  debugInfo: string[]
): Promise<MapOverlay[]> {
  const overlays: MapOverlay[] = [];

  // Query GroundOverlay (handle namespace variations)
  const groundOverlays = xmlDoc.querySelectorAll('GroundOverlay');
  debugInfo.push(`GroundOverlay элементов: ${groundOverlays.length}`);

  for (let i = 0; i < groundOverlays.length; i++) {
    const overlay = groundOverlays[i];
    const overlayName =
      overlay.querySelector('name')?.textContent || `Слой ${i + 1}`;

    // Get the image href
    const iconHref =
      overlay.querySelector('Icon > href')?.textContent ||
      overlay.querySelector('href')?.textContent ||
      '';

    if (!iconHref.trim()) {
      debugInfo.push(`Overlay ${i}: нет ссылки на изображение`);
      continue;
    }

    const href = iconHref.trim();
    debugInfo.push(`Overlay ${i} "${overlayName}": ссылка = "${href}"`);

    let imageUrl = '';

    // Handle data URI
    if (href.startsWith('data:')) {
      imageUrl = href;
      debugInfo.push(`Overlay ${i}: Data URI, длина = ${href.length}`);
    } else if (zip) {
      // KMZ - find the image inside the archive
      const hrefBasename = href.replace(/^.*[\\/]/, '');
      const allZipFiles = Object.keys(zip.files).filter((f) => !zip.files[f].dir);

      let foundPath = '';

      // Strategy 1: Exact match
      if (zip.files[href] && !zip.files[href].dir) {
        foundPath = href;
      }

      // Strategy 2: Match without leading ./
      if (!foundPath) {
        const cleanHref = href.replace(/^\.\//, '');
        if (zip.files[cleanHref] && !zip.files[cleanHref].dir) {
          foundPath = cleanHref;
        }
      }

      // Strategy 3: Case-insensitive search
      if (!foundPath) {
        const hrefLower = href.toLowerCase();
        foundPath =
          allZipFiles.find((f) => f.toLowerCase() === hrefLower) || '';
      }

      // Strategy 4: Match by basename
      if (!foundPath && hrefBasename) {
        const basenameLower = hrefBasename.toLowerCase();
        foundPath =
          allZipFiles.find(
            (f) =>
              f.toLowerCase().endsWith('/' + basenameLower) ||
              f.toLowerCase().endsWith(basenameLower)
          ) || '';
      }

      // Strategy 5: Find any image file that might match
      if (!foundPath && hrefBasename) {
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'];
        foundPath =
          allZipFiles.find((f) => {
            const ext = f.toLowerCase().split('.').pop() || '';
            return imageExtensions.includes(ext);
          }) || '';
      }

      if (foundPath && zip.files[foundPath]) {
        const imageBlob = await zip.files[foundPath].async('blob');
        const ext = foundPath.toLowerCase().split('.').pop();
        const mimeMap: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          bmp: 'image/bmp',
          webp: 'image/webp',
          tif: 'image/tiff',
          tiff: 'image/tiff',
        };
        const mime = mimeMap[ext || ''] || 'image/png';
        const typedBlob = new Blob([imageBlob], { type: mime });
        imageUrl = URL.createObjectURL(typedBlob);
        debugInfo.push(
          `Overlay ${i}: найдено изображение "${foundPath}", MIME=${mime}, размер=${(typedBlob.size / 1024).toFixed(1)} КБ`
        );
      } else {
        debugInfo.push(
          `Overlay ${i}: изображение НЕ НАЙДЕНО в архиве (искали "${href}")`
        );
        // Try external URL
        if (href.startsWith('http')) {
          imageUrl = href;
          debugInfo.push(`Overlay ${i}: пробуем внешнюю ссылку`);
        }
      }
    } else {
      // Plain KML - try href as URL
      if (href.startsWith('http')) {
        imageUrl = href;
        debugInfo.push(`Overlay ${i}: внешняя ссылка`);
      }
    }

    if (!imageUrl) {
      debugInfo.push(`Overlay ${i}: ПРОПУСК - не удалось получить изображение`);
      continue;
    }

    // Parse bounds
    let south = NaN,
      north = NaN,
      west = NaN,
      east = NaN;

    const latLonBox = overlay.querySelector('LatLonBox');
    if (latLonBox) {
      south = parseFloat(latLonBox.querySelector('south')?.textContent || 'NaN');
      north = parseFloat(latLonBox.querySelector('north')?.textContent || 'NaN');
      west = parseFloat(latLonBox.querySelector('west')?.textContent || 'NaN');
      east = parseFloat(latLonBox.querySelector('east')?.textContent || 'NaN');
      debugInfo.push(
        `Overlay ${i}: LatLonBox С=${north} Ю=${south} З=${west} В=${east}`
      );
    }

    // Try direct child elements
    if (isNaN(south)) {
      south = parseFloat(overlay.querySelector('south')?.textContent || 'NaN');
      north = parseFloat(overlay.querySelector('north')?.textContent || 'NaN');
      west = parseFloat(overlay.querySelector('west')?.textContent || 'NaN');
      east = parseFloat(overlay.querySelector('east')?.textContent || 'NaN');
      if (!isNaN(south)) {
        debugInfo.push(
          `Overlay ${i}: Прямые координаты С=${north} Ю=${south} З=${west} В=${east}`
        );
      }
    }

    // Try LatLonQuad
    if (isNaN(south)) {
      const latLonQuad = overlay.querySelector('LatLonQuad');
      if (latLonQuad) {
        const coords =
          latLonQuad.querySelector('coordinates')?.textContent?.trim() || '';
        const points = coords
          .split(/\s+/)
          .map((c) => {
            const [lng, lat] = c.split(',').map(Number);
            return { lat, lng };
          })
          .filter((p) => !isNaN(p.lat) && !isNaN(p.lng));

        if (points.length >= 3) {
          const lats = points.map((p) => p.lat);
          const lngs = points.map((p) => p.lng);
          south = Math.min(...lats);
          north = Math.max(...lats);
          west = Math.min(...lngs);
          east = Math.max(...lngs);
          debugInfo.push(
            `Overlay ${i}: LatLonQuad С=${north} Ю=${south} З=${west} В=${east}`
          );
        }
      }
    }

    if (isNaN(south) || isNaN(north) || isNaN(west) || isNaN(east)) {
      debugInfo.push(`Overlay ${i}: ПРОПУСК - координаты не найдены`);
      continue;
    }

    // <rotation> of LatLonBox: image fills the box, then rotates about its
    // center (positive = counterclockwise). Normalize into (-180, 180].
    const rotationRaw = parseFloat(
      latLonBox?.querySelector('rotation')?.textContent || '0'
    );
    const rotation = isNaN(rotationRaw)
      ? 0
      : ((rotationRaw % 360) + 540) % 360 - 180;

    let finalImageUrl = imageUrl;
    let finalBounds = { south, west, north, east };
    let appliedRotation: number | undefined = undefined;

    if (Math.abs(rotation) > 0.01) {
      debugInfo.push(
        `Overlay ${i}: rotation=${rotationRaw.toFixed(2)}°, применяю поворот изображения`
      );
      try {
        const rotated = await applyOverlayRotation(imageUrl, finalBounds, rotation);
        if (rotated) {
          if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
          finalImageUrl = rotated.imageUrl;
          finalBounds = rotated.bounds;
          appliedRotation = rotation;
          debugInfo.push(
            `Overlay ${i}: поворот применён (${rotation.toFixed(2)}°, формат ${rotated.encoded}), новые границы Ю=${finalBounds.south.toFixed(6)} С=${finalBounds.north.toFixed(6)} З=${finalBounds.west.toFixed(6)} В=${finalBounds.east.toFixed(6)}`
          );
        } else {
          debugInfo.push(
            `Overlay ${i}: поворот НЕ применён - не удалось обработать изображение`
          );
        }
      } catch (e) {
        debugInfo.push(
          `Overlay ${i}: поворот НЕ применён - ${(e as Error).message}`
        );
      }
    }

    overlays.push({
      imageUrl: finalImageUrl,
      bounds: finalBounds,
      name: overlayName,
      rotation: appliedRotation,
    });
  }

  return overlays;
}
