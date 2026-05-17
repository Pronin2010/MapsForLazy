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

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB not available'));
      return;
    }
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
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(data);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {
    console.warn('[Storage] saveMapData failed:', err);
  }
}

export async function loadMapData(): Promise<SavedMapData | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get('last');
      request.onsuccess = () => { db.close(); resolve(request.result || null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  } catch (err) {
    console.warn('[Storage] loadMapData failed:', err);
    return null;
  }
}

export async function clearMapData(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete('last');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {
    console.warn('[Storage] clearMapData failed:', err);
  }
}

/**
 * Convert a blob URL (from URL.createObjectURL) to a base64 data URL
 */
export async function blobUrlToBase64(blobUrl: string): Promise<string> {
  try {
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status}`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn('[Storage] blobUrlToBase64 failed:', err);
    // Return empty data URL as fallback
    return 'data:image/png;base64,';
  }
}
