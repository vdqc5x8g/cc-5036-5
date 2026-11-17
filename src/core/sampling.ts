import { axisLocate, emptyFieldSample, FieldAxis, FieldSampleResult, FieldMaskBox } from './fieldProtocol';
import { SampleReason, Vec3 } from './types';

/**
 * Host contract for trilinear sampling. Storage layout and mask bookkeeping
 * are supplied by each backend, so dense, chunked and legacy stores cannot
 * diverge on *when* a point is unavailable or on how the reason is reported.
 *
 * Availability is decided by explicit validity, never by a zero velocity:
 * a masked or absent region returns ok=false with its own reason.
 */
export interface TrilinearHost {
  readonly dims: [number, number, number];
  readonly axes: readonly [FieldAxis, FieldAxis, FieldAxis];
  readonly scalarNames: readonly string[];
  /** Validity of the cell containing the point; 'ok' means all eight corners usable. */
  cellStateAt(cell: [number, number, number]): SampleReason;
  /** Global cell index, x-fastest. */
  cellIndexOf(cell: [number, number, number]): number;
  chunkOf(cell: [number, number, number]): [number, number, number];
  chunkIndexOf(chunk: [number, number, number]): number;
  /**
   * Fill `out` with a stored node velocity for one corner of `cell`; false
   * when that node has no usable data. Passing the cell and corner together
   * lets chunked storage resolve the owning chunk without a global lookup.
   */
  readVelocity(cell: [number, number, number], corner: [number, number, number], out: Vec3): boolean;
  readScalar(name: string, cell: [number, number, number], corner: [number, number, number]): number;
}

const CORNERS: readonly [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

export function sampleTrilinear(
  host: TrilinearHost,
  p: Vec3,
  out?: FieldSampleResult,
): FieldSampleResult {
  const r = out ?? emptyFieldSample();
  r.ok = false;
  r.reason = 'out-of-bounds';
  r.v.x = r.v.y = r.v.z = 0;
  r.speed = 0;
  r.cellIndex = -1;
  r.cell[0] = r.cell[1] = r.cell[2] = -1;
  r.chunkIndex = -1;
  r.chunk[0] = r.chunk[1] = r.chunk[2] = -1;

  const [ax, ay, az] = host.axes;
  const lx = axisLocate(ax, p.x);
  const ly = axisLocate(ay, p.y);
  const lz = axisLocate(az, p.z);
  r.gridCoord.x = lx.g;
  r.gridCoord.y = ly.g;
  r.gridCoord.z = lz.g;
  if (!lx.inside || !ly.inside || !lz.inside) return r;

  const i = lx.i;
  const j = ly.i;
  const k = lz.i;
  const cell: [number, number, number] = [i, j, k];
  const chunk = host.chunkOf(cell);
  r.cellIndex = host.cellIndexOf(cell);
  r.cell[0] = i;
  r.cell[1] = j;
  r.cell[2] = k;
  r.chunk[0] = chunk[0];
  r.chunk[1] = chunk[1];
  r.chunk[2] = chunk[2];
  r.chunkIndex = host.chunkIndexOf(chunk);

  const state = host.cellStateAt(cell);
  if (state !== 'ok') {
    r.reason = state;
    return r;
  }
  const fx = lx.f;
  const fy = ly.f;
  const fz = lz.f;
  const weights = [
    (1 - fx) * (1 - fy) * (1 - fz),
    fx * (1 - fy) * (1 - fz),
    (1 - fx) * fy * (1 - fz),
    fx * fy * (1 - fz),
    (1 - fx) * (1 - fy) * fz,
    fx * (1 - fy) * fz,
    (1 - fx) * fy * fz,
    fx * fy * fz,
  ];

  let vx = 0;
  let vy = 0;
  let vz = 0;
  const tmp: Vec3 = { x: 0, y: 0, z: 0 };
  for (let q = 0; q < 8; q++) {
    if (!host.readVelocity(cell, CORNERS[q], tmp)) {
      r.reason = 'missing-data';
      return r;
    }
    const w = weights[q];
    vx += w * tmp.x;
    vy += w * tmp.y;
    vz += w * tmp.z;
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

  for (const name of host.scalarNames) {
    let val = 0;
    let bad = false;
    for (let q = 0; q < 8; q++) {
      const s = host.readScalar(name, cell, CORNERS[q]);
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

/** Merge contiguous runs of flagged cells along x into world boxes for display. */
export function mergeCellRuns(
  cellDims: [number, number, number],
  flags: Uint8Array,
  worldMin: (i: number, j: number, k: number) => Vec3,
  worldMax: (i: number, j: number, k: number) => Vec3,
  kind: FieldMaskBox['kind'],
): FieldMaskBox[] {
  const out: FieldMaskBox[] = [];
  const [cnx, cny, cnz] = cellDims;
  for (let k = 0; k < cnz; k++) {
    for (let j = 0; j < cny; j++) {
      let i = 0;
      while (i < cnx) {
        if (!flags[i + cnx * (j + cny * k)]) {
          i++;
          continue;
        }
        const start = i;
        while (i < cnx && flags[i + cnx * (j + cny * k)]) i++;
        const end = i - 1;
        out.push({
          kind,
          min: worldMin(start, j, k),
          max: worldMax(end, j, k),
          cellCount: end - start + 1,
        });
      }
    }
  }
  return out;
}

export interface CellMasks {
  cellMissing: Uint8Array;
  cellSolid: Uint8Array;
}

/** Cell is unavailable when any of its eight corner nodes is flagged. */
export function computeCellMasks(
  dims: [number, number, number],
  nodeMissing: Uint8Array,
  nodeSolid: Uint8Array,
): CellMasks & { validNode: Uint8Array } {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const validNode = new Uint8Array(n);
  for (let i = 0; i < n; i++) validNode[i] = nodeMissing[i] || nodeSolid[i] ? 0 : 1;
  const cellCount = (nx - 1) * (ny - 1) * (nz - 1);
  const cellMissing = new Uint8Array(cellCount);
  const cellSolid = new Uint8Array(cellCount);
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
        cellMissing[c] = miss ? 1 : 0;
        cellSolid[c] = solid ? 1 : 0;
      }
    }
  }
  return { cellMissing, cellSolid, validNode };
}
