/**
 * IndexedDB-based storage for persisting the last opened map.
 * Stores GeoJSON data + overlay images (as base64) + bounds + metadata.
 */

const DB_NAME = 'orienteering-maps';
const DB_VERSION = 1;
const STORE_NAME = 'last-map';

export interface SavedMapData {
  id: 'last';               // always overwrite single entry
  fileName: string;
  mapType: 'file' | 'url';
  mapUrl?: string;           // for URL-loaded maps
  savedAt: number;           // timestamp
  geoJson: string;           // serialized GeoJSON
  overlays: SavedOverlay[];  // overlays with base64 images
}

export interface SavedOverlay {
  imageBase64: string;       // data:image/png;base64,...
  bounds: { south: number; west: number; north: number; east: number };
  name: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveMapData(data: SavedMapData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadMapData(): Promise<SavedMapData | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get('last');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function clearMapData(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete('last');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Convert a blob URL (from URL.createObjectURL) to a base64 data URL
 */
export async function blobUrlToBase64(blobUrl: string): Promise<string> {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
