'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface DeviceOrientationState {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  isAvailable: boolean;
  hasPermission: boolean;
}

export interface DeviceOrientationHook extends DeviceOrientationState {
  requestPermission: () => Promise<boolean>;
}

export function useDeviceOrientation(): DeviceOrientationHook {
  const [state, setState] = useState<DeviceOrientationState>({
    alpha: null,
    beta: null,
    gamma: null,
    absolute: false,
    isAvailable: typeof window !== 'undefined' && 'DeviceOrientationEvent' in window,
    hasPermission: false,
  });

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      try {
        const permission = await (DeviceOrientationEvent as any).requestPermission();
        if (permission === 'granted') {
          setState((prev) => ({ ...prev, hasPermission: true }));
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    setState((prev) => ({ ...prev, hasPermission: true }));
    return true;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('DeviceOrientationEvent' in window)) return;

    const handleOrientation = (event: DeviceOrientationEvent) => {
      setState({
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        absolute: event.absolute,
        isAvailable: true,
        hasPermission: true,
      });
    };

    window.addEventListener('deviceorientation', handleOrientation);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
    };
  }, []);

  return {
    ...state,
    requestPermission,
  };
}
