export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : vec3();
}

export function isFiniteVec(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

export type Direction = 'forward' | 'both';

export type StopReason =
  | 'ok'
  | 'seed-invalid'
  | 'max-steps'
  | 'max-length'
  | 'max-time'
  | 'out-of-bounds'
  | 'missing-data'
  | 'solid'
  | 'stagnation'
  | 'closed-loop'
  | 'numerical';

export const STOP_LABEL_ZH: Record<StopReason, string> = {
  ok: '正常',
  'seed-invalid': '种子不可用',
  'max-steps': '达到最大步数',
  'max-length': '达到最大弧长',
  'max-time': '达到最大积分时间',
  'out-of-bounds': '离开网格范围',
  'missing-data': '进入缺测单元',
  solid: '接触固体/分离面',
  stagnation: '接近静止点',
  'closed-loop': '检测到闭环',
  numerical: '数值异常',
};

export type SampleReason = 'ok' | 'out-of-bounds' | 'missing-data' | 'solid';

export interface IntegratorParams {
  /** Requested output arc-length spacing, metres. */
  stepLength: number;
  /** Maximum integrated arc length per direction, metres. */
  maxArcLength: number;
  /** Maximum integrated time per direction, seconds. */
  maxTime: number;
  /** Maximum accepted output steps per direction. */
  maxSteps: number;
  /** Local position error tolerance for adaptive RK4, metres. */
  absTolerance: number;
  /** Maximum number of halvings for one output step. */
  maxSubsteps: number;
  /** Speed below which a trajectory is considered stalled, m/s. */
  stagnationSpeed: number;
  /** Spatial tolerance for loop closure detection, metres. */
  loopTolerance: number;
  /** Disable loop detection (still bounded by other limits). */
  detectLoops: boolean;
  direction: Direction;
}

export interface Sample {
  p: Vec3;
  v: Vec3;
  speed: number;
  t: number;
  s: number;
  scalars: Record<string, number>;
}

export interface IntegrationDirectionResult {
  samples: Sample[];
  stop: StopReason;
  stopDetail: string;
  steps: number;
  evals: number;
  substepCount: number;
  substepLimitHits: number;
  minStep: number;
  maxStep: number;
  time: number;
  arc: number;
}

export interface IntegrationStats {
  directions: { forward: IntegrationDirectionResult; backward: IntegrationDirectionResult | null };
  totalSamples: number;
  totalSteps: number;
  totalEvals: number;
  totalTime: number;
  totalArc: number;
  minStep: number;
  maxStep: number;
  meanStep: number;
}

export interface StreamlineResult {
  seedId: string;
  version: number;
  fieldEpoch: number;
  fieldId: string;
  seed: Vec3;
  positions: Float32Array;
  velocities: Float32Array;
  speeds: Float32Array;
  times: Float32Array;
  arcs: Float32Array;
  scalars: Record<string, Float32Array>;
  stop: { forward: StopReason; backward: StopReason | null };
  stopDetail: { forward: string; backward: string | null };
  stats: IntegrationStats;
  params: IntegratorParams;
  color: string;
  label: string;
  computationMs: number;
}

export interface HazardCheck {
  key: string;
  label: string;
  seed: Vec3;
  expected: StopReason;
  stop: StopReason;
  bounded: boolean;
  passed: boolean;
  detail: string;
  steps: number;
  arc: number;
  time: number;
  elapsedMs: number;
}

export interface ReferencePath {
  seedIndex: number;
  label: string;
  positions: Float32Array;
}

export interface ValidationMetric {
  label: string;
  value: number;
  unit: string;
  ok?: boolean;
}

export interface ValidationRow {
  seedIndex: number;
  seed: Vec3;
  sampleCount: number;
  maxError: number;
  rmsError: number;
  endpointError: number;
  relativeError: number;
  pathLength: number;
  method: string;
  note: string;
  metrics: ValidationMetric[];
  /** Thinned reference polyline (world metres) for optional overlay. */
  referencePoints?: Float32Array;
}

export interface ValidationReport {
  fieldId: string;
  fieldName: string;
  ranAt: string;
  method: string;
  params: IntegratorParams;
  rows: ValidationRow[];
  summary: {
    maxError: number;
    meanRelativeError: number;
    passed: boolean;
    tolerance: number;
    relativeTolerance: number;
  };
  disclaimer: string;
}
