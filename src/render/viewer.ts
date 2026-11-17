import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { FieldBackend, FieldMaskBox } from '../core/fieldProtocol';
import { StreamlineResult, Vec3 } from '../core/types';
import { ColorScale, colorForValue } from './colormap';
import { SceneHandles, simToThree, threeToSim, toVec3 } from './scene';

export interface StreamlineVisual {
  id: string;
  label: string;
  visible: boolean;
  selected: boolean;
  color: string;
  result: StreamlineResult;
  line: Line2;
  scale: ColorScale;
  seedIndex: number;
}

export interface ViewerOptions {
  container: HTMLElement;
  onHover: (hit: { x: number; y: number } | null) => void;
}

const MISSING_COLOR = 0xc2410c;
const MISSING_CHUNK_COLOR = 0xeab308;
const SOLID_COLOR = 0x64748b;
const OUTLINE_COLOR = 0x2f4a63;

/** Owns the three.js scene and keeps GPU objects in sync with model state. */
export class Viewer {
  readonly handles: SceneHandles;
  private readonly container: HTMLElement;
  private readonly bodyGroup = new THREE.Group();
  private readonly streamlines: StreamlineVisual[] = [];
  private maskGroup: THREE.Group | null = null;
  private raf = 0;
  private needsRender = true;
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private referenceVisuals: Line2[] = [];
  private highlight: THREE.Mesh | null = null;
  private hoverDot: THREE.Mesh | null = null;
  private axisLabels: THREE.Sprite[] = [];
  private placementPlane: THREE.Mesh | null = null;

  constructor(opts: ViewerOptions) {
    this.container = opts.container;
    const width = Math.max(1, opts.container.clientWidth);
    const height = Math.max(1, opts.container.clientHeight);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(width, height);
    renderer.setClearColor(0x0a0e14, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    opts.container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'viewport-canvas');

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0e14, 90, 320);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.05, 3000);
    camera.position.set(18, 20, 26);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.2;
    controls.maxDistance = 260;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 2, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(12, 28, 14);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fb2ff, 0.5);
    fill.position.set(-20, 8, -16);
    scene.add(fill);

    this.bodyGroup.add(this.maskGroup ?? new THREE.Group());
    scene.add(this.bodyGroup);

    const fieldGroup = new THREE.Group();
    const streamlineGroup = new THREE.Group();
    const seedGroup = new THREE.Group();
    const referenceGroup = new THREE.Group();
    const overlayGroup = new THREE.Group();
    scene.add(fieldGroup, streamlineGroup, seedGroup, referenceGroup, overlayGroup);

    this.handles = {
      renderer,
      scene,
      camera,
      controls,
      fieldGroup,
      streamlineGroup,
      seedGroup,
      referenceGroup,
      overlayGroup,
      dispose: () => this.dispose(),
    };

    this.addReferenceGround();
    this.addHoverDot();

    controls.addEventListener('change', () => {
      this.needsRender = true;
      this.updateLineResolutions();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(opts.container);
    window.addEventListener('resize', this.resize);

    this.resize();
    this.animate();
  }

  private addReferenceGround() {
    const grid = new THREE.GridHelper(80, 80, 0x24405a, 0x14212e);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = -0.001;
    this.handles.fieldGroup.add(grid);

    const axes = new THREE.AxesHelper(4);
    this.handles.fieldGroup.add(axes);
    this.addAxisLabels();
  }

  private addAxisLabels() {
    const makeLabel = (text: string, color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.font = 'bold 40px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 34);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sprite.scale.set(2.2, 1.1, 1);
      return sprite;
    };
    const labels: [THREE.Sprite, THREE.Vector3][] = [
      [makeLabel('x', '#ff6b6b'), new THREE.Vector3(4.6, 0.2, 0)],
      [makeLabel('y', '#6bffb3'), new THREE.Vector3(0, 0.2, -4.6)],
      [makeLabel('z', '#6bb6ff'), new THREE.Vector3(0, 4.6, 0)],
    ];
    for (const [sprite, pos] of labels) {
      sprite.position.copy(pos);
      this.handles.fieldGroup.add(sprite);
      this.axisLabels.push(sprite);
    }
  }

  private addHoverDot() {
    const geo = new THREE.SphereGeometry(0.09, 14, 10);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 });
    const dot = new THREE.Mesh(geo, mat);
    dot.renderOrder = 20;
    dot.visible = false;
    this.handles.overlayGroup.add(dot);
    this.hoverDot = dot;
  }

  setHoverDot(p: Vec3 | null) {
    if (!this.hoverDot) return;
    if (!p) {
      this.hoverDot.visible = false;
    } else {
      this.hoverDot.visible = true;
      this.hoverDot.position.copy(simToThree(p));
    }
    this.needsRender = true;
  }

  /** Rebuild field furniture (bounds, unavailable volumes, outline). */
  setField(backend: FieldBackend) {
    this.clearGroup(this.handles.fieldGroup, true);
    this.axisLabels = [];
    this.addReferenceGround();
    this.rebuildFieldDecor(backend);
    this.frameCamera(backend);
    this.reflowStreamlines();
    this.needsRender = true;
  }

  /**
   * Unavailable regions come from the backend's `maskBoxes()`, which already
   * merges contiguous cells against the real axis coordinates. That keeps
   * non-uniform grids and absent chunks geometrically honest without this
   * layer knowing the storage layout.
   */
  private rebuildFieldDecor(backend: FieldBackend) {
    const ext = backend.extent;
    const size = new THREE.Vector3(
      ext.max.x - ext.min.x,
      ext.max.z - ext.min.z,
      -(ext.max.y - ext.min.y),
    );
    const centre = simToThree({
      x: (ext.min.x + ext.max.x) / 2,
      y: (ext.min.y + ext.max.y) / 2,
      z: (ext.min.z + ext.max.z) / 2,
    });

    const boxGeo = new THREE.BoxGeometry(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z));
    const boxEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity: 0.85 }),
    );
    boxEdges.position.copy(centre);
    this.handles.fieldGroup.add(boxEdges);
    boxGeo.dispose();

    // Domain boundary planes are deliberately faint; the lattice itself is not drawn
    // densely because it would obscure streamlines.

    const maskGroup = new THREE.Group();
    const boxes = backend.maskBoxes();
    const byKind: Record<FieldMaskBox['kind'], FieldMaskBox[]> = {
      missing: [],
      solid: [],
      'missing-chunk': [],
    };
    for (const box of boxes) byKind[box.kind].push(box);

    const addBoxes = (kind: FieldMaskBox['kind'], items: FieldMaskBox[], color: number, opacity: number, edgeColor: number) => {
      if (!items.length) return;
      const m = this.buildBoxMesh(items, color, opacity, edgeColor);
      m.userData.maskKind = kind;
      maskGroup.add(m);
    };
    addBoxes('missing', byKind.missing, MISSING_COLOR, 0.05, 0xfb923c);
    addBoxes('missing-chunk', byKind['missing-chunk'], MISSING_CHUNK_COLOR, 0.12, 0xfacc15);
    addBoxes('solid', byKind.solid, SOLID_COLOR, 0.09, 0x94a3b8);
    this.maskGroup = maskGroup;
    this.handles.fieldGroup.add(maskGroup);
  }

  private buildBoxMesh(
    boxes: FieldMaskBox[],
    color: number,
    opacity: number,
    edgeColor: number,
  ): THREE.Group {
    const group = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Additive fill stays legible as a volume without a solid block hiding streamlines behind it.
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, boxes.length));
    const dummy = new THREE.Object3D();
    for (let idx = 0; idx < boxes.length; idx++) {
      const box = boxes[idx];
      // simToThree swaps y/z, so derive the three-space extent from both corners.
      const lo = simToThree(box.min);
      const hi = simToThree(box.max);
      dummy.position.set((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2);
      dummy.scale.set(
        Math.max(1e-4, Math.abs(hi.x - lo.x) * 0.96),
        Math.max(1e-4, Math.abs(hi.y - lo.y) * 0.96),
        Math.max(1e-4, Math.abs(hi.z - lo.z) * 0.96),
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
    }
    mesh.count = boxes.length;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);

    // A sampled wireframe marks the gap even where the fill is nearly transparent.
    const edgeGeo = new THREE.EdgesGeometry(geo);
    const edgeMat = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.55 });
    const maxEdges = 3000;
    const stride = Math.max(1, Math.ceil(boxes.length / maxEdges));
    for (let idx = 0; idx < boxes.length; idx += stride) {
      const box = boxes[idx];
      const lo = simToThree(box.min);
      const hi = simToThree(box.max);
      const seg = new THREE.LineSegments(edgeGeo, edgeMat);
      seg.position.set((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2);
      seg.scale.set(
        Math.max(1e-4, Math.abs(hi.x - lo.x) * 0.96),
        Math.max(1e-4, Math.abs(hi.y - lo.y) * 0.96),
        Math.max(1e-4, Math.abs(hi.z - lo.z) * 0.96),
      );
      group.add(seg);
    }
    edgeGeo.userData.shared = true;
    mat.userData.sharedEdgeMaterial = edgeMat;
    geo.dispose();
    return group;
  }

  frameCamera(backend: FieldBackend) {
    const ext = backend.extent;
    const centre = simToThree({
      x: (ext.min.x + ext.max.x) / 2,
      y: (ext.min.y + ext.max.y) / 2,
      z: (ext.min.z + ext.max.z) / 2,
    });
    const radius = Math.max(
      ext.max.x - ext.min.x,
      ext.max.y - ext.min.y,
      ext.max.z - ext.min.z,
      4,
    );
    this.handles.controls.target.copy(centre);
    const dir = new THREE.Vector3(0.62, 0.72, 0.6).normalize();
    this.handles.camera.position.copy(centre.clone().addScaledVector(dir, radius * 1.55));
    this.handles.camera.near = Math.max(0.03, radius / 5000);
    this.handles.camera.far = radius * 40;
    this.handles.camera.updateProjectionMatrix();
    this.handles.controls.update();
    this.needsRender = true;
  }

  private buildLineMaterial(linewidthPx: number, vertexColors: boolean): LineMaterial {
    const mat = new LineMaterial({
      linewidth: linewidthPx,
      vertexColors,
      worldUnits: false,
      alphaToCoverage: false,
      dashed: false,
    });
    mat.resolution.set(this.width, this.height);
    return mat;
  }

  addStreamline(
    result: StreamlineResult,
    opts: {
      label: string;
      seedIndex: number;
      scale: ColorScale;
      visible: boolean;
      selected: boolean;
      color: string;
    },
  ): StreamlineVisual {
    const count = result.positions.length / 3;
    const positions = new Float32Array(3 * count);
    const colors = new Float32Array(3 * count);
    const scalarArr = this.scalarArrayFor(result, opts.scale.label);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      simToThree(
        { x: result.positions[3 * i], y: result.positions[3 * i + 1], z: result.positions[3 * i + 2] },
        tmp,
      );
      positions[3 * i] = tmp.x;
      positions[3 * i + 1] = tmp.y;
      positions[3 * i + 2] = tmp.z;
      const value = scalarArr ? scalarArr[i] : result.speeds[i];
      const [r, g, b] = colorForValue(opts.scale, value);
      colors[3 * i] = r;
      colors[3 * i + 1] = g;
      colors[3 * i + 2] = b;
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const material = this.buildLineMaterial(opts.selected ? 3.6 : 2.1, true);
    const line = new Line2(geometry, material);
    line.userData.color = opts.color;
    line.computeLineDistances();
    line.frustumCulled = false;
    line.userData.streamlineId = result.seedId;
    this.handles.streamlineGroup.add(line);

    const visual: StreamlineVisual = {
      id: result.seedId,
      label: opts.label,
      visible: opts.visible,
      selected: opts.selected,
      color: opts.color,
      result,
      line,
      scale: opts.scale,
      seedIndex: opts.seedIndex,
    };
    this.streamlines.push(visual);
    this.needsRender = true;
    return visual;
  }

  private scalarArrayFor(result: StreamlineResult, label: string): Float32Array | null {
    if (label === '速度') return result.speeds;
    return result.scalars[label] ?? null;
  }

  removeStreamline(id: string) {
    const idx = this.streamlines.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const [visual] = this.streamlines.splice(idx, 1);
    this.handles.streamlineGroup.remove(visual.line);
    visual.line.geometry.dispose();
    (visual.line.material as THREE.Material).dispose();
    this.needsRender = true;
  }

  getStreamlineVisuals(): readonly StreamlineVisual[] {
    return this.streamlines;
  }

  setStreamlineVisible(id: string, visible: boolean) {
    const visual = this.streamlines.find((s) => s.id === id);
    if (!visual) return;
    visual.visible = visible;
    visual.line.visible = visible;
    this.needsRender = true;
  }

  setStreamlineSelected(id: string | null) {
    for (const visual of this.streamlines) {
      const selected = visual.id === id;
      visual.selected = selected;
      (visual.line.material as LineMaterial).linewidth = selected ? 3.8 : 2.1;
      (visual.line.material as LineMaterial).needsUpdate = true;
    }
    this.needsRender = true;
  }

  /** Update colour scale on all existing lines without re-integrating. */
  recolorStreamlines(scale: ColorScale) {
    for (const visual of this.streamlines) {
      const scalarArr = this.scalarArrayFor(visual.result, scale.label);
      const count = visual.result.positions.length / 3;
      const colors = new Float32Array(3 * count);
      for (let i = 0; i < count; i++) {
        const value = scalarArr ? scalarArr[i] : visual.result.speeds[i];
        const [r, g, b] = colorForValue(scale, value);
        colors[3 * i] = r;
        colors[3 * i + 1] = g;
        colors[3 * i + 2] = b;
      }
      visual.scale = scale;
      (visual.line.geometry as LineGeometry).setColors(colors);
      (visual.line.geometry as LineGeometry).attributes.instanceColorStart.needsUpdate = true;
      (visual.line.geometry as LineGeometry).attributes.instanceColorEnd.needsUpdate = true;
    }
    this.needsRender = true;
  }

  private reflowStreamlines() {
    // Field geometry did not change, so nothing to rebuild here; kept for future masks.
    this.needsRender = true;
  }

  addReferenceOverlay(points: Float32Array, color = 0xffffff) {
    this.clearReferenceOverlay();
    const count = points.length / 3;
    const positions = new Float32Array(3 * count);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      simToThree({ x: points[3 * i], y: points[3 * i + 1], z: points[3 * i + 2] }, tmp);
      positions[3 * i] = tmp.x;
      positions[3 * i + 1] = tmp.y;
      positions[3 * i + 2] = tmp.z;
    }
    const geo = new LineGeometry();
    geo.setPositions(positions);
    const mat = this.buildLineMaterial(1.4, false);
    mat.color = new THREE.Color(color);
    mat.transparent = true;
    mat.opacity = 0.85;
    mat.dashed = true;
    mat.dashSize = 0.35;
    mat.gapSize = 0.22;
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.frustumCulled = false;
    this.handles.referenceGroup.add(line);
    this.referenceVisuals.push(line);
    this.needsRender = true;
  }

  clearReferenceOverlay() {
    for (const line of this.referenceVisuals) {
      this.handles.referenceGroup.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.referenceVisuals = [];
    this.needsRender = true;
  }

  showSeedHandle(id: string, p: Vec3, color: string, index: number) {
    const existing = this.handles.seedGroup.getObjectByName(`seed-${id}`);
    if (existing) this.handles.seedGroup.remove(existing);
    const group = new THREE.Group();
    group.name = `seed-${id}`;
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.35),
      roughness: 0.35,
      metalness: 0.2,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), mat);
    sphere.position.copy(simToThree(p));
    sphere.userData.seedId = id;
    group.add(sphere);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.32, 0.025, 8, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    ring.position.copy(simToThree(p));
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    group.userData = { seedId: id, index };
    this.handles.seedGroup.add(group);
    this.needsRender = true;
  }

  removeSeedHandle(id: string) {
    const existing = this.handles.seedGroup.getObjectByName(`seed-${id}`);
    if (existing) {
      this.handles.seedGroup.remove(existing);
      this.needsRender = true;
    }
  }

  clearSeedHandles() {
    this.clearGroup(this.handles.seedGroup, false);
    this.needsRender = true;
  }

  setSeedDragging(id: string, dragging: boolean) {
    const handle = this.handles.seedGroup.getObjectByName(`seed-${id}`);
    if (!handle) return;
    handle.scale.setScalar(dragging ? 1.3 : 1);
    const ring = handle.children.find((c) => c instanceof THREE.Mesh && c.geometry.type === 'TorusGeometry') as
      | THREE.Mesh
      | undefined;
    if (ring) (ring.material as THREE.MeshBasicMaterial).opacity = dragging ? 1 : 0.9;
    this.needsRender = true;
  }

  setHighlight(p: Vec3 | null, color = 0xffffff) {
    if (!p) {
      if (this.highlight) {
        this.handles.overlayGroup.remove(this.highlight);
        this.highlight.geometry.dispose();
        (this.highlight.material as THREE.Material).dispose();
        this.highlight = null;
        this.needsRender = true;
      }
      return;
    }
    if (!this.highlight) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
      this.highlight = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), mat);
      this.highlight.renderOrder = 30;
      this.handles.overlayGroup.add(this.highlight);
    }
    (this.highlight.material as THREE.MeshBasicMaterial).color.set(color);
    this.highlight.position.copy(simToThree(p));
    this.highlight.visible = true;
    this.needsRender = true;
  }

  /** Translucent horizontal work plane where new seeds are placed (simulation z = z). */
  setPlacementPlane(z: number | null, extent?: { min: Vec3; max: Vec3 }) {
    if (z === null) {
      if (this.placementPlane) {
        this.handles.overlayGroup.remove(this.placementPlane);
        this.placementPlane.geometry.dispose();
        (this.placementPlane.material as THREE.Material).dispose();
        this.placementPlane = null;
        this.needsRender = true;
      }
      return;
    }
    const ext = extent;
    if (!ext) return;
    const w = Math.max(ext.max.x - ext.min.x, 0.1);
    const d = Math.max(ext.max.y - ext.min.y, 0.1);
    const geo = new THREE.PlaneGeometry(w, d);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4cc9f0,
      transparent: true,
      opacity: 0.055,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    if (this.placementPlane) {
      this.handles.overlayGroup.remove(this.placementPlane);
      this.placementPlane.geometry.dispose();
      (this.placementPlane.material as THREE.Material).dispose();
    }
    this.placementPlane = new THREE.Mesh(geo, mat);
    this.placementPlane.rotation.x = -Math.PI / 2;
    this.placementPlane.position.set((ext.min.x + ext.max.x) / 2, z, -(ext.min.y + ext.max.y) / 2);
    this.placementPlane.renderOrder = -1;
    this.handles.overlayGroup.add(this.placementPlane);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.3 }),
    );
    edges.rotation.copy(this.placementPlane.rotation);
    edges.position.copy(this.placementPlane.position);
    this.placementPlane.add(edges);
    this.needsRender = true;
  }

  /** Project simulation coordinate to CSS pixel coordinates. */
  project(p: Vec3): { x: number; y: number; visible: boolean; ndcZ: number } {
    const v = simToThree(p);
    v.project(this.handles.camera);
    return {
      x: ((v.x + 1) / 2) * this.width,
      y: ((1 - v.y) / 2) * this.height,
      visible: v.z > -1 && v.z < 1,
      ndcZ: v.z,
    };
  }

  /** Ray direction (world) through a CSS pixel on the canvas. */
  rayDirection(px: number, py: number): Vec3 {
    const ndc = new THREE.Vector2((px / this.width) * 2 - 1, -((py / this.height) * 2 - 1));
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.handles.camera);
    return { x: raycaster.ray.direction.x, y: raycaster.ray.direction.y, z: raycaster.ray.direction.z };
  }

  cameraEye(): Vec3 {
    return toVec3(this.handles.camera.position);
  }

  cameraForward(): Vec3 {
    const dir = new THREE.Vector3();
    this.handles.camera.getWorldDirection(dir);
    return toVec3(dir);
  }

  /** Ray from screen pixel intersecting a horizontal display plane at simulation z = planeZ. */
  screenToPlane(px: number, py: number, planeZ: number): Vec3 | null {
    const ndc = new THREE.Vector2((px / this.width) * 2 - 1, -((py / this.height) * 2 - 1));
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.handles.camera);
    // Display plane y = planeZ corresponds to sim z = planeZ.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeZ);
    const point = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(plane, point);
    if (!hit) return null;
    return threeToSim(point);
  }

  /** Distance in metres per pixel at a given world point (for cursor hints). */
  worldPerPixelAt(p: Vec3): number {
    const eye = this.handles.camera.position;
    const target = simToThree(p);
    const dist = eye.distanceTo(target);
    const fov = (this.handles.camera.fov * Math.PI) / 180;
    return (2 * dist * Math.tan(fov / 2)) / this.height;
  }

  private updateLineResolutions() {
    for (const visual of this.streamlines) {
      (visual.line.material as LineMaterial).resolution.set(this.width, this.height);
    }
    for (const line of this.referenceVisuals) {
      (line.material as LineMaterial).resolution.set(this.width, this.height);
    }
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.handles.renderer.setSize(w, h);
    this.handles.camera.aspect = w / h;
    this.handles.camera.updateProjectionMatrix();
    this.updateLineResolutions();
    this.needsRender = true;
  }

  requestRender() {
    this.needsRender = true;
  }

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate);
    this.handles.controls.update();
    if (this.needsRender) {
      this.handles.renderer.render(this.handles.scene, this.handles.camera);
      this.needsRender = false;
    }
  };

  /** Remove every descendant of the group's direct children; the group itself stays in the scene. */
  private clearGroup(group: THREE.Group, keepLights: boolean) {
    for (const child of [...group.children]) {
      if (keepLights && child instanceof THREE.Light) continue;
      if (child.parent) child.parent.remove(child);
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry?.dispose();
        }
      });
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.resizeObserver.disconnect();
    this.handles.renderer.dispose();
    this.handles.renderer.domElement.remove();
  }
}
