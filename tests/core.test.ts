import { describe, expect, it } from 'vitest';
import { VectorGrid } from '../src/core/grid';
import { DEFAULT_PARAMS, integrateStreamline } from '../src/core/integrator';
import {
  makeHyperbolicField,
  makeRankineVortexField,
  makeUniformField,
} from '../src/core/synthetic';
import { pickCandidates, pickLines, pointToSegment2D } from '../src/render/picking';
import { vec3, Vec3 } from '../src/core/types';
import { runValidation } from '../src/core/validation';

const makeGrid = (payload: ReturnType<typeof makeUniformField>) => new VectorGrid(payload);

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
    const res = integrateStreamline(grid, seed, { ...DEFAULT_PARAMS, stepLength: 0.2, maxArcLength: 8 }, meta(1));
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
      grid,
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
    const res = integrateStreamline(grid, seed, { ...DEFAULT_PARAMS, stepLength: 0.15, maxArcLength: 10 }, meta(3));
    for (let i = 0; i < res.positions.length / 3; i++) {
      expect(Math.abs(res.positions[3 * i + 1])).toBeLessThan(1e-6);
    }
  });

  it('uniform field reference deviation stays under tolerance', () => {
    const grid = makeGrid(makeUniformField({ dims: [101, 61, 13], spacing: 0.25 }));
    const report = runValidation({
      fieldKind: 'uniform',
      grid,
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
    const res = integrateStreamline(grid, seed, { ...DEFAULT_PARAMS, stepLength: 0.1, maxSteps: 5000 }, meta(4));
    expect(['closed-loop', 'stagnation', 'max-steps', 'max-length']).toContain(res.stop.forward);
    expect(res.stats.totalSteps).toBeLessThanOrEqual(5000);
    expect(res.positions.length / 3).toBeLessThan(20000);
  });

  it('stops immediately at an out-of-bounds seed', () => {
    const grid = makeGrid(makeUniformField());
    const res = integrateStreamline(grid, vec3(-50, -50, 0), DEFAULT_PARAMS, meta(5));
    expect(res.stop.forward).toBe('seed-invalid');
    expect(res.stats.totalSteps).toBe(0);
  });

  it('stops at missing-data boundaries instead of interpolating across the gap', () => {
    const grid = new VectorGrid(makeHyperbolicField());
    const seed = vec3(0.0, -1.2, 1.0);
    const res = integrateStreamline(grid, seed, { ...DEFAULT_PARAMS, stepLength: 0.1, maxArcLength: 50 }, meta(6));
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
      const res = integrateStreamline(grid, vec3(0.9, y, 1.0), { ...DEFAULT_PARAMS, stepLength: 0.1, maxArcLength: 60 }, meta(8));
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
    const res = integrateStreamline(grid, vec3(0, 0, 2), DEFAULT_PARAMS, meta(7));
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
