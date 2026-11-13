import type { Vector3 } from './render.js';
export interface OrientationReading {
  alpha: number;
  beta: number;
  gamma: number;
  absolute?: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}
export interface SunPosition { vector: [number, number, number]; azimuth: number; altitude: number; angularRadius: number; }
export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition;
export function screenLight(vector: Vector3, orientation: OrientationReading, screenAngle?: number): [number, number, number];
export function compassOffset(reading: OrientationReading): number | null;
