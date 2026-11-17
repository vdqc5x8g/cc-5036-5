/// <reference lib="webworker" />
import { FieldPayload, VectorGrid } from '../core/grid';
import { HazardProbe, integrateStreamline, runHazardChecks } from '../core/integrator';
import { IntegratorParams, StreamlineResult, Vec3 } from '../core/types';
import { runValidation, ValidationOptions } from '../core/validation';
import { SyntheticFieldId } from '../core/synthetic';

export type WorkerRequest =
  | { type: 'init'; requestId: number; field: FieldPayload }
  | {
      type: 'integrate';
      requestId: number;
      generation: number;
      jobs: { seedId: string; seed: Vec3; params: IntegratorParams; version: number; color: string; label: string }[];
      epoch: number;
    }
  | {
      type: 'validate';
      requestId: number;
      generation: number;
      fieldKind: SyntheticFieldId;
      seeds: Vec3[];
      params: IntegratorParams;
      tolerance: number;
      epoch: number;
      includeRefinement?: boolean;
    }
  | { type: 'hazards'; requestId: number; generation: number; probes: HazardProbe[]; params: IntegratorParams };

export type WorkerResponse =
  | { type: 'ready'; requestId: number; fieldId: string; epoch: number }
  | { type: 'integrated'; requestId: number; generation: number; epoch: number; results: StreamlineResult[]; ms: number }
  | {
      type: 'validated';
      requestId: number;
      generation: number;
      epoch: number;
      report: ReturnType<typeof runValidation>;
      ms: number;
    }
  | {
      type: 'hazards';
      requestId: number;
      generation: number;
      checks: ReturnType<typeof runHazardChecks>['checks'];
      allBounded: boolean;
      ms: number;
    }
  | { type: 'error'; requestId: number; message: string };

let grid: VectorGrid | null = null;
let fieldEpoch = 0;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        grid = new VectorGrid(msg.field);
        fieldEpoch = (msg.field as FieldPayload & { epoch?: number }).epoch ?? 0;
        grid.epoch = fieldEpoch;
        const response: WorkerResponse = {
          type: 'ready',
          requestId: msg.requestId,
          fieldId: grid.meta.id,
          epoch: fieldEpoch,
        };
        ctx.postMessage(response);
        break;
      }
      case 'integrate': {
        if (!grid) throw new Error('worker 尚未载入场数据');
        if (msg.epoch !== fieldEpoch) {
          // Stale field: refuse rather than return results from the wrong grid.
          ctx.postMessage({
            type: 'error',
            requestId: msg.requestId,
            message: `场版本不匹配（请求 ${msg.epoch}，当前 ${fieldEpoch}）`,
          } satisfies WorkerResponse);
          break;
        }
        const start = performance.now();
        const results = msg.jobs.map((job) =>
          integrateStreamline(grid!, job.seed, job.params, {
            seedId: job.seedId,
            version: job.version,
            color: job.color,
            label: job.label,
          }),
        );
        ctx.postMessage({
          type: 'integrated',
          requestId: msg.requestId,
          generation: msg.generation,
          epoch: msg.epoch,
          results,
          ms: performance.now() - start,
        } satisfies WorkerResponse);
        break;
      }
      case 'validate': {
        if (!grid) throw new Error('worker 尚未载入场数据');
        if (msg.epoch !== fieldEpoch) throw new Error('场版本不匹配，拒绝校验');
        const start = performance.now();
        const options: ValidationOptions = {
          fieldKind: msg.fieldKind,
          grid,
          params: msg.params,
          seeds: msg.seeds,
          toleranceMeters: msg.tolerance,
          includeRefinement: msg.includeRefinement ?? false,
        };
        const report = runValidation(options);
        ctx.postMessage({
          type: 'validated',
          requestId: msg.requestId,
          generation: msg.generation,
          epoch: msg.epoch,
          report,
          ms: performance.now() - start,
        } satisfies WorkerResponse);
        break;
      }
      case 'hazards': {
        if (!grid) throw new Error('worker 尚未载入场数据');
        const start = performance.now();
        const { checks, allBounded } = runHazardChecks(grid, msg.params, msg.probes, { timeBudgetMs: 2500 });
        ctx.postMessage({
          type: 'hazards',
          requestId: msg.requestId,
          generation: msg.generation,
          checks,
          allBounded,
          ms: performance.now() - start,
        } satisfies WorkerResponse);
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      requestId: (msg as { requestId: number }).requestId,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
