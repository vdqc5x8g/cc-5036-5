import { AppState, SeedRecord, STOP_TEXT } from '../state/store';
import { StopReason, STOP_LABEL_ZH } from '../core/types';

export interface LeftPanelHandlers {
  onSeedSelect: (id: string) => void;
  onSeedVisibility: (id: string, visible: boolean) => void;
  onSeedDelete: (id: string) => void;
  onSeedRename: (id: string, label: string) => void;
  onClearSeeds: () => void;
  onFocusSeed: (id: string) => void;
  onToggleMissing: (value: boolean) => void;
  onToggleSolid: (value: boolean) => void;
  onRunHazards: () => void;
}

const stopClass: Record<StopReason, string> = {
  ok: 'ok',
  'seed-invalid': 'error',
  'max-steps': 'warn',
  'max-length': 'warn',
  'max-time': 'warn',
  'out-of-bounds': 'neutral',
  'missing-data': 'warn',
  solid: 'neutral',
  stagnation: 'ok',
  'closed-loop': 'ok',
  numerical: 'error',
};

export function stopPill(stop: StopReason | null | undefined): string {
  if (!stop) return '<span class="stop-pill neutral">待计算</span>';
  return `<span class="stop-pill ${stopClass[stop]}" title="${STOP_LABEL_ZH[stop]}">${STOP_LABEL_ZH[stop]}</span>`;
}

export class LeftPanel {
  private root: HTMLElement;
  private handlers: LeftPanelHandlers;
  private lastKey = '';
  private editingSeed: string | null = null;

  constructor(root: HTMLElement, handlers: LeftPanelHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('change', this.onChange);
    this.root.addEventListener('dblclick', this.onDoubleClick);
  }

  private onClick = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.seedId;
    switch (action) {
      case 'seed-select':
        if (id) this.handlers.onSeedSelect(id);
        break;
      case 'seed-toggle':
        if (id) this.handlers.onSeedVisibility(id, actionEl.dataset.visible !== 'true');
        break;
      case 'seed-delete':
        if (id) this.handlers.onSeedDelete(id);
        break;
      case 'seed-focus':
        if (id) this.handlers.onFocusSeed(id);
        break;
      case 'clear-seeds':
        this.handlers.onClearSeeds();
        break;
      case 'run-hazards':
        this.handlers.onRunHazards();
        break;
      default:
        break;
    }
  };

  private onChange = (ev: Event) => {
    const target = ev.target as HTMLInputElement;
    if (target.dataset.toggle === 'missing') this.handlers.onToggleMissing(target.checked);
    if (target.dataset.toggle === 'solid') this.handlers.onToggleSolid(target.checked);
    if (target.dataset.renameSeed) {
      const label = target.value.trim();
      if (label) this.handlers.onSeedRename(target.dataset.renameSeed, label.slice(0, 24));
      this.editingSeed = null;
    }
  };

  private onDoubleClick = (ev: MouseEvent) => {
    const nameEl = (ev.target as HTMLElement).closest('.seed-name') as HTMLElement | null;
    const item = (ev.target as HTMLElement).closest('.seed-item') as HTMLElement | null;
    if (!nameEl || !item?.dataset.seedId) return;
    this.editingSeed = item.dataset.seedId;
    this.render(this.lastState!, true);
  };

  private lastState: AppState | null = null;

  update(state: AppState) {
    this.lastState = state;
    const key = this.makeKey(state);
    if (key === this.lastKey && !this.editingSeed) return;
    this.lastKey = key;
    this.render(state, false);
  }

  private makeKey(state: AppState): string {
    const seedKey = state.seeds
      .map(
        (s) =>
          `${s.id}:${s.label}:${s.visible}:${s.computing}:${s.version}:${s.result?.stop.forward ?? '-'}:${s.result?.stop.backward ?? '-'}:${s.position.x.toFixed(3)},${s.position.y.toFixed(3)},${s.position.z.toFixed(3)}`,
      )
      .join('|');
    return [
      state.fieldPayload.meta.id,
      state.fieldEpoch,
      state.selectedSeedId,
      seedKey,
      state.showMissing,
      state.showSolid,
      state.hazards ? state.hazards.checks.map((c) => `${c.key}:${c.stop}:${c.passed}`).join(',') : 'none',
      state.status.active,
    ].join('~');
  }

  private render(state: AppState, keepEditing: boolean) {
    const meta = state.fieldPayload.meta;
    const stats = state.grid.stats;
    const ext = stats.extent;
    const missingBounds = stats.missingBounds;
    const missingText = missingBounds
      ? `x ${missingBounds.min.x.toFixed(1)}–${missingBounds.max.x.toFixed(1)}, y ${missingBounds.min.y.toFixed(1)}–${missingBounds.max.y.toFixed(1)}, z ${missingBounds.min.z.toFixed(1)}–${missingBounds.max.z.toFixed(1)} m`
      : '无';

    const seedHtml = state.seeds.length
      ? state.seeds
          .map((seed) => this.renderSeed(seed, state.selectedSeedId === seed.id, state))
          .join('')
      : `<div class="section-sub" style="margin:0">尚未放置种子。点击视口或使用下方示例按钮。</div>`;

    this.root.innerHTML = `
      <div class="section" data-testid="field-section">
        <div class="section-title">
          已采用场数据
          ${meta.synthetic ? '<span class="badge">合成 / 非实测</span>' : '<span class="badge" style="background:rgba(76,201,240,.14);color:#9fd8ef">用户导入</span>'}
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:2px" data-testid="field-name">${escapeHtml(meta.name)}</div>
        <div class="section-sub" style="margin:2px 0 8px">${escapeHtml(meta.description)}</div>
        <dl class="field-grid">
          <dt>来源</dt><dd>${escapeHtml(meta.source)}</dd>
          <dt>出处</dt><dd>${escapeHtml(meta.provenance)}</dd>
          <dt>节点 / 单元</dt><dd>${fmtInt(stats.nodeCount)} / ${fmtInt(stats.cellCount)}</dd>
          <dt>范围</dt><dd>x ${ext.min.x.toFixed(1)}–${ext.max.x.toFixed(1)}<br/>y ${ext.min.y.toFixed(1)}–${ext.max.y.toFixed(1)}<br/>z ${ext.min.z.toFixed(1)}–${ext.max.z.toFixed(1)} m</dd>
          <dt>间距 Δ</dt><dd>${stats.spacing.x.toFixed(3)} / ${stats.spacing.y.toFixed(3)} / ${stats.spacing.z.toFixed(3)} m</dd>
          <dt>速度范围</dt><dd>${stats.speedMin.toFixed(3)} – ${stats.speedMax.toFixed(3)} m/s</dd>
          <dt>时间</dt><dd>${escapeHtml(meta.timeLabel)}</dd>
          <dt>缺测单元</dt><dd>${stats.missingCellCount}（${(stats.missingCellFraction * 100).toFixed(1)}%）</dd>
        </dl>
        ${
          meta.synthetic
            ? `<div class="notice warn"><strong>数据性质：</strong>${escapeHtml(meta.disclaimer)}</div>`
            : `<div class="notice info"><strong>数据性质：</strong>${escapeHtml(meta.disclaimer)}</div>`
        }
        <div class="legend-swatches">
          <label class="swatch-row"><input type="checkbox" data-toggle="missing" ${state.showMissing ? 'checked' : ''}/> 显示缺测体元</label>
          <label class="swatch-row"><input type="checkbox" data-toggle="solid" ${state.showSolid ? 'checked' : ''}/> 显示固体体元</label>
        </div>
        <div class="section-sub" style="margin-top:8px">
          <strong style="color:#ffb27a">缺测网格范围：</strong>${escapeHtml(missingText)}<br/>
          缺测与固体单元不参与插值；积分接触即停止，绝不跨越补洞。
        </div>
      </div>

      <div class="section" data-testid="seed-section">
        <div class="section-title">
          种子与流线 <span class="kv-inline">${state.seeds.length} 个</span>
        </div>
        <div class="seed-list" id="seed-list">${seedHtml}</div>
        <div style="display:flex;gap:6px;margin-top:9px;flex-wrap:wrap">
          <button class="btn tiny" data-action="clear-seeds" ${state.seeds.length ? '' : 'disabled'}>清空种子</button>
          <button class="btn tiny" id="demo-seeds-btn">放置示例种子</button>
        </div>
      </div>

      <div class="section">
        <div class="section-title">边界情形自检</div>
        <div class="section-sub" style="margin-top:0">
          在静止点、闭环、缺测、越界处各跑一次有界积分，确认不会无界循环。
        </div>
        <button class="btn tiny" data-action="run-hazards">重新运行自检</button>
        <div class="check-list" data-testid="hazard-list">
          ${
            state.hazards
              ? state.hazards.checks
                  .map(
                    (c) => `
              <div class="check-row" data-testid="hazard-${c.key}">
                <span class="check-icon ${c.passed ? 'pass' : 'fail'}">${c.passed ? '✓' : '✕'}</span>
                <div class="check-body">
                  <div class="check-label">${escapeHtml(c.label)} · ${stopPill(c.stop)}</div>
                  <div class="check-detail">${c.steps} 步 / ${c.arc.toFixed(2)} m / ${c.elapsedMs.toFixed(0)} ms${c.matchesExpectation ? '' : ' · 与预期不同'}</div>
                </div>
              </div>`,
                  )
                  .join('')
              : '<div class="section-sub">等待自检…</div>'
          }
        </div>
      </div>
    `;
    if (keepEditing && this.editingSeed) {
      const input = this.root.querySelector<HTMLInputElement>(`input[data-rename-seed="${this.editingSeed}"]`);
      input?.focus();
      input?.select();
    }
    this.attachDemoSeeds();
  }

  private renderSeed(seed: SeedRecord, selected: boolean, _state: AppState): string {
    const bwd = seed.result ? seed.result.stop.backward : seed.lastStop?.backward ?? null;
    const pos = `${seed.position.x.toFixed(2)}, ${seed.position.y.toFixed(2)}, ${seed.position.z.toFixed(2)}`;
    const stopText = seed.result
      ? `停：${STOP_TEXT[seed.result.stop.forward]}${bwd && bwd !== seed.result.stop.forward ? ' / 反 ' + STOP_TEXT[bwd] : ''}`
      : seed.computing
        ? '积分中…'
        : seed.lastStop
          ? `停：${STOP_TEXT[seed.lastStop.forward]}`
          : '等待积分';
    return `
      <div class="seed-item ${selected ? 'selected' : ''} ${seed.visible ? '' : 'hidden-seed'}" data-seed-id="${seed.id}">
        <span class="seed-dot" style="background:${seed.color}"></span>
        <div class="seed-main" data-action="seed-select" data-seed-id="${seed.id}">
          <div class="seed-name">
            ${
              this.editingSeed === seed.id
                ? `<input type="text" data-rename-seed="${seed.id}" value="${escapeHtml(seed.label)}" maxlength="24" />`
                : escapeHtml(seed.label)
            }
            ${seed.computing ? '<span class="spinner"></span>' : ''}
          </div>
          <div class="seed-pos">${pos} m</div>
          <div class="seed-stop">${escapeHtml(stopText)}</div>
        </div>
        <div class="seed-actions">
          <button class="icon-btn" title="聚焦" data-action="seed-focus" data-seed-id="${seed.id}">◎</button>
          <button class="icon-btn" title="${seed.visible ? '隐藏' : '显示'}" data-action="seed-toggle" data-seed-id="${seed.id}" data-visible="${seed.visible}">
            ${seed.visible ? '◉' : '○'}
          </button>
          <button class="icon-btn" title="删除" data-action="seed-delete" data-seed-id="${seed.id}">×</button>
        </div>
      </div>
    `;
  }

  private attachDemoSeeds() {
    const btn = this.root.querySelector<HTMLButtonElement>('#demo-seeds-btn');
    if (!btn) return;
    btn.onclick = () => {
      const event = new CustomEvent('demo-seeds');
      this.root.dispatchEvent(event);
    };
  }
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
