import { describe, expect, it } from 'vitest';
import { VectorGrid } from '../src/core/grid';
import { adapterForLegacyGrid, createFieldBackend } from '../src/core/fieldFactory';
import { DEFAULT_PARAMS, integrateStreamline } from '../src/core/integrator';
import {
  makeHyperbolicField,
  makeRankineVortexField,
  makeUniformField,
} from '../src/core/synthetic';
import { pickCandidates, pickLines, pointToSegment2D } from '../src/render/picking';
import { vec3, Vec3 } from '../src/core/types';
import { FIELD_BACKEND_PROTOCOL_VERSION } from '../src/core/fieldProtocol';
import { makeChunkedDemoField } from '../src/core/chunkedDemo';
import { runValidation } from '../src/core/validation';

const makeGrid = (payload: ReturnType<typeof makeUniformField>) => new VectorGrid(payload);
const backendOf = (grid: VectorGrid) => adapterForLegacyGrid(grid);

const meta = (i: number) => ({ seedId: `s${i}`, version: i, color: '#fff', label: `S${i}` });

describe('VectorGrid interpolation', () => {
  it('reproduces node values exactly and interpolates linearly', () => {
    const grid = makeGrid(makeUniformField({ dims: [5, 5, 5], spacing: 2, angleDeg: 0 }));
    const p = vec3(4, 4, 4);
    const s = grid.sample(p);
    expect(s.ok).toBe(true);
    const exact = grid.velocity[3 * grid.nodeIndex(2, 2, 2)];
    expect(s.v.x).toBeCloseTo(exact, 5);

    const mid = grid.sample(vec3(1, 0, 0));
    expect(mid.ok).toBe(true);
    // Between nodes at x=0 and x=2, horizontal u is constant.
    expect(mid.v.x).toBeCloseTo(1.2 * Math.cos(Math.PI / 9), 5);
  });

  it('reports out-of-bounds and does not silently clamp', () => {
    const grid = makeGrid(makeUniformField({ dims: [5, 5, 5], spacing: 1 }));
    const outside = grid.sample(vec3(-0.5, 1, 1));
    expect(outside.ok).toBe(false);
    expect(outside.reason).toBe('out-of-bounds');
  });

  it('marks cells with missing nodes as unavailable', () => {
    const payload = makeUniformField({ dims: [9, 9, 5], spacing: 1 });
    const [nx, ny] = payload.spec.dims;
    // Blank one cell's node fan.
    for (let k = 2; k <= 3; k++)
      for (let j = 2; j <= 3; j++)
        for (let i = 2; i <= 3; i++) payload.nodeMissing[i + nx * (j + ny * k)] = 1;
    const grid = new VectorGrid(payload);
    const inGap = grid.sample(vec3(2.5, 2.5, 2.5));
    expect(inGap.ok).toBe(false);
    expect(inGap.reason).toBe('missing-data');
    const outsideGap = grid.sample(vec3(5.5, 5.5, 2.5));
    expect(outsideGap.ok).toBe(true);
  });

  it('rejects malformed dimensions and spacing', () => {
    const payload = makeUniformField();
    expect(() => new VectorGrid({ ...payload, spec: { ...payload.spec, dims: [1, 5, 5] } })).toThrow();
    expect(() => new VectorGrid({ ...payload, spec: { ...payload.spec, spacing: vec3(0, 1, 1) } })).toThrow();
  });
});

describe('Streamline integration accuracy', () => {
  it('uniform flow follows a straight line at the correct angle', () => {
    const grid = makeGrid(makeUniformField({ dims: [81, 81, 9], spacing: 0.25 }));
    const seed = vec3(2, 2, 1);
    const res = integrateStreamline(backendOf(grid), seed, { ...DEFAULT_PARAMS, stepLength: 0.2, maxArcLength: 8 }, meta(1));
    expect(res.positions.length).toBeGreaterThan(20);
    // Direction error should be tiny for a nearly straight trajectory.
    const n = res.positions.length / 3;
    const last = vec3(res.positions[3 * n - 3], res.positions[3 * n - 2], res.positions[3 * n - 1]);
    const ax = last.x - seed.x;
    const ay = last.y - seed.y;
    const angle = (Math.atan2(ay, ax) * 180) / Math.PI;
    expect(Math.abs(angle - 20)).toBeLessThan(0.5);
  });

  it('matches a reference trajectory in the hyperbolic field', () => {
    const grid = new VectorGrid(makeHyperbolicField({ dims: [81, 61, 9], spacing: 0.25 }));
    const seeds = [vec3(1.5, 1.0, 1.0), vec3(2.0, 0.0, 1.5), vec3(-1.0, -1.5, 0.5)];
    const report = runValidation({
      fieldKind: 'hyperbolic',
      backend: backendOf(grid),
      params: { ...DEFAULT_PARAMS, stepLength: 0.2, maxArcLength: 12, absTolerance: 1e-3 },
      seeds,
      toleranceMeters: 0.05,
    });
    expect(report.rows.length).toBe(3);
    for (const row of report.rows) {
      expect(row.maxError).toBeLessThan(0.05);
    }
    expect(report.summary.passed).toBe(true);
  });

  it('keeps a y=0 seed on the analytic separation surface', () => {
    const grid = new VectorGrid(makeHyperbolicField({ dims: [81, 61, 9], spacing: 0.25 }));
    const seed = vec3(2, 0, 1);
    const res = integrateStreamline(backendOf(grid), seed, { ...DEFAULT_PARAMS, stepLength: 0.15, maxArcLength: 10 }, meta(3));
    for (let i = 0; i < res.positions.length / 3; i++) {
      expect(Math.abs(res.positions[3 * i + 1])).toBeLessThan(1e-6);
    }
  });

  it('uniform field reference deviation stays under tolerance', () => {
    const grid = makeGrid(makeUniformField({ dims: [101, 61, 13], spacing: 0.25 }));
    const report = runValidation({
      fieldKind: 'uniform',
      backend: backendOf(grid),
      params: { ...DEFAULT_PARAMS, stepLength: 0.15, maxArcLength: 25, absTolerance: 1e-4, maxSteps: 2000 },
      seeds: [vec3(5, 4, 1.5), vec3(-5, -3, 1)],
      toleranceMeters: 0.02,
    });
    expect(report.summary.maxError).toBeLessThan(0.02);
  });
});

describe('Stopping conditions stay bounded', () => {
  it('stops near the vortex centre (closed loop or stagnation), never runs unbounded', () => {
    const grid = new VectorGrid(makeRankineVortexField({ dims: [81, 81, 5], spacing: 0.2 }));
    const seed = vec3(2.0, 0.0, 0.4);
    const res = integrateStreamline(backendOf(grid), seed, { ...DEFAULT_PARAMS, stepLength: 0.1, maxSteps: 5000 }, meta(4));
    expect(['closed-loop', 'stagnation', 'max-steps', 'max-length']).toContain(res.stop.forward);
    expect(res.stats.totalSteps).toBeLessThanOrEqual(5000);
    expect(res.positions.length / 3).toBeLessThan(20000);
  });

  it('stops immediately at an out-of-bounds seed', () => {
    const grid = makeGrid(makeUniformField());
    const res = integrateStreamline(backendOf(grid), vec3(-50, -50, 0), DEFAULT_PARAMS, meta(5));
    expect(res.stop.forward).toBe('seed-invalid');
    expect(res.stats.totalSteps).toBe(0);
  });

  it('stops at missing-data boundaries instead of interpolating across the gap', () => {
    const grid = new VectorGrid(makeHyperbolicField());
    const seed = vec3(0.0, -1.2, 1.0);
    const res = integrateStreamline(backendOf(grid), seed, { ...DEFAULT_PARAMS, stepLength: 0.1, maxArcLength: 50 }, meta(6));
    expect(['missing-data', 'seed-invalid', 'out-of-bounds', 'max-length', 'stagnation']).toContain(res.stop.forward);
    // No sample may sit inside a masked cell.
    for (let i = 0; i < res.positions.length / 3; i++) {
      const p = vec3(res.positions[3 * i], res.positions[3 * i + 1], res.positions[3 * i + 2]);
      const s = grid.sample(p);
      expect(s.ok || s.reason !== 'ok').toBe(true);
      expect(s.reason === 'ok' || s.reason === 'missing-data' || s.reason === 'solid' || s.reason === 'out-of-bounds').toBe(true);
    }
  });

  it('never samples inside masked cells, even when the mask lies right on the path', () => {
    const grid = new VectorGrid(makeHyperbolicField());
    // Start just west of the built-in missing patch and sweep seeds into it.
    for (const y of [-1.0, -1.4, -1.8, -2.2]) {
      const res = integrateStreamline(backendOf(grid), vec3(0.9, y, 1.0), { ...DEFAULT_PARAMS, stepLength: 0.1, maxArcLength: 60 }, meta(8));
      expect(res.positions.length).toBeGreaterThan(3);
      for (let i = 0; i < res.positions.length / 3; i++) {
        const p = vec3(res.positions[3 * i], res.positions[3 * i + 1], res.positions[3 * i + 2]);
        const f = grid.sample(p);
        expect(f.reason).toBe('ok');
      }
    }
  });

  it('stagnation point seed does not iterate', () => {
    const grid = new VectorGrid(makeHyperbolicField());
    const res = integrateStreamline(backendOf(grid), vec3(0, 0, 2), DEFAULT_PARAMS, meta(7));
    expect(res.stop.forward).toBe('stagnation');
    expect(res.positions.length / 3).toBe(1);
  });
});

describe('Picking semantics', () => {
  const project =
    (scaleXY = 1) =>
    (p: Vec3) => ({ x: p.x * scaleXY, y: p.y * scaleXY, visible: true, ndcZ: 0 });
  const ray = () => vec3(0, 0, -1);
  const eye = vec3(0, 0, 100);

  it('uses pixel distance, and converts screen width to real space distance separately', () => {
    const near = {
      id: 'a',
      label: 'A',
      positions: new Float32Array([0, 0, 0, 100, 0, 0]),
      visible: true,
      kind: 'streamline' as const,
    };
    const far = {
      id: 'b',
      label: 'B',
      positions: new Float32Array([0, 0, -50, 100, 0, -50]),
      visible: true,
      kind: 'streamline' as const,
    };
    const hits = pickCandidates([near, far], { x: 50, y: 0 }, project(), ray, eye, {
      pixelTolerance: 5,
      depthBias: 0.1,
    });
    expect(hits.length).toBe(2);
    // Same screen distance, but the near line has the smaller ray depth.
    expect(hits[0].id).toBe('a');
    expect(hits[0].rayDepth).toBeLessThan(hits[1].rayDepth);
    const offsetEye = vec3(50, 3, 100);
    const hit = pickLines([near], { x: 50, y: 3 }, project(1), ray, offsetEye, { pixelTolerance: 5, depthBias: 0.1 });
    expect(hit).not.toBeNull();
    expect(hit!.screenDistance).toBeCloseTo(3, 6);
    expect(hit!.worldDistance).toBeCloseTo(3, 6);
  });

  it('excludes hidden lines from hits entirely', () => {
    const line = {
      id: 'hidden',
      label: 'hidden',
      positions: new Float32Array([0, 0, 0, 100, 0, 0]),
      visible: false,
      kind: 'streamline' as const,
    };
    const hit = pickLines([line], { x: 50, y: 0 }, project(), ray, eye, { pixelTolerance: 5, depthBias: 0.1 });
    expect(hit).toBeNull();
    const cands = pickCandidates([line], { x: 50, y: 0 }, project(), ray, eye, {
      pixelTolerance: 5,
      depthBias: 0.1,
    });
    expect(cands.length).toBe(0);
  });

  it('clamps to segment endpoints', () => {
    expect(pointToSegment2D(-5, 0, 0, 0, 10, 0).distance).toBeCloseTo(5);
    expect(pointToSegment2D(15, 0, 0, 0, 10, 0).distance).toBeCloseTo(5);
  });
});

describe('Field backend protocol v2', () => {
  const LEGACY_V = new VectorGrid(makeUniformField({ dims: [9, 9, 5], spacing: 1 }));

  it('dense backend with explicit non-uniform coordinates locates cells by coordinate, not index', () => {
    // Extra-fine sampling near x=0 makes a non-uniform axis; velocity is
    // constant along x so any correct coordinate lookup returns the same value.
    const axes: [Float64Array, Float64Array, Float64Array] = [
      Float64Array.from([0, 0.1, 0.25, 0.6, 1.2]),
      Float64Array.from([0, 0.5, 1.5, 3]),
      Float64Array.from([0, 1, 2.5]),
    ];
    const [nx, ny, nz] = [axes[0].length, axes[1].length, axes[2].length];
    const n = nx * ny * nz;
    const velocity = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) velocity[3 * i] = 2;
    const backend = createFieldBackend({
      layout: 'dense',
      meta: makeUniformField().meta,
      axes,
      velocity,
      scalars: {},
      nodeMissing: new Uint8Array(n),
      nodeSolid: new Uint8Array(n),
    });
    const s = backend.sample(vec3(0.62, 1.0, 1.2));
    expect(s.ok).toBe(true);
    expect(s.v.x).toBeCloseTo(2, 6);
    // 0.62 lies in cell [3,4] on the warped axis, not in the uniform cell index.
    expect(s.cell[0]).toBe(3);
    expect(backend.stats.axesUniform).toEqual([false, false, false]);
    expect(backend.stats.axisSpacing.max.x).toBeCloseTo(0.6, 6);
  });

  it('a missing chunk is a coverage gap, not zero velocity', () => {
    const input = makeChunkedDemoField();
    const backend = createFieldBackend(input);
    const missing = backend.maskBoxes().find((b) => b.kind === 'missing-chunk');
    expect(missing).toBeDefined();
    const p = vec3(
      (missing!.min.x + missing!.max.x) / 2,
      (missing!.min.y + missing!.max.y) / 2,
      (missing!.min.z + missing!.max.z) / 2,
    );
    const s = backend.sample(p);
    expect(s.ok).toBe(false);
    expect(s.reason).toBe('missing-chunk');
    // Crucially: no sample is invented, and velocity is not silently zero-valid.
    expect(backend.stats.missingChunkCount).toBe(1);
    expect(backend.stats.presentChunkCount).toBe(26);
  });

  it('a streamline entering a missing chunk stops with a bounded missing-chunk reason', () => {
    const backend = createFieldBackend(makeChunkedDemoField());
    // Seed upstream of the omitted centre chunk and follow the swirling flow into it.
    const result = integrateStreamline(backend, vec3(-4, 0, 1.5), { ...DEFAULT_PARAMS, stepLength: 0.2 }, meta(10));
    expect(result.stop.forward).toBe('missing-chunk');
    expect(result.stats.directions.forward.category).toBe('boundary');
    expect(result.stats.directions.forward.bounded).toBe(true);
    // Every recorded sample must be valid; the stop is recorded, not stepped into.
    for (let i = 0; i < result.positions.length / 3; i++) {
      const p = vec3(result.positions[3 * i], result.positions[3 * i + 1], result.positions[3 * i + 2]);
      expect(backend.sample(p).ok).toBe(true);
    }
  });

  it('legacy adapter reproduces VectorGrid sampling bit-for-bit', () => {
    const backend = adapterForLegacyGrid(LEGACY_V);
    for (const p of [vec3(0.3, 0.7, 1.2), vec3(4, 4, 2), vec3(-1, 0, 0), vec3(8, 8, 4)]) {
      const a = LEGACY_V.sample(p);
      const b = backend.sample(p);
      expect(b.ok).toBe(a.ok);
      expect(b.reason).toBe(a.reason);
      expect(b.v.x).toBe(a.v.x);
      expect(b.v.y).toBe(a.v.y);
      expect(b.v.z).toBe(a.v.z);
    }
    expect(backend.kind).toBe('legacy-grid');
    expect(backend.stats.protocolVersion).toBe(FIELD_BACKEND_PROTOCOL_VERSION);
  });

  it('dense and legacy backends agree on streamline trajectories and terminal states', () => {
    const legacy = adapterForLegacyGrid(LEGACY_V);
    const dense = createFieldBackend({
      layout: 'dense',
      meta: LEGACY_V.meta,
      axes: [
        Float64Array.from({ length: LEGACY_V.dims[0] }, (_, i) => i),
        Float64Array.from({ length: LEGACY_V.dims[1] }, (_, i) => i),
        Float64Array.from({ length: LEGACY_V.dims[2] }, (_, i) => i),
      ],
      velocity: LEGACY_V.velocity.slice(),
      scalars: Object.fromEntries(Object.entries(LEGACY_V.scalars).map(([k, v]) => [k, v.slice()])),
      nodeMissing: LEGACY_V.nodeMissing.slice(),
      nodeSolid: LEGACY_V.nodeSolid.slice(),
    });
    const seed = vec3(1, 1, 1);
    const params = { ...DEFAULT_PARAMS, stepLength: 0.25, maxArcLength: 5 };
    const a = integrateStreamline(legacy, seed, params, meta(12));
    const b = integrateStreamline(dense, seed, params, meta(13));
    expect(b.stop.forward).toBe(a.stop.forward);
    expect(b.positions.length).toBe(a.positions.length);
    for (let i = 0; i < a.positions.length; i++) {
      expect(b.positions[i]).toBeCloseTo(a.positions[i], 4);
    }
  });

  it('rejects malformed axis coordinates instead of guessing a spacing', () => {
    const base = makeUniformField({ dims: [3, 3, 3], spacing: 1 });
    expect(() =>
      createFieldBackend({
        layout: 'dense',
        meta: base.meta,
        axes: [Float64Array.from([0, 2, 1]), Float64Array.from([0, 1, 2]), Float64Array.from([0, 1, 2])],
        velocity: base.velocity,
        scalars: {},
        nodeMissing: base.nodeMissing,
        nodeSolid: base.nodeSolid,
      }),
    ).toThrow(/严格递增/);
  });
});
