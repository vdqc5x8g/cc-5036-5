import './styles.css';
import { AppStore, AppState, SeedRecord } from './state/store';
import { Viewer } from './render/viewer';
import { CandidateLine, pickCandidates, PickHit } from './render/picking';
import { ColorScale, gradientCss } from './render/colormap';
import { seedColor } from './render/scene';
import { LeftPanel } from './ui/leftPanel';
import { RightPanel } from './ui/rightPanel';
import { Vec3, vec3 } from './core/types';
import { makeSyntheticField, SYNTHETIC_FIELD_IDS, SyntheticFieldId } from './core/synthetic';
import { escapeHtml, fmt, fmtSci } from './util/format';

const FIELD_LABELS: Record<SyntheticFieldId, string> = {
  uniform: '匀速参考流',
  'rankine-vortex': 'Rankine 旋涡',
  hyperbolic: '双曲分离面',
};

interface UIrefs {
  viewport: HTMLElement;
  fieldSwitch: HTMLElement;
  leftPanel: HTMLElement;
  rightPanel: HTMLElement;
  computeHud: HTMLElement;
  cameraHud: HTMLElement;
  legend: HTMLElement;
  hint: HTMLElement;
  emptyHint: HTMLElement;
  tooltip: HTMLElement;
  candidatePopup: HTMLElement;
  toast: HTMLElement;
  importBtn: HTMLButtonElement;
  importInput: HTMLInputElement;
  recenterBtn: HTMLButtonElement;
}

function refs(): UIrefs {
  const el = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少 #${id}`);
    return node as T;
  };
  return {
    viewport: el('viewport'),
    fieldSwitch: el('field-switch'),
    leftPanel: el('left-panel'),
    rightPanel: el('right-panel'),
    computeHud: el('compute-hud'),
    cameraHud: el('camera-hud'),
    legend: el('legend'),
    hint: el('viewport-hint'),
    emptyHint: el('empty-hint'),
    tooltip: el('tooltip'),
    candidatePopup: el('candidate-popup'),
    toast: el('toast'),
    importBtn: el<HTMLButtonElement>('import-btn'),
    importInput: el<HTMLInputElement>('import-input'),
    recenterBtn: el<HTMLButtonElement>('recenter-btn'),
  };
}

class FlowApp {
  private ui = refs();
  private store: AppStore;
  private viewer: Viewer;
  private left: LeftPanel;
  private right: RightPanel;
  private placementZ = 0;
  private dragging: { seedId: string; pointerId: number; moved: boolean; offset: Vec3 } | null = null;
  private candidates: PickHit[] = [];
  private traceMarker = new Map<string, number>();
  private followTraceId: string | null = null;
  private rafPending = false;
  private lastHudKey = '';

  constructor() {
    const initial = makeSyntheticField('uniform');
    this.store = new AppStore(initial);
    this.viewer = new Viewer({
      container: this.ui.viewport,
      onHover: () => undefined,
    });
    this.left = new LeftPanel(this.ui.leftPanel, {
      onSeedSelect: (id) => this.store.selectSeed(id),
      onSeedVisibility: (id, visible) => {
        this.store.setSeedVisible(id, visible);
      },
      onSeedDelete: (id) => this.store.removeSeed(id),
      onSeedRename: (id, label) => this.store.setSeedLabel(id, label),
      onClearSeeds: () => this.store.clearSeeds(),
      onFocusSeed: (id) => this.focusSeed(id),
      onToggleMissing: (v) => this.store.setVisibility({ showMissing: v }),
      onToggleSolid: (v) => this.store.setVisibility({ showSolid: v }),
      onRunHazards: () => this.store.runHazardProbesNow(),
    });
    this.ui.leftPanel.addEventListener('demo-seeds', () => this.placeDemoSeeds());
    this.right = new RightPanel(this.ui.rightPanel, this.store, {
      onParams: (patch) => this.store.updateParams(patch),
      onColorBy: (value) => this.store.setColorBy(value),
      onColormap: (value) => this.store.setColormap(value),
      onToggleReference: (value) => {
        this.store.setVisibility({ showReference: value });
        if (!value) this.viewer.clearReferenceOverlay();
        else this.renderReferenceOverlays();
      },
      onRunValidation: () => this.store.runValidationNow(),
      onShowReferenceOverlay: (seedIndex) => this.showReferenceOverlay(seedIndex),
      onSeekSample: (seedId, index) => {
        this.traceMarker.set(seedId, index);
        this.store.selectSeed(seedId);
        this.syncTraceMarker();
      },
      onSeedVisible: (id, visible) => this.store.setSeedVisible(id, visible),
      onFollowTrace: (seedId) => {
        this.followTraceId = this.followTraceId === seedId ? null : seedId;
        this.syncTraceMarker();
      },
    });

    this.buildFieldSwitch();
    this.bindViewport();
    this.bindTopbar();
    this.store.subscribe((state) => this.onState(state));
    this.onState(this.store.getState());
    this.ui.viewport.style.cursor = 'crosshair';
  }

  private buildFieldSwitch() {
    this.ui.fieldSwitch.innerHTML = SYNTHETIC_FIELD_IDS.map(
      (id) =>
        `<button class="field-chip synthetic-badge" data-field="${id}" type="button">${FIELD_LABELS[id]}</button>`,
    ).join('');
    this.ui.fieldSwitch.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-field]');
      if (!btn?.dataset.field) return;
      const id = btn.dataset.field as SyntheticFieldId;
      this.store.loadSyntheticField(id);
      this.placementZ = this.defaultPlacementZ();
      this.viewer.setPlacementPlane(this.placementZ, this.store.getState().grid.extent);
      this.syncPlacementPlane();
    });
  }

  private bindTopbar() {
    this.ui.importBtn.addEventListener('click', () => this.ui.importInput.click());
    this.ui.importInput.addEventListener('change', async () => {
      const file = this.ui.importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        this.store.loadImportedField(json);
        this.placementZ = this.defaultPlacementZ();
        this.viewer.setPlacementPlane(this.placementZ, this.store.getState().grid.extent);
        this.store.showToast(`已载入 ${file.name}：按给定网格值插值与积分，未做水动力实测校核。`, 'info', 5200);
      } catch (err) {
        this.store.showToast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
      } finally {
        this.ui.importInput.value = '';
      }
    });
    this.ui.recenterBtn.addEventListener('click', () => {
      this.viewer.frameCamera(this.store.getState().grid);
      this.viewer.requestRender();
    });
  }

  private defaultPlacementZ(): number {
    const ext = this.store.getState().grid.extent;
    return (ext.min.z + ext.max.z) * 0.5;
  }

  // ---------- viewport interaction ----------

  private pointerToCanvas(ev: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.viewer.handles.renderer.domElement.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private bindViewport() {
    const canvas = this.viewer.handles.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', () => {
      this.ui.tooltip.hidden = true;
      this.viewer.setHoverDot(null);
    });
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('pointerup', () => {
      if (this.dragging) this.endDrag();
    });
  }

  /** Picking entry point shared by pointer handling and automated checks. */
  pickAtScreen(x: number, y: number): PickHit[] {
    return this.pickAt({ x, y });
  }

  private pickAt(pointer: { x: number; y: number }): PickHit[] {
    const lines = this.buildCandidateLines();
    const project = (p: Vec3) => this.viewer.project(p);
    const rayDir = (x: number, y: number) => this.viewer.rayDirection(x, y);
    const eye = this.viewer.cameraEye();
    const pixelTolerance = 7;
    return pickCandidates(lines, pointer, project, rayDir, eye, {
      pixelTolerance,
      depthBias: 0.05,
    });
  }

  private buildCandidateLines(): CandidateLine[] {
    const state = this.store.getState();
    const lines: CandidateLine[] = [];
    // Build from state, not from the renderer, so picking is never a frame behind a
    // freshly integrated result and visibility is the single source of truth.
    for (const seed of state.seeds) {
      if (!seed.visible || !seed.result || seed.result.positions.length < 6) continue;
      const result = seed.result;
      let scalars: Float32Array | undefined = result.scalars[state.colorBy] ?? result.speeds;
      lines.push({
        id: seed.id,
        label: seed.label,
        kind: 'streamline',
        positions: result.positions,
        scalars,
        visible: seed.visible,
        priority: seed.id === state.selectedSeedId ? 1 : 0,
      });
    }
    return lines;
  }

  private onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    const pointer = this.pointerToCanvas(ev);
    const candidates = this.pickAt(pointer);

    // Prefer hitting an existing seed handle for dragging.
    const seedHit = this.pickSeedHandle(pointer);
    if (seedHit) {
      this.dragging = { seedId: seedHit.id, pointerId: ev.pointerId, moved: false, offset: vec3() };
      this.viewer.handles.controls.enabled = false;
      this.viewer.setSeedDragging(seedHit.id, true);
      this.store.selectSeed(seedHit.id);
      this.store.setInteracting(true);
      (this.viewer.handles.renderer.domElement as HTMLCanvasElement).setPointerCapture(ev.pointerId);
      return;
    }

    if (candidates.length > 0) {
      // Overlap: offer an explicit chooser rather than silently taking the closest.
      if (candidates.length > 1) {
        this.showCandidates(pointer, candidates);
      } else {
        this.store.selectSeed(candidates[0].id);
        this.traceMarker.set(candidates[0].id, candidates[0].sampleIndex);
        this.syncTraceMarker();
      }
      return;
    }

    // Click on empty space: place a new seed on the placement plane.
    const planePoint = this.viewer.screenToPlane(pointer.x, pointer.y, this.placementZ);
    if (!planePoint) return;
    this.store.addSeed(planePoint);
  };

  private onPointerMove = (ev: PointerEvent) => {
    const pointer = this.pointerToCanvas(ev);

    if (this.dragging) {
      const seed = this.store.getState().seeds.find((s) => s.id === this.dragging!.seedId);
      if (!seed) return;
      const plane = this.viewer.screenToPlane(pointer.x, pointer.y, seed.position.z);
      if (!plane) return;
      const next = vec3(plane.x, plane.y, seed.position.z);
      this.dragging.moved = true;
      this.store.moveSeed(seed.id, next);
      this.syncSeedHandles();
      return;
    }

    // Seed handle hover takes precedence for cursor affordance.
    const seedHit = this.pickSeedHandle(pointer);
    const canvas = this.viewer.handles.renderer.domElement;
    if (seedHit) {
      canvas.style.cursor = 'grab';
      this.ui.tooltip.hidden = true;
      this.viewer.setHoverDot(null);
      return;
    }

    const hits = this.pickAt(pointer);
    if (hits.length === 0) {
      canvas.style.cursor = 'crosshair';
      this.ui.tooltip.hidden = true;
      this.viewer.setHoverDot(null);
      return;
    }
    canvas.style.cursor = hits.length > 1 ? 'copy' : 'pointer';
    this.viewer.setHoverDot(hits[0].position);
    this.showTooltip(pointer, hits);
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (!this.dragging) return;
    const wasMoved = this.dragging.moved;
    this.endDrag();
    if (!wasMoved) {
      // A click without movement should not move the seed; select it.
      this.store.selectSeed(this.dragging?.seedId ?? null);
    }
    void ev;
  };

  private endDrag() {
    if (!this.dragging) return;
    const id = this.dragging.seedId;
    this.viewer.setSeedDragging(id, false);
    this.viewer.handles.controls.enabled = true;
    this.dragging = null;
    this.store.setInteracting(false);
    // Force one final integration at the released position.
    this.store.moveSeed(id, this.store.getState().seeds.find((s) => s.id === id)!.position);
  }

  private pickSeedHandle(pointer: { x: number; y: number }): SeedRecord | null {
    const state = this.store.getState();
    let best: { seed: SeedRecord; dist: number } | null = null;
    for (const seed of state.seeds) {
      if (!seed.visible) continue;
      const proj = this.viewer.project(seed.position);
      if (!proj.visible) continue;
      const d = Math.hypot(proj.x - pointer.x, proj.y - pointer.y);
      const pxRadius = 12;
      if (d <= pxRadius && (!best || d < best.dist)) best = { seed, dist: d };
    }
    return best?.seed ?? null;
  }

  private showCandidates(pointer: { x: number; y: number }, candidates: PickHit[]) {
    this.candidates = candidates;
    const popup = this.ui.candidatePopup;
    popup.innerHTML = `
      <div class="candidate-title">重叠候选 · 屏幕距离 / 空间深度</div>
      ${candidates
        .map((hit, index) => {
          const seed = this.store.getState().seeds.find((s) => s.id === hit.id);
          return `<button class="candidate-item" data-candidate="${index}">
            <span class="swatch" style="background:${seed?.color ?? '#888'}"></span>
            <span>${escapeHtml(hit.label)}</span>
            <span class="candidate-meta">${hit.screenDistance.toFixed(1)} px<br/>${hit.rayDepth.toFixed(2)} m 深</span>
          </button>`;
        })
        .join('')}
    `;
    popup.hidden = false;
    const rect = this.viewer.handles.renderer.domElement.getBoundingClientRect();
    popup.style.left = `${Math.min(pointer.x + 14, rect.width - 250)}px`;
    popup.style.top = `${Math.min(pointer.y + 10, rect.height - 40 - candidates.length * 34)}px`;
    popup.onclick = (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-candidate]');
      if (!btn) return;
      const hit = this.candidates[Number(btn.dataset.candidate)];
      if (!hit) return;
      this.store.selectSeed(hit.id);
      this.traceMarker.set(hit.id, hit.sampleIndex);
      this.syncTraceMarker();
      popup.hidden = true;
    };
  }

  private showTooltip(pointer: { x: number; y: number }, hits: PickHit[]) {
    const hit = hits[0];
    const seed = this.store.getState().seeds.find((s) => s.id === hit.id);
    if (!seed) return;
    const state = this.store.getState();
    const scale = this.colorScale(state);
    const value = hit.scalar ?? 0;
    const tip = this.ui.tooltip;
    tip.innerHTML = `
      <div class="tip-head"><span class="tip-swatch" style="background:${seed.color}"></span>${escapeHtml(seed.label)}${
        hits.length > 1 ? ` <span class="tip-k">+${hits.length - 1} 个候选</span>` : ''
      }</div>
      <div><span class="tip-k">位置</span> <span class="tip-v">${hit.position.x.toFixed(2)}, ${hit.position.y.toFixed(2)}, ${hit.position.z.toFixed(2)} m</span></div>
      <div><span class="tip-k">${escapeHtml(state.colorBy)}</span> <span class="tip-v">${fmt(value, 3)} ${escapeHtml(scale.unit)}</span></div>
      <div><span class="tip-k">屏幕距</span> <span class="tip-v">${hit.screenDistance.toFixed(1)} px</span> · <span class="tip-k">射线距</span> <span class="tip-v">${Number.isFinite(hit.worldDistance) ? hit.worldDistance.toFixed(3) + ' m' : '—'}</span></div>
      <div class="tip-note">拾取按像素阈值；空间距为视射线到线段的真实最短距离，二者分别记录。</div>
    `;
    tip.hidden = false;
    const rect = this.viewer.handles.renderer.domElement.getBoundingClientRect();
    const w = tip.offsetWidth || 260;
    const h = tip.offsetHeight || 100;
    tip.style.left = `${Math.min(pointer.x + 16, rect.width - w - 8)}px`;
    tip.style.top = `${Math.min(pointer.y + 16, rect.height - h - 8)}px`;
  }

  private onKeyDown = (ev: KeyboardEvent) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const state = this.store.getState();
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (state.selectedSeedId) {
        this.store.removeSeed(state.selectedSeedId);
        ev.preventDefault();
      }
    }
    if (ev.key === 'Escape') {
      this.ui.candidatePopup.hidden = true;
      if (this.dragging) this.endDrag();
      else this.store.selectSeed(null);
    }
    if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
      const idx = Number(ev.key) - 1;
      const id = SYNTHETIC_FIELD_IDS[idx];
      if (id) {
        this.store.loadSyntheticField(id);
        this.syncPlacementPlane();
      }
    }
  };

  // ---------- state → view ----------

  private onState(state: AppState) {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.sync(state);
    });
  }

  private sync(state: AppState) {
    this.syncFieldChips(state);
    this.syncViewer(state);
    this.syncSeedHandles();
    this.syncHud(state);
    this.syncLegend(state);
    this.syncToast(state);
    this.left.update(state);
    this.right.update(state);
    this.ui.emptyHint.style.opacity = state.seeds.length ? '0' : '1';
    this.syncPlacementPlane(state);
    this.syncTraceMarker();
    if (state.showReference) this.renderReferenceOverlays();
  }

  private syncFieldChips(state: AppState) {
    for (const chip of this.ui.fieldSwitch.querySelectorAll<HTMLElement>('[data-field]')) {
      chip.classList.toggle('active', chip.dataset.field === state.fieldKind);
    }
  }

  private lastFieldEpoch = -1;

  private syncViewer(state: AppState) {
    if (state.fieldEpoch !== this.lastFieldEpoch) {
      this.lastFieldEpoch = state.fieldEpoch;
      this.viewer.setField(state.grid);
      this.placementZ = this.defaultPlacementZ();
      this.viewer.setPlacementPlane(this.placementZ, state.grid.extent);
    }
    // Remove visuals whose seeds disappeared.
    const seedIds = new Set(state.seeds.map((s) => s.id));
    for (const visual of this.viewer.getStreamlineVisuals()) {
      if (!seedIds.has(visual.id)) this.viewer.removeStreamline(visual.id);
    }
    const scale = this.colorScale(state);
    for (const seed of state.seeds) {
      const visual = this.viewer.getStreamlineVisuals().find((v) => v.id === seed.id);
      const ready = seed.result && seed.result.positions.length >= 6;
      if (!ready) {
        if (visual) this.viewer.removeStreamline(seed.id);
        continue;
      }
      if (!visual) {
        const created = this.viewer.addStreamline(seed.result!, {
          label: seed.label,
          seedIndex: seed.index,
          scale,
          visible: seed.visible,
          selected: state.selectedSeedId === seed.id,
          color: seed.color || seedColor(seed.index),
        });
        created.line.visible = seed.visible;
      } else {
        // Rebuild geometry when the result object changed (version or new integration).
        if (visual.result !== seed.result) {
          this.viewer.removeStreamline(seed.id);
          const created = this.viewer.addStreamline(seed.result!, {
            label: seed.label,
            seedIndex: seed.index,
            scale,
            visible: seed.visible,
            selected: state.selectedSeedId === seed.id,
            color: seed.color,
          });
          created.line.visible = seed.visible;
        } else {
          this.viewer.setStreamlineVisible(seed.id, seed.visible);
          visual.label = seed.label;
        }
      }
    }
    this.viewer.setStreamlineSelected(state.selectedSeedId);
    this.viewer.recolorStreamlines(scale);
    this.viewer.handles.fieldGroup.visible = true;
    this.applyMaskVisibility(state);
    this.viewer.requestRender();
  }

  private applyMaskVisibility(state: AppState) {
    this.viewer.handles.fieldGroup.traverse((obj) => {
      const kind = obj.userData?.maskKind;
      if (kind === 'missing') obj.visible = state.showMissing;
      if (kind === 'solid') obj.visible = state.showSolid;
    });
  }

  private syncSeedHandles() {
    const state = this.store.getState();
    const present = new Set<string>();
    for (const seed of state.seeds) {
      if (!seed.visible) {
        this.viewer.removeSeedHandle(seed.id);
        continue;
      }
      present.add(seed.id);
      this.viewer.showSeedHandle(seed.id, seed.position, seed.color, seed.index);
    }
    for (const group of [...this.viewer.handles.seedGroup.children]) {
      const id = group.userData?.seedId as string | undefined;
      if (id && !present.has(id)) this.viewer.removeSeedHandle(id);
    }
  }

  private colorScale(state: AppState): ColorScale {
    if (state.colorBy === '速度' || state.colorBy === 'speed') {
      return {
        min: state.grid.stats.speedMin,
        max: state.grid.stats.speedMax,
        name: state.colormap,
        label: '速度',
        unit: 'm/s',
      };
    }
    const range = state.grid.stats.scalarRanges[state.colorBy];
    return {
      min: range?.min ?? 0,
      max: range?.max ?? 1,
      name: state.colormap,
      label: state.colorBy,
      unit: state.fieldPayload.meta.units.scalar?.[state.colorBy] ?? '',
    };
  }

  private syncHud(state: AppState) {
    const scale = this.colorScale(state);
    const status = state.status;
    const selected = state.seeds.find((s) => s.id === state.selectedSeedId);
    const key = `${state.fieldEpoch}|${state.fieldPayload.meta.name}|${state.colorBy}|${state.colormap}|${status.active}|${status.lastMs}|${status.lastCount}|${selected?.id}|${state.seeds.length}|${state.params.stepLength}|${state.params.maxSteps}|${state.interacting}`;
    if (key === this.lastHudKey) {
      this.syncCameraHud();
      return;
    }
    this.lastHudKey = key;
    const p = state.params;
    this.ui.computeHud.innerHTML = `
      <div class="hud-row"><span class="hud-key">场</span><span class="hud-val">${escapeHtml(state.fieldPayload.meta.name)}</span></div>
      <div class="hud-row"><span class="hud-key">种子 / 流线</span><span class="hud-val">${state.seeds.length} / ${state.seeds.filter((s) => s.result).length}</span></div>
      <div class="hud-row"><span class="hud-key">步长 Δs / 最大步数</span><span class="hud-val">${p.stepLength.toFixed(3)} m / ${p.maxSteps}</span></div>
      <div class="hud-row"><span class="hud-key">容差 / 方向</span><span class="hud-val">${fmtSci(p.absTolerance, 1)} m / ${p.direction === 'both' ? '双向' : '单向'}</span></div>
      <div class="hud-row"><span class="hud-key">最近积分</span><span class="hud-val">${status.active ? `计算中 ${status.active}` : status.lastMs ? `${status.lastMs.toFixed(0)} ms · ${status.lastCount} 条` : '—'}</span></div>
      <div class="hud-row"><span class="hud-key">${escapeHtml(scale.label)}范围</span><span class="hud-val">${scale.min.toFixed(3)} – ${scale.max.toFixed(3)} ${escapeHtml(scale.unit)}</span></div>
      ${state.interacting ? '<div class="hud-row"><span class="hud-key">状态</span><span class="hud-val" style="color:#f4a261">拖动中 · 结果按种子版本过滤</span></div>' : ''}
    `;
    this.syncCameraHud();
  }

  private syncCameraHud() {
    const camera = this.viewer.handles.camera;
    const target = this.viewer.handles.controls.target;
    const dist = camera.position.distanceTo(target);
    this.ui.cameraHud.innerHTML = `
      <div class="hud-row"><span class="hud-key">视图</span><span class="hud-val">透视 · 米</span></div>
      <div class="hud-row"><span class="hud-val">距离 ${dist.toFixed(1)} m</span></div>
      <div class="hud-row"><span class="hud-val">左键放置/拖动 · 右键旋转 · 滚轮缩放</span></div>
      <div class="hud-row"><span class="hud-val">放置平面 z=${this.placementZ.toFixed(2)} m</span></div>
    `;
    this.ui.hint.innerHTML = `光标悬停读值 · 点击线可追查<br/>Delete 删除所选种子 · Esc 取消选择`;
  }

  private syncLegend(state: AppState) {
    const scale = this.colorScale(state);
    this.ui.legend.innerHTML = `
      <div class="legend-title"><span>${escapeHtml(scale.label)}</span><span>${escapeHtml(scale.unit)}</span></div>
      <div class="legend-gradient" style="background:${gradientCss(scale.name)}"></div>
      <div class="legend-ticks"><span>${scale.min.toFixed(3)}</span><span>${((scale.min + scale.max) / 2).toFixed(3)}</span><span>${scale.max.toFixed(3)}</span></div>
      <div class="legend-note">颜色取自网格插值/采样后的真实场值；灰色为缺测，不会当作零速度。</div>
    `;
  }

  private syncPlacementPlane(state?: AppState) {
    const s = state ?? this.store.getState();
    this.viewer.setPlacementPlane(this.placementZ, s.grid.extent);
  }

  private syncTraceMarker() {
    const state = this.store.getState();
    const id = this.followTraceId ?? state.selectedSeedId;
    if (!id) {
      this.viewer.setHighlight(null);
      return;
    }
    const seed = state.seeds.find((s) => s.id === id);
    if (!seed?.result) {
      this.viewer.setHighlight(null);
      return;
    }
    const cursor = this.traceMarker.get(id);
    if (cursor === undefined) {
      this.viewer.setHighlight(null);
      return;
    }
    const n = seed.result.positions.length / 3;
    const idx = Math.max(0, Math.min(n - 1, cursor));
    const p = vec3(
      seed.result.positions[3 * idx],
      seed.result.positions[3 * idx + 1],
      seed.result.positions[3 * idx + 2],
    );
    this.viewer.setHighlight(p, 0xffffff);
  }

  private syncToast(state: AppState) {
    const toast = this.ui.toast;
    if (!state.toast) {
      toast.hidden = true;
      return;
    }
    toast.hidden = false;
    toast.className = `toast ${state.toast.kind}`;
    toast.textContent = state.toast.message;
  }

  private renderReferenceOverlays() {
    const state = this.store.getState();
    this.viewer.clearReferenceOverlay();
    if (!state.showReference || !state.validation) return;
    for (const row of state.validation.rows) {
      if (!row.referencePoints) continue;
      const seed = state.seeds[row.seedIndex];
      this.viewer.addReferenceOverlay(row.referencePoints, seed ? 0xf2f2f2 : 0xffffff);
    }
  }

  private showReferenceOverlay(seedIndex: number) {
    const state = this.store.getState();
    const row = state.validation?.rows.find((r) => r.seedIndex === seedIndex);
    if (!row?.referencePoints) {
      this.store.showToast('该行没有参考轨迹（可能未产生有效轨迹）。', 'warn');
      return;
    }
    this.viewer.clearReferenceOverlay();
    this.viewer.addReferenceOverlay(row.referencePoints, 0xffffff);
    this.store.setVisibility({ showReference: true });
  }

  private focusSeed(id: string) {
    const state = this.store.getState();
    const seed = state.seeds.find((s) => s.id === id);
    if (!seed) return;
    this.store.selectSeed(id);
    const controls = this.viewer.handles.controls;
    const camera = this.viewer.handles.camera;
    const offset = camera.position.clone().sub(controls.target);
    const len = offset.length();
    controls.target.set(seed.position.x, seed.position.z, -seed.position.y);
    offset.setLength(Math.min(len, 14));
    camera.position.copy(controls.target.clone().add(offset));
    controls.update();
    this.viewer.requestRender();
  }

  private placeDemoSeeds() {
    const state = this.store.getState();
    const ext = state.grid.extent;
    const midZ = (ext.min.z + ext.max.z) / 2;
    const candidates: Vec3[] = [];
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const kind = state.fieldKind;
    if (kind === 'rankine-vortex') {
      candidates.push(
        vec3(lerp(ext.min.x, ext.max.x, 0.78), lerp(ext.min.y, ext.max.y, 0.5), midZ),
        vec3(lerp(ext.min.x, ext.max.x, 0.5), lerp(ext.min.y, ext.max.y, 0.28), midZ),
      );
    } else if (kind === 'hyperbolic') {
      candidates.push(
        vec3(lerp(ext.min.x, ext.max.x, 0.72), lerp(ext.min.y, ext.max.y, 0.7), midZ),
        vec3(lerp(ext.min.x, ext.max.x, 0.3), lerp(ext.min.y, ext.max.y, 0.64), midZ),
      );
    } else {
      candidates.push(
        vec3(lerp(ext.min.x, ext.max.x, 0.18), lerp(ext.min.y, ext.max.y, 0.3), midZ),
        vec3(lerp(ext.min.x, ext.max.x, 0.18), lerp(ext.min.y, ext.max.y, 0.62), midZ),
      );
    }
    for (const planned of candidates) {
      const valid = state.grid.nearestValidPoint(planned);
      if (valid) this.store.addSeed(valid);
    }
    this.viewer.requestRender();
  }
}

const app = new FlowApp();
// Test hook: expose real app state and the same picking path the pointer uses.
declare global {
  interface Window {
    __flowApp: {
      readonly store: AppStore;
      readonly viewer: Viewer;
      pickAtScreen(x: number, y: number): PickHit[];
    };
  }
}
window.__flowApp = {
  get store() {
    return (app as unknown as { store: AppStore }).store;
  },
  get viewer() {
    return (app as unknown as { viewer: Viewer }).viewer;
  },
  pickAtScreen: (x: number, y: number) => app.pickAtScreen(x, y),
};
