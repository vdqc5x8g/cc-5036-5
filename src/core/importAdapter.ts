import { normalizeImport } from './grid';
import { DenseFieldInput, FieldInput } from './fieldProtocol';

function isAxisList(v: unknown): v is [unknown, unknown, unknown] {
  return Array.isArray(v) && v.length === 3 && v.every((a) => Array.isArray(a) || ArrayBuffer.isView(a));
}

/**
 * Parse a user JSON file into the new field interface. `axes` (three explicit
 * coordinate arrays) selects a dense backend with non-uniform support; a
 * `spec.origin/spacing/dims` file keeps the legacy layout, which the factory
 * adapts. The legacy normaliser is not duplicated, so both paths share one
 * validation and one mask parser.
 */
export function normalizeImportInput(raw: unknown): FieldInput {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const axesRaw = obj.axes ?? (obj.spec as Record<string, unknown> | undefined)?.axes;
    if (isAxisList(axesRaw)) {
      return denseInputFromJson(obj, axesRaw as [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]);
    }
  }
  return normalizeImport(raw);
}

function denseInputFromJson(
  obj: Record<string, unknown>,
  axesRaw: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
): DenseFieldInput {
  const axes = axesRaw.map((a) => Float64Array.from(a as ArrayLike<number>)) as [
    Float64Array,
    Float64Array,
    Float64Array,
  ];
  const dims: [number, number, number] = [axes[0].length, axes[1].length, axes[2].length];
  if (dims.some((d) => d < 2)) throw new Error('每条坐标轴至少需要 2 个节点');
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;

  const velRaw = obj.velocity ?? obj.vectors;
  if (!Array.isArray(velRaw) && !ArrayBuffer.isView(velRaw)) {
    throw new Error('缺少 velocity 数组（x 变化最快，长度 3*nx*ny*nz）');
  }
  const src = velRaw as ArrayLike<number>;
  if (src.length !== 3 * n) {
    throw new Error(`velocity 长度应为 ${3 * n}（每节点 3 分量），实际 ${src.length}`);
  }
  const velocity = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) {
    const val = Number(src[i]);
    if (!Number.isFinite(val)) throw new Error(`velocity[${i}] 非有限值`);
    velocity[i] = val;
  }

  const scalars: Record<string, Float32Array> = {};
  if (obj.scalars && typeof obj.scalars === 'object') {
    for (const [name, arrLike] of Object.entries(obj.scalars as Record<string, unknown>)) {
      if (!Array.isArray(arrLike) && !ArrayBuffer.isView(arrLike)) throw new Error(`标量 ${name} 必须为数组`);
      const arr = arrLike as ArrayLike<number>;
      if (arr.length !== n) throw new Error(`标量 ${name} 长度应为 ${n}`);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const val = Number(arr[i]);
        out[i] = Number.isFinite(val) ? val : Number.NaN;
      }
      scalars[name] = out;
    }
  }

  const parseMask = (value: unknown): Uint8Array => {
    const out = new Uint8Array(n);
    if (value === undefined || value === null) return out;
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error('掩膜必须为数组');
    const mask = value as ArrayLike<number>;
    if (mask.length !== n) throw new Error(`掩膜长度应为 ${n}`);
    for (let i = 0; i < n; i++) out[i] = Number(mask[i]) ? 1 : 0;
    return out;
  };

  const unitsRaw = (obj.units ?? {}) as Record<string, unknown>;
  const scalarUnits: Record<string, string> = {};
  if (unitsRaw.scalar && typeof unitsRaw.scalar === 'object') {
    for (const [k, v] of Object.entries(unitsRaw.scalar as Record<string, unknown>)) scalarUnits[k] = String(v);
  }
  const meta = {
    id: String(obj.id ?? `import-${Date.now()}`),
    name: String(obj.name ?? '用户载入非等距网格'),
    source: String(obj.source ?? '用户上传 JSON'),
    synthetic: Boolean(obj.synthetic ?? false),
    description: String(obj.description ?? '用户导入的非等距向量网格；未经过水动力实测验证。'),
    provenance: String(obj.provenance ?? '用户提供的数据文件'),
    units: {
      length: String(unitsRaw.length ?? 'm'),
      velocity: String(unitsRaw.velocity ?? 'm/s'),
      scalar: scalarUnits,
    },
    timeLabel: String(obj.timeLabel ?? '稳态'),
    disclaimer: String(
      obj.disclaimer ??
        '用户载入数据：仅按给定网格值做插值与积分，不代表实测水动力结论，也未做物理一致性校核。',
    ),
    createdAt: new Date().toISOString(),
  };
  return {
    layout: 'dense',
    meta,
    axes,
    velocity,
    scalars,
    nodeMissing: parseMask(obj.missing ?? obj.missingMask),
    nodeSolid: parseMask(obj.solid ?? obj.solidMask),
  };
}

