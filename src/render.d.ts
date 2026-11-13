export type Vector3 = readonly [number, number, number] | Float32Array;
export type Material = 'smooth' | 'concrete' | 'glass' | 'wood' | 'graph';
export type MaskPainter = (context: CanvasRenderingContext2D, width: number, height: number) => void;
export interface RenderOptions {
  paintMask: MaskPainter;
  compositeForeground?: boolean;
  transparent?: boolean;
}
export interface RenderLight {
  light: Vector3;
  lightPositionMm?: Vector3 | null;
  skyUp?: Vector3;
  gapMm: number;
  thicknessMm: number;
  pixelsPerMm: number;
  material: Material;
  daylight: boolean;
  angularRadius?: number;
  altitude?: number;
}
export class SunRenderer {
  constructor(canvas: HTMLCanvasElement, options: RenderOptions);
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  resize(): void;
  invalidateMask(): void;
  draw(options: RenderLight): void;
  destroy(): void;
}
/** Untransformed text, readable images, and explicit data-shadow-shape="box" rounded shapes. */
export function drawElementMask(context: CanvasRenderingContext2D, root: HTMLElement, selector?: string): void;
export function signedDistanceField(alpha: Uint8Array, width: number, height: number, texelsPerUnit?: number): Uint8Array;
