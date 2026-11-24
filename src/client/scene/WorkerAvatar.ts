import * as THREE from 'three';
import type { AgentActivityState, AgentRole, AgentSnapshot, AgentSource } from '../../shared/protocol.js';
import type { GridPoint } from './Pathfinding.js';
import { COZY_PALETTE, createVoxelBox } from './VoxelBuilder.js';

export type AvatarArchetype = AgentRole | 'jefe';

const SOURCE_ACCENT: Record<AgentSource, number> = {
  agy: 0x38bdf8,
  web: 0x0ea5e9,
  claude: 0xf97316,
  custom: 0x10b981,
  demo: 0x8b5cf6
};

const SKIN_TONES = [0xf5d0b5, 0xe8b896, 0xd49b72, 0xb0754d, 0xfadcc4];
const HAIR_COLORS = [0x2c1e16, 0x4a3123, 0x8d5b36, 0x1f2937, 0xd4a359];

export class WorkerAvatar {
  readonly group = new THREE.Group();
  readonly headTopLocalY = 1.92;

  private readonly bodyRoot = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly torsoGroup = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly mugProp = new THREE.Group();
  private readonly bookProp = new THREE.Group();
  private readonly firedBoxProp = new THREE.Group();
  private readonly alertBeacon: THREE.Mesh;
  private readonly selectionRing: THREE.Mesh;

  private path: GridPoint[] = [];
  private targetFacing = 0;
  private walkPhase = 0;
  private actionPhase = Math.random() * Math.PI * 2;
  private currentState: AgentActivityState = 'idle';
  private isMoving = false;
  private isSeatedTarget = false;
  private snapshot: AgentSnapshot | null = null;

  constructor(
    readonly id: string,
    archetype: AvatarArchetype,
    source: AgentSource = 'agy',
    seedKey = id
  ) {
    const hash = hashString(seedKey);
    const skin = SKIN_TONES[hash % SKIN_TONES.length];
    const hair = HAIR_COLORS[(hash >> 3) % HAIR_COLORS.length];
    const accent = SOURCE_ACCENT[source] ?? 0x38bdf8;

    const shirtColor =
      archetype === 'jefe'
        ? 0x1e293b
        : archetype === 'coordinator'
          ? 0x334155
          : archetype === 'researcher'
            ? 0x5f7464
            : 0x475569;

    const pantsColor = archetype === 'jefe' ? 0x0f172a : 0x2b3340;

    // Legs (pivot at hip y = 0.56)
    this.leftLeg.position.set(-0.12, 0.56, 0);
    this.leftLeg.add(createVoxelBox(0.18, 0.56, 0.18, pantsColor, { y: -0.28 }));
    this.rightLeg.position.set(0.12, 0.56, 0);
    this.rightLeg.add(createVoxelBox(0.18, 0.56, 0.18, pantsColor, { y: -0.28 }));
    this.bodyRoot.add(this.leftLeg, this.rightLeg);

    // Torso
    this.torsoGroup.position.set(0, 0.88, 0);
    this.torsoGroup.add(createVoxelBox(0.46, 0.56, 0.28, shirtColor));

    if (archetype === 'jefe') {
      // White shirt V + gold executive pin
      this.torsoGroup.add(createVoxelBox(0.14, 0.34, 0.3, 0xf8fafc, { y: 0.08 }));
      this.torsoGroup.add(createVoxelBox(0.06, 0.06, 0.31, COZY_PALETTE.brass, { x: 0.13, y: 0.12 }));
    } else if (archetype === 'coordinator') {
      // Lanyard badge
      this.torsoGroup.add(createVoxelBox(0.08, 0.44, 0.3, accent, { y: 0.04 }));
    } else if (archetype === 'builder') {
      // Hoodie pocket / stripe
      this.torsoGroup.add(createVoxelBox(0.32, 0.14, 0.3, accent, { y: -0.14 }));
    } else if (archetype === 'researcher') {
      // Cardigan buttons
      this.torsoGroup.add(createVoxelBox(0.12, 0.46, 0.3, 0xe7dccb, { y: 0.02 }));
    }
    this.bodyRoot.add(this.torsoGroup);

    // Arms (pivot at shoulder y = 1.1)
    this.leftArm.position.set(-0.31, 1.1, 0);
    this.leftArm.add(createVoxelBox(0.14, 0.48, 0.16, shirtColor, { y: -0.2 }));
    this.leftArm.add(createVoxelBox(0.13, 0.11, 0.14, skin, { y: -0.45 }));

    this.rightArm.position.set(0.31, 1.1, 0);
    this.rightArm.add(createVoxelBox(0.14, 0.48, 0.16, shirtColor, { y: -0.2 }));
    this.rightArm.add(createVoxelBox(0.13, 0.11, 0.14, skin, { y: -0.45 }));
    this.bodyRoot.add(this.leftArm, this.rightArm);

    // Head
    this.headGroup.position.set(0, 1.4, 0);
    this.headGroup.add(createVoxelBox(0.42, 0.42, 0.42, skin));
    // Eyes
    this.headGroup.add(createVoxelBox(0.06, 0.06, 0.04, 0x18181b, { x: -0.1, y: 0.02, z: 0.21, castShadow: false }));
    this.headGroup.add(createVoxelBox(0.06, 0.06, 0.04, 0x18181b, { x: 0.1, y: 0.02, z: 0.21, castShadow: false }));
    // Hair cap
    this.headGroup.add(createVoxelBox(0.45, 0.14, 0.45, hair, { y: 0.2 }));
    this.headGroup.add(createVoxelBox(0.45, 0.28, 0.1, hair, { y: 0.04, z: -0.19 }));

    if (archetype === 'researcher') {
      // Voxel eyeglasses
      this.headGroup.add(createVoxelBox(0.14, 0.1, 0.05, 0x1f2937, { x: -0.1, y: 0.02, z: 0.22, castShadow: false }));
      this.headGroup.add(createVoxelBox(0.14, 0.1, 0.05, 0x1f2937, { x: 0.1, y: 0.02, z: 0.22, castShadow: false }));
      this.headGroup.add(createVoxelBox(0.08, 0.03, 0.05, 0x1f2937, { x: 0, y: 0.03, z: 0.22, castShadow: false }));
    } else if (archetype === 'builder') {
      // Over-ear headphones tinted with engine accent
      this.headGroup.add(createVoxelBox(0.5, 0.07, 0.1, 0x1f2937, { y: 0.28 }));
      this.headGroup.add(createVoxelBox(0.08, 0.18, 0.18, accent, { x: -0.25, y: 0.04 }));
      this.headGroup.add(createVoxelBox(0.08, 0.18, 0.18, accent, { x: 0.25, y: 0.04 }));
    }
    this.bodyRoot.add(this.headGroup);

    // Props
    this.mugProp.position.set(0.32, 0.85, 0.26);
    this.mugProp.add(createVoxelBox(0.14, 0.16, 0.14, 0xf8fafc));
    this.mugProp.add(createVoxelBox(0.1, 0.04, 0.1, COZY_PALETTE.coffeeDark, { y: 0.07 }));
    this.mugProp.visible = false;
    this.bodyRoot.add(this.mugProp);

    this.bookProp.position.set(0, 0.86, 0.34);
    this.bookProp.add(createVoxelBox(0.32, 0.06, 0.24, 0x2b6cb0));
    this.bookProp.add(createVoxelBox(0.28, 0.07, 0.2, 0xfef3c7, { y: 0.01 }));
    this.bookProp.visible = false;
    this.bodyRoot.add(this.bookProp);

    // Fired cardboard box prop
    this.firedBoxProp.position.set(0, 0.9, 0.38);
    this.firedBoxProp.add(createVoxelBox(0.48, 0.36, 0.36, 0xb88652));
    this.firedBoxProp.add(createVoxelBox(0.5, 0.05, 0.12, 0xe7d2b5, { y: 0.17 }));
    this.firedBoxProp.visible = false;
    this.bodyRoot.add(this.firedBoxProp);

    // Alert beacon above head (error / asking_boss)
    this.alertBeacon = createVoxelBox(0.18, 0.18, 0.18, 0xef4444, {
      y: 1.98,
      emissiveHex: 0xef4444,
      emissiveIntensity: 0.7,
      castShadow: false
    });
    this.alertBeacon.visible = false;
    this.bodyRoot.add(this.alertBeacon);

    // Selection ring on floor
    const ringGeo = new THREE.RingGeometry(0.42, 0.54, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x0f766e,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.position.y = 0.03;
    this.selectionRing.visible = false;
    this.group.add(this.selectionRing);

    this.group.add(this.bodyRoot);

    this.tagPickable(archetype === 'jefe');
  }

  private tagPickable(isBoss: boolean): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (isBoss) {
          obj.userData.isBoss = true;
        } else {
          obj.userData.agentId = this.id;
        }
      }
    });
  }

  setSnapshot(snapshot: AgentSnapshot): void {
    this.snapshot = snapshot;
    this.currentState = snapshot.state;
  }

  getSnapshot(): AgentSnapshot | null {
    return this.snapshot;
  }

  setSelected(selected: boolean): void {
    this.selectionRing.visible = selected;
  }

  setRoute(path: GridPoint[], finalFacing: number, seatedAtGoal: boolean): void {
    this.path = path;
    this.targetFacing = finalFacing;
    this.isSeatedTarget = seatedAtGoal;
    this.isMoving = path.length > 0;
  }

  snapTo(x: number, z: number, facing: number, seated: boolean): void {
    this.group.position.set(x, 0, z);
    this.bodyRoot.rotation.y = facing;
    this.targetFacing = facing;
    this.path = [];
    this.isMoving = false;
    this.isSeatedTarget = seated;
  }

  getWorldHeadPosition(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(this.group.position.x, this.bodyRoot.position.y + this.headTopLocalY, this.group.position.z);
    return out;
  }

  isWalking(): boolean {
    return this.isMoving;
  }

  update(dt: number, bossAlertPulse = false): void {
    this.actionPhase += dt * 4.5;

    if (this.path.length > 0) {
      const next = this.path[0];
      const dx = next.x - this.group.position.x;
      const dz = next.z - this.group.position.z;
      const dist = Math.hypot(dx, dz);
      const speed = this.currentState === 'fired' ? 3.4 : 2.9;

      if (dist < 0.08) {
        this.group.position.x = next.x;
        this.group.position.z = next.z;
        this.path.shift();
        if (this.path.length === 0) {
          this.isMoving = false;
        }
      } else {
        const step = Math.min(dist, speed * dt);
        this.group.position.x += (dx / dist) * step;
        this.group.position.z += (dz / dist) * step;
        const moveAngle = Math.atan2(dx, dz);
        this.bodyRoot.rotation.y = lerpAngle(this.bodyRoot.rotation.y, moveAngle, Math.min(1, dt * 12));
        this.walkPhase += dt * 11;
      }
    } else {
      this.isMoving = false;
      this.bodyRoot.rotation.y = lerpAngle(this.bodyRoot.rotation.y, this.targetFacing, Math.min(1, dt * 8));
    }

    // Reset props visibility
    this.mugProp.visible = false;
    this.bookProp.visible = false;
    this.firedBoxProp.visible = false;
    this.alertBeacon.visible = false;

    if (this.isMoving) {
      this.bodyRoot.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.06;
      this.leftLeg.rotation.x = Math.sin(this.walkPhase) * 0.55;
      this.rightLeg.rotation.x = -Math.sin(this.walkPhase) * 0.55;

      if (this.currentState === 'fired') {
        this.firedBoxProp.visible = true;
        this.leftArm.rotation.x = -0.95;
        this.rightArm.rotation.x = -0.95;
      } else {
        this.leftArm.rotation.x = -Math.sin(this.walkPhase) * 0.45;
        this.rightArm.rotation.x = Math.sin(this.walkPhase) * 0.45;
      }
      this.headGroup.rotation.y = 0;
      this.headGroup.rotation.x = 0;
      return;
    }

    // Stationary animations by state
    if (this.isSeatedTarget) {
      this.bodyRoot.position.y = -0.18;
      this.leftLeg.rotation.x = -1.25;
      this.rightLeg.rotation.x = -1.25;
    } else {
      this.bodyRoot.position.y = 0;
      this.leftLeg.rotation.x = 0;
      this.rightLeg.rotation.x = 0;
    }

    if (this.currentState === 'coding') {
      // Fast typing motion
      this.leftArm.rotation.x = -0.95 + Math.sin(this.actionPhase * 2.5) * 0.16;
      this.rightArm.rotation.x = -0.95 + Math.cos(this.actionPhase * 2.5) * 0.16;
      this.headGroup.rotation.x = 0.08;
      this.headGroup.rotation.y = Math.sin(this.actionPhase * 0.4) * 0.08;
    } else if (this.currentState === 'reading') {
      this.bookProp.visible = true;
      this.leftArm.rotation.x = -0.85;
      this.rightArm.rotation.x = -0.85;
      this.headGroup.rotation.x = 0.2;
      this.headGroup.rotation.y = Math.sin(this.actionPhase * 0.5) * 0.14;
    } else if (this.currentState === 'coffee') {
      this.mugProp.visible = true;
      this.rightArm.rotation.x = -0.8 + Math.sin(this.actionPhase * 0.4) * 0.18;
      this.leftArm.rotation.x = -0.25;
      this.headGroup.rotation.x = Math.sin(this.actionPhase * 0.4) * 0.06;
      this.headGroup.rotation.y = Math.sin(this.actionPhase * 0.3) * 0.18;
    } else if (this.currentState === 'planning' || this.currentState === 'terminal') {
      this.leftArm.rotation.x = -0.5 + Math.sin(this.actionPhase) * 0.18;
      this.rightArm.rotation.x = -0.7 + Math.cos(this.actionPhase) * 0.2;
      this.headGroup.rotation.y = Math.sin(this.actionPhase * 0.5) * 0.22;
      this.headGroup.rotation.x = 0;
    } else if (this.currentState === 'asking_boss') {
      this.leftArm.rotation.x = -0.15;
      this.rightArm.rotation.x = -1.6 + Math.sin(this.actionPhase * 1.4) * 0.22;
      this.alertBeacon.visible = true;
      const mat = this.alertBeacon.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xf59e0b);
      mat.emissive.setHex(0xf59e0b);
      this.alertBeacon.position.y = 1.98 + Math.sin(this.actionPhase * 1.6) * 0.08;
    } else if (this.currentState === 'error') {
      this.leftArm.rotation.x = -2.2;
      this.rightArm.rotation.x = -2.2;
      this.alertBeacon.visible = true;
      const mat = this.alertBeacon.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xef4444);
      mat.emissive.setHex(0xef4444);
      this.alertBeacon.position.y = 1.98 + Math.abs(Math.sin(this.actionPhase * 2)) * 0.12;
    } else if (this.currentState === 'fired') {
      this.firedBoxProp.visible = true;
      this.leftArm.rotation.x = -0.95;
      this.rightArm.rotation.x = -0.95;
    } else {
      // Idle / Boss default
      this.leftArm.rotation.x = this.isSeatedTarget ? -0.65 : Math.sin(this.actionPhase * 0.3) * 0.06;
      this.rightArm.rotation.x = this.isSeatedTarget ? -0.65 : -Math.sin(this.actionPhase * 0.3) * 0.06;
      this.headGroup.rotation.y = bossAlertPulse
        ? Math.sin(this.actionPhase * 1.2) * 0.25
        : Math.sin(this.actionPhase * 0.25) * 0.12;
      this.headGroup.rotation.x = 0;
      if (bossAlertPulse) {
        this.alertBeacon.visible = true;
        const mat = this.alertBeacon.material as THREE.MeshStandardMaterial;
        mat.color.setHex(0xf59e0b);
        mat.emissive.setHex(0xf59e0b);
        this.alertBeacon.position.y = 1.98 + Math.sin(this.actionPhase * 1.8) * 0.09;
      }
    }
  }
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lerpAngle(current: number, target: number, t: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * t;
}
