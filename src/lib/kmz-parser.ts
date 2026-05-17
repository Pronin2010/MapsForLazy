import JSZip from 'jszip';
import { kml } from '@mapbox/togeojson';
import type { GeoJsonObject } from 'geojson';

/**
 * Parse a KMZ file (ZIP containing KML) and return GeoJSON
 */
export async function parseKMZ(file: File): Promise<GeoJsonObject> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Find the KML file inside the KMZ
  const kmlFile = Object.keys(zip.files).find(
    (name) => name.endsWith('.kml') && !name.startsWith('__MACOSX')
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

/**
 * Parse a KML string and return GeoJSON
 */
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

/**
 * Extract GroundOverlay image from KMZ if present
 */
export async function extractKMZOverlays(file: File): Promise<Array<{
  imageUrl: string;
  bounds: [[number, number], [number, number]]; // [[south, west], [north, east]]
}>> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const overlays: Array<{
    imageUrl: string;
    bounds: [[number, number], [number, east: number]];
  }> = [];

  const kmlFile = Object.keys(zip.files).find(
    (name) => name.endsWith('.kml') && !name.startsWith('__MACOSX')
  );

  if (!kmlFile) return overlays;

  const kmlContent = await zip.files[kmlFile].async('text');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlContent, 'text/xml');

  // Find all GroundOverlay elements
  const groundOverlays = xmlDoc.querySelectorAll('GroundOverlay');

  for (const overlay of groundOverlays) {
    const icon = overlay.querySelector('Icon > href');
    if (!icon?.textContent) continue;

    const href = icon.textContent.trim();

    // Try to find the image in the KMZ
    const imageFile = Object.keys(zip.files).find(
      (name) => name.endsWith(href) || name.endsWith('/' + href) || name === href
    );

    if (!imageFile) continue;

    const imageBlob = await zip.files[imageFile].async('blob');
    const imageUrl = URL.createObjectURL(imageBlob);

    // Parse LatLonBox or LatLonQuad
    const latLonBox = overlay.querySelector('LatLonBox');
    let south = 0, north = 0, west = 0, east = 0;

    if (latLonBox) {
      south = parseFloat(latLonBox.querySelector('south')?.textContent || '0');
      north = parseFloat(latLonBox.querySelector('north')?.textContent || '0');
      west = parseFloat(latLonBox.querySelector('west')?.textContent || '0');
      east = parseFloat(latLonBox.querySelector('east')?.textContent || '0');
    }

    if (south !== 0 || north !== 0) {
      overlays.push({
        imageUrl,
        bounds: [[south, west], [north, east]],
      });
    }
  }

  return overlays;
}
