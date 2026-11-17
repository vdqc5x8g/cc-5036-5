import type { FieldMeta } from './grid';
import {
  axisCenter,
  axisGridCoordinate,
  axisStats,
  axisWorldAt,
  boundsOfAxes,
  FieldAxis,
  FieldBackend,
  FieldBackendStats,
  FieldBackendKind,
  FieldMaskBox,
  FieldSampleResult,
  nominalSpacingOf,
} from './fieldProtocol';
import { Vec3, vec3, SampleReason } from './types';

export function worldMinOf(axes: readonly [FieldAxis, FieldAxis, FieldAxis], i: number, j: number, k: number): Vec3 {
  return vec3(
    axes[0].coords[Math.max(0, Math.min(axes[0].count - 1, i))],
    axes[1].coords[Math.max(0, Math.min(axes[1].count - 1, j))],
    axes[2].coords[Math.max(0, Math.min(axes[2].count - 1, k))],
  );
}

export function worldMaxOf(axes: readonly [FieldAxis, FieldAxis, FieldAxis], i: number, j: number, k: number): Vec3 {
  return worldMinOf(axes, i + 1, j + 1, k + 1);
}

export interface MaskWorldBounds {
  bounds: { min: Vec3; max: Vec3 } | null;
  count: number;
}

export function maskWorldBounds(
  cellDims: [number, number, number],
  flags: Uint8Array,
  axes: readonly [FieldAxis, FieldAxis, FieldAxis],
): MaskWorldBounds {
  const [cnx, cny, cnz] = cellDims;
  let count = 0;
  const min = vec3(Infinity, Infinity, Infinity);
  const max = vec3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < cnz; k++) {
    for (let j = 0; j < cny; j++) {
      for (let i = 0; i < cnx; i++) {
        if (!flags[i + cnx * (j + cny * k)]) continue;
        count++;
        const lo = worldMinOf(axes, i, j, k);
        const hi = worldMaxOf(axes, i, j, k);
        min.x = Math.min(min.x, lo.x);
        min.y = Math.min(min.y, lo.y);
        min.z = Math.min(min.z, lo.z);
        max.x = Math.max(max.x, hi.x);
        max.y = Math.max(max.y, hi.y);
        max.z = Math.max(max.z, hi.z);
      }
    }
  }
  return { bounds: count ? { min, max } : null, count };
}

export interface FieldAggregates {
  nodeCount: number;
  validNodeCount: number;
  speedMin: number;
  speedMax: number;
  speedSum: number;
  scalarRanges: Record<string, { min: number; max: number }>;
}

export interface StatsInput {
  protocolVersion: number;
  backendKind: FieldBackendKind;
  meta: FieldMeta;
  axes: readonly [FieldAxis, FieldAxis, FieldAxis];
  aggregates: FieldAggregates;
  cellDims: [number, number, number];
  cellMissing: Uint8Array;
  cellSolid: Uint8Array;
  chunkSize: [number, number, number] | null;
  chunkDims: [number, number, number] | null;
  chunkCount: number;
  presentChunkCount: number;
  missingChunkCells: Uint8Array | null;
}

export function buildFieldStats(input: StatsInput): FieldBackendStats {
  const { axes, meta, aggregates } = input;
  const missing = maskWorldBounds(input.cellDims, input.cellMissing, axes);
  const solid = maskWorldBounds(input.cellDims, input.cellSolid, axes);
  const missingChunk = input.missingChunkCells
    ? maskWorldBounds(input.cellDims, input.missingChunkCells, axes)
    : { bounds: null, count: 0 };

  const scalarRanges: Record<string, { min: number; max: number; unit: string }> = {};
  for (const [name, range] of Object.entries(aggregates.scalarRanges)) {
    scalarRanges[name] = { ...range, unit: meta.units.scalar?.[name] ?? '' };
  }

  const cellCount = input.cellDims[0] * input.cellDims[1] * input.cellDims[2];
  const chunkCount = input.chunkCount;
  const missingChunkCount = chunkCount - input.presentChunkCount;
  return {
    protocolVersion: input.protocolVersion,
    backendKind: input.backendKind,
    nodeCount: aggregates.nodeCount,
    cellCount,
    validNodeCount: aggregates.validNodeCount,
    missingCellCount: missing.count,
    solidCellCount: solid.count,
    missingCellFraction: cellCount ? missing.count / cellCount : 0,
    missingBounds: missing.bounds,
    solidBounds: solid.bounds,
    speedMin: Number.isFinite(aggregates.speedMin) ? aggregates.speedMin : 0,
    speedMax: Number.isFinite(aggregates.speedMax) ? aggregates.speedMax : 0,
    speedMean: aggregates.validNodeCount ? aggregates.speedSum / aggregates.validNodeCount : 0,
    scalarRanges,
    extent: boundsOfAxes(axes),
    spacing: nominalSpacingOf(axes),
    dims: [axes[0].count, axes[1].count, axes[2].count],
    axes: [axisStats(axes[0]), axisStats(axes[1]), axisStats(axes[2])],
    axesUniform: [axes[0].uniform, axes[1].uniform, axes[2].uniform],
    axisSpacing: {
      min: vec3(axes[0].spacingMin, axes[1].spacingMin, axes[2].spacingMin),
      max: vec3(axes[0].spacingMax, axes[1].spacingMax, axes[2].spacingMax),
    },
    chunkSize: input.chunkSize,
    chunkDims: input.chunkDims,
    chunkCount,
    presentChunkCount: input.presentChunkCount,
    missingChunkCount,
    missingChunkFraction: chunkCount ? missingChunkCount / chunkCount : 0,
    missingChunkBounds: missingChunk.bounds,
  };
}

/** Accumulate per-node statistics; shared by dense and chunked backends. */
export class AggregateBuilder {
  validNodeCount = 0;
  speedMin = Infinity;
  speedMax = -Infinity;
  speedSum = 0;
  private ranges: Record<string, { min: number; max: number }> = {};

  addVelocity(v: Vec3): void {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return;
    this.validNodeCount++;
    const sp = Math.hypot(v.x, v.y, v.z);
    this.speedMin = Math.min(this.speedMin, sp);
    this.speedMax = Math.max(this.speedMax, sp);
    this.speedSum += sp;
  }

  addScalar(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const range = this.ranges[name] ?? { min: Infinity, max: -Infinity };
    range.min = Math.min(range.min, value);
    range.max = Math.max(range.max, value);
    this.ranges[name] = range;
  }

  finish(nodeCount: number): FieldAggregates {
    const scalarRanges: Record<string, { min: number; max: number }> = {};
    for (const [name, range] of Object.entries(this.ranges)) scalarRanges[name] = range;
    return {
      nodeCount,
      validNodeCount: this.validNodeCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      speedSum: this.speedSum,
      scalarRanges,
    };
  }
}


/**
 * Protocol plumbing shared by every backend: coordinate lookup, cell/chunk
 * indexing and bounds. Subclasses supply storage-specific sampling.
 */
export abstract class AbstractFieldBackend implements FieldBackend {
  abstract readonly protocolVersion: number;
  abstract readonly kind: FieldBackendKind;
  abstract readonly meta: FieldMeta;
  abstract readonly axes: readonly [FieldAxis, FieldAxis, FieldAxis];
  abstract readonly scalarNames: readonly string[];
  abstract readonly stats: FieldBackendStats;
  abstract readonly chunkSize: [number, number, number] | null;
  abstract readonly chunkDims: [number, number, number] | null;
  epoch = 0;

  abstract sample(p: Vec3, out?: FieldSampleResult): FieldSampleResult;
  abstract nearestValidPoint(p: Vec3, maxRings?: number): Vec3 | null;
  abstract maskBoxes(): FieldMaskBox[];

  get dims(): [number, number, number] {
    return [this.axes[0].count, this.axes[1].count, this.axes[2].count];
  }

  get cellDims(): [number, number, number] {
    return [this.axes[0].count - 1, this.axes[1].count - 1, this.axes[2].count - 1];
  }

  get extent(): { min: Vec3; max: Vec3 } {
    return boundsOfAxes(this.axes);
  }

  abstract cellState(i: number, j: number, k: number): SampleReason;
  abstract cellStateAt(cell: [number, number, number]): SampleReason;
  abstract chunkPresent(index: [number, number, number]): boolean;

  cellIndexOf(cell: [number, number, number]): number {
    const [cnx, cny] = this.cellDims;
    return cell[0] + cnx * (cell[1] + cny * cell[2]);
  }

  cellCenter(i: number, j: number, k: number): Vec3 {
    return vec3(axisCenter(this.axes[0], i), axisCenter(this.axes[1], j), axisCenter(this.axes[2], k));
  }

  worldToGrid(p: Vec3): Vec3 {
    return vec3(
      axisGridCoordinate(this.axes[0], p.x),
      axisGridCoordinate(this.axes[1], p.y),
      axisGridCoordinate(this.axes[2], p.z),
    );
  }

  gridToWorld(g: Vec3): Vec3 {
    return vec3(axisWorldAt(this.axes[0], g.x), axisWorldAt(this.axes[1], g.y), axisWorldAt(this.axes[2], g.z));
  }

  isInsideData(p: Vec3): boolean {
    return this.sample(p).ok;
  }

  scalarRange(name: string): { min: number; max: number } | null {
    const range = this.stats.scalarRanges[name];
    return range ? { min: range.min, max: range.max } : null;
  }

  chunkOf(cell: [number, number, number]): [number, number, number] {
    if (!this.chunkSize) return [-1, -1, -1];
    const [sx, sy, sz] = this.chunkSize;
    return [Math.floor(cell[0] / sx), Math.floor(cell[1] / sy), Math.floor(cell[2] / sz)];
  }

  chunkIndexOf(chunk: [number, number, number]): number {
    if (!this.chunkDims) return -1;
    const [cx, cy] = this.chunkDims;
    return chunk[0] + cx * (chunk[1] + cy * chunk[2]);
  }

  /** Largest cell-aligned chunk box that lies inside this lattice. */
  protected chunkCellBounds(c: [number, number, number]): { i0: number; j0: number; k0: number; i1: number; j1: number; k1: number } | null {
    if (!this.chunkSize || !this.chunkDims) return null;
    const [cx, cy, cz] = this.chunkDims;
    if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= cx || c[1] >= cy || c[2] >= cz) return null;
    const [sx, sy, sz] = this.chunkSize;
    const [cnx, cny, cnz] = this.cellDims;
    const i0 = c[0] * sx;
    const j0 = c[1] * sy;
    const k0 = c[2] * sz;
    return {
      i0,
      j0,
      k0,
      i1: Math.min(cnx - 1, i0 + sx - 1),
      j1: Math.min(cny - 1, j0 + sy - 1),
      k1: Math.min(cnz - 1, k0 + sz - 1),
    };
  }

  chunkWorldBounds(chunk: [number, number, number]): { min: Vec3; max: Vec3 } | null {
    const b = this.chunkCellBounds(chunk);
    if (!b) return null;
    return {
      min: worldMinOf(this.axes, b.i0, b.j0, b.k0),
      max: worldMaxOf(this.axes, b.i1, b.j1, b.k1),
    };
  }

  protected worldMin(i: number, j: number, k: number): Vec3 {
    return worldMinOf(this.axes, i, j, k);
  }

  protected worldMax(i: number, j: number, k: number): Vec3 {
    return worldMaxOf(this.axes, i, j, k);
  }
}
