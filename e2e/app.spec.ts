import { expect, test, type Page } from '@playwright/test';

async function appState(page: Page) {
  return page.evaluate(() => {
    const state = window.__flowApp.store.getState();
    return {
      fieldEpoch: state.fieldEpoch,
      fieldName: state.backend.meta.name,
      fieldKind: state.fieldKind,
      seeds: state.seeds.map((s) => ({
        id: s.id,
        label: s.label,
        position: s.position,
        visible: s.visible,
        version: s.version,
        computing: s.computing,
        hasResult: Boolean(s.result),
        resultVersion: s.result?.version ?? null,
        stopForward: s.result?.stop.forward ?? null,
        samples: s.result ? s.result.positions.length / 3 : 0,
      })),
      selectedSeedId: state.selectedSeedId,
      hazards: state.hazards?.checks.map((c) => ({ key: c.key, stop: c.stop, passed: c.passed })) ?? null,
      validation: state.validation
        ? {
            passed: state.validation.summary.passed,
            maxError: state.validation.summary.maxError,
            rows: state.validation.rows.map((r) => ({
              maxError: r.maxError,
              endpointError: r.endpointError,
              metrics: r.metrics.map((m) => ({ label: m.label, value: m.value })),
            })),
          }
        : null,
      colorBy: state.colorBy,
      params: state.params,
    };
  });
}

async function canvasBox(page: Page) {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas missing');
  return box;
}

async function clickCanvas(page: Page, fx: number, fy: number) {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__flowApp), undefined, { timeout: 20_000 });
  await page.waitForTimeout(600);
});

test('loads the uniform reference field with provenance and disclaimer', async ({ page }) => {
  await expect(page.getByTestId('field-name')).toContainText('匀速参考流');
  const section = page.locator('[data-testid="field-section"]');
  await expect(section).toContainText('合成 / 非实测');
  await expect(section).toContainText('不代表任何实测水动力条件');
  await expect(section).toContainText('缺测网格范围');
  const state = await appState(page);
  expect(state.fieldKind).toBe('uniform');
});

test('places a seed, integrates a real streamline and shows the parameters used', async ({ page }) => {
  await clickCanvas(page, 0.5, 0.6);
  await page.waitForFunction(() => window.__flowApp.store.getState().seeds.some((s) => s.result !== null), undefined, {
    timeout: 20_000,
  });
  const state = await appState(page);
  expect(state.seeds.length).toBe(1);
  const seed = state.seeds[0];
  expect(seed.hasResult).toBe(true);
  expect(seed.samples).toBeGreaterThan(10);

  // The sample count and arc length must reflect genuine steps, not a chain of grid arrows.
  const geom = await page.evaluate(() => {
    const s = window.__flowApp.store.getState().seeds[0];
    const r = s.result!;
    let chord = 0;
    for (let i = 1; i < r.positions.length / 3; i++) {
      chord += Math.hypot(
        r.positions[3 * i] - r.positions[3 * (i - 1)],
        r.positions[3 * i + 1] - r.positions[3 * (i - 1) + 1],
        r.positions[3 * i + 2] - r.positions[3 * (i - 1) + 2],
      );
    }
    const steps = r.stats.totalSteps;
    return { chord, arc: r.stats.totalArc, steps, stepLength: r.params.stepLength, firstSpeed: r.speeds[0] };
  });
  // Arclength-parameterised integration advances ~Δs per step; the curve length matches.
  expect(geom.arc).toBeGreaterThan(geom.stepLength);
  expect(Math.abs(geom.chord - geom.arc) / geom.arc).toBeLessThan(0.02);
  // Uniform reference field speed is 1.2 m/s by construction.
  expect(geom.firstSpeed).toBeGreaterThan(1.0);
  expect(geom.firstSpeed).toBeLessThan(1.5);

  await expect(page.locator('#compute-hud')).toContainText('步长 Δs');
  await expect(page.locator('#compute-hud')).toContainText('最大步数');
  await expect(page.locator('#compute-hud')).toContainText('容差');
});

test('drag keeps the newest seed state and never installs a stale result', async ({ page }) => {
  // Slow the integrator down so in-flight results genuinely land mid-drag.
  await page.evaluate(() => window.__flowApp.store.updateParams({ stepLength: 0.03, maxArcLength: 120 }));
  await clickCanvas(page, 0.45, 0.55);
  await page.waitForFunction(() => window.__flowApp.store.getState().seeds[0]?.result != null, undefined, {
    timeout: 20_000,
  });
  const initial = await appState(page);
  const startPos = initial.seeds[0].position;

  // Record every installed result version while dragging; a stale write would break monotonicity.
  await page.evaluate(() => {
    const w = window as unknown as { __versionLog: string[] };
    w.__versionLog = [];
    const store = window.__flowApp.store;
    let lastVersion = -1;
    let lastId = '';
    const seed = store.getState().seeds[0];
    lastVersion = seed.version;
    lastId = seed.id;
    store.subscribe(() => {
      const s = store.getState().seeds.find((x) => x.id === lastId);
      if (!s) return;
      if (s.result && s.result.version !== lastVersion) {
        w.__versionLog.push(`${s.version}:${s.result.version}`);
        lastVersion = s.version;
      }
    });
  });

  const box = await canvasBox(page);
  const start = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(start.x + i * 8, start.y + i * 4, { steps: 2 });
    await page.waitForTimeout(45);
  }
  await page.mouse.move(start.x + 210, start.y + 105, { steps: 6 });
  await page.mouse.up();

  await page.waitForFunction(
    () => {
      const s = window.__flowApp.store.getState().seeds[0];
      return Boolean(s?.result) && s!.result!.version === s!.version && !s!.computing;
    },
    undefined,
    { timeout: 20_000 },
  );

  const settled = await appState(page);
  const seed = settled.seeds[0];
  expect(seed.resultVersion).toBe(seed.version);
  // Seed genuinely moved.
  expect(Math.hypot(seed.position.x - startPos.x, seed.position.y - startPos.y)).toBeGreaterThan(1);
  // Every install in the log carried the current version at that moment.
  const log = await page.evaluate(() => (window as unknown as { __versionLog: string[] }).__versionLog);
  for (const entry of log) {
    const [seedVersion, resultVersion] = entry.split(':').map(Number);
    expect(resultVersion).toBe(seedVersion);
  }
  expect(log.length).toBeGreaterThan(0);

  // During the drag the app must keep showing a stale-version guard in the HUD or in seed state:
  // after release, no seed may report a result older than its own version.
  const stale = await page.evaluate(() =>
    window.__flowApp.store
      .getState()
      .seeds.filter((s) => s.result && s.result.version !== s.version)
      .map((s) => s.id),
  );
  expect(stale).toEqual([]);
});

test('hidden streamlines never occlude picking at their screen position', async ({ page }) => {
  await page.click('#demo-seeds-btn');
  await page.waitForFunction(
    () => window.__flowApp.store.getState().seeds.filter((s) => s.result).length >= 2,
    undefined,
    { timeout: 20_000 },
  );
  const state = await appState(page);
  expect(state.seeds.length).toBe(2);

  const firstId = state.seeds[0].id;
  // Probe the midpoint of the first line before hiding it: must hit it.
  const screen = await page.evaluate((id) => {
    const seed = window.__flowApp.store.getState().seeds.find((s) => s.id === id)!;
    const r = seed.result!;
    const mid = Math.floor(r.positions.length / 6);
    return window.__flowApp.viewer.project({
      x: r.positions[3 * mid],
      y: r.positions[3 * mid + 1],
      z: r.positions[3 * mid + 2],
    });
  }, firstId);

  const before = await page.evaluate((p) => {
    const hits = window.__flowApp.pickAtScreen(p.x, p.y);
    return hits.map((h) => h.id);
  }, screen);
  expect(before).toContain(firstId);

  await page.click(`[data-action="seed-toggle"][data-seed-id="${firstId}"]`);
  await page.waitForFunction(
    (id) => window.__flowApp.store.getState().seeds.find((x) => x.id === id)?.visible === false,
    firstId,
    { timeout: 10_000 },
  );

  const after = await page.evaluate((p) => {
    const hits = window.__flowApp.pickAtScreen(p.x, p.y);
    return hits.map((h) => h.id);
  }, screen);
  expect(after).not.toContain(firstId);

  // The other line is still selectable.
  const otherId = state.seeds[1].id;
  const otherScreen = await page.evaluate((id) => {
    const seed = window.__flowApp.store.getState().seeds.find((s) => s.id === id)!;
    const r = seed.result!;
    const mid = Math.floor(r.positions.length / 6);
    return window.__flowApp.viewer.project({
      x: r.positions[3 * mid],
      y: r.positions[3 * mid + 1],
      z: r.positions[3 * mid + 2],
    });
  }, otherId);
  const otherHits = await page.evaluate((p) => {
    const hits = window.__flowApp.pickAtScreen(p.x, p.y);
    return hits.map((h) => h.id);
  }, otherScreen);
  expect(otherHits).toContain(otherId);
});

test('overlapping streamlines produce a candidate chooser with screen distance and ray depth', async ({ page }) => {
  await page.click('#demo-seeds-btn');
  await page.waitForFunction(
    () => window.__flowApp.store.getState().seeds.filter((s) => s.result).length >= 2,
    undefined,
    { timeout: 20_000 },
  );
  // Move the first seed exactly onto the second: the uniform field then produces identical curves.
  const ids = await page.evaluate(() => window.__flowApp.store.getState().seeds.map((s) => s.id));
  const target = await page.evaluate(
    (id) => window.__flowApp.store.getState().seeds.find((s) => s.id === id)!.position,
    ids[1],
  );
  await page.evaluate(
    ({ id, position }) => window.__flowApp.store.moveSeed(id, position),
    { id: ids[0], position: target },
  );
  await page.waitForFunction(
    () => {
      const seeds = window.__flowApp.store.getState().seeds;
      return seeds.every((s) => Boolean(s.result) && s.result!.version === s.version);
    },
    undefined,
    { timeout: 20_000 },
  );

  const screen = await page.evaluate(() => {
    const seed = window.__flowApp.store.getState().seeds[0];
    const r = seed.result!;
    const mid = Math.floor(r.positions.length / 6);
    return window.__flowApp.viewer.project({
      x: r.positions[3 * mid],
      y: r.positions[3 * mid + 1],
      z: r.positions[3 * mid + 2],
    });
  });
  const hits = await page.evaluate((p) => {
    const list = window.__flowApp.pickAtScreen(p.x, p.y);
    return { count: list.length, ids: list.map((h) => h.id) };
  }, screen);
  expect(hits.count).toBeGreaterThanOrEqual(2);

  const box = await canvasBox(page);
  await page.mouse.click(box.x + screen.x, box.y + screen.y);
  await page.waitForTimeout(400);
  const popup = page.locator('#candidate-popup');
  await expect(popup).toBeVisible();
  const items = popup.locator('.candidate-item');
  expect(await items.count()).toBeGreaterThanOrEqual(2);
  const first = await items.first().textContent();
  expect(first).toContain('px');
  expect(first).toContain('深');

  // Choosing a candidate selects that exact seed (no silent nearest-line fallback).
  const chosenLabel = (await items.first().textContent())?.trim() ?? '';
  await items.first().click();
  await expect(popup).toBeHidden();
  const selected = await page.evaluate(() => {
    const state = window.__flowApp.store.getState();
    return state.seeds.find((s) => s.id === state.selectedSeedId)?.label ?? null;
  });
  expect(chosenLabel).toContain(selected!);
});

test('parameter changes re-integrate and the trace panel reports the used step size', async ({ page }) => {
  await clickCanvas(page, 0.5, 0.55);
  await page.waitForFunction(() => window.__flowApp.store.getState().seeds[0]?.result != null, undefined, {
    timeout: 20_000,
  });
  const before = await appState(page);
  const samplesBefore = before.seeds[0].samples;

  await page.evaluate(() => window.__flowApp.store.updateParams({ stepLength: 0.8 }));
  await page.waitForFunction(
    (previous) => {
      const s = window.__flowApp.store.getState().seeds[0];
      return s?.result && s.result.params.stepLength === 0.8 && s.result.positions.length / 3 !== previous;
    },
    samplesBefore,
    { timeout: 20_000 },
  );
  const after = await appState(page);
  expect(after.params.stepLength).toBe(0.8);
  expect(after.seeds[0].samples).not.toBe(samplesBefore);
  await expect(page.locator('[data-testid="selected-section"]')).toContainText('步长 min/mean/max');
  // The panel must name the parameters that actually produced this trajectory.
  await expect(page.getByTestId('used-params')).toContainText('Δs 0.800 m');
});

test('validation against the analytic reference reports errors and refinement metric', async ({ page }) => {
  await page.click('[data-field="hyperbolic"]');
  await page.waitForFunction(() => window.__flowApp.store.getState().fieldKind === 'hyperbolic', undefined, {
    timeout: 15_000,
  });
  await page.click('[data-action="run-validation"]');
  await page.waitForFunction(() => Boolean(window.__flowApp.store.getState().validation), undefined, {
    timeout: 60_000,
  });
  const state = await appState(page);
  expect(state.validation!.rows.length).toBeGreaterThan(0);
  for (const row of state.validation!.rows) {
    expect(row.maxError).toBeLessThan(0.02);
    expect(Number.isFinite(row.endpointError)).toBe(true);
  }
  // Hyperbolic uses an exact flow-map oracle; y=0 seeds should include the separation invariant.
  const labels = state.validation!.rows.flatMap((r) => r.metrics.map((m) => m.label));
  expect(labels).toContain('最大点偏差');
  expect(labels).toContain('同弧长终点偏差');
  await expect(page.locator('[data-testid="validation-table"] tbody tr')).toHaveCount(state.validation!.rows.length);
  await expect(page.locator('[data-testid="validation-section"]')).toContainText('精确流映射');
});

test('imports a user grid JSON with masks and keeps the missing extent visible', async ({ page }) => {
  await page.setInputFiles('#import-input', 'public/examples/channel-demo.json');
  await page.waitForFunction(
    () => window.__flowApp.store.getState().fieldKind === 'imported',
    undefined,
    { timeout: 20_000 },
  );
  const section = page.locator('[data-testid="field-section"]');
  await expect(section).toContainText('用户导入');
  await expect(section).toContainText('缺测网格范围');
  await expect(section).toContainText('示例数据');
  const stats = await page.evaluate(() => {
    const g = window.__flowApp.store.getState().backend;
    return {
      dims: g.dims,
      missingCells: g.stats.missingCellCount,
      solidCells: g.stats.solidCellCount,
      missingBounds: g.stats.missingBounds,
    };
  });
  expect(stats.dims).toEqual([16, 12, 5]);
  expect(stats.missingCells).toBeGreaterThan(0);
  expect(stats.solidCells).toBeGreaterThan(0);
  expect(stats.missingBounds).not.toBeNull();

  // Imported fields have no analytic reference, so validation must refuse honestly.
  await page.click('[data-action="run-validation"]');
  await expect(page.locator('#toast')).toContainText('导入场没有解析参考解');
});

test('hazard self-check covers stagnation, closed loop, missing data and out-of-bounds', async ({ page }) => {
  await page.click('[data-field="rankine-vortex"]');
  await page.waitForFunction(
    () => (window.__flowApp.store.getState().hazards?.checks.length ?? 0) >= 3,
    undefined,
    { timeout: 30_000 },
  );
  const state = await appState(page);
  const byKey = new Map(state.hazards!.map((c) => [c.key, c]));
  expect(byKey.get('stagnation')?.stop).toBe('stagnation');
  expect(byKey.get('closed-loop')?.stop).toBe('closed-loop');
  expect(byKey.get('out-of-bounds')?.stop).toBe('seed-invalid');
  expect(state.hazards!.every((c) => c.passed)).toBe(true);

  await page.click('[data-field="hyperbolic"]');
  await page.waitForFunction(
    () => window.__flowApp.store.getState().hazards?.checks.some((c) => c.key === 'missing-data'),
    undefined,
    { timeout: 30_000 },
  );
  const hState = await appState(page);
  expect(hState.hazards!.find((c) => c.key === 'missing-data')?.stop).toBe('seed-invalid');
  expect(hState.hazards!.find((c) => c.key === 'separation')?.passed).toBe(true);
});

test('exposes the field-data interface version and the active backend', async ({ page }) => {
  await expect(page.getByTestId('protocol-version')).toContainText('v2');
  await expect(page.getByTestId('protocol-version')).toContainText('旧场适配器');
  await expect(page.locator('#compute-hud')).toContainText('v2');
});

test('non-uniform imported axes locate cells by coordinate and keep masks visible', async ({ page }) => {
  await page.setInputFiles('#import-input', 'public/examples/nonuniform-demo.json');
  await page.waitForFunction(
    () => window.__flowApp.store.getState().fieldKind === 'imported',
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('protocol-version')).toContainText('稠密');
  await expect(page.locator('[data-testid="field-section"]')).toContainText('非等距');
  const info = await page.evaluate(() => {
    const b = window.__flowApp.store.getState().backend;
    // A point away from the masked window, and one inside it.
    const clear = b.sample({ x: 0, y: -3.5, z: 1.0 });
    const inGap = b.sample({ x: 0, y: 0, z: 1.0 });
    return {
      kind: b.kind,
      protocol: b.protocolVersion,
      axesUniform: b.stats.axesUniform,
      spacingMaxX: b.stats.axisSpacing.max.x,
      spacingMinX: b.stats.axisSpacing.min.x,
      sampleOk: clear.ok,
      gapOk: inGap.ok,
      gapReason: inGap.reason,
      cellX: clear.cell[0],
    };
  });
  expect(info.kind).toBe('dense');
  expect(info.protocol).toBe(2);
  expect(info.axesUniform).toEqual([false, false, true]);
  // Non-uniform spacing is reported truthfully rather than collapsed to one value.
  expect(info.spacingMaxX).toBeGreaterThan(info.spacingMinX);
  expect(info.sampleOk).toBe(true);
  expect(info.gapOk).toBe(false);
  expect(info.gapReason).toBe('missing-data');
});

test('chunked demo: absent chunk is a coverage gap and stops the streamline as missing-chunk', async ({ page }) => {
  await page.click('[data-field="chunked-demo"]');
  await page.waitForFunction(
    () => window.__flowApp.store.getState().backend.kind === 'chunked',
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('protocol-version')).toContainText('分块存储');
  await expect(page.getByTestId('missing-chunk-stat')).toContainText('1/27');

  const gap = await page.evaluate(() => {
    const b = window.__flowApp.store.getState().backend;
    const box = b.maskBoxes().find((x) => x.kind === 'missing-chunk')!;
    const p = {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2,
    };
    const s = b.sample(p);
    return { reason: s.reason, ok: s.ok, speed: s.speed, present: b.stats.presentChunkCount };
  });
  // The critical contract: a gap must not masquerade as zero velocity.
  expect(gap.ok).toBe(false);
  expect(gap.reason).toBe('missing-chunk');
  expect(gap.present).toBe(26);

  // Drive a real streamline from the UI into the gap and check the terminal state.
  await page.evaluate(() => {
    const store = window.__flowApp.store;
    store.addSeed({ x: -4, y: 0, z: 1.5 }, { allowRelocate: true });
  });
  await page.waitForFunction(
    () => window.__flowApp.store.getState().seeds.some((s) => s.result !== null),
    undefined,
    { timeout: 20_000 },
  );
  const result = await page.evaluate(() => {
    const seed = window.__flowApp.store.getState().seeds.find((s) => s.result) ?? window.__flowApp.store.getState().seeds[0];
    const r = seed.result!;
    return {
      stop: r.stop.forward,
      category: r.stats.directions.forward.category,
      bounded: r.stats.directions.forward.bounded,
      detail: r.stopDetail.forward,
      samples: r.positions.length / 3,
    };
  });
  expect(result.stop).toBe('missing-chunk');
  expect(result.category).toBe('boundary');
  expect(result.bounded).toBe(true);
  expect(result.detail).toContain('缺块');
  expect(result.samples).toBeGreaterThan(3);

  // Every recorded sample must still be valid data (the stop is not stepped into).
  const allValid = await page.evaluate(() => {
    const s = window.__flowApp.store.getState();
    const r = s.seeds.find((x) => x.result)!.result!;
    for (let i = 0; i < r.positions.length / 3; i++) {
      const p = { x: r.positions[3 * i], y: r.positions[3 * i + 1], z: r.positions[3 * i + 2] };
      if (!s.backend.sample(p).ok) return false;
    }
    return true;
  });
  expect(allValid).toBe(true);
});

test('streamline interaction reports how it failed, not a silent stuck spinner', async ({ page }) => {
  // Force the worker path to fail after a request is in flight: the failure
  // must propagate to the seed record (no seed may stay "computing" forever).
  await page.evaluate(() => window.__flowApp.store.updateParams({ stepLength: 0.3, maxArcLength: 30 }));
  await clickCanvas(page, 0.5, 0.6);
  await page.waitForFunction(
    () => window.__flowApp.store.getState().seeds.some((s) => s.result !== null),
    undefined,
    { timeout: 20_000 },
  );
  const before = await appState(page);
  const seedId = before.seeds[0].id;

  const after = await page.evaluate((id) => {
    const store = window.__flowApp.store as unknown as {
      onWorkerFailureForTest?: (message: string) => void;
    };
    store.onWorkerFailureForTest?.('模拟积分线程失败');
    const seed = window.__flowApp.store.getState().seeds.find((s) => s.id === id)!;
    return {
      computing: seed.computing,
      stop: seed.lastStop?.forward ?? null,
      detail: seed.result?.stopDetail.forward ?? '',
      statusError: window.__flowApp.store.getState().status.error,
    };
  }, seedId);

  expect(after.computing).toBe(false);
  expect(after.stop).toBe('numerical');
  expect(after.detail).toContain('模拟积分线程失败');
  expect(after.statusError).toContain('模拟积分线程失败');
});

test('each trajectory is stamped with the field-data interface version it ran through', async ({ page }) => {
  await clickCanvas(page, 0.5, 0.55);
  await page.waitForFunction(
    () => window.__flowApp.store.getState().seeds.some((s) => s.result !== null),
    undefined,
    { timeout: 20_000 },
  );
  const stamped = await page.evaluate(() => {
    const seed = window.__flowApp.store.getState().seeds.find((s) => s.result)!;
    const r = seed.result!;
    return { version: r.fieldProtocolVersion, kind: r.fieldBackendKind, backend: window.__flowApp.store.getState().backend.protocolVersion };
  });
  expect(stamped.version).toBe(2);
  expect(stamped.backend).toBe(2);
  // Legacy synthetic fields run through the adapter, and say so.
  expect(stamped.kind).toBe('legacy-grid');
  await expect(page.getByTestId('result-protocol')).toContainText('v2');
  await expect(page.getByTestId('result-protocol')).toContainText('legacy-grid');
});
