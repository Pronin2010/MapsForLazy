import 'leaflet';

declare module 'leaflet' {
  interface MapOptions {
    rotate?: boolean;
    bearing?: number;
    rotateControl?: boolean;
    shiftKeyRotate?: boolean;
  }

  interface Map {
    /** Rotate the map view (degrees, positive = clockwise on screen). */
    setBearing(theta: number): void;
    getBearing(): number;
  }
}

declare module 'leaflet-rotate';
