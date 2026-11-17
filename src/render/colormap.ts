export type ColormapName = 'turbo' | 'viridis' | 'coolwarm' | 'magma';

/** Piecewise-linear, perceptually reasonable colormaps sampled to a LUT. */
const STOPS: Record<ColormapName, [number, [number, number, number]][]> = {
  turbo: [
    [0.0, [0.19, 0.07, 0.23]],
    [0.15, [0.27, 0.38, 0.94]],
    [0.3, [0.1, 0.78, 0.79]],
    [0.45, [0.35, 0.95, 0.35]],
    [0.6, [0.98, 0.88, 0.2]],
    [0.75, [0.98, 0.5, 0.12]],
    [0.9, [0.79, 0.15, 0.06]],
    [1.0, [0.48, 0.02, 0.02]],
  ],
  viridis: [
    [0.0, [0.267, 0.005, 0.329]],
    [0.25, [0.253, 0.265, 0.53]],
    [0.5, [0.128, 0.567, 0.551]],
    [0.75, [0.369, 0.789, 0.383]],
    [1.0, [0.993, 0.906, 0.144]],
  ],
  coolwarm: [
    [0.0, [0.23, 0.3, 0.75]],
    [0.25, [0.55, 0.69, 0.99]],
    [0.5, [0.87, 0.87, 0.87]],
    [0.75, [0.96, 0.6, 0.48]],
    [1.0, [0.71, 0.02, 0.15]],
  ],
  magma: [
    [0.0, [0.001, 0.0, 0.014]],
    [0.25, [0.316, 0.071, 0.485]],
    [0.5, [0.716, 0.215, 0.475]],
    [0.75, [0.987, 0.535, 0.382]],
    [1.0, [0.987, 0.991, 0.749]],
  ],
};

export function colormap(name: ColormapName, t: number): [number, number, number] {
  const stops = STOPS[name];
  const clampT = Math.min(1, Math.max(0, t));
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (clampT >= stops[i][0] && clampT <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = Math.min(1, Math.max(0, (clampT - lo[0]) / span));
  return [
    lo[1][0] + (hi[1][0] - lo[1][0]) * f,
    lo[1][1] + (hi[1][1] - lo[1][1]) * f,
    lo[1][2] + (hi[1][2] - lo[1][2]) * f,
  ];
}

export function colormapCss(name: ColormapName, t: number): string {
  const [r, g, b] = colormap(name, t);
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`;
}

export interface ColorScale {
  min: number;
  max: number;
  name: ColormapName;
  label: string;
  unit: string;
}

export function colorForValue(scale: ColorScale, value: number): [number, number, number] {
  if (!Number.isFinite(value)) return [0.45, 0.45, 0.45];
  const span = scale.max - scale.min;
  const t = span > 1e-12 ? (value - scale.min) / span : 0.5;
  return colormap(scale.name, t);
}

export function cssForValue(scale: ColormapName, value: number, min: number, max: number): string {
  const span = max - min;
  const t = span > 1e-12 ? (value - min) / span : 0.5;
  return colormapCss(scale, t);
}

export function gradientCss(name: ColormapName, steps = 24): string {
  const stops: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    stops.push(`${colormapCss(name, t)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
