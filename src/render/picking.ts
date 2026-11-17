import { Vec3, vec3 } from '../core/types';

export interface CandidateLine {
  id: string;
  label: string;
  /** Flat [x,y,z,...] world positions. */
  positions: Float32Array;
  /** Optional per-vertex scalar used for tooltip readout; length = positions.length/3. */
  scalars?: Float32Array;
  visible: boolean;
  /** Higher = preferred when ties occur (e.g. selected line). */
  priority?: number;
  kind: 'streamline' | 'reference';
}

export interface PickHit {
  id: string;
  label: string;
  kind: 'streamline' | 'reference';
  /** Pixel distance from pointer to the projected segment. */
  screenDistance: number;
  /** Perpendicular distance in metres from the eye ray to the 3D segment at closest approach. */
  worldDistance: number;
  /** Distance along the view ray from the camera to the closest approach point, metres. */
  rayDepth: number;
  segmentIndex: number;
  /** Interpolated position on the segment (world). */
  position: Vec3;
  /** Nearest sample index. */
  sampleIndex: number;
  scalar: number | null;
  screenPoint: { x: number; y: number };
}

export interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
  ndcZ: number;
}

export type Projector = (p: Vec3) => ProjectedPoint;
export type RayDirection = (pixelX: number, pixelY: number) => Vec3 | null;

function pointSegmentClosest3D(
  a: Vec3,
  b: Vec3,
  eye: Vec3,
  dir: Vec3,
): { rayT: number; segT: number; distance: number; point: Vec3 } {
  // Closest approach between ray P(t) = eye + t*dir (t>=0) and segment A + s*(B-A) (s in [0,1]).
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const vz = b.z - a.z;
  const wx = eye.x - a.x;
  const wy = eye.y - a.y;
  const wz = eye.z - a.z;
  const aa = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
  const bb = dir.x * vx + dir.y * vy + dir.z * vz;
  const cc = vx * vx + vy * vy + vz * vz;
  const dd = dir.x * wx + dir.y * wy + dir.z * wz;
  const ee = vx * wx + vy * wy + vz * wz;
  const denom = aa * cc - bb * bb;

  let s: number;
  let t: number;
  if (cc < 1e-20) {
    s = 0;
    t = Math.max(0, -dd / Math.max(aa, 1e-20));
  } else if (Math.abs(denom) < 1e-16) {
    s = 0;
    t = Math.max(0, -dd / Math.max(aa, 1e-20));
  } else {
    // Closed form. Derivation (t eliminate): s = (aa*ee - bb*dd)/denom, t = (bb*s - dd)/aa.
    s = (aa * ee - bb * dd) / denom;
    if (s < 0) {
      s = 0;
      t = Math.max(0, -dd / Math.max(aa, 1e-20));
    } else if (s > 1) {
      s = 1;
      t = Math.max(0, (bb - dd) / Math.max(aa, 1e-20));
    } else {
      t = (bb * s - dd) / Math.max(aa, 1e-20);
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -ee / Math.max(cc, 1e-20)));
      }
    }
  }

  const point = vec3(a.x + s * vx, a.y + s * vy, a.z + s * vz);
  const rx = point.x - (eye.x + t * dir.x);
  const ry = point.y - (eye.y + t * dir.y);
  const rz = point.z - (eye.z + t * dir.z);
  return { rayT: t, segT: s, distance: Math.hypot(rx, ry, rz), point };
}

/** Visible-only screen-space pick with world-space distance recorded for each candidate. */
export function pickLines(
  lines: CandidateLine[],
  pointer: { x: number; y: number },
  project: Projector,
  rayDir: RayDirection,
  cameraEye: Vec3,
  opts: { pixelTolerance: number; depthBias: number },
): PickHit | null {
  const ray = rayDir(pointer.x, pointer.y);
  const hits: PickHit[] = [];

  for (const line of lines) {
    if (!line.visible) continue; // hidden objects must not occlude picks
    const count = line.positions.length / 3;
    if (count < 2) continue;
    let prevProj: ProjectedPoint | null = null;
    let prevP = vec3();
    for (let i = 0; i < count; i++) {
      const p = vec3(line.positions[3 * i], line.positions[3 * i + 1], line.positions[3 * i + 2]);
      const proj = project(p);
      if (i === 0) {
        prevProj = proj;
        prevP = p;
        continue;
      }
      if (prevProj && proj.visible && prevProj.visible) {
        const d = pointToSegment2D(pointer.x, pointer.y, prevProj.x, prevProj.y, proj.x, proj.y);
        if (d.distance <= opts.pixelTolerance) {
          // Recover 3D closest approach using the actual view ray to avoid treating
          // screen width as spatial proximity.
          const closest = ray
            ? pointSegmentClosest3D(prevP, p, cameraEye, ray)
            : { rayT: 0, segT: d.t, distance: Number.NaN, point: p };
          const sampleFloat = i - 1 + d.t;
          const sampleIndex = Math.round(sampleFloat);
          let scalar: number | null = null;
          if (line.scalars) {
            const s0 = line.scalars[i - 1];
            const s1 = line.scalars[i];
            if (Number.isFinite(s0) && Number.isFinite(s1)) {
              scalar = s0 + (s1 - s0) * d.t;
            }
          }
          const screenPoint = {
            x: prevProj.x + (proj.x - prevProj.x) * d.t,
            y: prevProj.y + (proj.y - prevProj.y) * d.t,
          };
          hits.push({
            id: line.id,
            label: line.label,
            kind: line.kind,
            screenDistance: d.distance,
            worldDistance: closest.distance,
            rayDepth: closest.rayT,
            segmentIndex: i - 1,
            position: closest.point,
            sampleIndex,
            scalar,
            screenPoint,
          });
        }
      }
      prevProj = proj;
      prevP = p;
    }
  }

  if (hits.length === 0) return null;
  // Prefer nearest screen distance; break ties by true ray depth and explicit priority.
  const priorityOf = (hit: PickHit) => lines.find((l) => l.id === hit.id)?.priority ?? 0;
  hits.sort((a, b) => {
    const screenDelta = a.screenDistance - b.screenDistance;
    if (Math.abs(screenDelta) > 0.5) return screenDelta;
    const depthDelta = a.rayDepth - b.rayDepth;
    if (Math.abs(depthDelta) > opts.depthBias) return depthDelta;
    return priorityOf(b) - priorityOf(a);
  });
  return hits[0];
}

/** All visible candidate hits, ordered for an explicit candidate chooser in the UI. */
export function pickCandidates(
  lines: CandidateLine[],
  pointer: { x: number; y: number },
  project: Projector,
  rayDir: RayDirection,
  cameraEye: Vec3,
  opts: { pixelTolerance: number; depthBias: number },
): PickHit[] {
  const results: PickHit[] = [];
  for (const line of lines) {
    if (!line.visible) continue;
    const hit = pickLines([line], pointer, project, rayDir, cameraEye, opts);
    if (hit) results.push(hit);
  }
  results.sort((a, b) => {
    const screenDelta = a.screenDistance - b.screenDistance;
    if (Math.abs(screenDelta) > 0.5) return screenDelta;
    return a.rayDepth - b.rayDepth;
  });
  return results;
}

export function pointToSegment2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; t: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  let t = denom > 1e-12 ? (apx * abx + apy * aby) / denom : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return { distance: Math.hypot(dx, dy), t };
}
