'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null; // degrees from north
  speed: number | null; // m/s
  timestamp: number | null;
  error: string | null;
  isTracking: boolean;
}

export interface GeolocationHook extends GeolocationState {
  startTracking: () => void;
  stopTracking: () => void;
  hasSupport: boolean;
}

export function useGeolocation(): GeolocationHook {
  const [state, setState] = useState<GeolocationState>({
    latitude: null,
    longitude: null,
    accuracy: null,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    timestamp: null,
    error: null,
    isTracking: false,
  });

  const watchIdRef = useRef<number | null>(null);
  const positionsRef = useRef<GeolocationPosition[]>([]);

  const hasSupport = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const startTracking = useCallback(() => {
    if (!hasSupport) {
      setState((prev) => ({ ...prev, error: 'Геолокация не поддерживается вашим браузером' }));
      return;
    }

    setState((prev) => ({ ...prev, isTracking: true, error: null }));

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        // Store positions for heading calculation
        positionsRef.current.push(position);
        if (positionsRef.current.length > 10) {
          positionsRef.current.shift();
        }

        // Calculate heading from movement if device doesn't provide it
        let calculatedHeading: number | null = position.coords.heading;

        if (calculatedHeading === null && positionsRef.current.length >= 2) {
          const prev = positionsRef.current[positionsRef.current.length - 2];
          const curr = position;
          const dLat = curr.coords.latitude - prev.coords.latitude;
          const dLon = curr.coords.longitude - prev.coords.longitude;
          const dist = Math.sqrt(dLat * dLat + dLon * dLon);

          // Only calculate heading if moved enough (avoid GPS jitter)
          if (dist > 0.00001) {
            calculatedHeading = bearing(
              prev.coords.latitude,
              prev.coords.longitude,
              curr.coords.latitude,
              curr.coords.longitude
            );
          }
        }

        setState({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          heading: calculatedHeading,
          speed: position.coords.speed,
          timestamp: position.timestamp,
          error: null,
          isTracking: true,
        });
      },
      (error) => {
        let errorMessage: string;
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Доступ к геолокации запрещён. Разрешите доступ в настройках браузера.';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Информация о местоположении недоступна';
            break;
          case error.TIMEOUT:
            errorMessage = 'Время ожидания геолокации истекло';
            break;
          default:
            errorMessage = 'Неизвестная ошибка геолокации';
        }
        setState((prev) => ({ ...prev, error: errorMessage, isTracking: false }));
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 2000,
      }
    );
  }, [hasSupport]);

  const stopTracking = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    positionsRef.current = [];
    setState((prev) => ({ ...prev, isTracking: false }));
  }, []);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return {
    ...state,
    startTracking,
    stopTracking,
    hasSupport,
  };
}

/**
 * Calculate bearing between two points in degrees from north (0-360)
 */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

  let brng = toDeg(Math.atan2(y, x));
  return ((brng % 360) + 360) % 360;
}
