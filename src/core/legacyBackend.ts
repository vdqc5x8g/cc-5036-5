import type { FieldMeta, FieldStats } from './grid';
import { VectorGrid } from './grid';
import {
  axesFromUniformSpec,
  FieldAxis,
  FIELD_BACKEND_PROTOCOL_VERSION,
  FieldBackendStats,
  FieldMaskBox,
  FieldSampleResult,
} from './fieldProtocol';
import { AbstractFieldBackend, AggregateBuilder, buildFieldStats, worldMaxOf, worldMinOf } from './fieldBackend';
import { mergeCellRuns } from './sampling';
import { SampleReason, Vec3, vec3 } from './types';

/**
 * Adapter for the pre-protocol `VectorGrid` (uniform origin/spacing/dims).
 * The legacy sampler is kept intact and its reasons are translated one-to-one,
 * so old fields keep running through the new integration path without any
 * silent zero-filling: an unavailable legacy sample stays unavailable.
 */
export class LegacyGridBackend extends AbstractFieldBackend {
  readonly protocolVersion = FIELD_BACKEND_PROTOCOL_VERSION;
  readonly kind = 'legacy-grid' as const;
  readonly meta: FieldMeta;
  readonly axes: readonly [FieldAxis, FieldAxis, FieldAxis];
  readonly scalarNames: readonly string[];
  readonly chunkSize = null;
  readonly chunkDims = null;
  readonly stats: FieldBackendStats;
  readonly legacy: VectorGrid;

  private readonly cellMissing: Uint8Array;
  private readonly cellSolid: Uint8Array;
  private boxes: FieldMaskBox[] | null = null;

  constructor(grid: VectorGrid) {
    super();
    this.legacy = grid;
    this.meta = { ...grid.meta };
    this.axes = axesFromUniformSpec(grid.spec) as unknown as readonly [FieldAxis, FieldAxis, FieldAxis];
    this.scalarNames = Object.keys(grid.scalars).sort();
    this.cellMissing = grid.cellMissing;
    this.cellSolid = grid.cellSolid;

    const [nx, ny, nz] = grid.dims;
    const n = nx * ny * nz;
    const aggregate = new AggregateBuilder();
    const tmp: Vec3 = vec3();
    for (let node = 0; node < n; node++) {
      if (grid.nodeMissing[node] || grid.nodeSolid[node]) continue;
      tmp.x = grid.velocity[3 * node];
      tmp.y = grid.velocity[3 * node + 1];
      tmp.z = grid.velocity[3 * node + 2];
      aggregate.addVelocity(tmp);
      for (const name of this.scalarNames) aggregate.addScalar(name, grid.scalars[name][node]);
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
    this.epoch = grid.epoch;
  }

  get dims(): [number, number, number] {
    return [this.axes[0].count, this.axes[1].count, this.axes[2].count];
  }

  sample(p: Vec3, out?: FieldSampleResult): FieldSampleResult {
    const legacy = this.legacy.sample(p);
    const r = out ?? {
      ok: false,
      reason: 'out-of-bounds' as SampleReason,
      v: vec3(),
      speed: 0,
      scalars: {},
      cellIndex: -1,
      cell: [-1, -1, -1] as [number, number, number],
      gridCoord: vec3(),
      chunkIndex: -1,
      chunk: [-1, -1, -1] as [number, number, number],
    };
    r.ok = legacy.ok;
    r.reason = legacy.reason;
    // Legacy `SampleResult` has no chunk fields; they stay explicitly absent.
    r.v.x = legacy.v.x;
    r.v.y = legacy.v.y;
    r.v.z = legacy.v.z;
    r.speed = legacy.speed;
    r.scalars = { ...legacy.scalars };
    r.cellIndex = legacy.cellIndex;
    r.cell[0] = legacy.cell[0];
    r.cell[1] = legacy.cell[1];
    r.cell[2] = legacy.cell[2];
    r.gridCoord.x = legacy.gridCoord.x;
    r.gridCoord.y = legacy.gridCoord.y;
    r.gridCoord.z = legacy.gridCoord.z;
    r.chunkIndex = -1;
    r.chunk[0] = r.chunk[1] = r.chunk[2] = -1;
    return r;
  }

  cellState(i: number, j: number, k: number): SampleReason {
    const ci = i + this.cellDims[0] * (j + this.cellDims[1] * k);
    if (this.cellSolid[ci]) return 'solid';
    if (this.cellMissing[ci]) return 'missing-data';
    return 'ok';
  }

  cellStateAt(cell: [number, number, number]): SampleReason {
    return this.cellState(cell[0], cell[1], cell[2]);
  }

  chunkPresent(): boolean {
    return false;
  }

  nearestValidPoint(p: Vec3, maxRings = 24): Vec3 | null {
    return this.legacy.nearestValidPoint(p, maxRings);
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

export type { FieldStats };
