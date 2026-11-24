import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { AgentActivityState, AgentSnapshot, BossRequest, OfficeMetrics } from '../../shared/protocol.js';
import { LightingCycle, type LightingMode } from './LightingCycle.js';
import { OfficePathfinder } from './Pathfinding.js';
import { MetricsWall } from './MetricsWall.js';
import { WorkerAvatar } from './WorkerAvatar.js';
import { type StationSlot, ZonesAndProps } from './ZonesAndProps.js';

export interface BubbleProjection {
  agentId: string;
  name: string;
  state: AgentActivityState;
  statusText: string;
  screenX: number;
  screenY: number;
  selected: boolean;
}

export class OfficeWorld {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly pathfinder = new OfficePathfinder();
  private readonly lighting: LightingCycle;
  private readonly zones: ZonesAndProps;
  private readonly metricsWall: MetricsWall;
  private readonly bossAvatar: WorkerAvatar;
  private readonly workers = new Map<string, WorkerAvatar>();
  private readonly lastRouteKey = new Map<string, string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerDownPos = { x: 0, y: 0 };

  private selectedAgentId: string | null = null;
  private currentMetrics: OfficeMetrics = {
    activeAgents: 0,
    loungingAgents: 0,
    totalToolsRun: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    deskCapacity: 4,
    bySource: { agy: 0, claude: 0, custom: 0, web: 0, demo: 0 },
    activityHistory: new Array(20).fill(0)
  };
  private bossQueue: BossRequest[] = [];
  private cameraAzimuthStep = 0;

  private readonly frustumSize = 24;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSelectAgent: (agentId: string | null) => void,
    private readonly onClickBoss: () => void
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera = new THREE.OrthographicCamera(
      (-this.frustumSize * aspect) / 2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      -this.frustumSize / 2,
      0.1,
      150
    );

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minZoom = 0.55;
    this.controls.maxZoom = 2.4;
    this.controls.maxPolarAngle = Math.PI / 2.25;
    this.controls.minPolarAngle = Math.PI / 6;

    this.lighting = new LightingCycle(this.scene);
    this.zones = new ZonesAndProps(this.pathfinder, this.lighting);
    this.scene.add(this.zones.group);

    this.metricsWall = new MetricsWall();
    this.scene.add(this.metricsWall.group);

    this.bossAvatar = new WorkerAvatar('__jefe__', 'jefe', 'agy', 'jefe');
    this.bossAvatar.snapTo(
      this.zones.bossAvatarSpot.x,
      this.zones.bossAvatarSpot.z,
      this.zones.bossAvatarSpot.facing,
      this.zones.bossAvatarSpot.seated
    );
    this.scene.add(this.bossAvatar.group);

    this.resetCamera();

    window.addEventListener('resize', this.handleResize);
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointerup', this.handlePointerUp);
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.renderer.dispose();
  }

  setLightingMode(mode: LightingMode): void {
    this.lighting.setMode(mode);
    this.metricsWall.update(this.currentMetrics, this.lighting.getActivePhaseLabel(), true);
  }

  rotateCamera90(): void {
    this.cameraAzimuthStep = (this.cameraAzimuthStep + 1) % 4;
    const angles = [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4];
    const angle = angles[this.cameraAzimuthStep];
    const target = this.controls.target.clone();
    const radius = 34;
    this.camera.position.set(
      target.x + Math.sin(angle) * radius,
      24,
      target.z + Math.cos(angle) * radius
    );
    this.controls.update();
  }

  resetCamera(): void {
    this.cameraAzimuthStep = 0;
    this.controls.target.set(0, 0.5, -1.5);
    this.camera.position.set(24, 24, 24);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setSelectedAgent(agentId: string | null): void {
    this.selectedAgentId = agentId;
    for (const [id, avatar] of this.workers.entries()) {
      avatar.setSelected(id === agentId);
    }
  }

  syncState(agents: AgentSnapshot[], bossQueue: BossRequest[], metrics: OfficeMetrics): void {
    this.bossQueue = bossQueue;
    this.currentMetrics = metrics;

    let highestDesk = 3;
    for (const a of agents) {
      if (a.deskIndex !== null && a.deskIndex > highestDesk) {
        highestDesk = a.deskIndex;
      }
    }
    const neededPods = Math.max(1, Math.ceil((highestDesk + 1) / 4));
    this.zones.ensureDeskPods(neededPods, true);

    const activeIds = new Set(agents.map((a) => a.id));
    for (const id of Array.from(this.workers.keys())) {
      if (!activeIds.has(id)) {
        this.removeWorker(id);
      }
    }

    for (const agent of agents) {
      this.upsertWorker(agent);
    }

    this.metricsWall.update(metrics, this.lighting.getActivePhaseLabel(), true);
  }

  upsertWorker(agent: AgentSnapshot): void {
    if (agent.deskIndex !== null) {
      const neededPods = Math.max(1, Math.ceil((agent.deskIndex + 1) / 4));
      this.zones.ensureDeskPods(neededPods, true);
    }

    let avatar = this.workers.get(agent.id);
    if (!avatar) {
      avatar = new WorkerAvatar(agent.id, agent.role, agent.source, agent.name + agent.id);
      avatar.snapTo(
        this.zones.elevatorInsideSpot.x,
        this.zones.elevatorInsideSpot.z,
        Math.PI / 2,
        false
      );
      this.zones.triggerElevatorDoors();
      this.workers.set(agent.id, avatar);
      this.scene.add(avatar.group);
    }

    avatar.setSelected(agent.id === this.selectedAgentId);
    avatar.setSnapshot(agent);

    const slot = this.resolveTargetSlot(agent);
    const routeKey = `${agent.state}:${slot.x.toFixed(1)},${slot.z.toFixed(1)}`;
    if (this.lastRouteKey.get(agent.id) !== routeKey) {
      this.lastRouteKey.set(agent.id, routeKey);
      if (agent.state === 'fired' || agent.state === 'leaving') {
        this.zones.triggerElevatorDoors();
      }
      const startPt = { x: avatar.group.position.x, z: avatar.group.position.z };
      const path = this.pathfinder.findPath(startPt, { x: slot.x, z: slot.z });
      avatar.setRoute(path, slot.facing, slot.seated);
    }
  }

  removeWorker(agentId: string): void {
    const avatar = this.workers.get(agentId);
    if (!avatar) return;
    this.scene.remove(avatar.group);
    this.workers.delete(agentId);
    this.lastRouteKey.delete(agentId);
  }

  updateMetrics(metrics: OfficeMetrics): void {
    this.currentMetrics = metrics;
    this.metricsWall.update(metrics, this.lighting.getActivePhaseLabel(), false);
  }

  setBossQueue(bossQueue: BossRequest[]): void {
    this.bossQueue = bossQueue;
  }

  update(dt: number): BubbleProjection[] {
    this.controls.update();
    this.lighting.update(dt);

    let hasErrorWorker = false;
    const occupiedDesks = new Set<number>();

    for (const avatar of this.workers.values()) {
      avatar.update(dt);
      const snap = avatar.getSnapshot();
      if (!snap) continue;
      if (snap.state === 'error') {
        hasErrorWorker = true;
      }
      if (snap.deskIndex !== null && snap.state === 'coding' && !avatar.isWalking()) {
        occupiedDesks.add(snap.deskIndex);
      }
    }

    // Light up desk screens for actively coding workers
    for (const desk of this.zones.desks) {
      const targetEmissive = occupiedDesks.has(desk.index) ? 0.95 : 0.08;
      desk.monitorScreenMat.emissiveIntensity +=
        (targetEmissive - desk.monitorScreenMat.emissiveIntensity) * Math.min(1, dt * 6);
    }

    this.bossAvatar.update(dt, this.bossQueue.length > 0);
    this.zones.update(dt, hasErrorWorker);
    this.metricsWall.update(this.currentMetrics, this.lighting.getActivePhaseLabel(), false);

    this.renderer.render(this.scene, this.camera);

    return this.projectBubbles();
  }

  private projectBubbles(): BubbleProjection[] {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const vec = new THREE.Vector3();
    const out: BubbleProjection[] = [];

    for (const avatar of this.workers.values()) {
      const snap = avatar.getSnapshot();
      if (!snap) continue;
      avatar.getWorldHeadPosition(vec);
      vec.project(this.camera);
      if (vec.z > 1) continue;
      const sx = (vec.x * 0.5 + 0.5) * width;
      const sy = (-vec.y * 0.5 + 0.5) * height;
      out.push({
        agentId: snap.id,
        name: snap.name,
        state: snap.state,
        statusText: snap.statusText,
        screenX: sx,
        screenY: sy,
        selected: snap.id === this.selectedAgentId
      });
    }
    return out;
  }

  private resolveTargetSlot(agent: AgentSnapshot): StationSlot {
    const seed = hashIndex(agent.id);
    if (agent.state === 'fired' || agent.state === 'leaving') {
      return { x: this.zones.elevatorInsideSpot.x, z: this.zones.elevatorInsideSpot.z, facing: -Math.PI / 2, seated: false };
    }
    if (agent.state === 'asking_boss') {
      return this.zones.bossVisitorSpots[seed % this.zones.bossVisitorSpots.length];
    }
    if (agent.state === 'planning') {
      return this.zones.boardroomSpots[seed % this.zones.boardroomSpots.length];
    }
    if (agent.state === 'reading') {
      return this.zones.librarySpots[seed % this.zones.librarySpots.length];
    }
    if (agent.state === 'terminal') {
      return this.zones.serverSpots[seed % this.zones.serverSpots.length];
    }
    if (agent.state === 'coffee') {
      return this.zones.coffeeSpots[seed % this.zones.coffeeSpots.length];
    }
    if (agent.deskIndex !== null && this.zones.desks[agent.deskIndex]) {
      return this.zones.desks[agent.deskIndex].seat;
    }
    return this.zones.elevatorSpot;
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    const aspect = width / height;
    this.camera.left = (-this.frustumSize * aspect) / 2;
    this.camera.right = (this.frustumSize * aspect) / 2;
    this.camera.top = this.frustumSize / 2;
    this.camera.bottom = -this.frustumSize / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.pointerDownPos.x = e.clientX;
    this.pointerDownPos.y = e.clientY;
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (dist > 6) return;

    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );

    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [this.bossAvatar.group];
    for (const avatar of this.workers.values()) {
      targets.push(avatar.group);
    }

    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) {
      this.onSelectAgent(null);
      return;
    }

    const firstHit = hits[0].object;
    if (firstHit.userData.isBoss) {
      this.onClickBoss();
      return;
    }
    const agentId = typeof firstHit.userData.agentId === 'string' ? firstHit.userData.agentId : null;
    this.onSelectAgent(agentId);
  };
}

function hashIndex(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) {
    sum += id.charCodeAt(i);
  }
  return sum;
}
