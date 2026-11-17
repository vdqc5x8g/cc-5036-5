import {
  DenseFieldInput,
  FieldBackendStats,
  FieldMaskBox,
  FIELD_BACKEND_PROTOCOL_VERSION,
  FieldSampleResult,
  makeAxis,
} from './fieldProtocol';
import { AbstractFieldBackend, AggregateBuilder, buildFieldStats, worldMaxOf, worldMinOf } from './fieldBackend';
import { computeCellMasks, mergeCellRuns, sampleTrilinear, TrilinearHost } from './sampling';
import { clamp, SampleReason, Vec3, vec3 } from './types';
import type { FieldMeta } from './grid';

/**
 * Dense, node-major storage with explicit per-axis node coordinates.
 * Unavailability is decided by node/cell masks; a zero velocity is a
 * legitimate value and never doubles as a missing-data marker.
 */
export class DenseFieldBackend extends AbstractFieldBackend implements TrilinearHost {
  readonly protocolVersion = FIELD_BACKEND_PROTOCOL_VERSION;
  readonly kind = 'dense' as const;
  readonly meta: FieldMeta;
  readonly axes;
  readonly scalarNames: readonly string[];
  readonly chunkSize = null;
  readonly chunkDims = null;
  readonly stats: FieldBackendStats;

  private readonly velocity: Float32Array;
  private readonly scalars: Record<string, Float32Array>;
  private readonly validNode: Uint8Array;
  private readonly cellMissing: Uint8Array;
  private readonly cellSolid: Uint8Array;
  private boxes: FieldMaskBox[] | null = null;

  constructor(input: DenseFieldInput) {
    super();
    this.meta = { ...input.meta };
    this.axes = [makeAxis(input.axes[0]), makeAxis(input.axes[1]), makeAxis(input.axes[2])] as const;
    const dims: [number, number, number] = [this.axes[0].count, this.axes[1].count, this.axes[2].count];
    const n = dims[0] * dims[1] * dims[2];
    if (input.velocity.length !== 3 * n) {
      throw new Error(`速度数组长度 ${input.velocity.length} 与节点数 ${n} 不匹配（期望 ${3 * n}）`);
    }
    for (const [name, arr] of Object.entries(input.scalars)) {
      if (arr.length !== n) throw new Error(`标量 ${name} 长度 ${arr.length} 与节点数 ${n} 不匹配`);
    }
    if (input.nodeMissing.length !== n) throw new Error('缺测掩膜长度与节点数不匹配');
    if (input.nodeSolid.length !== n) throw new Error('固体掩膜长度与节点数不匹配');

    this.velocity = input.velocity;
    this.scalars = input.scalars;
    this.scalarNames = Object.keys(input.scalars).sort();
    const masks = computeCellMasks(dims, input.nodeMissing, input.nodeSolid);
    this.cellMissing = masks.cellMissing;
    this.cellSolid = masks.cellSolid;
    this.validNode = masks.validNode;

    const aggregate = new AggregateBuilder();
    const tmp: Vec3 = { x: 0, y: 0, z: 0 };
    for (let node = 0; node < n; node++) {
      if (!this.validNode[node]) continue;
      if (!this.nodeVelocity(node, tmp)) continue;
      aggregate.addVelocity(tmp);
      for (const name of this.scalarNames) aggregate.addScalar(name, this.scalars[name][node]);
    }

    this.stats = buildFieldStats({
      protocolVersion: this.protocolVersion,
      backendKind: this.kind,
      meta: this.meta,
      axes: this.axes,
      aggregates: aggregate.finish(n),
      cellDims: this.cellDims,
      cellMissing: this.cellMissing,
      cellSolid: this.cellSolid,
      chunkSize: null,
      chunkDims: null,
      chunkCount: 0,
      presentChunkCount: 0,
      missingChunkCells: null,
    });
  }

  get dims(): [number, number, number] {
    return [this.axes[0].count, this.axes[1].count, this.axes[2].count];
  }

  sample(p: Vec3, out?: FieldSampleResult): FieldSampleResult {
    return sampleTrilinear(this, p, out);
  }

  cellState(i: number, j: number, k: number): SampleReason {
    return this.cellStateAt([i, j, k]);
  }

  cellStateAt(cell: [number, number, number]): SampleReason {
    const ci = this.cellIndexOf(cell);
    if (this.cellSolid[ci]) return 'solid';
    if (this.cellMissing[ci]) return 'missing-data';
    return 'ok';
  }

  chunkOf(): [number, number, number] {
    return [-1, -1, -1];
  }

  chunkIndexOf(): number {
    return -1;
  }

  chunkPresent(): boolean {
    return false;
  }

  readVelocity(cell: [number, number, number], corner: [number, number, number], out: Vec3): boolean {
    const [nx, ny] = this.dims;
    const node = cell[0] + corner[0] + nx * (cell[1] + corner[1] + ny * (cell[2] + corner[2]));
    return this.nodeVelocity(node, out);
  }

  readScalar(name: string, cell: [number, number, number], corner: [number, number, number]): number {
    const [nx, ny] = this.dims;
    const node = cell[0] + corner[0] + nx * (cell[1] + corner[1] + ny * (cell[2] + corner[2]));
    return this.scalars[name][node];
  }

  private nodeVelocity(node: number, out: Vec3): boolean {
    const vx = this.velocity[3 * node];
    const vy = this.velocity[3 * node + 1];
    const vz = this.velocity[3 * node + 2];
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) return false;
    out.x = vx;
    out.y = vy;
    out.z = vz;
    return true;
  }

  nearestValidPoint(p: Vec3, maxRings = 24): Vec3 | null {
    const [nx, ny, nz] = this.dims;
    const g = this.worldToGrid(p);
    const ci = clamp(Math.floor(g.x), 0, nx - 2);
    const cj = clamp(Math.floor(g.y), 0, ny - 2);
    const ck = clamp(Math.floor(g.z), 0, nz - 2);
    if (this.cellStateAt([ci, cj, ck]) === 'ok') return this.clampToBounds(p);
    const target = this.clampToBounds(p);
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (let ring = 1; ring <= maxRings; ring++) {
      for (let dk = -ring; dk <= ring; dk++) {
        for (let dj = -ring; dj <= ring; dj++) {
          for (let di = -ring; di <= ring; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== ring) continue;
            const i = ci + di;
            const j = cj + dj;
            const k = ck + dk;
            if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) continue;
            if (this.cellStateAt([i, j, k]) !== 'ok') continue;
            const c = this.cellCenter(i, j, k);
            const d = (c.x - target.x) ** 2 + (c.y - target.y) ** 2 + (c.z - target.z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  clampToBounds(p: Vec3, insetFraction = 0.001): Vec3 {
    const ext = this.extent;
    const inset = (min: number, max: number) => Math.min((max - min) * insetFraction, (max - min) * 0.5);
    return vec3(
      clamp(p.x, ext.min.x + inset(ext.min.x, ext.max.x), ext.max.x - inset(ext.min.x, ext.max.x)),
      clamp(p.y, ext.min.y + inset(ext.min.y, ext.max.y), ext.max.y - inset(ext.min.y, ext.max.y)),
      clamp(p.z, ext.min.z + inset(ext.min.z, ext.max.z), ext.max.z - inset(ext.min.z, ext.max.z)),
    );
  }

  maskBoxes(): FieldMaskBox[] {
    if (!this.boxes) {
      const wmin = (i: number, j: number, k: number) => worldMinOf(this.axes, i, j, k);
      const wmax = (i: number, j: number, k: number) => worldMaxOf(this.axes, i, j, k);
      this.boxes = [
        ...mergeCellRuns(this.cellDims, this.cellMissing, wmin, wmax, 'missing'),
        ...mergeCellRuns(this.cellDims, this.cellSolid, wmin, wmax, 'solid'),
      ];
    }
    return this.boxes;
  }
}
