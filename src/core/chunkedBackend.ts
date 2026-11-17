import {
  ChunkedFieldInput,
  ChunkPayload,
  FieldBackendStats,
  FieldMaskBox,
  FIELD_BACKEND_PROTOCOL_VERSION,
  FieldSampleResult,
  makeAxis,
} from './fieldProtocol';
import { AbstractFieldBackend, AggregateBuilder, buildFieldStats, worldMaxOf, worldMinOf } from './fieldBackend';
import { mergeCellRuns, sampleTrilinear, TrilinearHost } from './sampling';
import { clamp, SampleReason, Vec3, vec3 } from './types';
import type { FieldMeta } from './grid';

interface Chunk {
  index: [number, number, number];
  /** Cell extent actually stored (trimmed at the lattice edge). */
  cellDims: [number, number, number];
  /** Stored node layer extent = cellDims + 1 per axis. */
  nodeDims: [number, number, number];
  velocity: Float32Array;
  scalars: Record<string, Float32Array>;
  nodeMissing: Uint8Array;
  nodeSolid: Uint8Array;
}

/**
 * Chunked storage. Each present chunk stores its own cell block plus one node
 * layer (shared with the neighbouring chunk). A chunk that is not supplied is
 * a *gap in coverage*: sampling inside it returns `missing-chunk` (never a
 * zero velocity), so the integrator stops with a bounded terminal reason. The
 * dense sampler is reused per chunk so interpolation cannot drift between the
 * two layouts.
 */
export class ChunkedFieldBackend extends AbstractFieldBackend implements TrilinearHost {
  readonly protocolVersion = FIELD_BACKEND_PROTOCOL_VERSION;
  readonly kind = 'chunked' as const;
  readonly meta: FieldMeta;
  readonly axes;
  readonly scalarNames: readonly string[];
  readonly chunkSize: [number, number, number];
  readonly chunkDims: [number, number, number];
  readonly stats: FieldBackendStats;

  private readonly chunks: (Chunk | null)[];
  /** Global cell index → owning chunk, or -1 when absent. */
  private readonly cellChunk: Int32Array;
  private readonly cellMissing: Uint8Array;
  private readonly cellSolid: Uint8Array;
  private readonly cellAbsent: Uint8Array;
  private boxes: FieldMaskBox[] | null = null;

  constructor(input: ChunkedFieldInput) {
    super();
    this.meta = { ...input.meta };
    this.axes = [makeAxis(input.axes[0]), makeAxis(input.axes[1]), makeAxis(input.axes[2])] as const;
    const dims: [number, number, number] = [this.axes[0].count, this.axes[1].count, this.axes[2].count];
    const [sx, sy, sz] = input.chunkSize;
    if (![sx, sy, sz].every((s) => Number.isInteger(s) && s >= 1)) {
      throw new Error('分块尺寸必须为 >=1 的整数');
    }
    this.chunkSize = [sx, sy, sz];
    const [cnx, cny, cnz] = this.cellDims;
    this.chunkDims = [Math.ceil(cnx / sx), Math.ceil(cny / sy), Math.ceil(cnz / sz)];
    const chunkCount = this.chunkDims[0] * this.chunkDims[1] * this.chunkDims[2];
    this.chunks = new Array<Chunk | null>(chunkCount).fill(null);
    this.cellChunk = new Int32Array(cnx * cny * cnz).fill(-1);
    this.cellMissing = new Uint8Array(cnx * cny * cnz);
    this.cellSolid = new Uint8Array(cnx * cny * cnz);
    this.cellAbsent = new Uint8Array(cnx * cny * cnz);

    for (const payload of input.chunks) {
      this.installChunk(payload);
    }

    const scalarNames = new Set<string>();
    for (const chunk of this.chunks) {
      if (!chunk) continue;
      for (const name of Object.keys(chunk.scalars)) scalarNames.add(name);
    }
    this.scalarNames = [...scalarNames].sort();

    // Cells not covered by any supplied chunk are a coverage gap.
    for (let c = 0; c < this.cellChunk.length; c++) this.cellAbsent[c] = this.cellChunk[c] < 0 ? 1 : 0;

    // Aggregate over unique global nodes so shared chunk layers are not
    // double-counted in reported speed statistics.
    const aggregate = new AggregateBuilder();
    const tmp: Vec3 = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let i = 0; i < dims[0]; i++) {
          const cell: [number, number, number] = [
            Math.min(i, dims[0] - 2),
            Math.min(j, dims[1] - 2),
            Math.min(k, dims[2] - 2),
          ];
          const corner: [number, number, number] = [i - cell[0], j - cell[1], k - cell[2]];
          const chunk = this.chunkAt(cell);
          if (!chunk) continue;
          const local = this.localNodeIndex(chunk, cell, corner);
          if (chunk.nodeMissing[local] || chunk.nodeSolid[local]) continue;
          if (!this.readVelocity(cell, corner, tmp)) continue;
          aggregate.addVelocity(tmp);
          for (const name of this.scalarNames) {
            aggregate.addScalar(name, this.readScalar(name, cell, corner));
          }
        }
      }
    }

    let present = 0;
    for (const chunk of this.chunks) if (chunk) present++;

    this.stats = buildFieldStats({
      protocolVersion: this.protocolVersion,
      backendKind: this.kind,
      meta: this.meta,
      axes: this.axes,
      aggregates: aggregate.finish(dims[0] * dims[1] * dims[2]),
      cellDims: this.cellDims,
      cellMissing: this.cellMissing,
      cellSolid: this.cellSolid,
      chunkSize: this.chunkSize,
      chunkDims: this.chunkDims,
      chunkCount,
      presentChunkCount: present,
      missingChunkCells: this.cellAbsent,
    });
  }

  get dims(): [number, number, number] {
    return [this.axes[0].count, this.axes[1].count, this.axes[2].count];
  }

  private installChunk(payload: ChunkPayload): void {
    const [cx, cy, cz] = this.chunkDims;
    const [cxi, cyi, czi] = payload.index;
    if (cxi < 0 || cyi < 0 || czi < 0 || cxi >= cx || cyi >= cy || czi >= cz) {
      throw new Error(`块索引 [${payload.index.join(',')}] 超出范围 ${cx}×${cy}×${cz}`);
    }
    const [sx, sy, sz] = this.chunkSize;
    const [cnx, cny, cnz] = this.cellDims;
    const i0 = cxi * sx;
    const j0 = cyi * sy;
    const k0 = czi * sz;
    const cellDims: [number, number, number] = [
      Math.min(sx, cnx - i0),
      Math.min(sy, cny - j0),
      Math.min(sz, cnz - k0),
    ];
    const nodeDims: [number, number, number] = [cellDims[0] + 1, cellDims[1] + 1, cellDims[2] + 1];
    const n = nodeDims[0] * nodeDims[1] * nodeDims[2];
    if (payload.velocity.length !== 3 * n) {
      throw new Error(`块 [${payload.index.join(',')}] 速度长度 ${payload.velocity.length} 与节点数 ${n} 不匹配`);
    }
    if (payload.nodeMissing.length !== n || payload.nodeSolid.length !== n) {
      throw new Error(`块 [${payload.index.join(',')}] 掩膜长度与节点数 ${n} 不匹配`);
    }
    const scalars: Record<string, Float32Array> = {};
    for (const [name, arr] of Object.entries(payload.scalars)) {
      if (arr.length !== n) throw new Error(`块 [${payload.index.join(',')}] 标量 ${name} 长度与节点数不匹配`);
      scalars[name] = arr;
    }
    const chunk: Chunk = {
      index: [cxi, cyi, czi],
      cellDims,
      nodeDims,
      velocity: payload.velocity,
      scalars,
      nodeMissing: payload.nodeMissing,
      nodeSolid: payload.nodeSolid,
    };
    this.chunks[this.chunkIndexOf(chunk.index)] = chunk;

    // Cell-level masks come from this chunk's node layer. Where two chunks
    // disagree along the shared layer, any flagged corner makes the cell
    // unavailable — the conservative reading.
    for (let lk = 0; lk < cellDims[2]; lk++) {
      for (let lj = 0; lj < cellDims[1]; lj++) {
        for (let li = 0; li < cellDims[0]; li++) {
          const gi = i0 + li;
          const gj = j0 + lj;
          const gk = k0 + lk;
          const ci = gi + cnx * (gj + cny * gk);
          let miss = 0;
          let solid = 0;
          for (let dk = 0; dk < 2; dk++) {
            for (let dj = 0; dj < 2; dj++) {
              for (let di = 0; di < 2; di++) {
                const local = li + di + nodeDims[0] * (lj + dj + nodeDims[1] * (lk + dk));
                miss |= chunk.nodeMissing[local];
                solid |= chunk.nodeSolid[local];
              }
            }
          }
          this.cellMissing[ci] = miss ? 1 : 0;
          this.cellSolid[ci] = solid ? 1 : 0;
          this.cellChunk[ci] = this.chunkIndexOf(chunk.index);
        }
      }
    }
  }
  sample(p: Vec3, out?: FieldSampleResult): FieldSampleResult {
    return sampleTrilinear(this, p, out);
  }

  cellState(i: number, j: number, k: number): SampleReason {
    return this.cellStateAt([i, j, k]);
  }

  cellStateAt(cell: [number, number, number]): SampleReason {
    const ci = this.cellIndexOf(cell);
    if (this.cellChunk[ci] < 0) return 'missing-chunk';
    if (this.cellSolid[ci]) return 'solid';
    if (this.cellMissing[ci]) return 'missing-data';
    return 'ok';
  }

  chunkPresent(index: [number, number, number]): boolean {
    const res = this.chunkCellBounds(index);
    if (!res) return false;
    return this.chunks[this.chunkIndexOf(index)] !== null;
  }

  private chunkAt(cell: [number, number, number]): Chunk | null {
    const ci = this.cellIndexOf(cell);
    const chunk = this.cellChunk[ci];
    return chunk >= 0 ? this.chunks[chunk] : null;
  }

  private localNodeIndex(chunk: Chunk, cell: [number, number, number], corner: [number, number, number]): number {
    const [cx, cy, cz] = chunk.index;
    const [sx, sy, sz] = this.chunkSize;
    const li = cell[0] + corner[0] - cx * sx;
    const lj = cell[1] + corner[1] - cy * sy;
    const lk = cell[2] + corner[2] - cz * sz;
    return li + chunk.nodeDims[0] * (lj + chunk.nodeDims[1] * lk);
  }

  readVelocity(cell: [number, number, number], corner: [number, number, number], out: Vec3): boolean {
    const chunk = this.chunkAt(cell);
    if (!chunk) return false;
    const local = this.localNodeIndex(chunk, cell, corner);
    const vx = chunk.velocity[3 * local];
    const vy = chunk.velocity[3 * local + 1];
    const vz = chunk.velocity[3 * local + 2];
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) return false;
    out.x = vx;
    out.y = vy;
    out.z = vz;
    return true;
  }

  readScalar(name: string, cell: [number, number, number], corner: [number, number, number]): number {
    const chunk = this.chunkAt(cell);
    if (!chunk) return Number.NaN;
    const arr = chunk.scalars[name];
    if (!arr) return Number.NaN;
    return arr[this.localNodeIndex(chunk, cell, corner)];
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
        ...mergeCellRuns(this.cellDims, this.cellAbsent, wmin, wmax, 'missing-chunk'),
      ];
    }
    return this.boxes;
  }
}
