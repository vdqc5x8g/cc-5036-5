export function fmt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function fmtSci(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toExponential(digits);
}

export function fmtInt(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

export function gaussian(value: number, digits = 3): string {
  return fmtSci(value, digits);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtCoord(p: { x: number; y: number; z: number }, digits = 2): string {
  return `(${p.x.toFixed(digits)}, ${p.y.toFixed(digits)}, ${p.z.toFixed(digits)})`;
}
