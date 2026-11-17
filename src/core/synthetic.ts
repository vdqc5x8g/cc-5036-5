import { computeVorticityScalar, FieldPayload, GridSpec, VectorGrid } from './grid';
import { Vec3, vec3 } from './types';

export interface SyntheticFieldOptions {
  dims?: [number, number, number];
  spacing?: number;
  origin?: Vec3;
  angleDeg?: number;
  speed?: number;
  coreRadius?: number;
  peakTangential?: number;
  stretch?: number;
  shear?: number;
  /** Fraction of cells to blank out as instrument gaps (deterministic). */
  missingPatch?: { x: [number, number]; y: [number, number]; z: [number, number] } | null;
}

const DISCLAIMER =
  '合成/理想化流场：由解析公式生成，用于验证插值、积分与交互，不代表任何实测水动力条件，不可用于工程或安全结论。';

function baseMeta(
  id: string,
  name: string,
  description: string,
  analytic: FieldPayload['meta']['analytic'],
  timeLabel = '稳态 · 解析合成场',
): FieldPayload['meta'] {
  return {
    id,
    name,
    source: '内置解析合成场生成器',
    synthetic: true,
    description,
    provenance: '程序按解析公式在规则网格上采样生成；无观测或数值模型输入。',
    units: { length: 'm', velocity: 'm/s', scalar: { speed: 'm/s', vorticity: '1/s' } },
    timeLabel,
    disclaimer: DISCLAIMER,
    createdAt: new Date().toISOString(),
    analytic,
  };
}

function yawnMask(
  spec: GridSpec,
  patch: NonNullable<SyntheticFieldOptions['missingPatch']>,
): Uint8Array {
  const [nx, ny, nz] = spec.dims;
  const n = nx * ny * nz;
  const mask = new Uint8Array(n);
  for (let k = 0; k < nz; k++) {
    const z = spec.origin.z + k * spec.spacing.z;
    for (let j = 0; j < ny; j++) {
      const y = spec.origin.y + j * spec.spacing.y;
      for (let i = 0; i < nx; i++) {
        const x = spec.origin.x + i * spec.spacing.x;
        if (
          x >= patch.x[0] && x <= patch.x[1] &&
          y >= patch.y[0] && y <= patch.y[1] &&
          z >= patch.z[0] && z <= patch.z[1]
        ) {
          mask[i + nx * (j + ny * k)] = 1;
        }
      }
    }
  }
  return mask;
}

function buildField(
  spec: GridSpec,
  meta: FieldPayload['meta'],
  velocityOf: (p: Vec3) => Vec3,
  scalarOf?: (p: Vec3, v: Vec3) => Record<string, number>,
  missingPatch: SyntheticFieldOptions['missingPatch'] = null,
): FieldPayload {
  const [nx, ny, nz] = spec.dims;
  const n = nx * ny * nz;
  const velocity = new Float32Array(3 * n);
  const scalarNames = scalarOf ? Object.keys(scalarOf(vec3(), vec3(1, 0, 0))) : [];
  const scalars: Record<string, Float32Array> = {};
  for (const name of scalarNames) scalars[name] = new Float32Array(n);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p = vec3(
          spec.origin.x + i * spec.spacing.x,
          spec.origin.y + j * spec.spacing.y,
          spec.origin.z + k * spec.spacing.z,
        );
        const v = velocityOf(p);
        const node = i + nx * (j + ny * k);
        velocity[3 * node] = v.x;
        velocity[3 * node + 1] = v.y;
        velocity[3 * node + 2] = v.z;
        if (scalarOf) {
          const s = scalarOf(p, v);
          for (const name of scalarNames) scalars[name][node] = s[name] ?? Number.NaN;
        }
      }
    }
  }

  // Vorticity is derived from the sampled grid itself, not the analytic formula,
  // so colouring reflects what the interpolated field actually contains.
  const gridTmp = new VectorGrid({
    meta,
    spec,
    velocity,
    scalars,
    nodeMissing: new Uint8Array(n),
    nodeSolid: new Uint8Array(n),
  });
  const vort = computeVorticityScalar(gridTmp);
  const withVort = { ...scalars, vorticity: vort.data };

  const nodeMissing = missingPatch ? yawnMask(spec, missingPatch) : new Uint8Array(n);
  return {
    meta,
    spec,
    velocity,
    scalars: withVort,
    nodeMissing,
    nodeSolid: new Uint8Array(n),
  };
}

/**
 * Shared absolute-scale constants. Wavelengths are in metres, not grid units, so a
 * refined grid samples the same continuous field and reference comparisons stay valid.
 */
export const UNIFORM_PARAMS = { angleDeg: 20, speed: 1.2, wAmp: 0.06, Ly: 24, Lx: 40.8 } as const;
export const VORTEX_PARAMS = { coreRadius: 3.5, peakTangential: 2.2, axial: 0 } as const;
export const HYPERBOLIC_PARAMS = { a: 0.55, c: 0.08, z0: 2.0 } as const;

export function uniformVelocity(p: Vec3): Vec3 {
  const angle = (UNIFORM_PARAMS.angleDeg * Math.PI) / 180;
  const vx = UNIFORM_PARAMS.speed * Math.cos(angle);
  const vy = UNIFORM_PARAMS.speed * Math.sin(angle);
  const wz =
    UNIFORM_PARAMS.wAmp *
    Math.sin((2 * Math.PI * p.y) / UNIFORM_PARAMS.Ly) *
    Math.cos((2 * Math.PI * p.x) / UNIFORM_PARAMS.Lx);
  return vec3(vx, vy, wz);
}

export function vortexVelocity(p: Vec3): Vec3 {
  const { coreRadius: rc, peakTangential: peak, axial } = VORTEX_PARAMS;
  const omega = peak / rc;
  const r = Math.hypot(p.x, p.y);
  const vt = r < rc ? omega * r : (peak * rc) / Math.max(r, 1e-9);
  return r > 1e-12 ? vec3((-vt * p.y) / r, (vt * p.x) / r, axial) : vec3(0, 0, axial);
}

export function hyperbolicVelocity(p: Vec3): Vec3 {
  const { a, c, z0 } = HYPERBOLIC_PARAMS;
  return vec3(a * p.x, -a * p.y, -c * (p.z - z0));
}

/** Uniform flow tilted in the XY plane; exact solution: straight lines, |v| constant. */
export function makeUniformField(opts: SyntheticFieldOptions = {}): FieldPayload {
  const dims = opts.dims ?? [41, 25, 9];
  const spacing = opts.spacing ?? 1;
  const vx = uniformVelocity(vec3()).x;
  const vy = uniformVelocity(vec3()).y;
  const spec: GridSpec = {
    origin: opts.origin ?? vec3(0, 0, 0),
    spacing: vec3(spacing, spacing, spacing),
    dims,
  };
  const velocityOf = (p: Vec3) => uniformVelocity(p);

  const meta = baseMeta(
    'uniform',
    '匀速参考流（含微弱竖向起伏）',
    `主流沿 ${UNIFORM_PARAMS.angleDeg}° 倾斜，水平速度分量恒为 (${vx.toFixed(3)}, ${vy.toFixed(3)}) m/s；竖向 w 为 ${UNIFORM_PARAMS.wAmp} m/s 量级的平滑正弦（波长绝对尺度 ${UNIFORM_PARAMS.Ly} m），用于验证三维插值。解析参考解在连续场上独立积分。`,
    {
      kind: 'uniform',
      velocity: vec3(vx, vy, 0),
      note: `w(x,y)=${UNIFORM_PARAMS.wAmp}·sin(2πy/${UNIFORM_PARAMS.Ly})·cos(2πx/${UNIFORM_PARAMS.Lx})`,
    },
  );
  return buildField(
    spec,
    meta,
    velocityOf,
    (_p, v) => ({ speed: Math.hypot(v.x, v.y, v.z), vzW: v.z }),
    opts.missingPatch ?? null,
  );
}

/** Rankine vortex: solid-body core, 1/r exterior, with a weak axial flow. */
export function makeRankineVortexField(opts: SyntheticFieldOptions = {}): FieldPayload {
  const dims = opts.dims ?? [41, 41, 9];
  const spacing = opts.spacing ?? 0.5;
  const rc = VORTEX_PARAMS.coreRadius;
  const peak = VORTEX_PARAMS.peakTangential;
  const omega = peak / rc;
  const spec: GridSpec = {
    origin: opts.origin ?? vec3(-(dims[0] - 1) * spacing * 0.5, -(dims[1] - 1) * spacing * 0.5, 0),
    spacing: vec3(spacing, spacing, spacing),
    dims,
  };
  const centreY = 0;
  const centreX = 0;
  const velocityOf = (p: Vec3) => vortexVelocity(p);
  const meta = baseMeta(
    'rankine-vortex',
    'Rankine 旋涡（含弱轴向流）',
    `组合涡：r < ${rc} m 为刚体旋转（ω=${omega.toFixed(4)} rad/s），r ≥ ${rc} m 环量守恒（切向速度 ${peak} m/s × rc/r）；z 方向均匀，因此任一 z 平面内都是严格闭环，用于检验闭环与静止点处理。`,
    { kind: 'rankine-vortex', center: [centreX, centreY], coreRadius: rc, angularSpeed: omega, note: 'vt=min(ωr, Γ/2πr)' },
  );
  return buildField(
    spec,
    meta,
    velocityOf,
    (p, v) => {
      const r = Math.hypot(p.x - centreX, p.y - centreY);
      const vt = r < rc ? omega * r : (peak * rc) / Math.max(r, 1e-9);
      return { speed: Math.hypot(v.x, v.y, v.z), tangential: vt, radius: r };
    },
    opts.missingPatch ?? null,
  );
}

/**
 * 3D hyperbolic stagnation flow: u = a x, v = -a y, w = c z.
 * Coordinate planes are invariant manifolds; y = 0 is the known separation surface,
 * and the origin is an exact stagnation point. Streamlines have analytic time solution
 * x = x0 e^{at}, y = y0 e^{-at}, z = z0 e^{ct}, giving independent reference checks.
 */
export function makeHyperbolicField(opts: SyntheticFieldOptions = {}): FieldPayload {
  const dims = opts.dims ?? [41, 31, 9];
  const spacing = opts.spacing ?? 0.5;
  const { a, c, z0 } = HYPERBOLIC_PARAMS;
  const spec: GridSpec = {
    origin: opts.origin ?? vec3(-10, -7.5, 0),
    spacing: vec3(spacing, spacing, spacing),
    dims,
  };
  const velocityOf = (p: Vec3) => hyperbolicVelocity(p);
  const meta = baseMeta(
    'hyperbolic',
    '双曲分离面场（解析不变量 y=0）',
    `三维双曲驻点流 u=${a}x，v=−${a}y，w=−${c}(z−${z0})。y=0 为不变的已知分离面，(0,0,${z0}) 为精确静止点；解析时间解 x=x₀e^{${a}t}，y=y₀e^{−${a}t}，z=${z0}+(z₀−${z0})e^{−${c}t}。网格内含一段可见缺测区，用于检验缺测范围与停止行为。`,
    {
      kind: 'hyperbolic',
      a,
      c,
      axis: 'y',
      note: `y=0 为解析不变量分离面；(0,0,${z0}) 为静止点`,
    },
  );
  return buildField(
    spec,
    meta,
    velocityOf,
    (_p, v) => ({ speed: Math.hypot(v.x, v.y, v.z), strainRate: a }),
    opts.missingPatch ??
      {
        // A visible instrument gap documenting missing coverage.
        x: [1.5, 4.0],
        y: [-2.5, -0.6],
        z: [0, 3],
      },
  );
}

/** High-resolution reference field for convergence comparisons. */
export function makeRefinedField(kind: 'uniform' | 'rankine-vortex' | 'hyperbolic', baseSpacing: number): FieldPayload {
  const factor = 3;
  const opts: SyntheticFieldOptions = {
    dims: undefined,
    spacing: baseSpacing / factor,
    missingPatch: null,
  };
  if (kind === 'uniform') {
    opts.dims = [121, 73, 25];
    return makeUniformField(opts);
  }
  if (kind === 'rankine-vortex') {
    opts.dims = [121, 121, 25];
    return makeRankineVortexField(opts);
  }
  opts.dims = [121, 91, 25];
  return makeHyperbolicField(opts);
}

export const SYNTHETIC_FIELD_IDS = ['uniform', 'rankine-vortex', 'hyperbolic'] as const;
export type SyntheticFieldId = (typeof SYNTHETIC_FIELD_IDS)[number];

export function makeSyntheticField(id: SyntheticFieldId): FieldPayload {
  switch (id) {
    case 'uniform':
      return makeUniformField();
    case 'rankine-vortex':
      return makeRankineVortexField();
    case 'hyperbolic':
      return makeHyperbolicField();
  }
}

/** Analytic / high-order reference trajectory for validation. */
export interface ReferenceTrajectory {
  positions: Float32Array;
  /** Arc length at each sample. */
  arc: Float32Array;
  /** Time at each sample. */
  time: Float32Array;
  note: string;
}

/**
 * Independent reference integrator: classical RK4 in time with a much smaller
 * fixed step on the analytic (continuous) velocity law, not the sampled grid.
 * This deliberately differs from the app's arc-length adaptive scheme.
 */
export function referenceTrajectory(
  velocityOf: (p: Vec3) => Vec3,
  seed: Vec3,
  opts: { direction?: 1 | -1; lengthMeters: number; stepMeters: number; maxSteps?: number } = {
    lengthMeters: 50,
    stepMeters: 0.005,
  },
): ReferenceTrajectory {
  const sign = opts.direction ?? 1;
  const maxSteps = opts.maxSteps ?? 200_000;
  const out: number[] = [];
  const arcs: number[] = [];
  const times: number[] = [];
  let p = vec3(seed.x, seed.y, seed.z);
  let s = 0;
  let t = 0;
  out.push(p.x, p.y, p.z);
  arcs.push(0);
  times.push(0);
  let step = opts.stepMeters;
  for (let i = 0; i < maxSteps && s < opts.lengthMeters; i++) {
    const v1 = velocityOf(p);
    const sp1 = Math.hypot(v1.x, v1.y, v1.z);
    if (sp1 < 1e-10) break;
    // Time-based RK4; step grows/shrinks to respect the arc-length target.
    let dt = step / sp1;
    const k1 = vec3(v1.x * sign, v1.y * sign, v1.z * sign);
    const p2 = vec3(p.x + (k1.x * dt) / 2, p.y + (k1.y * dt) / 2, p.z + (k1.z * dt) / 2);
    const v2 = velocityOf(p2);
    const k2 = vec3(v2.x * sign, v2.y * sign, v2.z * sign);
    const p3 = vec3(p.x + (k2.x * dt) / 2, p.y + (k2.y * dt) / 2, p.z + (k2.z * dt) / 2);
    const v3 = velocityOf(p3);
    const k3 = vec3(v3.x * sign, v3.y * sign, v3.z * sign);
    const p4 = vec3(p.x + k3.x * dt, p.y + k3.y * dt, p.z + k3.z * dt);
    const v4 = velocityOf(p4);
    const k4 = vec3(v4.x * sign, v4.y * sign, v4.z * sign);
    const np = vec3(
      p.x + (dt * (k1.x + 2 * k2.x + 2 * k3.x + k4.x)) / 6,
      p.y + (dt * (k1.y + 2 * k2.y + 2 * k3.y + k4.y)) / 6,
      p.z + (dt * (k1.z + 2 * k2.z + 2 * k3.z + k4.z)) / 6,
    );
    const seg = Math.hypot(np.x - p.x, np.y - p.y, np.z - p.z);
    if (!(seg > 1e-14)) break;
    s += seg;
    t += dt;
    p = np;
    out.push(p.x, p.y, p.z);
    arcs.push(s);
    times.push(t);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) break;
    // Avoid huge arrays for long trajectories at very fine steps.
    if (i > 50_000) step = Math.max(step, opts.stepMeters * 2);
  }
  return {
    positions: new Float32Array(out),
    arc: new Float32Array(arcs),
    time: new Float32Array(times),
    note: `连续解析场上的 RK4（固定 ${opts.stepMeters} m 步长）独立积分`,
  };
}

export function analyticVelocityFunction(id: SyntheticFieldId): (p: Vec3) => Vec3 {
  switch (id) {
    case 'uniform':
      return uniformVelocity;
    case 'rankine-vortex':
      return vortexVelocity;
    case 'hyperbolic':
      return hyperbolicVelocity;
  }
}
