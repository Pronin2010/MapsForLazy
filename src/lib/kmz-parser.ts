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
}

export interface ParsedMapResult {
  geoJson: GeoJsonObject | null;
  overlays: MapOverlay[];
  featureCount: number;
  overlayCount: number;
  debugInfo: string[];
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

    overlays.push({
      imageUrl,
      bounds: { south, west, north, east },
      name: overlayName,
    });
  }

  return overlays;
}
