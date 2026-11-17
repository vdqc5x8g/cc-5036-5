import { normalizeImportInput } from '../core/importAdapter';
import { createFieldBackend } from '../core/fieldFactory';
import type { FieldBackend, FieldInput } from '../core/fieldProtocol';
import {
  DEFAULT_PARAMS,
  HazardProbe,
  integrateStreamline,
  maskHazardProbes,
  runHazardChecks,
} from '../core/integrator';
import {
  HYPERBOLIC_PARAMS,
  makeSyntheticField,
  SyntheticFieldId,
  SYNTHETIC_FIELD_IDS,
  VORTEX_PARAMS,
} from '../core/synthetic';
import {
  IntegratorParams,
  IntegratorParams as Params,
  StreamlineResult,
  StopReason,
  STOP_LABEL_ZH,
  ValidationReport,
  Vec3,
  vec3,
} from '../core/types';
import { runValidation } from '../core/validation';
import { makeChunkedDemoField } from '../core/chunkedDemo';
import { ColormapName } from '../render/colormap';
import { WorkerRequest, WorkerResponse } from '../workers/integrate.worker';

export interface SeedRecord {
  id: string;
  index: number;
  position: Vec3;
  color: string;
  label: string;
  visible: boolean;
  version: number;
  result: StreamlineResult | null;
  computing: boolean;
  lastStop: { forward: StopReason; backward: StopReason | null } | null;
  createdAt: number;
}

export interface ComputeStatus {
  active: number;
  lastMs: number;
  lastCount: number;
  generation: number;
  error: string | null;
}

export interface AppState {
  /** Raw description the active backend was built from (dense, chunked or legacy). */
  fieldInput: FieldInput;
  /** Active backend (dense, chunked or legacy adapter) used by every sampler. */
  backend: FieldBackend;
  fieldEpoch: number;
  seeds: SeedRecord[];
  selectedSeedId: string | null;
  hoveredSeedId: string | null;
  params: IntegratorParams;
  colorBy: string;
  colormap: ColormapName;
  showMissing: boolean;
  showSolid: boolean;
  showReference: boolean;
  showSeeds: boolean;
  status: ComputeStatus;
  hazards: ReturnType<typeof runHazardChecks> | null;
  validation: ValidationReport | null;
  interacting: boolean;
  fieldKind: SyntheticFieldId | 'imported';
  toast: { id: number; message: string; kind: 'info' | 'warn' | 'error' } | null;
}

export type Listener = (state: AppState) => void;
export type ComputeRunner = (backend: FieldBackend) => void;

export class AppStore {
  private state: AppState;
  private listeners = new Set<Listener>();
  private worker: Worker | null = null;
  private requestSeq = 0;
  private pendingByRequest = new Map<number, { seedIds: string[]; generation: number; epoch: number }>();
  private generation = 0;
  /** Seeds whose geometry changed; only these need re-integration. */
  private dirty = new Set<string>();
  private workerBusy = false;
  private queuedSynth: (() => void) | null = null;
  private validationJob: { requestId: number; generation: number } | null = null;
  private toastSeq = 0;
  private inlineFallback = false;

  constructor(fieldInput: FieldInput) {
    this.state = this.initialState(fieldInput);
    this.startWorker();
    this.runHazardProbesSoon();
  }

  private initialState(fieldInput: FieldInput): AppState {
    const backend = createFieldBackend(fieldInput);
    const fieldKind: SyntheticFieldId | 'imported' = SYNTHETIC_FIELD_IDS.includes(
      backend.meta.id as SyntheticFieldId,
    )
      ? (backend.meta.id as SyntheticFieldId)
      : 'imported';
    return {
      fieldInput,
      backend,
      fieldEpoch: 0,
      seeds: [],
      selectedSeedId: null,
      hoveredSeedId: null,
      params: { ...DEFAULT_PARAMS },
      colorBy: '速度',
      colormap: 'turbo',
      showMissing: true,
      showSolid: true,
      showReference: false,
      showSeeds: true,
      status: { active: 0, lastMs: 0, lastCount: 0, generation: 0, error: null },
      hazards: null,
      validation: null,
      interacting: false,
      fieldKind,
      toast: null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AppState {
    return this.state;
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }

  setState(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  showToast(message: string, kind: 'info' | 'warn' | 'error' = 'info', durationMs = 3800) {
    const id = ++this.toastSeq;
    this.state = { ...this.state, toast: { id, message, kind } };
    this.emit();
    setTimeout(() => {
      if (this.state.toast?.id === id) {
        this.state = { ...this.state, toast: null };
        this.emit();
      }
    }, durationMs);
  }

  private startWorker() {
    try {
      this.worker = new Worker(new URL('../workers/integrate.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data);
      this.worker.onerror = (ev) => {
        this.onWorkerFailure(ev.message || '未知错误');
        this.inlineFallback = true;
      };
      this.postInit();
    } catch (err) {
      this.inlineFallback = true;
      this.showToast(`无法启动积分线程，改用主线程计算：${err instanceof Error ? err.message : err}`, 'warn');
    }
  }

  private postInit() {
    if (!this.worker) return;
    const requestId = ++this.requestSeq;
    this.worker.postMessage({
      type: 'init',
      requestId,
      field: this.state.fieldInput,
      epoch: this.state.fieldEpoch,
    } satisfies WorkerRequest);
  }

  private ready = false;

  private onWorkerMessage(msg: WorkerResponse) {
    switch (msg.type) {
      case 'ready': {
        this.workerBusy = false;
        this.ready = true;
        this.flushQueuedSynth();
        break;
      }
      case 'integrated': {
        this.workerBusy = false;
        this.resolveIntegration(msg);
        this.flushQueuedSynth();
        break;
      }
      case 'validated': {
        this.workerBusy = false;
        if (msg.epoch !== this.state.fieldEpoch || (this.validationJob && msg.generation !== this.validationJob.generation)) {
          break;
        }
        this.validationJob = null;
        this.setState({ validation: msg.report });
        break;
      }
      case 'hazards': {
        this.workerBusy = false;
        this.setState({
          hazards: { checks: msg.checks, allBounded: msg.allBounded },
        });
        break;
      }
      case 'error': {
        this.workerBusy = false;
        this.onWorkerFailure(msg.message);
        this.flushQueuedSynth();
        break;
      }
    }
  }

  /**
   * A failed request must never leave seeds stuck in "computing": the failure
   * is written back onto the affected seed records so streamline interaction
   * shows a terminal reason instead of spinning forever. The failure is not
   * swallowed into a default velocity or a fabricated trajectory.
   */
  private onWorkerFailure(message: string) {
    const failed = new Set(
      [...this.pendingByRequest.values()]
        .filter((p) => p.generation === this.generation)
        .flatMap((p) => p.seedIds),
    );
    this.pendingByRequest.clear();
    const seeds = failed.size
      ? this.state.seeds.map((seed) =>
          failed.has(seed.id)
            ? {
                ...seed,
                computing: false,
                lastStop: { forward: 'numerical' as StopReason, backward: null },
                result: seed.result
                  ? {
                      ...seed.result,
                      stopDetail: { ...seed.result.stopDetail, forward: `计算失败：${message}` },
                    }
                  : null,
              }
            : seed,
        )
      : this.state.seeds;
    this.setState({ seeds, status: { ...this.state.status, error: message, active: 0 } });
    this.showToast(`计算失败：${message}`, 'error');
  }

  /** Test seam: exercise the failure feedback path without killing the worker. */
  onWorkerFailureForTest(message: string): SeedRecord[] {
    const targets = this.state.seeds.filter((seed) => seed.computing);
    // If nothing is in flight, hold every seed as pending so the test exercises
    // the real write-back path rather than a no-op.
    if (targets.length === 0) {
      const ids = this.state.seeds.map((seed) => seed.id);
      const requestId = -1;
      this.pendingByRequest.set(requestId, {
        seedIds: ids,
        generation: this.generation,
        epoch: this.state.fieldEpoch,
      });
      this.state = {
        ...this.state,
        seeds: this.state.seeds.map((seed) => ({ ...seed, computing: true })),
      };
      this.onWorkerFailure(message);
      this.flushQueuedSynth();
      return this.state.seeds;
    }
    const ids = targets.map((seed) => seed.id);
    this.pendingByRequest.set(-1, { seedIds: ids, generation: this.generation, epoch: this.state.fieldEpoch });
    this.onWorkerFailure(message);
    this.flushQueuedSynth();
    return this.state.seeds;
  }

  private flushQueuedSynth() {
    const next = this.queuedSynth;
    this.queuedSynth = null;
    if (next) next();
  }

  // ---- Field management ----

  loadSyntheticField(id: SyntheticFieldId) {
    const payload = makeSyntheticField(id);
    this.replaceField(payload, id);
  }

  loadImportedField(raw: unknown) {
    // Explicit per-axis `axes` select a non-uniform dense backend; legacy
    // origin/spacing/dims files keep their adapter path.
    const input = normalizeImportInput(raw);
    this.replaceField(input, 'imported');
  }

  loadChunkedDemo() {
    this.replaceField(makeChunkedDemoField(), 'imported');
  }

  /** Load a pre-built input directly (used for the chunked demo field). */
  loadFieldInput(input: FieldInput, kind: SyntheticFieldId | 'imported' = 'imported') {
    this.replaceField(input, kind);
  }

  private replaceField(input: FieldInput, kind: SyntheticFieldId | 'imported') {
    // Bump generation first so every in-flight result is invalidated.
    this.generation++;
    const epoch = this.state.fieldEpoch + 1;
    const backend = createFieldBackend(input);
    backend.epoch = epoch;
    this.pendingByRequest.clear();
    this.validationJob = null;
    this.dirty.clear();
    this.state = {
      ...this.state,
      fieldInput: input,
      backend,
      fieldEpoch: epoch,
      fieldKind: kind,
      seeds: [],
      selectedSeedId: null,
      hazards: null,
      validation: null,
      colorBy: backend.scalarRange('speed') ? '速度' : this.state.colorBy,
      status: { ...this.state.status, active: 0, error: null, generation: this.generation },
    };
    this.emit();
    this.postInit();
    this.runHazardProbesSoon();
  }

  // ---- Seeds ----

  addSeed(position: Vec3, opts: { allowRelocate?: boolean } = {}): SeedRecord {
    const backend = this.state.backend;
    let p = position;
    if (!backend.isInsideData(p)) {
      if (!opts.allowRelocate) {
        const snapped = backend.nearestValidPoint(p);
        this.showToast(
          snapped
            ? '种子落在缺测或网格外，已吸附到最近的可用单元中心。'
            : '该位置没有可用场数据，未放置种子。',
          'warn',
        );
        if (!snapped) {
          return this.makeInvalidSeedRecord(position);
        }
        p = snapped;
      }
    }
    const index = this.state.seeds.length;
    const id = `seed-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e5).toString(36)}`;
    const record: SeedRecord = {
      id,
      index,
      position: { ...p },
      color: seedPalette(index),
      label: `S${index + 1}`,
      visible: true,
      version: 1,
      result: null,
      computing: true,
      lastStop: null,
      createdAt: Date.now(),
    };
    this.state = {
      ...this.state,
      seeds: [...this.state.seeds, record],
      selectedSeedId: id,
    };
    this.dirty.add(id);
    this.emit();
    this.scheduleCompute();
    return record;
  }

  private makeInvalidSeedRecord(position: Vec3): SeedRecord {
    const id = `seed-invalid-${Date.now().toString(36)}`;
    const record: SeedRecord = {
      id,
      index: this.state.seeds.length,
      position: { ...position },
      color: '#94a3b8',
      label: '无效种子',
      visible: false,
      version: 0,
      result: null,
      computing: false,
      lastStop: { forward: 'seed-invalid', backward: null },
      createdAt: Date.now(),
    };
    this.showToast('种子不在有效网格内，已忽略。', 'error');
    return record;
  }

  moveSeed(id: string, position: Vec3) {
    const backend = this.state.backend;
    let p = position;
    if (!backend.isInsideData(p)) {
      const snapped = backend.nearestValidPoint(p);
      if (!snapped) {
        this.showToast('拖动位置没有可用场数据，种子保持在最后一个有效位置。', 'warn');
        return;
      }
      p = snapped;
    }
    const seeds = this.state.seeds.map((seed) =>
      seed.id === id
        ? { ...seed, position: { ...p }, version: seed.version + 1, computing: true }
        : seed,
    );
    this.state = { ...this.state, seeds };
    this.dirty.add(id);
    this.emit();
    this.scheduleCompute();
  }

  setSeedVisible(id: string, visible: boolean) {
    const seeds = this.state.seeds.map((s) => (s.id === id ? { ...s, visible } : s));
    this.setState({ seeds });
  }

  setSeedLabel(id: string, label: string) {
    const seeds = this.state.seeds.map((s) => (s.id === id ? { ...s, label } : s));
    this.setState({ seeds });
  }

  selectSeed(id: string | null) {
    this.setState({ selectedSeedId: id });
  }

  removeSeed(id: string) {
    this.generation++;
    const seeds = this.state.seeds.filter((s) => s.id !== id);
    for (const [requestId, pending] of this.pendingByRequest) {
      if (pending.seedIds.includes(id)) this.pendingByRequest.delete(requestId);
    }
    this.setState({
      seeds,
      selectedSeedId: this.state.selectedSeedId === id ? null : this.state.selectedSeedId,
      status: { ...this.state.status, generation: this.generation },
    });
  }

  clearSeeds() {
    this.generation++;
    this.pendingByRequest.clear();
    this.setState({
      seeds: [],
      selectedSeedId: null,
      status: { ...this.state.status, active: 0, generation: this.generation },
    });
  }

  setInteracting(interacting: boolean) {
    if (this.state.interacting === interacting) return;
    this.state = { ...this.state, interacting };
    this.emit();
  }

  // ---- Parameters ----

  updateParams(patch: Partial<IntegratorParams>, opts: { recompute?: boolean } = {}) {
    const params = { ...this.state.params, ...patch };
    validateParams(params);
    this.state = { ...this.state, params };
    this.emit();
    if (opts.recompute !== false) {
      for (const seed of this.state.seeds) this.dirty.add(seed.id);
      this.scheduleCompute(true);
    }
  }

  setColorBy(colorBy: string) {
    this.setState({ colorBy });
  }

  setColormap(colormap: ColormapName) {
    this.setState({ colormap });
  }

  setVisibility(patch: Partial<Pick<AppState, 'showMissing' | 'showSolid' | 'showReference' | 'showSeeds'>>) {
    this.setState(patch);
  }

  // ---- Compute scheduling ----

  /** Debounced, serialised compute. Drag updates mutate seed state immediately; stale results are dropped. */
  private computeTimer: number | null = null;

  private scheduleCompute(immediate = false) {
    if (this.computeTimer !== null) {
      clearTimeout(this.computeTimer);
      this.computeTimer = null;
    }
    const delay = immediate ? 0 : this.state.interacting ? 90 : 26;
    this.computeTimer = window.setTimeout(() => {
      this.computeTimer = null;
      this.runDirty();
    }, delay);
  }

  private runDirty() {
    const ids = [...this.dirty];
    if (ids.length === 0) return;
    if (this.workerBusy) {
      // Coalesce: retry once the worker reports back.
      this.queuedSynth = () => this.runDirty();
      return;
    }
    const jobs = ids
      .map((id) => this.state.seeds.find((s) => s.id === id))
      .filter((s): s is SeedRecord => Boolean(s))
      .map((seed) => ({
        seedId: seed.id,
        seed: seed.position,
        params: this.state.params,
        version: seed.version,
        color: seed.color,
        label: seed.label,
      }));
    this.dirty.clear();
    if (jobs.length === 0) return;

    if (this.inlineFallback || !this.worker) {
      this.runDirtyInline(jobs);
      return;
    }

    const requestId = ++this.requestSeq;
    const generation = this.generation;
    this.pendingByRequest.set(requestId, {
      seedIds: jobs.map((job) => job.seedId),
      generation,
      epoch: this.state.fieldEpoch,
    });
    this.workerBusy = true;
    this.state = {
      ...this.state,
      status: { ...this.state.status, active: jobs.length, generation },
    };
    this.emit();
    this.worker.postMessage({
      type: 'integrate',
      requestId,
      generation,
      epoch: this.state.fieldEpoch,
      jobs,
    } satisfies WorkerRequest);
  }

  private runDirtyInline(jobs: { seedId: string; seed: Vec3; params: IntegratorParams; version: number; color: string; label: string }[]) {
    const generation = this.generation;
    const results = jobs.map((job) =>
      integrateStreamline(this.state.backend, job.seed, job.params, {
        seedId: job.seedId,
        version: job.version,
        color: job.color,
        label: job.label,
      }),
    );
    this.resolveIntegration({
      type: 'integrated',
      requestId: 0,
      generation,
      epoch: this.state.fieldEpoch,
      results,
      ms: 0,
    });
  }

  private resolveIntegration(msg: Extract<WorkerResponse, { type: 'integrated' }>) {
    // Reject results from an older field or generation; a drag may have produced a newer seed version.
    if (msg.epoch !== this.state.fieldEpoch || msg.generation !== this.generation) {
      return;
    }
    const bySeed = new Map(msg.results.map((r) => [r.seedId, r]));
    const seeds = this.state.seeds.map((seed) => {
      const result = bySeed.get(seed.id);
      if (!result) return seed;
      if (result.version !== seed.version) return seed; // stale version: keep current state
      return {
        ...seed,
        result,
        computing: false,
        lastStop: result.stop,
      };
    });
    this.state = {
      ...this.state,
      seeds,
      status: {
        active: 0,
        lastMs: msg.ms,
        lastCount: msg.results.length,
        generation: msg.generation,
        error: null,
      },
    };
    this.emit();
  }

  runValidationNow(seedsOverride?: Vec3[], tolerance = 0.02) {
    const seeds = seedsOverride ?? this.validationSeeds();
    if (seeds.length === 0) {
      this.showToast('没有可用于校验的种子。', 'warn');
      return;
    }
    if (this.state.fieldKind === 'imported') {
      this.showToast('导入场没有解析参考解，无法运行定量校验。', 'warn');
      return;
    }
    const generation = this.generation;
    if (this.worker && !this.inlineFallback) {
      if (this.workerBusy) {
        this.showToast('积分线程正忙，请稍后重试校验。', 'warn');
        return;
      }
      const requestId = ++this.requestSeq;
      this.validationJob = { requestId, generation };
      this.workerBusy = true;
      this.worker.postMessage({
        type: 'validate',
        requestId,
        generation,
        epoch: this.state.fieldEpoch,
        fieldKind: this.state.fieldKind,
        seeds,
        params: this.state.params,
        tolerance,
        includeRefinement: true,
      } satisfies WorkerRequest);
    } else {
      const report = runValidation({
        fieldKind: this.state.fieldKind,
        backend: this.state.backend,
        params: this.state.params,
        seeds,
        toleranceMeters: tolerance,
        includeRefinement: true,
      });
      this.setState({ validation: report });
    }
  }

  private validationSeeds(): Vec3[] {
    const backend = this.state.backend;
    const ext = backend.extent;
    const seeds: Vec3[] = [];
    const choose = (fx: number, fy: number, fz: number) =>
      vec3(
        ext.min.x + (ext.max.x - ext.min.x) * fx,
        ext.min.y + (ext.max.y - ext.min.y) * fy,
        ext.min.z + (ext.max.z - ext.min.z) * fz,
      );
    if (this.state.fieldKind === 'rankine-vortex') {
      // Avoid the exact core: a seed on the stagnation point has no trajectory to compare.
      seeds.push(choose(0.68, 0.5, 0.5), choose(0.56, 0.5, 0.5), choose(0.5, 0.72, 0.5));
    } else if (this.state.fieldKind === 'hyperbolic') {
      seeds.push(choose(0.62, 0.62, 0.5), choose(0.62, 0.5, 0.5), choose(0.38, 0.4, 0.5));
    } else {
      seeds.push(choose(0.2, 0.3, 0.4), choose(0.55, 0.5, 0.55));
    }
    return seeds;
  }

  private hazardProbes(): HazardProbe[] {
    const kind = this.state.fieldKind;
    if (kind === 'imported') return maskHazardProbes(this.state.backend);
    const { a, z0 } = HYPERBOLIC_PARAMS;
    if (kind === 'hyperbolic') {
      return [
        { key: 'stagnation', label: `静止点 (0,0,${z0})`, seed: vec3(0, 0, z0), expected: 'stagnation' },
        { key: 'separation', label: '分离面 y=0 上的线', seed: vec3(2, 0, 1.0), expected: 'out-of-bounds' },
        { key: 'missing-data', label: '缺测区种子', seed: vec3(2.5, -1.5, 1.0), expected: 'seed-invalid' },
        { key: 'out-of-bounds', label: '网格外种子', seed: vec3(-40, 0, 1), expected: 'seed-invalid' },
      ];
    }
    if (kind === 'rankine-vortex') {
      return [
        { key: 'stagnation', label: '旋涡中心静止点', seed: vec3(0, 0, 0.4), expected: 'stagnation' },
        { key: 'closed-loop', label: '中心附近闭环', seed: vec3(1.0, 0, 0.4), expected: 'closed-loop' },
        { key: 'out-of-bounds', label: '网格外种子', seed: vec3(-40, 0, 0.4), expected: 'seed-invalid' },
      ];
    }
    void a;
    return [
      { key: 'out-of-bounds', label: '网格外种子', seed: vec3(-40, 0, 1), expected: 'seed-invalid' },
      { key: 'closed-loop', label: '长直线（应受步数/弧长上限约束）', seed: vec3(1, 1, 1), expected: 'out-of-bounds' },
    ];
  }

  runHazardProbesNow() {
    if (this.inlineFallback) {
      const probes = this.hazardProbes();
      this.setState({ hazards: runHazardChecks(this.state.backend, this.state.params, probes) });
      return;
    }
    if (!this.worker || this.workerBusy) {
      this.queuedSynth = () => this.runHazardProbesNow();
      return;
    }
    const requestId = ++this.requestSeq;
    this.workerBusy = true;
    this.worker.postMessage({
      type: 'hazards',
      requestId,
      generation: this.generation,
      probes: this.hazardProbes(),
      params: this.state.params,
    } satisfies WorkerRequest);
  }

  runHazardProbesSoon() {
    window.setTimeout(() => {
      if (this.inlineFallback) this.runHazardProbesNow();
      else if (this.ready && !this.workerBusy) this.runHazardProbesNow();
      else window.setTimeout(() => this.runHazardProbesSoon(), 120);
    }, 100);
  }

  getHazardProbes(): HazardProbe[] {
    return this.hazardProbes();
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}

export function validateParams(params: Params) {
  const checks: [boolean, string][] = [
    [Number.isFinite(params.stepLength) && params.stepLength > 0, '步长必须为正数'],
    [Number.isFinite(params.maxArcLength) && params.maxArcLength > 0, '最大弧长必须为正数'],
    [Number.isFinite(params.maxTime) && params.maxTime > 0, '最大时间必须为正数'],
    [Number.isInteger(params.maxSteps) && params.maxSteps >= 1 && params.maxSteps <= 200000, '最大步数必须在 1–200000 之间'],
    [Number.isFinite(params.absTolerance) && params.absTolerance > 0, '误差容差必须为正数'],
    [Number.isInteger(params.maxSubsteps) && params.maxSubsteps >= 0 && params.maxSubsteps <= 20, '最大细分次数必须在 0–20 之间'],
    [Number.isFinite(params.stagnationSpeed) && params.stagnationSpeed >= 0, '静止阈值必须为非负数'],
    [Number.isFinite(params.loopTolerance) && params.loopTolerance > 0, '闭环容差必须为正数'],
  ];
  for (const [ok, message] of checks) {
    if (!ok) throw new Error(message);
  }
  if (params.loopTolerance > params.maxArcLength / 10) {
    throw new Error('闭环容差相对于最大弧长过大，容易误判，请减小');
  }
}

function seedPalette(index: number): string {
  const palette = ['#ffd166', '#06d6a0', '#48cae4', '#f78c6b', '#c77dff', '#90be6d', '#ff8fab'];
  return palette[index % palette.length];
}

export const STOP_TEXT = STOP_LABEL_ZH;

export { VORTEX_PARAMS };
