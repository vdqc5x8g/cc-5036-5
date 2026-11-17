import { AppStore, AppState, STOP_TEXT, SeedRecord } from '../state/store';
import { IntegratorParams, STOP_LABEL_ZH } from '../core/types';
import { ColormapName, colormapCss } from '../render/colormap';
import { escapeHtml, fmt, fmtInt, fmtSci } from '../util/format';

export interface RightPanelHandlers {
  onParams: (patch: Partial<IntegratorParams>) => void;
  onColorBy: (value: string) => void;
  onColormap: (value: ColormapName) => void;
  onToggleReference: (value: boolean) => void;
  onRunValidation: () => void;
  onShowReferenceOverlay: (seedIndex: number) => void;
  onSeekSample: (seedId: string, sampleIndex: number) => void;
  onSeedVisible: (id: string, visible: boolean) => void;
  onFollowTrace: (seedId: string) => void;
}

export class RightPanel {
  private root: HTMLElement;
  private store: AppStore;
  private handlers: RightPanelHandlers;
  private lastKey = '';
  private traceCursor = new Map<string, number>();
  private followTrace = false;

  constructor(root: HTMLElement, store: AppStore, handlers: RightPanelHandlers) {
    this.root = root;
    this.store = store;
    this.handlers = handlers;
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
    this.root.addEventListener('change', this.onChange);
  }

  private onClick = (ev: MouseEvent) => {
    const el = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'run-validation') this.handlers.onRunValidation();
    if (action === 'ref-overlay') this.handlers.onShowReferenceOverlay(Number(el.dataset.seedIndex));
    if (action === 'trace-prev' || action === 'trace-next') {
      const seedId = el.dataset.seedId!;
      const seed = this.store.getState().seeds.find((s) => s.id === seedId);
      if (!seed?.result) return;
      const count = seed.result.positions.length / 3;
      if (count === 0) return;
      const current = this.traceCursor.get(seedId) ?? 0;
      const next = action === 'trace-next' ? Math.min(count - 1, current + 1) : Math.max(0, current - 1);
      const step = el.dataset.jump ? Number(el.dataset.jump) : 1;
      const finalIndex =
        el.dataset.jump === 'start' ? 0 : el.dataset.jump === 'end' ? count - 1 : action === 'trace-next' ? Math.min(count - 1, current + step) : Math.max(0, current - step);
      this.traceCursor.set(seedId, finalIndex);
      void next;
      this.handlers.onSeekSample(seedId, finalIndex);
    }
    if (action === 'follow-trace') {
      this.followTrace = !this.followTrace;
      this.handlers.onFollowTrace(el.dataset.seedId!);
      this.lastKey = '';
      this.update(this.store.getState());
    }
  };

  private onInput = (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    if (input.dataset.param) {
      const key = input.dataset.param as keyof IntegratorParams;
      const raw = input.type === 'range' ? Number(input.value) : input.value;
      let value: number | string | boolean;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.dataset.kind === 'int') value = Math.round(Number(raw));
      else value = Number(raw);
      const patch: Partial<IntegratorParams> = {};
      if (key === 'direction') patch.direction = String(value) as 'forward' | 'both';
      else (patch as Record<string, unknown>)[key] = value;
      try {
        this.handlers.onParams(patch);
      } catch (err) {
        this.store.showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    }
    if (input.dataset.colorBy !== undefined) this.handlers.onColorBy(input.value);
    if (input.dataset.colormap !== undefined) this.handlers.onColormap(input.value as ColormapName);
    if (input.type === 'range' && input.dataset.param) {
      const label = this.root.querySelector<HTMLElement>(`[data-value-for="${input.dataset.param}"]`);
      if (label) label.textContent = input.value;
    }
  };

  private onChange = (ev: Event) => {
    const input = ev.target as HTMLInputElement;
    if (input.dataset.toggle === 'reference') this.handlers.onToggleReference(input.checked);
    if (input.dataset.seedVisible && input.dataset.seedVisible !== '') {
      this.handlers.onSeedVisible(input.dataset.seedVisible, input.checked);
    }
  };

  update(state: AppState) {
    const key = this.makeKey(state);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.render(state);
  }

  private makeKey(state: AppState): string {
    const p = state.params;
    const selected = state.seeds.find((s) => s.id === state.selectedSeedId);
    const val = state.validation;
    return [
      p.stepLength,
      p.maxArcLength,
      p.maxTime,
      p.maxSteps,
      p.absTolerance,
      p.maxSubsteps,
      p.stagnationSpeed,
      p.loopTolerance,
      p.detectLoops,
      p.direction,
      state.colorBy,
      state.colormap,
      state.selectedSeedId,
      selected?.result?.stop.forward ?? '-',
      selected?.result?.stop.backward ?? '-',
      selected?.result?.seedId ?? '-',
      selected?.result?.version ?? '-',
      selected?.result?.params.stepLength ?? '-',
      selected?.result?.positions.length ?? '-',
      selected?.computing,
      selected?.visible,
      val ? `${val.ranAt}:${val.summary.passed}:${val.rows.length}` : 'noval',
      state.seeds.length,
      this.followTrace,
      [...this.traceCursor.entries()].join(','),
      state.showReference,
    ].join('|');
  }

  private render(state: AppState) {
    const p = state.params;
    const selected = state.seeds.find((s) => s.id === state.selectedSeedId) ?? null;
    const scalarOptions = ['速度', ...state.backend.scalarNames.filter((n) => n !== 'speed')];
    const scale = this.scaleFor(state);
    const unit = this.unitFor(state);

    this.root.innerHTML = `
      <div class="section">
        <div class="section-title">求值参数 <span class="kv-inline">主线程→积分线程</span></div>
        <div class="control">
          <div class="control-head">
            <span class="control-label">弧长步长 Δs</span>
            <span class="control-value" data-value-for="stepLength">${p.stepLength.toFixed(3)} m</span>
          </div>
          <input type="range" min="0.02" max="2" step="0.01" value="${p.stepLength}" data-param="stepLength" data-testid="param-stepLength" />
          <div class="control-hint">输出采样目标间距；局部转弯误差超限时自动二分细分。</div>
        </div>
        <div class="control">
          <div class="control-head">
            <span class="control-label">位置误差容差</span>
            <span class="control-value" data-value-for="absTolerance">${fmtSci(p.absTolerance)} m</span>
          </div>
          <input type="range" min="0.00001" max="0.05" step="0.00001" value="${p.absTolerance}" data-param="absTolerance" />
        </div>
        <div class="control">
          <div class="control-head">
            <span class="control-label">最大弧长</span>
            <span class="control-value" data-value-for="maxArcLength">${p.maxArcLength.toFixed(0)} m</span>
          </div>
          <input type="range" min="5" max="2000" step="5" value="${p.maxArcLength}" data-param="maxArcLength" />
        </div>
        <div class="control">
          <div class="control-head">
            <span class="control-label">最大积分时间</span>
            <span class="control-value" data-value-for="maxTime">${p.maxTime.toFixed(0)} s</span>
          </div>
          <input type="range" min="5" max="5000" step="5" value="${p.maxTime}" data-param="maxTime" />
        </div>
        <div class="number-grid">
          <div class="number-field">
            <label>最大步数</label>
            <input type="number" min="1" max="200000" step="1" value="${p.maxSteps}" data-param="maxSteps" data-kind="int" data-testid="param-maxSteps" />
          </div>
          <div class="number-field">
            <label>最大细分次数</label>
            <input type="number" min="0" max="20" step="1" value="${p.maxSubsteps}" data-param="maxSubsteps" data-kind="int" />
          </div>
          <div class="number-field">
            <label>静止阈值 (m/s)</label>
            <input type="number" min="0" step="0.00001" value="${p.stagnationSpeed}" data-param="stagnationSpeed" data-testid="param-stagnation" />
          </div>
          <div class="number-field">
            <label>闭环容差 (m)</label>
            <input type="number" min="0.0001" step="0.001" value="${p.loopTolerance}" data-param="loopTolerance" />
          </div>
        </div>
        <div class="control" style="margin-top:10px">
          <div class="control-head"><span class="control-label">积分方向</span></div>
          <select data-param="direction" data-testid="param-direction">
            <option value="both" ${p.direction === 'both' ? 'selected' : ''}>双向（向上游 + 下游）</option>
            <option value="forward" ${p.direction === 'forward' ? 'selected' : ''}>仅沿流向</option>
          </select>
        </div>
        <div class="toggle-row">
          <span>闭环检测</span>
          <label class="switch ${p.detectLoops ? 'on' : ''}">
            <input type="checkbox" data-param="detectLoops" ${p.detectLoops ? 'checked' : ''} style="display:none" />
          </label>
        </div>
        <div class="control-hint" style="margin-top:2px">
          积分在弧长参数下用 RK4 推进（dx/ds = v/|v|），时间为 ∫ds/|v|。静止、闭环、缺测、固体、越界均有显式停止条件与上限。
        </div>
      </div>

      <div class="section">
        <div class="section-title">着色</div>
        <div class="number-grid">
          <div class="number-field">
            <label>属性</label>
            <select data-color-by data-testid="color-by">
              ${scalarOptions.map((name) => `<option value="${name}" ${state.colorBy === name ? 'selected' : ''}>${name}</option>`).join('')}
            </select>
          </div>
          <div class="number-field">
            <label>色带</label>
            <select data-colormap data-testid="colormap">
              ${(['turbo', 'viridis', 'coolwarm', 'magma'] as ColormapName[])
                .map((name) => `<option value="${name}" ${state.colormap === name ? 'selected' : ''}>${name}</option>`)
                .join('')}
            </select>
          </div>
        </div>
        <div class="control-hint" style="margin-top:6px">当前范围 ${scale.min.toFixed(3)} – ${scale.max.toFixed(3)} ${unit}；每帧按真实场值 / 采样值着色，不使用固定示意颜色。</div>
      </div>

      <div class="section" data-testid="selected-section">
        <div class="section-title">所选流线追查</div>
        ${selected ? this.renderSelected(state, selected) : '<div class="section-sub" style="margin:0">在视口点击流线，或从左侧选择一个种子。</div>'}
      </div>

      <div class="section" data-testid="validation-section">
        <div class="section-title">轨迹误差校验</div>
        <div class="section-sub" style="margin-top:0">
          以解析 / 高精度独立参考对照当前参数下的轨迹。合成场专用，导入场无参考。
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <button class="btn tiny primary" data-action="run-validation" ${state.fieldKind === 'imported' ? 'disabled' : ''}>运行校验</button>
          <label class="swatch-row kv-inline"><input type="checkbox" data-toggle="reference" ${state.showReference ? 'checked' : ''}/> 叠加参考线</label>
        </div>
        ${state.validation ? this.renderValidation(state) : '<div class="section-sub">尚未运行。</div>'}
      </div>
    `;
    this.attachRangeLabels();
  }

  private renderSelected(state: AppState, seed: SeedRecord): string {
    const result = seed.result;
    if (!result) {
      return `<div class="section-sub" style="margin:0">${seed.computing ? '积分中…' : '尚无结果'}</div>`;
    }
    const cursor = Math.min(this.traceCursor.get(seed.id) ?? 0, result.positions.length / 3 - 1);
    const n = result.positions.length / 3;
    const idx = Math.max(0, cursor);
    const pos = {
      x: result.positions[3 * idx],
      y: result.positions[3 * idx + 1],
      z: result.positions[3 * idx + 2],
    };
    const vel = {
      x: result.velocities[3 * idx],
      y: result.velocities[3 * idx + 1],
      z: result.velocities[3 * idx + 2],
    };
    const scalarNames = Object.keys(result.scalars);
    const sparkColor = (value: number) => {
      const sc = this.scaleFor(state);
      return colormapCss(sc.name, sc.max > sc.min ? (value - sc.min) / (sc.max - sc.min) : 0.5);
    };
    return `
      <div class="seed-detail" data-testid="selected-detail">
        <div class="detail-row"><span class="detail-k">种子</span><span class="detail-v">${escapeHtml(seed.label)} · ${seed.position.x.toFixed(3)}, ${seed.position.y.toFixed(3)}, ${seed.position.z.toFixed(3)} m</span></div>
        <div class="detail-row"><span class="detail-k">正向停止</span><span class="detail-v">${stopLabel(result.stop.forward)} · ${result.stats.directions.forward.category}${result.stats.directions.forward.bounded ? '' : ' · 未受限'}</span></div>
        <div class="detail-row"><span class="detail-k">反向停止</span><span class="detail-v">${result.stop.backward ? `${stopLabel(result.stop.backward)} · ${result.stats.directions.backward?.category ?? ''}` : '未积分'}</span></div>
        <div class="detail-row"><span class="detail-k">采样 / 步数</span><span class="detail-v">${fmtInt(n)} / ${fmtInt(result.stats.totalSteps)}</span></div>
        <div class="detail-row"><span class="detail-k">弧长 / 时间</span><span class="detail-v">${result.stats.totalArc.toFixed(2)} m / ${result.stats.totalTime.toFixed(2)} s</span></div>
        <div class="detail-row"><span class="detail-k">步长 min/mean/max</span><span class="detail-v">${fmtSci(result.stats.minStep)} / ${result.stats.meanStep.toFixed(3)} / ${result.stats.maxStep.toFixed(3)} m</span></div>
        <div class="detail-row"><span class="detail-k">场求值次数</span><span class="detail-v">${fmtInt(result.stats.totalEvals)}</span></div>
        <div class="detail-row"><span class="detail-k">计算耗时</span><span class="detail-v">${result.computationMs.toFixed(0)} ms</span></div>
        <div class="detail-row"><span class="detail-k">本次参数</span><span class="detail-v" data-testid="used-params">Δs ${result.params.stepLength.toFixed(3)} m · 上限 ${result.params.maxSteps} 步 / ${result.params.maxArcLength.toFixed(0)} m · ${result.params.direction === 'both' ? '双向' : '单向'}</span></div>
        <div class="detail-row"><span class="detail-k">场接口版本</span><span class="detail-v" data-testid="result-protocol">v${result.fieldProtocolVersion} · ${result.fieldBackendKind}</span></div>
      </div>
      <div class="stop-note" style="font-size:10px;color:var(--text-faint);line-height:1.5;margin-top:8px;font-family:var(--mono)">
        ${escapeHtml(result.stopDetail.forward)}${result.stopDetail.backward ? '<br/>' + escapeHtml(result.stopDetail.backward) : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap">
        <button class="btn tiny" data-action="trace-prev" data-seed-id="${seed.id}" data-jump="1">−1</button>
        <button class="btn tiny" data-action="trace-prev" data-seed-id="${seed.id}" data-jump="10">−10</button>
        <span class="kv-inline">采样 ${idx + 1} / ${n}</span>
        <button class="btn tiny" data-action="trace-next" data-seed-id="${seed.id}" data-jump="10">+10</button>
        <button class="btn tiny" data-action="trace-next" data-seed-id="${seed.id}" data-jump="1">+1</button>
      </div>
      <div class="seed-detail" style="margin-top:8px">
        <div class="detail-row"><span class="detail-k">追查位置</span><span class="detail-v" data-testid="trace-position">${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)} m</span></div>
        <div class="detail-row"><span class="detail-k">该点速度</span><span class="detail-v">${vel.x.toFixed(3)}, ${vel.y.toFixed(3)}, ${vel.z.toFixed(3)} m/s</span></div>
        <div class="detail-row"><span class="detail-k">速率 / 累计弧长</span><span class="detail-v">${result.speeds[idx].toFixed(3)} m/s / ${result.arcs[idx].toFixed(2)} m</span></div>
        <div class="detail-row"><span class="detail-k">累计时间</span><span class="detail-v">${result.times[idx].toFixed(3)} s</span></div>
        ${scalarNames
          .map(
            (name) =>
              `<div class="detail-row"><span class="detail-k">${escapeHtml(name)}</span><span class="detail-v">${fmt(result.scalars[name][idx], 4)}</span></div>`,
          )
          .join('')}
      </div>
      <div class="trace-strip" style="margin-top:8px;height:22px;border-radius:5px;overflow:hidden;display:flex;border:1px solid var(--border)">
        ${Array.from({ length: 48 })
          .map((_, k) => {
            const sampleIdx = Math.min(n - 1, Math.floor((k / 47) * (n - 1)));
            return `<span style="flex:1;background:${sparkColor(result.speeds[sampleIdx])}"></span>`;
          })
          .join('')}
      </div>
      <div class="control-hint">色条为整条流线的速率剖面，用于定位追查位置。</div>
      <div class="toggle-row">
        <span>显示该流线</span>
        <label class="switch ${seed.visible ? 'on' : ''}">
          <input type="checkbox" data-seed-visible="${seed.id}" ${seed.visible ? 'checked' : ''} style="display:none" />
        </label>
      </div>
    `;
  }

  private renderValidation(state: AppState): string {
    const report = state.validation!;
    const pass = report.summary.passed;
    const rows = report.rows
      .map((row) => {
        const rowOk =
          row.maxError <= report.summary.tolerance ||
          (Number.isFinite(row.relativeError) && row.relativeError <= report.summary.relativeTolerance);
        return `
      <tr>
        <td>#${row.seedIndex + 1}</td>
        <td class="${rowOk ? 'pass' : 'fail'}">${fmtSci(row.maxError, 2)}</td>
        <td>${fmtSci(row.rmsError, 2)}</td>
        <td>${fmtSci(row.endpointError, 2)}</td>
        <td>${fmtSci(row.relativeError, 1)}</td>
        <td><button class="btn tiny" data-action="ref-overlay" data-seed-index="${row.seedIndex}">叠加</button></td>
      </tr>`;
      })
      .join('');
    return `
      <div class="validation-summary">
        <span class="stop-pill ${pass ? 'ok' : 'error'}">${pass ? '通过' : '未达标'}</span>
        <span class="kv-inline">最大偏差 ${fmtSci(report.summary.maxError, 2)} m / 容差 ${report.summary.tolerance} m（或相对 ≤ ${(report.summary.relativeTolerance * 100).toFixed(1)}%）</span>
      </div>
      <table class="metric-table" data-testid="validation-table">
        <thead><tr><th>种子</th><th>max Δ (m)</th><th>rms (m)</th><th>终点 (m)</th><th>相对</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="control-hint" style="margin-top:6px">
        ${escapeHtml(report.method)}<br/>
        ${report.rows[0] ? escapeHtml(report.rows[0].method) : ''}
      </div>
      <div class="notice ${pass ? 'info' : 'warn'}" style="margin-top:8px"><strong>校验边界：</strong>${escapeHtml(report.disclaimer)}</div>
    `;
  }

  private scaleFor(state: AppState): { min: number; max: number; name: ColormapName; label: string } {
    const backend = state.backend;
    if (state.colorBy === '速度' || state.colorBy === 'speed') {
      return { min: backend.stats.speedMin, max: backend.stats.speedMax, name: state.colormap, label: '速度' };
    }
    const range = backend.stats.scalarRanges[state.colorBy];
    return {
      min: range?.min ?? 0,
      max: range?.max ?? 1,
      name: state.colormap,
      label: state.colorBy,
    };
  }

  private unitFor(state: AppState): string {
    if (state.colorBy === '速度' || state.colorBy === 'speed') return 'm/s';
    return state.backend.meta.units.scalar?.[state.colorBy] ?? '';
  }

  private attachRangeLabels() {
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[type="range"][data-param]')) {
      const key = input.dataset.param;
      const label = this.root.querySelector<HTMLElement>(`[data-value-for="${key}"]`);
      if (!label) continue;
      input.oninput = () => {
        const value = Number(input.value);
        if (key === 'stepLength') label.textContent = `${value.toFixed(3)} m`;
        else if (key === 'absTolerance') label.textContent = `${value.toExponential(2)} m`;
        else if (key === 'maxArcLength') label.textContent = `${value.toFixed(0)} m`;
        else if (key === 'maxTime') label.textContent = `${value.toFixed(0)} s`;
        else label.textContent = input.value;
      };
    }
  }
}

function stopLabel(stop: keyof typeof STOP_LABEL_ZH): string {
  return STOP_TEXT[stop];
}
