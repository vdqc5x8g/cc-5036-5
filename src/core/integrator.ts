import { FieldBackend } from './fieldProtocol';
import {
  add,
  distance,
  dot,
  IntegrationDirectionResult,
  IntegrationStats,
  IntegratorParams,
  isBoundedStop,
  length,
  Sample,
  SampleReason,
  scale,
  STOP_CATEGORY,
  StopReason,
  StreamlineResult,
  sub,
  Vec3,
  vec3,
} from './types';

/** Translate an unavailable-sample reason into a bounded trajectory stop. */
export function stopFromSampleReason(reason: SampleReason): StopReason {
  switch (reason) {
    case 'missing-chunk':
      return 'missing-chunk';
    case 'missing-data':
      return 'missing-data';
    case 'solid':
      return 'solid';
    default:
      return 'out-of-bounds';
  }
}

export function describeSampleReason(reason: SampleReason): string {
  switch (reason) {
    case 'missing-chunk':
      return '进入缺块区域';
    case 'missing-data':
      return '进入缺测单元';
    case 'solid':
      return '接触固体/分离面';
    default:
      return '越出网格边界';
  }
}


export const DEFAULT_PARAMS: IntegratorParams = {
  stepLength: 0.35,
  maxArcLength: 400,
  maxTime: 1200,
  maxSteps: 6000,
  absTolerance: 1e-3,
  maxSubsteps: 8,
  stagnationSpeed: 1e-4,
  loopTolerance: 0.02,
  detectLoops: true,
  direction: 'both',
};

const MIN_SUBSTEP = 1e-7;

/**
 * Arc-length parameterised velocity: dx/ds = v/|v|. Integrating in s keeps output
 * sample spacing even when speed varies; elapsed time is a separate integral dt = ds/|v|.
 * RK4 is applied to the normalised unit field, and the unit direction is re-evaluated
 * at every substage, so a streamline never "connects arrows" across a singular cell.
 */
class FlowSampler {
  evals = 0;
  private readonly backend: FieldBackend;

  constructor(backend: FieldBackend) {
    this.backend = backend;
  }

  /** Unit direction of travel at p, signed by integration direction. */
  dir(p: Vec3, sign: 1 | -1): { ok: boolean; reason: SampleReason; d: Vec3; speed: number } {
    this.evals++;
    const s = this.backend.sample(p);
    if (!s.ok) {
      return { ok: false, reason: s.reason, d: vec3(), speed: 0 };
    }
    if (s.speed < 1e-12) {
      return { ok: false, reason: 'solid', d: vec3(), speed: 0 };
    }
    const inv = sign / s.speed;
    return { ok: true, reason: 'ok', d: vec3(s.v.x * inv, s.v.y * inv, s.v.z * inv), speed: s.speed };
  }

  /** RK4 over one substep of arc length h starting at p with unit travel direction d0. */
  rk4(p: Vec3, d0: Vec3, h: number, sign: 1 | -1): { p: Vec3; ok: boolean; reason: SampleReason } {
    const k1 = d0;
    const k2r = this.dir(add(p, scale(k1, h / 2)), sign);
    if (!k2r.ok) return { p: add(p, scale(k1, h)), ok: false, reason: k2r.reason };
    const k3r = this.dir(add(p, scale(k2r.d, h / 2)), sign);
    if (!k3r.ok) return { p: add(p, scale(k1, h)), ok: false, reason: k3r.reason };
    const k4r = this.dir(add(p, scale(k3r.d, h)), sign);
    if (!k4r.ok) return { p: add(p, scale(k1, h)), ok: false, reason: k4r.reason };
    const dx = (k1.x + 2 * k2r.d.x + 2 * k3r.d.x + k4r.d.x) / 6;
    const dy = (k1.y + 2 * k2r.d.y + 2 * k3r.d.y + k4r.d.y) / 6;
    const dz = (k1.z + 2 * k2r.d.z + 2 * k3r.d.z + k4r.d.z) / 6;
    return { p: add(p, scale(vec3(dx, dy, dz), h)), ok: true, reason: 'ok' };
  }

  /** Time increment along a step: trapezoidal 2-point quadrature of ds/|v|. */
  dtEntering(speedStart: number, speedEnd: number, h: number): number {
    const a = 1 / Math.max(speedStart, 1e-12);
    const b = 1 / Math.max(speedEnd, 1e-12);
    return (0.5 * (a + b)) * h;
  }
}

function makeSample(
  p: Vec3,
  v: Vec3,
  t: number,
  s: number,
  scalars: Record<string, number>,
): Sample {
  return { p: vec3(p.x, p.y, p.z), v: vec3(v.x, v.y, v.z), speed: length(v), t, s, scalars };
}

/**
 * Largest h in (0, hMax] whose RK4 step stays inside valid data, found by bisection.
 * Returns 0 when no positive step is legal (the point sits on the domain boundary).
 */
function maxAdmissibleSubstep(
  backend: FieldBackend,
  p: Vec3,
  dir: Vec3,
  hMax: number,
  sign: 1 | -1,
): number {
  let lo = 0;
  let hi = hMax;
  // Coarse exponential search first; at least one trial already failed at hi.
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid <= MIN_SUBSTEP) return 0;
    const trial = backend.sample(add(p, scale(dir, mid)));
    // A single Euler probe is sufficient to reject out-of-domain midpoints; the caller
    // re-runs full RK4 on the accepted h afterwards.
    if (trial.ok) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-6) break;
  }
  void sign;
  return lo;
}

interface DirectionOptions {
  direction: 1 | -1;
  params: IntegratorParams;
  backend: FieldBackend;
}

function integrateDirection(
  seed: Vec3,
  opts: DirectionOptions,
): IntegrationDirectionResult {
  const { direction, params, backend } = opts;
  const sampler = new FlowSampler(backend);
  const samples: Sample[] = [];
  const forward = direction > 0;
  const stopDetailPrefix = forward ? '正向' : '反向';

  const result: IntegrationDirectionResult = {
    samples,
    stop: 'ok',
    stopDetail: '',
    category: 'completed',
    bounded: true,
    steps: 0,
    evals: 0,
    substepCount: 0,
    substepLimitHits: 0,
    minStep: Infinity,
    maxStep: 0,
    time: 0,
    arc: 0,
  };

  const seedSample = backend.sample(seed);
  if (!seedSample.ok) {
    result.stop = 'seed-invalid';
    result.category = STOP_CATEGORY['seed-invalid'];
    result.bounded = isBoundedStop('seed-invalid');
    result.stopDetail = `${stopDetailPrefix}种子位于${describeSampleReason(seedSample.reason)}，无法积分。`;
    result.minStep = 0;
    return result;
  }

  const d0 = sampler.dir(seed, direction);
  if (!d0.ok || d0.speed < params.stagnationSpeed) {
    result.stop = 'stagnation';
    result.category = STOP_CATEGORY.stagnation;
    result.bounded = isBoundedStop('stagnation');
    result.stopDetail = `${stopDetailPrefix}种子处速度 ${d0.speed.toExponential(2)} m/s 低于静止阈值 ${params.stagnationSpeed.toExponential(2)} m/s。`;
    result.minStep = 0;
    samples.push(makeSample(seed, seedSample.v, 0, 0, seedSample.scalars));
    return result;
  }

  samples.push(makeSample(seed, seedSample.v, 0, 0, seedSample.scalars));

  let p = vec3(seed.x, seed.y, seed.z);
  // d0.d is already signed by the integration direction; do not apply the sign twice.
  let dir = vec3(d0.d.x, d0.d.y, d0.d.z);
  let speed = d0.speed;
  let t = 0;
  let s = 0;
  const step = params.stepLength;
  const maxSteps = Math.max(1, Math.floor(params.maxSteps));
  const loopTolerance = params.loopTolerance;
  const directionWord = forward ? '正向' : '反向';

  const stopWith = (reason: StopReason, detail: string) => {
    result.stop = reason;
    result.stopDetail = detail;
    result.category = STOP_CATEGORY[reason];
    result.bounded = isBoundedStop(reason);
    result.evals = sampler.evals;
    result.minStep = Number.isFinite(result.minStep) ? result.minStep : 0;
    return result;
  };

  const stopForBoundary = (reason: SampleReason, detail: string) =>
    stopWith(stopFromSampleReason(reason), detail);

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    if (s >= params.maxArcLength - 1e-12) {
      return stopWith('max-length', `${directionWord}达到最大弧长 ${params.maxArcLength.toFixed(1)} m。`);
    }
    if (t >= params.maxTime - 1e-12) {
      return stopWith('max-time', `${directionWord}达到最大积分时间 ${params.maxTime.toFixed(1)} s。`);
    }
    const hGoal = Math.min(step, params.maxArcLength - s);
    if (hGoal <= MIN_SUBSTEP) {
      return stopWith('max-length', `${directionWord}达到最大弧长 ${params.maxArcLength.toFixed(1)} m。`);
    }

    let h = hGoal;
    let accepted: { p: Vec3; ok: boolean; reason: SampleReason } | null = null;
    let acceptedH = h;
    let halvings = 0;
    let reachedStagnation = false;
    let boundaryReason: SampleReason | null = null;

    for (; halvings <= params.maxSubsteps; halvings++) {
      const trial = sampler.rk4(p, dir, h, direction);
      if (!trial.ok) {
        // A substage left the valid domain. Find the largest admissible sub-step by
        // bisection; if no positive step fits, the streamline is on the boundary.
        boundaryReason = trial.reason;
        const found = maxAdmissibleSubstep(backend, p, dir, h, direction);
        if (found <= MIN_SUBSTEP || found < hGoal * 1e-4) {
          result.substepLimitHits++;
          return stopForBoundary(
            trial.reason,
            `${directionWord}在弧长 ${s.toFixed(2)} m 处${describeSampleReason(trial.reason)}（步长降为 ${found.toExponential(2)} m 仍不合法），已停止。`,
          );
        }
        h = found;
        result.substepCount++;
        continue;
      }
      // Re-evaluate the direction at the trial endpoint to judge local turning error.
      const endDir = sampler.dir(trial.p, direction);
      if (!endDir.ok) {
        boundaryReason = endDir.reason;
        const found = maxAdmissibleSubstep(backend, p, dir, h, direction);
        if (found <= MIN_SUBSTEP || found < hGoal * 1e-4) {
          result.substepLimitHits++;
          return stopForBoundary(
            endDir.reason,
            `${directionWord}在弧长 ${s.toFixed(2)} m 处${describeSampleReason(endDir.reason)}，已停止。`,
          );
        }
        h = found;
        result.substepCount++;
        continue;
      }
      if (endDir.speed < params.stagnationSpeed) {
        reachedStagnation = true;
        accepted = trial;
        acceptedH = h;
        result.substepCount++;
        break;
      }
      // Local error proxy: deviation of the chord direction from the midpoint step.
      const midDir = sampler.dir(add(p, scale(dir, h / 2)), direction);
      let turnError = 0;
      if (midDir.ok) {
        const chord = scale(sub(trial.p, p), 1 / Math.max(length(sub(trial.p, p)), 1e-12));
        const cosAngle = Math.min(1, Math.max(-1, dot(chord, midDir.d)));
        turnError = Math.sqrt(Math.max(0, 2 * (1 - cosAngle))) * h;
      }
      if (turnError > params.absTolerance && h > MIN_SUBSTEP * 4 && halvings < params.maxSubsteps) {
        h *= 0.5;
        result.substepCount++;
        continue;
      }
      accepted = trial;
      acceptedH = h;
      if (turnError > params.absTolerance) result.substepLimitHits++;
      break;
    }

    if (!accepted) {
      result.substepLimitHits++;
      if (boundaryReason) {
        return stopForBoundary(
          boundaryReason,
          `${directionWord}在弧长 ${s.toFixed(2)} m 处${describeSampleReason(boundaryReason)}，已停止。`,
        );
      }
      return stopWith('numerical', `${directionWord}在弧长 ${s.toFixed(2)} m 处无法满足步长细分容差，已停止以避免无界计算。`);
    }

    const previousP = p;
    p = accepted.p;
    // Arc length advances by the accepted RK4 substep h, since the ODE is
    // dx/ds = v/|v|. Using the chord |p - previousP| instead would systematically
    // under-count on curved paths and accumulate a phase error over many turns.
    const segLength = acceptedH;
    const chord = distance(previousP, p);
    if (!(segLength > 0) || !Number.isFinite(segLength)) {
      return stopWith('numerical', `${directionWord}在弧长 ${s.toFixed(2)} m 处出现零长度或非有限步，已停止。`);
    }
    if (!Number.isFinite(chord) || chord > segLength * 1.05 + 1e-9) {
      return stopWith('numerical', `${directionWord}在弧长 ${s.toFixed(2)} m 处步进位移与弧长不一致，已停止以避免无界计算。`);
    }
    s += segLength;
    result.steps++;
    result.minStep = Math.min(result.minStep, segLength);
    result.maxStep = Math.max(result.maxStep, segLength);
    result.arc = s;

    const end = backend.sample(p);
    if (!end.ok) {
      return stopForBoundary(
        end.reason,
        `${directionWord}在弧长 ${s.toFixed(2)} m 处${describeSampleReason(end.reason)}，已停止。`,
      );
    }
    if (end.speed < params.stagnationSpeed) {
      t += sampler.dtEntering(speed, Math.max(end.speed, 1e-12), segLength);
      result.time = t;
      samples.push(makeSample(p, end.v, t, s, end.scalars));
      return stopWith(
        'stagnation',
        `${directionWord}在 ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} m 附近速度降至 ${end.speed.toExponential(2)} m/s（静止点），已停止。`,
      );
    }

    t += sampler.dtEntering(speed, end.speed, segLength);
    speed = end.speed;
    const nextDir = vec3(end.v.x / end.speed, end.v.y / end.speed, end.v.z / end.speed);
    dir = vec3(nextDir.x * direction, nextDir.y * direction, nextDir.z * direction);
    result.time = t;
    result.arc = s;
    result.evals = sampler.evals;
    samples.push(makeSample(p, end.v, t, s, end.scalars));

    if (reachedStagnation) {
      return stopWith('stagnation', `${directionWord}接近静止点，已停止。`);
    }

    if (params.detectLoops && s > 4 * step) {
      // Compare only with samples that are genuinely far apart along the path;
      // tiny halved steps near a stagnation point must not masquerade as closure.
      const minPathSeparation = Math.max(4 * step, 8 * loopTolerance);
      for (let idx = 0; idx < samples.length - 3; idx++) {
        const prev = samples[idx];
        if (Math.abs(s - prev.s) < minPathSeparation) continue;
        const dq = distance(prev.p, p);
        if (dq < loopTolerance) {
          // Closing a loop requires comparable direction; a mere crossing is not closure.
          const prevSpeed = Math.hypot(prev.v.x, prev.v.y, prev.v.z);
          if (prevSpeed < 1e-12) continue;
          const px = (prev.v.x / prevSpeed) * direction;
          const py = (prev.v.y / prevSpeed) * direction;
          const pz = (prev.v.z / prevSpeed) * direction;
          const cosAngle = px * dir.x + py * dir.y + pz * dir.z;
          if (cosAngle > 0.94) {
            return stopWith(
              'closed-loop',
              `${directionWord}回到先前位置（间距 ${dq.toFixed(4)} m < 容差 ${loopTolerance} m），判定闭环并停止。`,
            );
          }
        }
      }
    }
  }

  return stopWith('max-steps', `${directionWord}达到最大步数 ${maxSteps}，已停止。`);
}

/** Integrate a streamline through a seed. Handles both directions. */
export function integrateStreamline(
  backend: FieldBackend,
  seed: Vec3,
  params: IntegratorParams,
  meta: { seedId: string; version: number; color: string; label: string },
): StreamlineResult {
  const start = performance.now();
  const fieldEpoch = backend.epoch;

  const forward = integrateDirection(seed, { direction: 1, params, backend });
  const backward =
    params.direction === 'both'
      ? integrateDirection(seed, { direction: -1, params, backend })
      : null;

  // Assemble: reverse the backward direction, then the forward direction.
  const ordered: Sample[] = [];
  if (backward) {
    for (let i = backward.samples.length - 1; i > 0; i--) {
      const sm = backward.samples[i];
      // Backward arc/time are signed so the merged array is monotone.
      ordered.push({
        ...sm,
        s: -sm.s,
        t: -sm.t,
      });
    }
  }
  for (let i = 0; i < forward.samples.length; i++) {
    ordered.push(forward.samples[i]);
  }

  const n = ordered.length;
  const positions = new Float32Array(3 * n);
  const velocities = new Float32Array(3 * n);
  const speeds = new Float32Array(n);
  const times = new Float32Array(n);
  const arcs = new Float32Array(n);
  const scalarNames = [...backend.scalarNames];
  const scalars: Record<string, Float32Array> = {};
  for (const name of scalarNames) scalars[name] = new Float32Array(n);

  let minStep = Infinity;
  let maxStep = 0;
  for (let i = 0; i < n; i++) {
    const sm = ordered[i];
    positions[3 * i] = sm.p.x;
    positions[3 * i + 1] = sm.p.y;
    positions[3 * i + 2] = sm.p.z;
    velocities[3 * i] = sm.v.x;
    velocities[3 * i + 1] = sm.v.y;
    velocities[3 * i + 2] = sm.v.z;
    speeds[i] = sm.speed;
    times[i] = sm.t;
    arcs[i] = sm.s;
    for (const name of scalarNames) {
      const val = sm.scalars[name];
      scalars[name][i] = Number.isFinite(val) ? val : Number.NaN;
    }
  }

  for (const dirResult of [forward, backward]) {
    if (!dirResult || dirResult.steps === 0) continue;
    if (Number.isFinite(dirResult.minStep)) minStep = Math.min(minStep, dirResult.minStep);
    maxStep = Math.max(maxStep, dirResult.maxStep);
  }

  const totalSteps = forward.steps + (backward?.steps ?? 0);
  const stats: IntegrationStats = {
    directions: { forward, backward },
    totalSamples: n,
    totalSteps,
    totalEvals: forward.evals + (backward?.evals ?? 0),
    totalTime: forward.time + (backward?.time ?? 0),
    totalArc: forward.arc + (backward?.arc ?? 0),
    minStep: Number.isFinite(minStep) ? minStep : 0,
    maxStep,
    meanStep: totalSteps ? (forward.arc + (backward?.arc ?? 0)) / totalSteps : 0,
  };

  return {
    seedId: meta.seedId,
    version: meta.version,
    fieldEpoch,
    fieldId: backend.meta.id,
    fieldProtocolVersion: backend.protocolVersion,
    fieldBackendKind: backend.kind,
    seed: vec3(seed.x, seed.y, seed.z),
    positions,
    velocities,
    speeds,
    times,
    arcs,
    scalars,
    stop: { forward: forward.stop, backward: backward ? backward.stop : null },
    stopDetail: {
      forward: forward.stopDetail,
      backward: backward ? backward.stopDetail : null,
    },
    stats,
    params: { ...params },
    color: meta.color,
    label: meta.label,
    computationMs: performance.now() - start,
  };
}

/** Deterministic hazard seeds provided by the field definition (analytic where possible). */
export interface HazardProbe {
  key: string;
  label: string;
  seed: Vec3;
  expected: StopReason;
}

/** Build default probes from backend mask geometry; field-specific probes should be supplied by the caller. */
export function maskHazardProbes(backend: FieldBackend): HazardProbe[] {
  const [nx, ny, nz] = backend.dims;
  const spacing = backend.stats.spacing;
  const origin = backend.extent.min;
  const probes: HazardProbe[] = [
    {
      key: 'out-of-bounds',
      label: '越界种子',
      seed: vec3(origin.x - 3 * spacing.x, origin.y + 0.5 * spacing.y, origin.z + 0.5 * spacing.z),
      expected: 'seed-invalid',
    },
  ];
  // A missing chunk is its own hazard class: a seed inside it must be rejected
  // as unavailable, not accepted with a zero-velocity field.
  const gap = backend.maskBoxes().find((box) => box.kind === 'missing-chunk');
  if (gap) {
    probes.push({
      key: 'missing-chunk',
      label: '缺块中心种子',
      seed: vec3((gap.min.x + gap.max.x) / 2, (gap.min.y + gap.max.y) / 2, (gap.min.z + gap.max.z) / 2),
      expected: 'seed-invalid',
    });
  }
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (backend.cellState(i, j, k) === 'missing-data') {
          probes.push({ key: 'missing-data', label: '缺测单元', seed: backend.cellCenter(i, j, k), expected: 'seed-invalid' });
          return probes;
        }
      }
    }
  }
  return probes;
}

export interface HazardCheckResult {
  key: string;
  label: string;
  seed: Vec3;
  expected: StopReason;
  stop: StopReason;
  bounded: boolean;
  passed: boolean;
  matchesExpectation: boolean;
  detail: string;
  steps: number;
  arc: number;
  time: number;
  elapsedMs: number;
}

export interface HazardRunOptions {
  timeBudgetMs?: number;
}

/** Runs bounded hazard probes. A probe exceeding the wall-clock budget fails. */
export function runHazardChecks(
  backend: FieldBackend,
  baseParams: IntegratorParams,
  probes: HazardProbe[],
  opts: HazardRunOptions = {},
): { checks: HazardCheckResult[]; allBounded: boolean } {
  const budget = opts.timeBudgetMs ?? 1500;
  const checks: HazardCheckResult[] = [];
  let allBounded = true;
  for (const probe of probes) {
    const params: IntegratorParams = {
      ...baseParams,
      maxSteps: Math.min(4000, baseParams.maxSteps),
      maxArcLength: Math.min(2000, baseParams.maxArcLength),
      maxTime: Math.min(5000, baseParams.maxTime),
      direction: 'both',
    };
    const start = performance.now();
    let stop: StopReason = 'numerical';
    let detail = '';
    let steps = 0;
    let arc = 0;
    let time = 0;
    let bounded = true;
    try {
      const fwd = integrateDirection(probe.seed, { direction: 1, params, backend });
      const bwd = integrateDirection(probe.seed, { direction: -1, params, backend });
      stop = fwd.stop === 'seed-invalid' ? bwd.stop : fwd.stop;
      detail = fwd.stop === 'seed-invalid' ? bwd.stopDetail : fwd.stopDetail;
      steps = fwd.steps + bwd.steps;
      arc = fwd.arc + bwd.arc;
      time = fwd.time + bwd.time;
    } catch (err) {
      detail = `计算异常：${err instanceof Error ? err.message : String(err)}`;
    }
    const elapsedMs = performance.now() - start;
    if (elapsedMs > budget) bounded = false;
    // A hazard probe must end in a specific terminal state, not by running out
    // of steps or failing numerically. Mirrors the pre-migration contract while
    // adding missing-chunk as a legitimate boundary outcome.
    const terminal = stop !== 'max-steps' && stop !== 'numerical' && stop !== 'ok';
    const matchesExpectation = stop === probe.expected;
    const passed = bounded && terminal;
    if (!passed) allBounded = false;
    checks.push({
      key: probe.key,
      label: probe.label,
      seed: probe.seed,
      expected: probe.expected,
      stop,
      bounded,
      passed,
      matchesExpectation,
      detail: detail || '未产生停止说明',
      steps,
      arc,
      time,
      elapsedMs,
    });
  }
  return { checks, allBounded };
}
