import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Vec3 } from '../core/types';

export interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  fieldGroup: THREE.Group;
  streamlineGroup: THREE.Group;
  seedGroup: THREE.Group;
  referenceGroup: THREE.Group;
  overlayGroup: THREE.Group;
  dispose: () => void;
}

export const SEED_COLORS = [
  '#ffd166',
  '#06d6a0',
  '#48cae4',
  '#f78c6b',
  '#c77dff',
  '#90be6d',
  '#ff8fab',
  '#b8de6f',
];

export function seedColor(index: number): string {
  return SEED_COLORS[index % SEED_COLORS.length];
}

export function toVec3(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Convert simulation coordinates (z up) to three.js coordinates (y up).
 * The viewer works in world metres and only swaps axes for display.
 */
export function simToThree(p: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p.x, p.z, -p.y);
}

export function threeToSim(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: -v.z, z: v.y };
}

export function makeArrowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(32, 6);
  ctx.lineTo(58, 52);
  ctx.lineTo(32, 40);
  ctx.lineTo(6, 52);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

let arrowTexture: THREE.Texture | null = null;
export function getArrowTexture(): THREE.Texture {
  if (!arrowTexture) arrowTexture = makeArrowTexture();
  return arrowTexture;
}
