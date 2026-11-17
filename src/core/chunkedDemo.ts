import { ChunkPayload, ChunkedFieldInput } from './fieldProtocol';
import { FieldMeta } from './grid';
import { Vec3, vec3 } from './types';

/**
 * Chunked demo: a rotating base flow on a deliberately **non-uniform** lattice,
 * stored as 3×3×3 chunks with the central chunk omitted. A streamline aimed at
 * the centre is therefore expected to terminate with `missing-chunk` — a
 * bounded coverage-gap stop, not a zero-velocity stall.
 */
export interface ChunkedDemoOptions {
  /** Chunk omitted from storage; defaults to the middle chunk. */
  omitChunk?: [number, number, number];
}

const CHUNK_SIZE: [number, number, number] = [10, 8, 4];
const CHUNK_DIMS: [number, number, number] = [3, 3, 3];
const CELL_DIMS: [number, number, number] = [
  CHUNK_SIZE[0] * CHUNK_DIMS[0],
  CHUNK_SIZE[1] * CHUNK_DIMS[1],
  CHUNK_SIZE[2] * CHUNK_DIMS[2],
];

/** Non-uniform axis: dense near the middle, stretched toward the edges. */
function nonUniformAxis(min: number, max: number, count: number, density: number): Float64Array {
  const coords = new Float64Array(count);
  const denom = Math.tanh(density);
  for (let i = 0; i < count; i++) {
    const u = (i / (count - 1)) * 2 - 1;
    const warped = density === 0 ? u : Math.tanh(u * density) / denom;
    coords[i] = min + ((warped + 1) / 2) * (max - min);
  }
  coords[0] = min;
  coords[count - 1] = max;
  return coords;
}

export function chunkedDemoAxes(): [Float64Array, Float64Array, Float64Array] {
  return [
    nonUniformAxis(-6, 6, CELL_DIMS[0] + 1, 1.4),
    nonUniformAxis(-5, 5, CELL_DIMS[1] + 1, 1.2),
    nonUniformAxis(0, 3, CELL_DIMS[2] + 1, 0),
  ];
}

function velocityAt(p: Vec3): Vec3 {
  // Shear + rotation: streamlines curve, so a chunk gap is reached by a real path.
  const r2 = p.x * p.x + p.y * p.y;
  const swirl = 0.55 / (1 + 0.25 * r2);
  return vec3(-swirl * p.y + 0.35, swirl * p.x + 0.15, 0.06 * Math.sin(p.x));
}

export function makeChunkedDemoField(opts: ChunkedDemoOptions = {}): ChunkedFieldInput {
  const axes = chunkedDemoAxes();
  const omit = opts.omitChunk ?? [1, 1, 1];
  const chunks: ChunkPayload[] = [];
  for (let cz = 0; cz < CHUNK_DIMS[2]; cz++) {
    for (let cy = 0; cy < CHUNK_DIMS[1]; cy++) {
      for (let cx = 0; cx < CHUNK_DIMS[0]; cx++) {
        if (cx === omit[0] && cy === omit[1] && cz === omit[2]) continue;
        const i0 = cx * CHUNK_SIZE[0];
        const j0 = cy * CHUNK_SIZE[1];
        const k0 = cz * CHUNK_SIZE[2];
        const cellDims: [number, number, number] = [
          Math.min(CHUNK_SIZE[0], CELL_DIMS[0] - i0),
          Math.min(CHUNK_SIZE[1], CELL_DIMS[1] - j0),
          Math.min(CHUNK_SIZE[2], CELL_DIMS[2] - k0),
        ];
        const nodeDims: [number, number, number] = [cellDims[0] + 1, cellDims[1] + 1, cellDims[2] + 1];
        const n = nodeDims[0] * nodeDims[1] * nodeDims[2];
        const velocity = new Float32Array(3 * n);
        const speed = new Float32Array(n);
        for (let lk = 0; lk < nodeDims[2]; lk++) {
          for (let lj = 0; lj < nodeDims[1]; lj++) {
            for (let li = 0; li < nodeDims[0]; li++) {
              const p = vec3(axes[0][i0 + li], axes[1][j0 + lj], axes[2][k0 + lk]);
              const v = velocityAt(p);
              const node = li + nodeDims[0] * (lj + nodeDims[1] * lk);
              velocity[3 * node] = v.x;
              velocity[3 * node + 1] = v.y;
              velocity[3 * node + 2] = v.z;
              speed[node] = Math.hypot(v.x, v.y, v.z);
            }
          }
        }
        chunks.push({
          index: [cx, cy, cz],
          velocity,
          scalars: { speed },
          nodeMissing: new Uint8Array(n),
          nodeSolid: new Uint8Array(n),
        });
      }
    }
  }

  const meta: FieldMeta = {
    id: 'chunked-demo',
    name: '分块存储演示（非等距网格 + 中央缺块）',
    source: '内置分块演示生成器',
    synthetic: true,
    description:
      '3×3×3 分块存储：x/y 轴为非等距坐标，中央块未提供。进入缺块的流线以“缺块”终止，绝不按零速度处理。',
    provenance: '程序按解析速度公式在非等距节点上采样；中央块被刻意省略以演示覆盖缺口。',
    units: { length: 'm', velocity: 'm/s', scalar: { speed: 'm/s' } },
    timeLabel: '稳态 · 分块演示',
    disclaimer:
      '分块演示数据：用于验证非等距坐标、缺块语义与终止原因，不代表任何实测水动力条件。',
    createdAt: new Date().toISOString(),
  };

  return {
    layout: 'chunked',
    meta,
    axes: axes as unknown as [Float64Array, Float64Array, Float64Array],
    chunkSize: CHUNK_SIZE,
    chunks,
  };
}

export const CHUNKED_DEMO_CHUNK_SIZE = CHUNK_SIZE;
export const CHUNKED_DEMO_CELL_DIMS = CELL_DIMS;
