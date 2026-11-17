import { VectorGrid } from './grid';
import { integrateStreamline } from './integrator';
import * as syntheticModule from './synthetic';
import {
  analyticVelocityFunction,
  HYPERBOLIC_PARAMS,
  ReferenceTrajectory,
  referenceTrajectory,
  SyntheticFieldId,
} from './synthetic';
import { distance, IntegratorParams, ValidationReport, ValidationRow, Vec3, vec3 } from './types';

export interface ValidationOptions {
  fieldKind: SyntheticFieldId;
  grid: VectorGrid;
  params: IntegratorParams;
  seeds: Vec3[];
  toleranceMeters: number;
  /** Compare against the same analytic field sampled on a 3x finer grid. */
  includeRefinement?: boolean;
}

/** Build a 3x-refined sampling of the same synthetic field, without mask gaps. */
function refinedGridFor(fieldKind: SyntheticFieldId, spacing: Vec3): VectorGrid {
  return new VectorGrid(syntheticModule.makeRefinedField(fieldKind, spacing.x));
}


interface Deviation {
  maxError: number;
  rmsError: number;
  endpointError: number;
  sampleCount: number;
  matchedCount: number;
}

/**
 * Compare the app trajectory against the reference by matching arc length.
 * Both trajectories are arc-length parameterised, so position at the same
 * travelled distance is the meaningful comparison. Also reports the endpoint
 * mismatch (a strong global-accuracy indicator).
 */
function arcMatchedDeviation(
  positions: Float32Array,
  arcs: Float32Array,
  ref: Array<{ s: number; p: Vec3 }>,
): Deviation {
  const n = positions.length / 3;
  if (n === 0 || ref.length === 0) {
    return { maxError: 0, rmsError: 0, endpointError: 0, sampleCount: 0, matchedCount: 0 };
  }
  let maxError = 0;
  let sumSq = 0;
  let matched = 0;
  let cursor = 0;
  // Only compare within the reference's arc-length coverage. The app may trace
  // beyond either end (closed loops, approach to a stagnation point); clamping
  // out-of-range samples to the reference endpoint would manufacture a large error.
  const refStart = ref[0].s;
  const refEnd = ref[ref.length - 1].s;
  for (let i = 0; i < n; i++) {
    const s = arcs[i];
    if (!Number.isFinite(s) || s < refStart || s > refEnd) continue;
    while (cursor < ref.length - 2 && ref[cursor + 1].s < s) cursor++;
    const a = ref[cursor];
    const b = ref[Math.min(cursor + 1, ref.length - 1)];
    const span = b.s - a.s;
    const t = span > 1e-12 ? Math.min(1, Math.max(0, (s - a.s) / span)) : 0;
    const px = a.p.x + (b.p.x - a.p.x) * t;
    const py = a.p.y + (b.p.y - a.p.y) * t;
    const pz = a.p.z + (b.p.z - a.p.z) * t;
    const err = Math.hypot(positions[3 * i] - px, positions[3 * i + 1] - py, positions[3 * i + 2] - pz);
    if (!Number.isFinite(err)) continue;
    maxError = Math.max(maxError, err);
    sumSq += err * err;
    matched++;
  }
  // Endpoint is compared at the app's final arc length if the reference covers it;
  // otherwise at the reference's end (the last directly comparable point).
  const sEnd = Math.min(arcs[n - 1], refEnd);
  let endpointError = Number.NaN;
  if (Number.isFinite(sEnd) && ref.length > 0 && sEnd >= ref[0].s) {
    let c = 0;
    while (c < ref.length - 2 && ref[c + 1].s < sEnd) c++;
    const a = ref[c];
    const b = ref[Math.min(c + 1, ref.length - 1)];
    const span = b.s - a.s;
    const t = span > 1e-12 ? Math.min(1, Math.max(0, (sEnd - a.s) / span)) : 0;
    endpointError = distance(
      vec3(positions[3 * (n - 1)], positions[3 * (n - 1) + 1], positions[3 * (n - 1) + 2]),
      vec3(a.p.x + (b.p.x - a.p.x) * t, a.p.y + (b.p.y - a.p.y) * t, a.p.z + (b.p.z - a.p.z) * t),
    );
  }
  return {
    maxError,
    rmsError: matched ? Math.sqrt(sumSq / matched) : 0,
    endpointError,
    sampleCount: n,
    matchedCount: matched,
  };
}

function thinReference(traj: ReferenceTrajectory, maxPoints = 12_000): { s: number; p: Vec3 }[] {
  const n = traj.positions.length / 3;
  const stride = Math.max(1, Math.floor(n / maxPoints));
  const out: { s: number; p: Vec3 }[] = [];
  for (let i = 0; i < n; i += stride) {
    out.push({
      s: traj.arc[i],
      p: vec3(traj.positions[3 * i], traj.positions[3 * i + 1], traj.positions[3 * i + 2]),
    });
  }
  const last = n - 1;
  const lastP = vec3(traj.positions[3 * last], traj.positions[3 * last + 1], traj.positions[3 * last + 2]);
  if (out.length === 0 || out[out.length - 1].s !== traj.arc[last]) {
    out.push({ s: traj.arc[last], p: lastP });
  }
  return out;
}

/** Analytic time-flow map for the hyperbolic field; an exact, grid-independent oracle. */
function analyticTrace(seed: Vec3, direction: 1 | -1, lengthMeters: number): { s: number; p: Vec3 }[] {
  const { a, c, z0 } = HYPERBOLIC_PARAMS;
  const out: { s: number; p: Vec3 }[] = [{ s: 0, p: vec3(seed.x, seed.y, seed.z) }];
  const dt = 1 / 4000;
  let s = 0;
  let t = 0;
  let prev = vec3(seed.x, seed.y, seed.z);
  for (let i = 0; i < 400_000 && s < lengthMeters; i++) {
    t += dt;
    const x = seed.x * Math.exp(a * direction * t);
    const y = seed.y * Math.exp(-a * direction * t);
    const z = z0 + (seed.z - z0) * Math.exp(-c * direction * t);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) break;
    const p = vec3(x, y, z);
    s += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    prev = p;
    out.push({ s, p });
    if (Math.abs(x) > 10_000 || Math.abs(y) > 10_000) break;
  }
  return out;
}

function mergeBothDirections(
  backward: { s: number; p: Vec3 }[],
  forward: { s: number; p: Vec3 }[],
): { s: number; p: Vec3 }[] {
  const out: { s: number; p: Vec3 }[] = [];
  for (let i = backward.length - 1; i > 0; i--) out.push({ s: -backward[i].s, p: backward[i].p });
  for (let i = 0; i < forward.length; i++) out.push(forward[i]);
  return out;
}

export function runValidation(opts: ValidationOptions): ValidationReport {
  const { fieldKind, grid, params, seeds, toleranceMeters } = opts;
  const analytic = analyticVelocityFunction(fieldKind);
  const rows: ValidationRow[] = [];
  let maxError = 0;
  let relSum = 0;
  let relCount = 0;

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const result = integrateStreamline(grid, seed, params, {
      seedId: `val-${i}`,
      version: 0,
      color: '#ffffff',
      label: `校验 #${i + 1}`,
    });
    if (result.positions.length < 6 || result.stats.totalArc <= 0) {
      rows.push({
        seedIndex: i,
        seed,
        sampleCount: result.positions.length / 3,
        maxError: Number.NaN,
        rmsError: Number.NaN,
        endpointError: Number.NaN,
        relativeError: Number.NaN,
        pathLength: 0,
        method: '未产生有效轨迹',
        note: result.stopDetail.forward,
        metrics: [],
      });
      continue;
    }

    const refTarget = Math.min(params.maxArcLength, 300);
    let reference: { s: number; p: Vec3 }[];
    let method: string;
    let note: string;
    if (fieldKind === 'hyperbolic') {
      const fwd = analyticTrace(seed, 1, refTarget);
      const bwd = params.direction === 'both' ? analyticTrace(seed, -1, refTarget) : [];
      reference = mergeBothDirections(bwd, fwd);
      method = '精确流映射 exp(A·t)，非数值积分';
      note = '双曲线性场有闭式解；误差只反映插值、弧长参数化与 RK4 步进，不含参考积分误差。';
    } else {
      const fwd = referenceTrajectory(analytic, seed, {
        direction: 1,
        lengthMeters: refTarget,
        stepMeters: 0.004,
      });
      const bwdTraj =
        params.direction === 'both'
          ? referenceTrajectory(analytic, seed, { direction: -1, lengthMeters: refTarget, stepMeters: 0.004 })
          : null;
      const toRef = (tr: ReferenceTrajectory) => thinReference(tr);
      reference = mergeBothDirections(bwdTraj ? toRef(bwdTraj) : [], toRef(fwd));
      method = fwd.note;
      note = '参考解在连续解析场上以 0.004 m 步长独立 RK4 积分，不读取本应用插值后的网格。';
    }

    const dev = arcMatchedDeviation(result.positions, result.arcs, reference);
    const pathLen = result.stats.totalArc;
    const rel = pathLen > 0 ? dev.maxError / pathLen : Number.NaN;

    // Interpolation vs integration split: rerun the same seed/params on a 3x finer
    // sampling of the same analytic field. If the error drops sharply, grid
    // resolution dominates; if it stays, the stepping scheme dominates.
    let refinement: { maxError: number; note: string } | null = null;
    if (opts.includeRefinement && fieldKind !== 'hyperbolic') {
      try {
        const fine = refinedGridFor(fieldKind, grid.spec.spacing);
        const fineResult = integrateStreamline(fine, seed, params, {
          seedId: `val-fine-${i}`,
          version: 0,
          color: '#ffffff',
          label: 'refine',
        });
        if (fineResult.positions.length >= 6) {
          const fineRef = arcMatchedDeviation(fineResult.positions, fineResult.arcs, reference);
          refinement = {
            maxError: fineRef.maxError,
            note: `3× 细化网格（Δ=${fine.spec.spacing.x.toFixed(3)} m）同参数重算`,
          };
          note += ' “细化网格”指标用于区分网格插值误差与积分方法误差；若偏差未明显下降，说明限制精度的是积分/相位而非网格分辨率。';
        }
      } catch {
        refinement = null;
      }
    }

    const metrics = [
      { label: '最大点偏差', value: dev.maxError, unit: 'm', ok: dev.maxError <= toleranceMeters },
      { label: 'RMS 偏差', value: dev.rmsError, unit: 'm', ok: dev.rmsError <= toleranceMeters },
      { label: '同弧长终点偏差', value: dev.endpointError, unit: 'm' },
      { label: '相对误差', value: rel, unit: '', ok: Number.isFinite(rel) ? rel < 2e-3 : undefined },
    ];
    if (refinement) {
      metrics.push({
        label: '细化网格最大偏差',
        value: refinement.maxError,
        unit: 'm',
        ok: refinement.maxError <= toleranceMeters,
      });
    }

    if (fieldKind === 'hyperbolic') {
      // Independent invariant check: y=0 is a separation surface, so a seed on y=0 must keep y=0.
      if (Math.abs(seed.y) < 1e-9) {
        let maxAbsY = 0;
        for (let q = 0; q < result.positions.length / 3; q++) {
          maxAbsY = Math.max(maxAbsY, Math.abs(result.positions[3 * q + 1]));
        }
        metrics.push({ label: '分离面 |y| 最大漂移', value: maxAbsY, unit: 'm', ok: maxAbsY < 1e-6 });
      }
    }

    const refStride = Math.max(1, Math.floor(reference.length / 2500));
    const refPoints: number[] = [];
    for (let q = 0; q < reference.length; q += refStride) {
      refPoints.push(reference[q].p.x, reference[q].p.y, reference[q].p.z);
    }
    const lastRef = reference[reference.length - 1].p;
    refPoints.push(lastRef.x, lastRef.y, lastRef.z);

    rows.push({
      seedIndex: i,
      seed,
      sampleCount: dev.sampleCount,
      maxError: dev.maxError,
      rmsError: dev.rmsError,
      endpointError: dev.endpointError,
      relativeError: rel,
      pathLength: pathLen,
      method,
      note,
      metrics,
      referencePoints: new Float32Array(refPoints),
    });
    if (Number.isFinite(dev.maxError)) maxError = Math.max(maxError, dev.maxError);
    if (Number.isFinite(rel)) {
      relSum += rel;
      relCount++;
    }
  }

  const relTolerance = 2e-3;
  const validRows = rows.filter((r) => Number.isFinite(r.maxError));
  const rowPasses = (r: ValidationRow) =>
    r.maxError <= toleranceMeters ||
    (Number.isFinite(r.relativeError) && r.relativeError <= relTolerance);
  // Rows without a trajectory (e.g. seed on a stagnation point) are reported but do
  // not condemn the implementation: there is nothing numerical to compare.
  const passed = validRows.length > 0 && validRows.every(rowPasses);
  return {
    fieldId: grid.meta.id,
    fieldName: grid.meta.name,
    ranAt: new Date().toISOString(),
    method: `逐采样点按累计弧长对齐到独立参考轨迹；通过判据为最大偏差 ≤ ${toleranceMeters} m 或相对误差 ≤ ${(relTolerance * 100).toFixed(1)}%（长闭环路径按后者）。${opts.fieldKind === 'hyperbolic' ? '参考为精确流映射。' : '参考为连续解析场 0.004 m 步长 RK4。'}`,
    params: { ...params },
    rows,
    summary: {
      maxError,
      meanRelativeError: relCount ? relSum / relCount : Number.NaN,
      passed,
      tolerance: toleranceMeters,
      relativeTolerance: relTolerance,
    },
    disclaimer:
      '校验仅说明本查看器的插值与积分实现与给定解析/高精度参考一致；合成场本身是理想化算例，不是实测水动力结论。',
  };
}
