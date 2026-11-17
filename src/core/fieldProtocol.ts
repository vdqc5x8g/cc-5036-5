import type { FieldMeta, FieldPayload, FieldStats } from './grid';
import { SampleReason, Vec3 } from './types';

/**
 * Version of the field-data interface (coordinates + validity + sampling).
 * Bumped whenever a backend written against the previous contract can no
 * longer be read correctly. It is shown in the viewport HUD and stamped into
 * results, so a screenshot always names the interface version in use.
 *
 * v1 → dense `origin + uniform spacing + node arrays` (legacy VectorGrid).
 * v2 → explicit per-axis node coordinates, per-sample validity reason and an
 *      optional chunked storage layout.
 */
export const FIELD_BACKEND_PROTOCOL_VERSION = 2;
export const FIELD_BACKEND_PROTOCOL_LABEL = `v${FIELD_BACKEND_PROTOCOL_VERSION}`;

export type FieldBackendKind = 'dense' | 'chunked' | 'legacy-grid';

/** One axis with explicit node coordinates in metres, strictly increasing. */
export interface FieldAxis {
  readonly coords: Float64Array;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly uniform: boolean;
  readonly spacingMin: number;
  readonly spacingMax: number;
}

export interface FieldAxisStats {
  count: number;
  min: number;
  max: number;
  uniform: boolean;
  spacingMin: number;
  spacingMax: number;
}

export interface FieldSampleResult {
  ok: boolean;
  reason: SampleReason;
  v: Vec3;
  speed: number;
  scalars: Record<string, number>;
  /** Global cell index, x-fastest, or -1 when out of range. */
  cellIndex: number;
  cell: [number, number, number];
  /** Raw continuous grid coordinates; may extrapolate outside the lattice. */
  gridCoord: Vec3;
  /** Chunk index, x-fastest; -1 for dense storage and out-of-range points. */
  chunkIndex: number;
  chunk: [number, number, number];
}

export interface FieldMaskBox {
  kind: 'missing' | 'missing-chunk' | 'solid';
  min: Vec3;
  max: Vec3;
  cellCount: number;
  chunk?: [number, number, number];
}

export interface FieldBackendStats extends FieldStats {
  protocolVersion: number;
  backendKind: FieldBackendKind;
  axes: [FieldAxisStats, FieldAxisStats, FieldAxisStats];
  axesUniform: [boolean, boolean, boolean];
  axisSpacing: { min: Vec3; max: Vec3 };
  chunkSize: [number, number, number] | null;
  chunkDims: [number, number, number] | null;
  chunkCount: number;
  presentChunkCount: number;
  missingChunkCount: number;
  missingChunkFraction: number;
  missingChunkBounds: { min: Vec3; max: Vec3 } | null;
}

/**
 * Backend contract consumed by integration, validation and the viewport.
 * Implementations may be dense, chunked, or an adapter over the legacy
 * VectorGrid. Callers must never read a concrete storage layout.
 */
export interface FieldBackend {
  readonly protocolVersion: number;
  readonly kind: FieldBackendKind;
  readonly meta: FieldMeta;
  readonly axes: readonly [FieldAxis, FieldAxis, FieldAxis];
  readonly dims: [number, number, number];
  readonly scalarNames: readonly string[];
  readonly stats: FieldBackendStats;
  readonly extent: { min: Vec3; max: Vec3 };
  readonly chunkSize: [number, number, number] | null;
  readonly chunkDims: [number, number, number] | null;
  epoch: number;

  /**
   * Sample velocity, scalars and validity at a world point. A masked or absent
   * region returns ok=false with a reason; velocity is never substituted with
   * zero to make an unavailable point look valid.
   */
  sample(p: Vec3, out?: FieldSampleResult): FieldSampleResult;
  isInsideData(p: Vec3): boolean;
  nearestValidPoint(p: Vec3, maxRings?: number): Vec3 | null;
  scalarRange(name: string): { min: number; max: number } | null;
  /** Unavailable regions as world boxes, for the 3D viewport. */
  maskBoxes(): FieldMaskBox[];
  /** State of the cell with the given global index. */
  cellState(i: number, j: number, k: number): SampleReason;
  cellCenter(i: number, j: number, k: number): Vec3;
  worldToGrid(p: Vec3): Vec3;
  gridToWorld(g: Vec3): Vec3;
  chunkPresent(index: [number, number, number]): boolean;
  chunkWorldBounds(index: [number, number, number]): { min: Vec3; max: Vec3 } | null;
}

export interface DenseFieldInput {
  layout: 'dense';
  meta: FieldMeta;
  /** Node coordinates per axis in metres; each strictly increasing. */
  axes: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** Node-major, x-fastest, 3 components per node. */
  velocity: Float32Array;
  scalars: Record<string, Float32Array>;
  nodeMissing: Uint8Array;
  nodeSolid: Uint8Array;
}

export interface ChunkPayload {
  index: [number, number, number];
  velocity: Float32Array;
  scalars: Record<string, Float32Array>;
  nodeMissing: Uint8Array;
  nodeSolid: Uint8Array;
}

export interface ChunkedFieldInput {
  layout: 'chunked';
  meta: FieldMeta;
  axes: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** Chunk size in cells; every chunk stores its cells plus one shared node layer. */
  chunkSize: [number, number, number];
  /** Absent chunks are legitimately missing data, not zero velocity. */
  chunks: ChunkPayload[];
}

/** Any raw field description the app can turn into a backend. */
export type FieldInput = FieldPayload | DenseFieldInput | ChunkedFieldInput;

export function emptyFieldSample(reason: SampleReason = 'out-of-bounds'): FieldSampleResult {
  return {
    ok: false,
    reason,
    v: { x: 0, y: 0, z: 0 },
    speed: 0,
    scalars: {},
    cellIndex: -1,
    cell: [-1, -1, -1],
    gridCoord: { x: 0, y: 0, z: 0 },
    chunkIndex: -1,
    chunk: [-1, -1, -1],
  };
}

export function makeAxis(coords: ArrayLike<number>): FieldAxis {
  if (coords.length < 2) throw new Error('坐标轴至少需要 2 个节点');
  const arr = coords instanceof Float64Array ? coords : Float64Array.from(coords);
  let spacingMin = Infinity;
  let spacingMax = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) throw new Error(`坐标轴第 ${i} 个节点非有限值`);
    if (i > 0) {
      const d = arr[i] - arr[i - 1];
      if (!(d > 0)) throw new Error(`坐标轴必须严格递增（第 ${i - 1}→${i} 个节点间距 ${d}）`);
      spacingMin = Math.min(spacingMin, d);
      spacingMax = Math.max(spacingMax, d);
    }
  }
  const mean = (arr[arr.length - 1] - arr[0]) / (arr.length - 1);
  const uniform = spacingMax - spacingMin <= Math.max(1e-12, Math.abs(mean) * 1e-9);
  return {
    coords: arr,
    count: arr.length,
    min: arr[0],
    max: arr[arr.length - 1],
    uniform,
    spacingMin,
    spacingMax,
  };
}

/** Continuous grid coordinate; extrapolates with the nearest cell spacing outside the lattice. */
export function axisGridCoordinate(axis: FieldAxis, value: number): number {
  const n = axis.count;
  if (!Number.isFinite(value)) return Number.NaN;
  if (value <= axis.min) {
    const d = axis.coords[1] - axis.coords[0];
    return (value - axis.min) / d;
  }
  if (value >= axis.max) {
    const d = axis.coords[n - 1] - axis.coords[n - 2];
    return n - 1 + (value - axis.max) / d;
  }
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (axis.coords[mid] <= value) lo = mid;
    else hi = mid;
  }
  const i = Math.min(lo, n - 2);
  const d = axis.coords[i + 1] - axis.coords[i];
  return i + (value - axis.coords[i]) / d;
}

export interface AxisLocation {
  inside: boolean;
  /** Cell index 0..count-2 when inside; nearest cell otherwise. */
  i: number;
  /** Fraction within the cell, 0..1. */
  f: number;
  g: number;
}

export function axisLocate(axis: FieldAxis, value: number): AxisLocation {
  if (!Number.isFinite(value)) return { inside: false, i: 0, f: 0, g: Number.NaN };
  const tol = Math.max(1e-12, Math.abs(axis.max - axis.min) * 1e-12);
  if (value < axis.min - tol || value > axis.max + tol) {
    return {
      inside: false,
      i: value < axis.min ? 0 : axis.count - 2,
      f: value < axis.min ? 0 : 1,
      g: axisGridCoordinate(axis, value),
    };
  }
  const clamped = Math.min(axis.max, Math.max(axis.min, value));
  let lo = 0;
  let hi = axis.count - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (axis.coords[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const i = Math.min(lo, axis.count - 2);
  const d = axis.coords[i + 1] - axis.coords[i];
  const f = d > 0 ? Math.min(1, Math.max(0, (clamped - axis.coords[i]) / d)) : 0;
  return { inside: true, i, f, g: i + f };
}

export function axisWorldAt(axis: FieldAxis, g: number): number {
  if (!Number.isFinite(g)) return Number.NaN;
  const clamped = Math.min(axis.count - 1, Math.max(0, g));
  const i = Math.min(Math.floor(clamped), axis.count - 2);
  const f = clamped - i;
  return axis.coords[i] + (axis.coords[i + 1] - axis.coords[i]) * f;
}

export function axisCenter(axis: FieldAxis, i: number): number {
  const a = axis.coords[Math.min(axis.count - 1, Math.max(0, i))];
  const b = axis.coords[Math.min(axis.count - 1, Math.max(0, i + 1))];
  return (a + b) * 0.5;
}

export function axisStats(axis: FieldAxis): FieldAxisStats {
  return {
    count: axis.count,
    min: axis.min,
    max: axis.max,
    uniform: axis.uniform,
    spacingMin: axis.spacingMin,
    spacingMax: axis.spacingMax,
  };
}

export function axesFromUniformSpec(spec: {
  origin: Vec3;
  spacing: Vec3;
  dims: [number, number, number];
}): [FieldAxis, FieldAxis, FieldAxis] {
  const axis = (count: number, start: number, step: number): FieldAxis => {
    const coords = new Float64Array(count);
    for (let i = 0; i < count; i++) coords[i] = start + i * step;
    return makeAxis(coords);
  };
  return [
    axis(spec.dims[0], spec.origin.x, spec.spacing.x),
    axis(spec.dims[1], spec.origin.y, spec.spacing.y),
    axis(spec.dims[2], spec.origin.z, spec.spacing.z),
  ];
}

export function boundsOfAxes(axes: readonly [FieldAxis, FieldAxis, FieldAxis]): { min: Vec3; max: Vec3 } {
  return {
    min: { x: axes[0].min, y: axes[1].min, z: axes[2].min },
    max: { x: axes[0].max, y: axes[1].max, z: axes[2].max },
  };
}

export function nominalSpacingOf(axes: readonly [FieldAxis, FieldAxis, FieldAxis]): Vec3 {
  return {
    x: (axes[0].max - axes[0].min) / (axes[0].count - 1),
    y: (axes[1].max - axes[1].min) / (axes[1].count - 1),
    z: (axes[2].max - axes[2].min) / (axes[2].count - 1),
  };
}
