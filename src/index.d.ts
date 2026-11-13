import type { MaskPainter, Material, Vector3 } from './render.js';
export { SunRenderer, drawElementMask, signedDistanceField } from './render.js';
export { sunPosition, screenLight, compassOffset } from './physics.js';
export type { MaskPainter, Material, Vector3 } from './render.js';

export type ShadowMode = 'auto' | 'cursor' | 'sunlight' | 'manual';
export type CalibrationMethod = 'compass' | 'sun';
export interface ShadowStatus {
  readonly mode: 'setup' | 'cursor' | 'sunlight' | 'manual' | 'destroyed';
  readonly phase: 'setup' | 'cursor' | 'location' | 'motion' | 'calibration' | 'live' | 'night' | 'backlit' | 'grazing' | 'manual' | 'error' | 'destroyed';
  readonly label: string;
  readonly message: string;
  readonly action: null | 'start' | 'retry' | 'calibrate';
  readonly actionLabel: string | null;
  readonly canCalibrate: boolean;
  readonly calibrationMethod: CalibrationMethod | null;
  readonly canAlign: boolean;
}
export interface ShadowOptions {
  /** Only matching descendants cast shadows. Defaults to .shadows-ink. */
  selector?: string;
  gapMm?: number;
  thicknessMm?: number;
  /** CSS pixels per millimeter, measured against a physical ruler when accuracy matters. */
  pixelsPerMm?: number;
  material?: Material;
  mode?: ShadowMode;
  sourceHeightMm?: number;
  onStatus?: (status: ShadowStatus) => void;
  /** Optional existing canvas. Otherwise the plugin creates and removes its own. */
  canvas?: HTMLCanvasElement;
  /** Transparent shadow-only overlay by default; false draws the demo receiver surface. */
  transparent?: boolean;
  /** Overrides DOM silhouette drawing. Coordinates are CSS pixels within the canvas. */
  paintMask?: MaskPainter;
}
export interface ShadowLight {
  /** Screen-space direction toward light: x right, y up, z out of the screen. */
  direction?: Vector3;
  /** Finite source position in millimeters from the canvas bottom-left; null is directional. */
  positionMm?: Vector3 | null;
  skyUp?: Vector3;
  daylight?: boolean;
  angularRadius?: number;
  altitude?: number;
}
export interface ShadowController {
  readonly ready: Promise<ShadowController>;
  readonly canvas: HTMLCanvasElement;
  readonly status: ShadowStatus | null;
  readonly options: Readonly<ShadowOptions>;
  setOptions(options: Omit<ShadowOptions, 'canvas' | 'transparent'>): ShadowController;
  setLight(light: ShadowLight): ShadowController;
  refresh(): Promise<void>;
  /** Call directly from a user click/tap to request motion and location permissions. */
  startSunlight(): Promise<void>;
  beginCalibration(method?: CalibrationMethod): boolean;
  calibrate(method?: CalibrationMethod): boolean;
  stopSunlight(): ShadowController;
  destroy(): void;
}
export function isMobileDevice(): boolean;
export function createShadows(root: HTMLElement, options?: ShadowOptions): ShadowController;
