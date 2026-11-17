import { VectorGrid, type FieldPayload } from './grid';
import { ChunkedFieldBackend } from './chunkedBackend';
import { DenseFieldBackend } from './denseBackend';
import { LegacyGridBackend } from './legacyBackend';
import {
  ChunkedFieldInput,
  DenseFieldInput,
  FieldBackend,
  FieldInput,
  FIELD_BACKEND_PROTOCOL_VERSION,
} from './fieldProtocol';

export { ChunkedFieldBackend, DenseFieldBackend, LegacyGridBackend };

/**
 * Build a backend for any supported input:
 *  - `{ layout: 'dense' }`    explicit per-axis coordinates, masks carry validity
 *  - `{ layout: 'chunked' }`  chunked storage; absent chunks are genuine gaps
 *  - legacy `FieldPayload`    adapted through `VectorGrid`
 *  - an existing `VectorGrid` adapted in place
 * No branch substitutes a default velocity for unavailable data.
 */
export function createFieldBackend(input: FieldInput | VectorGrid): FieldBackend {
  if (input instanceof VectorGrid) return new LegacyGridBackend(input);
  if ((input as ChunkedFieldInput).layout === 'chunked') {
    return new ChunkedFieldBackend(input as ChunkedFieldInput);
  }
  if ((input as DenseFieldInput).layout === 'dense') {
    return new DenseFieldBackend(input as DenseFieldInput);
  }
  return new LegacyGridBackend(new VectorGrid(input as FieldPayload));
}

/** Wrap an already-built legacy grid without re-copying its arrays. */
export function adapterForLegacyGrid(grid: VectorGrid): FieldBackend {
  return new LegacyGridBackend(grid);
}

export function protocolStamp(): { version: number; label: string } {
  return { version: FIELD_BACKEND_PROTOCOL_VERSION, label: `v${FIELD_BACKEND_PROTOCOL_VERSION}` };
}
