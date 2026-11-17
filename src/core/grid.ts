import { clamp, Vec3, vec3 } from './types';

export type ScalarChannelMap = Record<string, Float32Array>;

export interface GridSpec {
  origin: Vec3;
  spacing: Vec3;
  dims: [number, number, number];
}

export interface AnalyticalReference {
  kind: 'uniform' | 'rankine-vortex' | 'hyperbolic';
  velocity?: Vec3;
  center?: [number, number];
  coreRadius?: number;
  angularSpeed?: number;
  a?: number;
  b?: number;
  c?: number;
  axis?: 'x' | 'y' | 'z';
  note?: string;
}

export interface FieldStats {
  nodeCount: number;
  cellCount: number;
  validNodeCount: number;
  missingCellCount: number;
  solidCellCount: number;
  missingCellFraction: number;
  missingBounds: { min: Vec3; max: Vec3 } | null;
  solidBounds: { min: Vec3; max: Vec3 } | null;
  speedMin: number;
  speedMax: number;
  speedMean: number;
  scalarRanges: Record<string, { min: number; max: number; unit: string }>;
  extent: { min: Vec3; max: Vec3 };
  spacing: Vec3;
  dims: [number, number, number];
}

export interface FieldMeta {
  id: string;
  name: string;
  source: string;
  synthetic: boolean;
  description: string;
  provenance: string;
  units: { length: string; velocity: string; scalar?: Record<string, string> };
  timeLabel: string;
  disclaimer: string;
  createdAt: string;
  analytic?: AnalyticalReference;
}

export interface FieldPayload {
  meta: FieldMeta;
  spec: GridSpec;
  velocity: Float32Array;
  scalars: ScalarChannelMap;
  nodeMissing: Uint8Array;
  nodeSolid: Uint8Array;
}

export type SampleReason = 'ok' | 'out-of-bounds' | 'missing-data' | 'solid';

export interface SampleResult {
  ok: boolean;
  reason: SampleReason;
  v: Vec3;
  speed: number;
  scalars: Record<string, number>;
  cellIndex: number;
  cell: [number, number, number];
  /** Raw continuous grid coordinates. */
  gridCoord: Vec3;
}

export const emptySample = (): SampleResult => ({
  ok: false,
  reason: 'out-of-bounds',
  v: vec3(),
  speed: 0,
  scalars: {},
  cellIndex: -1,
  cell: [-1, -1, -1],
  gridCoord: vec3(),
});

/**
 * Node-major, x-fastest vector grid in metres, velocity in m/s.
 * Missing/solid masks are node flags; a cell is unavailable when any of its
 * eight corner nodes is flagged. Interpolation never crosses into a masked cell.
 */
export class VectorGrid {
  readonly spec: GridSpec;
  readonly meta: FieldMeta;
  readonly dims: [number, number, number];
  readonly cellDims: [number, number, number];
  readonly velocity: Float32Array;
  readonly scalars: ScalarChannelMap;
  readonly nodeMissing: Uint8Array;
  readonly nodeSolid: Uint8Array;
  /** (nx-1)*(ny-1)*(nz-1), x-fastest. */
  readonly cellMissing: Uint8Array;
  readonly cellSolid: Uint8Array;
  readonly stats: FieldStats;
  /** Monotonic version stamped by the app on every field replacement; used to reject stale results. */
  epoch = 0;

  private readonly scalarNames: string[];
  private readonly validNode: Uint8Array;

  constructor(payload: FieldPayload) {
    const { spec, meta, velocity, scalars, nodeMissing, nodeSolid } = payload;
    const [nx, ny, nz] = spec.dims;
    const n = nx * ny * nz;
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || !Number.isInteger(nz) || nx < 2 || ny < 2 || nz < 2) {
      throw new Error('网格维度必须为 >=2 的整数（至少 2x2x2 节点）');
    }
    if (
      !Number.isFinite(spec.spacing.x) || spec.spacing.x <= 0 ||
      !Number.isFinite(spec.spacing.y) || spec.spacing.y <= 0 ||
      !Number.isFinite(spec.spacing.z) || spec.spacing.z <= 0
    ) {
      throw new Error('网格间距必须为有限正数（米）');
    }
    if (velocity.length !== 3 * n) {
      throw new Error(`速度数组长度 ${velocity.length} 与维度 ${nx}x${ny}x${nz} 不匹配（期望 ${3 * n}）`);
    }
    for (const [name, arr] of Object.entries(scalars)) {
      if (arr.length !== n) throw new Error(`标量 ${name} 长度 ${arr.length} 与节点数 ${n} 不匹配`);
    }
    if (nodeMissing.length !== n) throw new Error('缺测掩膜长度与节点数不匹配');
    if (nodeSolid.length !== n) throw new Error('固体掩膜长度与节点数不匹配');

    this.spec = {
      origin: { ...spec.origin },
      spacing: { ...spec.spacing },
      dims: [...spec.dims],
    };
    this.meta = { ...meta };
    this.dims = [nx, ny, nz];
    this.cellDims = [nx - 1, ny - 1, nz - 1];
    this.velocity = velocity;
    this.scalars = scalars;
    this.nodeMissing = nodeMissing;
    this.nodeSolid = nodeSolid;
    this.scalarNames = Object.keys(scalars).sort();

    this.validNode = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.validNode[i] = nodeMissing[i] || nodeSolid[i] ? 0 : 1;

    const cellCount = (nx - 1) * (ny - 1) * (nz - 1);
    this.cellMissing = new Uint8Array(cellCount);
    this.cellSolid = new Uint8Array(cellCount);
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const c = i + (nx - 1) * (j + (ny - 1) * k);
          let miss = 0;
          let solid = 0;
          for (let dk = 0; dk < 2; dk++) {
            for (let dj = 0; dj < 2; dj++) {
              for (let di = 0; di < 2; di++) {
                const node = i + di + nx * (j + dj + ny * (k + dk));
                miss |= nodeMissing[node];
                solid |= nodeSolid[node];
              }
            }
          }
          this.cellMissing[c] = miss ? 1 : 0;
          this.cellSolid[c] = solid ? 1 : 0;
        }
      }
    }

    this.stats = this.computeStats();
  }

  get nodeCount(): number {
    return this.dims[0] * this.dims[1] * this.dims[2];
  }

  get cellCount(): number {
    return this.cellMissing.length;
  }

  nodeIndex(i: number, j: number, k: number): number {
    return i + this.dims[0] * (j + this.dims[1] * k);
  }

  cellIndex(i: number, j: number, k: number): number {
    return i + this.cellDims[0] * (j + this.cellDims[1] * k);
  }

  worldOfNode(i: number, j: number, k: number): Vec3 {
    const { origin, spacing } = this.spec;
    return vec3(origin.x + i * spacing.x, origin.y + j * spacing.y, origin.z + k * spacing.z);
  }

  cellCenter(i: number, j: number, k: number): Vec3 {
    const { origin, spacing } = this.spec;
    return vec3(
      origin.x + (i + 0.5) * spacing.x,
      origin.y + (j + 0.5) * spacing.y,
      origin.z + (k + 0.5) * spacing.z,
    );
  }

  get extent(): { min: Vec3; max: Vec3 } {
    return this.stats.extent;
  }

  isNodeValid(i: number, j: number, k: number): boolean {
    return this.validNode[this.nodeIndex(i, j, k)] === 1;
  }

  isCellValid(i: number, j: number, k: number): boolean {
    return this.cellMissing[this.cellIndex(i, j, k)] === 0 && this.cellSolid[this.cellIndex(i, j, k)] === 0;
  }

  /**
   * True only when the point lies within the node lattice (inclusive) and its
   * containing cell has neither missing nor solid corners.
   */
  isInsideData(p: Vec3): boolean {
    return this.sample(p).ok;
  }

  /** Sample by trilinear interpolation. Never allocates result data on the hot path beyond a SampleResult. */
  sample(p: Vec3, out?: SampleResult): SampleResult {
    const r = out ?? emptySample();
    r.ok = false;
    r.reason = 'out-of-bounds';
    r.v.x = 0;
    r.v.y = 0;
    r.v.z = 0;
    r.speed = 0;
    r.cellIndex = -1;
    r.cell[0] = r.cell[1] = r.cell[2] = -1;

    const [nx, ny, nz] = this.dims;
    const { origin, spacing } = this.spec;
    const gx = (p.x - origin.x) / spacing.x;
    const gy = (p.y - origin.y) / spacing.y;
    const gz = (p.z - origin.z) / spacing.z;
    r.gridCoord.x = gx;
    r.gridCoord.y = gy;
    r.gridCoord.z = gz;

    const tol = 1e-9;
    if (
      !Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz) ||
      gx < -tol || gy < -tol || gz < -tol ||
      gx > nx - 1 + tol || gy > ny - 1 + tol || gz > nz - 1 + tol
    ) {
      return r;
    }

    let cx = clamp(gx, 0, nx - 1);
    let cy = clamp(gy, 0, ny - 1);
    let cz = clamp(gz, 0, nz - 1);
    let i = Math.min(Math.floor(cx), nx - 2);
    let j = Math.min(Math.floor(cy), ny - 2);
    let k = Math.min(Math.floor(cz), nz - 2);
    // At the exact upper boundary keep the last cell with fraction 1.
    if (i === nx - 2 && cx > nx - 2) cx = nx - 1;
    if (j === ny - 2 && cy > ny - 2) cy = ny - 1;
    if (k === nz - 2 && cz > nz - 2) cz = nz - 1;
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    if (k < 0) k = 0;
    cx = clamp(cx, 0, nx - 1);
    cy = clamp(cy, 0, ny - 1);
    cz = clamp(cz, 0, nz - 1);
    // Recompute cell after clamping-and-snapping.
    i = Math.min(Math.floor(cx), nx - 2);
    j = Math.min(Math.floor(cy), ny - 2);
    k = Math.min(Math.floor(cz), nz - 2);
    const fx = clamp(cx - i, 0, 1);
    const fy = clamp(cy - j, 0, 1);
    const fz = clamp(cz - k, 0, 1);

    const ci = this.cellIndex(i, j, k);
    r.cellIndex = ci;
    r.cell[0] = i;
    r.cell[1] = j;
    r.cell[2] = k;
    if (this.cellSolid[ci]) {
      r.reason = 'solid';
      return r;
    }
    if (this.cellMissing[ci]) {
      r.reason = 'missing-data';
      return r;
    }

    const w000 = (1 - fx) * (1 - fy) * (1 - fz);
    const w100 = fx * (1 - fy) * (1 - fz);
    const w010 = (1 - fx) * fy * (1 - fz);
    const w110 = fx * fy * (1 - fz);
    const w001 = (1 - fx) * (1 - fy) * fz;
    const w101 = fx * (1 - fy) * fz;
    const w011 = (1 - fx) * fy * fz;
    const w111 = fx * fy * fz;
    const weights = [w000, w100, w010, w110, w001, w101, w011, w111];
    const offs = [
      0, 1, nx, 1 + nx, nx * ny, 1 + nx * ny, nx + nx * ny, 1 + nx + nx * ny,
    ];
    const base = i + nx * (j + ny * k);

    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (let q = 0; q < 8; q++) {
      const node = base + offs[q];
      const w = weights[q];
      vx += w * this.velocity[3 * node];
      vy += w * this.velocity[3 * node + 1];
      vz += w * this.velocity[3 * node + 2];
    }

    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
      r.reason = 'missing-data';
      return r;
    }

    r.ok = true;
    r.reason = 'ok';
    r.v.x = vx;
    r.v.y = vy;
    r.v.z = vz;
    r.speed = Math.hypot(vx, vy, vz);

    for (const name of this.scalarNames) {
      const arr = this.scalars[name];
      let val = 0;
      let bad = false;
      for (let q = 0; q < 8; q++) {
        const s = arr[base + offs[q]];
        if (!Number.isFinite(s)) {
          bad = true;
          break;
        }
        val += weights[q] * s;
      }
      r.scalars[name] = bad ? Number.NaN : val;
    }

    return r;
  }

  /** Clamp a point to the interior of the data lattice. */
  clampToBounds(p: Vec3, insetFraction = 0.001): Vec3 {
    const { origin, spacing } = this.spec;
    const [nx, ny, nz] = this.dims;
    const insx = spacing.x * insetFraction;
    const insy = spacing.y * insetFraction;
    const insz = spacing.z * insetFraction;
    return vec3(
      clamp(p.x, origin.x + insx, origin.x + (nx - 1) * spacing.x - insx),
      clamp(p.y, origin.y + insy, origin.y + (ny - 1) * spacing.y - insy),
      clamp(p.z, origin.z + insz, origin.z + (nz - 1) * spacing.z - insz),
    );
  }

  /** Find the nearest cell centre with valid data, searching outward in cell rings. */
  nearestValidPoint(p: Vec3, maxRings = 24): Vec3 | null {
    const { origin, spacing } = this.spec;
    const [nx, ny, nz] = this.dims;
    const gx = clamp((p.x - origin.x) / spacing.x, 0, nx - 1);
    const gy = clamp((p.y - origin.y) / spacing.y, 0, ny - 1);
    const gz = clamp((p.z - origin.z) / spacing.z, 0, nz - 1);
    const ci = clamp(Math.floor(gx), 0, nx - 2);
    const cj = clamp(Math.floor(gy), 0, ny - 2);
    const ck = clamp(Math.floor(gz), 0, nz - 2);
    if (this.isCellValid(ci, cj, ck)) {
      return this.clampToBounds(p);
    }
    let best: Vec3 | null = null;
    let bestD = Infinity;
    const target = vec3(
      origin.x + gx * spacing.x,
      origin.y + gy * spacing.y,
      origin.z + gz * spacing.z,
    );
    for (let ring = 1; ring <= maxRings; ring++) {
      for (let dk = -ring; dk <= ring; dk++) {
        for (let dj = -ring; dj <= ring; dj++) {
          for (let di = -ring; di <= ring; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== ring) continue;
            const i = ci + di;
            const j = cj + dj;
            const k = ck + dk;
            if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) continue;
            if (!this.isCellValid(i, j, k)) continue;
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

  scalarRange(name: string): { min: number; max: number } | null {
    const arr = this.scalars[name];
    if (!arr) return null;
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let i = 0; i < arr.length; i++) {
      if (this.validNode[i] && Number.isFinite(arr[i])) {
        min = Math.min(min, arr[i]);
        max = Math.max(max, arr[i]);
        count++;
      }
    }
    return count ? { min, max } : null;
  }

  private computeStats(): FieldStats {
    const [nx, ny, nz] = this.dims;
    const { origin, spacing } = this.spec;
    let validNodes = 0;
    let speedMin = Infinity;
    let speedMax = -Infinity;
    let speedSum = 0;
    for (let node = 0; node < this.nodeCount; node++) {
      if (!this.validNode[node]) continue;
      const ux = this.velocity[3 * node];
      const uy = this.velocity[3 * node + 1];
      const uz = this.velocity[3 * node + 2];
      if (!Number.isFinite(ux) || !Number.isFinite(uy) || !Number.isFinite(uz)) continue;
      validNodes++;
      const sp = Math.hypot(ux, uy, uz);
      speedMin = Math.min(speedMin, sp);
      speedMax = Math.max(speedMax, sp);
      speedSum += sp;
    }

    let missingCount = 0;
    let solidCount = 0;
    let mmiss = vec3(Infinity, Infinity, Infinity);
    let mmax = vec3(-Infinity, -Infinity, -Infinity);
    let smin = vec3(Infinity, Infinity, Infinity);
    let smax = vec3(-Infinity, -Infinity, -Infinity);
    const [cnx, cny] = this.cellDims;
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const c = i + cnx * (j + cny * k);
          if (this.cellMissing[c]) {
            missingCount++;
            const cx = origin.x + i * spacing.x;
            const cy = origin.y + j * spacing.y;
            const cz = origin.z + k * spacing.z;
            mmiss.x = Math.min(mmiss.x, cx);
            mmiss.y = Math.min(mmiss.y, cy);
            mmiss.z = Math.min(mmiss.z, cz);
            mmax.x = Math.max(mmax.x, cx + spacing.x);
            mmax.y = Math.max(mmax.y, cy + spacing.y);
            mmax.z = Math.max(mmax.z, cz + spacing.z);
          }
          if (this.cellSolid[c]) {
            solidCount++;
            const cx = origin.x + i * spacing.x;
            const cy = origin.y + j * spacing.y;
            const cz = origin.z + k * spacing.z;
            smin.x = Math.min(smin.x, cx);
            smin.y = Math.min(smin.y, cy);
            smin.z = Math.min(smin.z, cz);
            smax.x = Math.max(smax.x, cx + spacing.x);
            smax.y = Math.max(smax.y, cy + spacing.y);
            smax.z = Math.max(smax.z, cz + spacing.z);
          }
        }
      }
    }

    const scalarRanges: Record<string, { min: number; max: number; unit: string }> = {};
    for (const [name, arr] of Object.entries(this.scalars)) {
      let min = Infinity;
      let max = -Infinity;
      let count = 0;
      for (let i = 0; i < arr.length; i++) {
        if (this.validNode[i] && Number.isFinite(arr[i])) {
          min = Math.min(min, arr[i]);
          max = Math.max(max, arr[i]);
          count++;
        }
      }
      if (count) {
        scalarRanges[name] = {
          min,
          max,
          unit: this.meta.units.scalar?.[name] ?? '',
        };
      }
    }

    return {
      nodeCount: this.nodeCount,
      cellCount: this.cellCount,
      validNodeCount: validNodes,
      missingCellCount: missingCount,
      solidCellCount: solidCount,
      missingCellFraction: this.cellCount ? missingCount / this.cellCount : 0,
      missingBounds: missingCount ? { min: mmiss, max: mmax } : null,
      solidBounds: solidCount ? { min: smin, max: smax } : null,
      speedMin: Number.isFinite(speedMin) ? speedMin : 0,
      speedMax: Number.isFinite(speedMax) ? speedMax : 0,
      speedMean: validNodes ? speedSum / validNodes : 0,
      scalarRanges,
      extent: {
        min: vec3(origin.x, origin.y, origin.z),
        max: vec3(
          origin.x + (nx - 1) * spacing.x,
          origin.y + (ny - 1) * spacing.y,
          origin.z + (nz - 1) * spacing.z,
        ),
      },
      spacing: { ...spacing },
      dims: [nx, ny, nz],
    };
  }
}

/** Build a vorticity magnitude scalar channel by central differences. */
export function computeVorticityScalar(grid: VectorGrid): { data: Float32Array; range: { min: number; max: number } } {
  const [nx, ny, nz] = grid.dims;
  const { spacing } = grid.spec;
  const out = new Float32Array(nx * ny * nz).fill(Number.NaN);
  let min = Infinity;
  let max = -Infinity;
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        if (!grid.isNodeValid(i, j, k)) continue;
        const c = grid.nodeIndex(i, j, k);
        const xp = grid.nodeIndex(i + 1, j, k);
        const xm = grid.nodeIndex(i - 1, j, k);
        const yp = grid.nodeIndex(i, j + 1, k);
        const ym = grid.nodeIndex(i, j - 1, k);
        const zp = grid.nodeIndex(i, j, k + 1);
        const zm = grid.nodeIndex(i, j, k - 1);
        if (
          !grid.isNodeValid(i + 1, j, k) || !grid.isNodeValid(i - 1, j, k) ||
          !grid.isNodeValid(i, j + 1, k) || !grid.isNodeValid(i, j - 1, k) ||
          !grid.isNodeValid(i, j, k + 1) || !grid.isNodeValid(i, j, k - 1)
        ) continue;
        const dvzdy = (grid.velocity[3 * yp + 2] - grid.velocity[3 * ym + 2]) / (2 * spacing.y);
        const dvydz = (grid.velocity[3 * zp + 1] - grid.velocity[3 * zm + 1]) / (2 * spacing.z);
        const dvxdz = (grid.velocity[3 * zp] - grid.velocity[3 * zm]) / (2 * spacing.z);
        const dvzdx = (grid.velocity[3 * xp + 2] - grid.velocity[3 * xm + 2]) / (2 * spacing.x);
        const dvydx = (grid.velocity[3 * xp + 1] - grid.velocity[3 * xm + 1]) / (2 * spacing.x);
        const dvxdy = (grid.velocity[3 * yp] - grid.velocity[3 * ym]) / (2 * spacing.y);
        const wx = dvzdy - dvydz;
        const wy = dvxdz - dvzdx;
        const wz = dvydx - dvxdy;
        const mag = Math.hypot(wx, wy, wz);
        if (!Number.isFinite(mag)) continue;
        out[c] = mag;
        min = Math.min(min, mag);
        max = Math.max(max, mag);
      }
    }
  }
  return { data: out, range: { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 1 } };
}

/** Validate and normalise an imported grid payload, producing masks and meta. */
export function normalizeImport(raw: unknown): FieldPayload {
  if (!raw || typeof raw !== 'object') throw new Error('JSON 根对象缺失');
  const obj = raw as Record<string, unknown>;
  const specRaw = (obj.spec ?? obj.grid ?? obj) as Record<string, unknown>;
  const dimsRaw = (specRaw.dims ?? obj.dims) as unknown;
  if (!Array.isArray(dimsRaw) || dimsRaw.length !== 3) throw new Error('dims 必须为 [nx, ny, nz]');
  const dims = dimsRaw.map((d) => Number(d)) as [number, number, number];
  if (dims.some((d) => !Number.isInteger(d) || d < 2)) throw new Error('dims 必须为 >=2 的整数');
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;

  const num3 = (v: unknown, name: string): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} 必须为长度 3 的数组`);
    const arr = v.map(Number);
    if (arr.some((x) => !Number.isFinite(x))) throw new Error(`${name} 含非有限值`);
    return vec3(arr[0], arr[1], arr[2]);
  };
  const origin = num3(specRaw.origin ?? obj.origin ?? [0, 0, 0], 'origin');
  const spacing = num3(specRaw.spacing ?? obj.spacing ?? obj.cellSize ?? [1, 1, 1], 'spacing');
  if (spacing.x <= 0 || spacing.y <= 0 || spacing.z <= 0) throw new Error('spacing 必须为正数（米）');

  let velocity: Float32Array;
  const velRaw = obj.velocity ?? obj.vectors;
  if (Array.isArray(velRaw) || ArrayBuffer.isView(velRaw)) {
    const src = velRaw as ArrayLike<number>;
    const want = 3 * n;
    if (src.length !== want && src.length !== n) {
      throw new Error(`velocity 长度应为 ${want}（每节点 3 分量）或 ${n}（每节点对象/模长），实际 ${src.length}`);
    }
    velocity = new Float32Array(3 * n);
    if (src.length === want) {
      for (let i = 0; i < want; i++) {
        const val = Number(src[i]);
        if (!Number.isFinite(val)) throw new Error(`velocity[${i}] 非有限值`);
        velocity[i] = val;
      }
    } else {
      // Magnitude-only input is not a vector field; reject clearly instead of inventing directions.
      throw new Error('velocity 必须包含 3 分量向量（x 变化最快），无法用模长代替');
    }
  } else {
    throw new Error('缺少 velocity 数组（x 变化最快，长度 3*nx*ny*nz）');
  }

  const scalars: ScalarChannelMap = {};
  if (obj.scalars && typeof obj.scalars === 'object') {
    for (const [name, arrLike] of Object.entries(obj.scalars as Record<string, unknown>)) {
      if (!Array.isArray(arrLike) && !ArrayBuffer.isView(arrLike)) {
        throw new Error(`标量 ${name} 必须为数组`);
      }
      const src = arrLike as ArrayLike<number>;
      if (src.length !== n) throw new Error(`标量 ${name} 长度应为 ${n}`);
      const arr = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const val = Number(src[i]);
        arr[i] = Number.isFinite(val) ? val : Number.NaN;
      }
      scalars[name] = arr;
    }
  }

  const parseMask = (v: unknown): Uint8Array => {
    const out = new Uint8Array(n);
    if (v === undefined || v === null) return out;
    if (!Array.isArray(v) && !ArrayBuffer.isView(v)) throw new Error('掩膜必须为数组');
    const src = v as ArrayLike<number>;
    if (src.length !== n) throw new Error(`掩膜长度应为 ${n}`);
    for (let i = 0; i < n; i++) out[i] = Number(src[i]) ? 1 : 0;
    return out;
  };
  const nodeMissing = parseMask(obj.missing ?? obj.missingMask);
  const nodeSolid = parseMask(obj.solid ?? obj.solidMask);

  const unitsRaw = (obj.units ?? {}) as Record<string, unknown>;
  const scalarUnits: Record<string, string> = {};
  if (unitsRaw.scalar && typeof unitsRaw.scalar === 'object') {
    for (const [k, v] of Object.entries(unitsRaw.scalar as Record<string, unknown>)) scalarUnits[k] = String(v);
  }
  const meta: FieldMeta = {
    id: String(obj.id ?? `import-${Date.now()}`),
    name: String(obj.name ?? '用户载入网格'),
    source: String(obj.source ?? '用户上传 JSON'),
    synthetic: Boolean(obj.synthetic ?? false),
    description: String(obj.description ?? '用户导入的向量网格；未经过水动力实测验证。'),
    provenance: String(obj.provenance ?? '用户提供的数据文件'),
    units: {
      length: String(unitsRaw.length ?? 'm'),
      velocity: String(unitsRaw.velocity ?? 'm/s'),
      scalar: scalarUnits,
    },
    timeLabel: String(obj.timeLabel ?? '稳态'),
    disclaimer: String(
      obj.disclaimer ??
        '用户载入数据：仅按给定网格值做插值与积分，不代表实测水动力结论，也未做物理一致性校核。',
    ),
    createdAt: new Date().toISOString(),
  };

  return { meta, spec: { origin, spacing, dims }, velocity, scalars, nodeMissing, nodeSolid };
}

/** Serialise a payload for transfer; returns copies so the source grid remains usable. */
export function copyPayloadForWorker(payload: FieldPayload): FieldPayload {
  return {
    meta: { ...payload.meta },
    spec: {
      origin: { ...payload.spec.origin },
      spacing: { ...payload.spec.spacing },
      dims: [...payload.spec.dims],
    },
    velocity: payload.velocity.slice(),
    scalars: Object.fromEntries(Object.entries(payload.scalars).map(([k, v]) => [k, v.slice()])),
    nodeMissing: payload.nodeMissing.slice(),
    nodeSolid: payload.nodeSolid.slice(),
  };
}
