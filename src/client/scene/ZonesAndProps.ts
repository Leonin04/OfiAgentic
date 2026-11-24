import * as THREE from 'three';
import type { LightingCycle } from './LightingCycle.js';
import type { GridPoint, OfficePathfinder } from './Pathfinding.js';
import { COZY_PALETTE, createVoxelBox, getVoxelMaterial } from './VoxelBuilder.js';

export interface StationSlot extends GridPoint {
  facing: number;
  seated: boolean;
}

export interface DeskUnit {
  index: number;
  seat: StationSlot;
  monitorScreenMat: THREE.MeshStandardMaterial;
  lampLight: THREE.PointLight;
  lampShadeMat: THREE.MeshStandardMaterial;
}

interface PodAnimation {
  group: THREE.Group;
  elapsed: number;
  duration: number;
  startY: number;
}

interface SteamParticle {
  mesh: THREE.Mesh;
  age: number;
  speed: number;
}

export class ZonesAndProps {
  readonly group = new THREE.Group();
  readonly desks: DeskUnit[] = [];
  readonly bossAvatarSpot: StationSlot = { x: -0.5, z: -8.7, facing: 0, seated: true };
  readonly elevatorSpot: StationSlot = { x: -11.4, z: 1.5, facing: Math.PI / 2, seated: false };
  readonly elevatorInsideSpot: GridPoint = { x: -13.1, z: 1.5 };

  readonly bossVisitorSpots: StationSlot[] = [
    { x: -1.6, z: -5.6, facing: Math.PI, seated: false },
    { x: 0.6, z: -5.6, facing: Math.PI, seated: false },
    { x: -0.5, z: -4.8, facing: Math.PI, seated: false }
  ];

  readonly boardroomSpots: StationSlot[] = [
    { x: 7.4, z: -7.2, facing: Math.PI / 2, seated: true },
    { x: 11.6, z: -7.2, facing: -Math.PI / 2, seated: true },
    { x: 9.5, z: -5.3, facing: Math.PI, seated: true },
    { x: 9.5, z: -9.1, facing: 0, seated: true }
  ];

  readonly librarySpots: StationSlot[] = [
    { x: 10.6, z: -1.4, facing: Math.PI / 2, seated: false },
    { x: 10.6, z: 0.8, facing: Math.PI / 2, seated: false },
    { x: 10.6, z: 3.0, facing: Math.PI / 2, seated: false },
    { x: 8.6, z: 2.0, facing: 0, seated: false }
  ];

  readonly serverSpots: StationSlot[] = [
    { x: -8.6, z: -8.8, facing: -Math.PI / 2, seated: false },
    { x: -8.6, z: -6.8, facing: -Math.PI / 2, seated: false },
    { x: -8.6, z: -4.8, facing: -Math.PI / 2, seated: false },
    { x: -9.8, z: -3.8, facing: Math.PI, seated: false }
  ];

  readonly coffeeSpots: StationSlot[] = [
    { x: -9.5, z: 7.1, facing: Math.PI, seated: true },
    { x: -8.5, z: 7.1, facing: Math.PI, seated: true },
    { x: -7.5, z: 7.1, facing: Math.PI, seated: true },
    { x: -10.3, z: 5.5, facing: -Math.PI / 2, seated: false },
    { x: -6.8, z: 5.6, facing: -Math.PI / 2, seated: false }
  ];

  private podCount = 0;
  private readonly floorExtensions = new THREE.Group();
  private readonly podsGroup = new THREE.Group();
  private readonly podAnimations: PodAnimation[] = [];
  private readonly serverLeds: THREE.MeshStandardMaterial[] = [];
  private readonly steamParticles: SteamParticle[] = [];
  private elevatorLeftDoor!: THREE.Mesh;
  private elevatorRightDoor!: THREE.Mesh;
  private elevatorOpenTimer = 0;

  constructor(
    private readonly pathfinder: OfficePathfinder,
    private readonly lighting: LightingCycle
  ) {
    this.group.add(this.floorExtensions);
    this.group.add(this.podsGroup);

    this.buildBaseFloorAndWalls();
    this.buildBossOffice();
    this.buildBoardroom();
    this.buildLibrary();
    this.buildServerRoom();
    this.buildCafeAndElevator();

    this.ensureDeskPods(1, false);
  }

  ensureDeskPods(neededPods: number, animateNew = true): void {
    const targetPods = Math.max(1, neededPods);
    if (targetPods <= this.podCount) return;

    while (this.podCount < targetPods) {
      const podIdx = this.podCount;
      this.createDeskPod(podIdx, animateNew && podIdx > 0);
      this.podCount += 1;
    }

    this.rebuildNavObstacles();
  }

  getMaxZ(): number {
    return 9 + Math.max(0, this.podCount - 1) * 7;
  }

  triggerElevatorDoors(): void {
    this.elevatorOpenTimer = 2.6;
  }

  update(dt: number, hasErrorWorker: boolean): void {
    // Animate newly expanded pods dropping smoothly
    for (let i = this.podAnimations.length - 1; i >= 0; i -= 1) {
      const anim = this.podAnimations[i];
      anim.elapsed += dt;
      const t = Math.min(1, anim.elapsed / anim.duration);
      const eased = easeOutBack(t);
      anim.group.position.y = anim.startY * (1 - eased);
      if (t >= 1) {
        anim.group.position.y = 0;
        this.podAnimations.splice(i, 1);
      }
    }

    // Server rack LEDs blink green/cyan normally, red when error occurs
    const blink = Math.sin(performance.now() * 0.008) > 0;
    this.serverLeds.forEach((mat, idx) => {
      if (hasErrorWorker) {
        mat.color.setHex(0xef4444);
        mat.emissive.setHex(0xef4444);
        mat.emissiveIntensity = blink ? 1.5 : 0.25;
      } else {
        const normalColor = idx % 2 === 0 ? 0x22c55e : 0x38bdf8;
        mat.color.setHex(normalColor);
        mat.emissive.setHex(normalColor);
        mat.emissiveIntensity = (Math.sin(performance.now() * 0.005 + idx) > -0.2) ? 1.1 : 0.25;
      }
    });

    // Coffee machine voxel steam
    for (const p of this.steamParticles) {
      p.age += dt * p.speed;
      if (p.age > 1) {
        p.age = 0;
      }
      p.mesh.position.y = 1.45 + p.age * 1.1;
      const scale = 0.08 + (1 - p.age) * 0.08;
      p.mesh.scale.set(scale, scale, scale);
      (p.mesh.material as THREE.MeshStandardMaterial).opacity = (1 - p.age) * 0.55;
    }

    // Elevator sliding doors
    if (this.elevatorOpenTimer > 0) {
      this.elevatorOpenTimer = Math.max(0, this.elevatorOpenTimer - dt);
    }
    const targetOpen = this.elevatorOpenTimer > 0 ? 0.72 : 0;
    const leftTargetZ = 1.5 - 0.36 - targetOpen;
    const rightTargetZ = 1.5 + 0.36 + targetOpen;
    this.elevatorLeftDoor.position.z += (leftTargetZ - this.elevatorLeftDoor.position.z) * Math.min(1, dt * 8);
    this.elevatorRightDoor.position.z += (rightTargetZ - this.elevatorRightDoor.position.z) * Math.min(1, dt * 8);
  }

  private buildBaseFloorAndWalls(): void {
    // Main base floor slab: x [-14..14] (28), z [-12..9.5] (21.5)
    const baseFloor = createVoxelBox(28.4, 0.3, 21.8, COZY_PALETTE.floorWoodA, {
      x: 0,
      y: -0.15,
      z: -1.25
    });
    this.group.add(baseFloor);

    // Subtle wooden plank grid strips
    for (let x = -13; x <= 13; x += 2) {
      this.group.add(
        createVoxelBox(0.96, 0.02, 21.4, COZY_PALETTE.floorWoodB, {
          x,
          y: 0.01,
          z: -1.25,
          castShadow: false
        })
      );
    }

    // North Wall
    this.group.add(
      createVoxelBox(28.4, 4.4, 0.5, COZY_PALETTE.wallCream, {
        x: 0,
        y: 2.2,
        z: -12.1
      })
    );
    this.group.add(
      createVoxelBox(28.4, 1.1, 0.56, COZY_PALETTE.wallWainscot, {
        x: 0,
        y: 0.55,
        z: -12.08
      })
    );

    // West Wall (partial low cutaway near south for visibility)
    this.group.add(
      createVoxelBox(0.5, 4.4, 13.0, COZY_PALETTE.wallCream, {
        x: -14.1,
        y: 2.2,
        z: -5.8
      })
    );
    this.group.add(
      createVoxelBox(0.56, 1.1, 21.8, COZY_PALETTE.wallWainscot, {
        x: -14.08,
        y: 0.55,
        z: -1.25
      })
    );

    // Sunlit Windows on North Wall flanks
    for (const wx of [-9.2, 9.2]) {
      this.group.add(createVoxelBox(4.2, 2.2, 0.14, COZY_PALETTE.walnut, { x: wx, y: 2.6, z: -11.82 }));
      this.group.add(
        createVoxelBox(3.8, 1.85, 0.16, COZY_PALETTE.glassBlue, {
          x: wx,
          y: 2.6,
          z: -11.8,
          emissiveHex: 0xbae6fd,
          emissiveIntensity: 0.25,
          transparent: true,
          opacity: 0.72,
          castShadow: false
        })
      );
    }
  }

  private buildBossOffice(): void {
    // Raised walnut dais + cozy terracotta rug
    this.group.add(createVoxelBox(7.2, 0.12, 5.2, COZY_PALETTE.walnut, { x: -0.5, y: 0.06, z: -7.5 }));
    this.group.add(createVoxelBox(6.2, 0.04, 4.2, COZY_PALETTE.terracotta, { x: -0.5, y: 0.13, z: -7.2 }));

    // Executive Desk
    this.group.add(createVoxelBox(3.4, 0.76, 1.2, COZY_PALETTE.walnut, { x: -0.5, y: 0.5, z: -7.4 }));
    // Executive Chair
    this.group.add(createVoxelBox(0.8, 0.2, 0.8, 0x1e293b, { x: -0.5, y: 0.48, z: -8.7 }));
    this.group.add(createVoxelBox(0.8, 0.9, 0.18, 0x1e293b, { x: -0.5, y: 0.95, z: -9.05 }));

    // Wide monitor & brass nameplate
    this.group.add(createVoxelBox(1.3, 0.65, 0.08, COZY_PALETTE.screenDark, { x: -0.5, y: 1.24, z: -7.65 }));
    this.group.add(
      createVoxelBox(1.18, 0.54, 0.09, COZY_PALETTE.screenWarm, {
        x: -0.5,
        y: 1.24,
        z: -7.62,
        emissiveHex: 0xfde68a,
        emissiveIntensity: 0.45,
        castShadow: false
      })
    );
    this.group.add(createVoxelBox(0.6, 0.14, 0.12, COZY_PALETTE.brass, { x: 0.55, y: 0.95, z: -6.95 }));

    // Boss Brass Desk Lamp
    this.addWarmLamp(-1.8, 0.88, -7.4, 1.4);

    // Decorative corner plant
    this.addPottedPlant(2.8, 0, -9.6);
  }

  private buildBoardroom(): void {
    // Oak Conference Table
    this.group.add(createVoxelBox(3.0, 0.14, 1.8, COZY_PALETTE.oakLight, { x: 9.5, y: 0.74, z: -7.2 }));
    this.group.add(createVoxelBox(0.3, 0.7, 1.2, COZY_PALETTE.slateDark, { x: 8.5, y: 0.35, z: -7.2 }));
    this.group.add(createVoxelBox(0.3, 0.7, 1.2, COZY_PALETTE.slateDark, { x: 10.5, y: 0.35, z: -7.2 }));

    // Chairs around table
    for (const [cx, cz] of [
      [7.4, -7.2],
      [11.6, -7.2],
      [9.5, -5.3],
      [9.5, -9.1]
    ]) {
      this.group.add(createVoxelBox(0.55, 0.42, 0.55, COZY_PALETTE.sage, { x: cx, y: 0.21, z: cz }));
    }
  }

  private buildLibrary(): void {
    // Tall wooden bookshelves along East side (x = 12.6)
    for (const bz of [-1.4, 0.8, 3.0]) {
      this.group.add(createVoxelBox(0.9, 2.8, 1.8, COZY_PALETTE.walnut, { x: 12.6, y: 1.4, z: bz }));
      // Colorful voxel books across 3 shelves
      for (let shelf = 0; shelf < 3; shelf += 1) {
        const sy = 0.65 + shelf * 0.75;
        for (let b = 0; b < 5; b += 1) {
          const color = COZY_PALETTE.bookColors[(shelf * 5 + b + Math.abs(Math.round(bz))) % COZY_PALETTE.bookColors.length];
          this.group.add(
            createVoxelBox(0.45, 0.48, 0.22, color, {
              x: 12.35,
              y: sy,
              z: bz - 0.58 + b * 0.28
            })
          );
        }
      }
    }

    // Reading corner warm floor lamp
    this.addWarmLamp(11.6, 0, 4.3, 1.2, 1.8);
    this.addPottedPlant(12.2, 0, -3.3);
  }

  private buildServerRoom(): void {
    // Glass enclosure partitions
    this.group.add(
      createVoxelBox(0.18, 2.8, 3.6, COZY_PALETTE.glassBlue, {
        x: -6.5,
        y: 1.4,
        z: -8.6,
        transparent: true,
        opacity: 0.32,
        castShadow: false
      })
    );
    this.group.add(
      createVoxelBox(6.8, 2.8, 0.18, COZY_PALETTE.glassBlue, {
        x: -10.2,
        y: 1.4,
        z: -2.8,
        transparent: true,
        opacity: 0.32,
        castShadow: false
      })
    );

    // 3 Server Racks
    for (const [idx, rz] of [-8.8, -6.8, -4.8].entries()) {
      this.group.add(createVoxelBox(1.1, 2.7, 1.2, COZY_PALETTE.slateDark, { x: -11.5, y: 1.35, z: rz }));
      for (let s = 0; s < 3; s += 1) {
        const ledMat = getVoxelMaterial(0x22c55e, {
          emissiveHex: 0x22c55e,
          emissiveIntensity: 1.0
        }).clone();
        this.serverLeds.push(ledMat);
        this.group.add(
          createVoxelBox(0.08, 0.14, 0.72, 0x22c55e, {
            x: -10.92,
            y: 0.75 + s * 0.65,
            z: rz + (idx % 2 === 0 ? 0.04 : -0.04),
            material: ledMat,
            castShadow: false
          })
        );
      }
    }
  }

  private buildCafeAndElevator(): void {
    // Elevator frame on West boundary (x = -13.6, z = 1.5)
    this.group.add(createVoxelBox(0.9, 3.3, 2.4, COZY_PALETTE.slateMid, { x: -13.6, y: 1.65, z: 1.5 }));
    this.group.add(
      createVoxelBox(0.4, 2.9, 1.8, 0xfef3c7, {
        x: -13.3,
        y: 1.45,
        z: 1.5,
        emissiveHex: 0xfde68a,
        emissiveIntensity: 0.35,
        castShadow: false
      })
    );
    this.elevatorLeftDoor = createVoxelBox(0.12, 2.8, 0.72, COZY_PALETTE.metalSilver, {
      x: -13.08,
      y: 1.4,
      z: 1.5 - 0.36
    });
    this.elevatorRightDoor = createVoxelBox(0.12, 2.8, 0.72, COZY_PALETTE.metalSilver, {
      x: -13.08,
      y: 1.4,
      z: 1.5 + 0.36
    });
    this.group.add(this.elevatorLeftDoor, this.elevatorRightDoor);

    // Espresso Counter + Machine
    this.group.add(createVoxelBox(1.4, 0.95, 2.4, COZY_PALETTE.walnut, { x: -11.9, y: 0.48, z: 5.5 }));
    this.group.add(createVoxelBox(1.5, 0.1, 2.5, 0xf5efe6, { x: -11.9, y: 0.98, z: 5.5 }));
    this.group.add(createVoxelBox(0.55, 0.5, 0.6, COZY_PALETTE.slateDark, { x: -11.9, y: 1.25, z: 5.5 }));
    this.group.add(createVoxelBox(0.58, 0.14, 0.56, COZY_PALETTE.terracotta, { x: -11.88, y: 1.42, z: 5.5 }));

    // Rising voxel steam puffs
    for (let i = 0; i < 4; i += 1) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        roughness: 0.9
      });
      const puff = createVoxelBox(0.12, 0.12, 0.12, 0xffffff, {
        x: -11.85 + (i % 2) * 0.08,
        y: 1.5,
        z: 5.5 + (i - 1.5) * 0.05,
        material: mat,
        castShadow: false
      });
      this.group.add(puff);
      this.steamParticles.push({ mesh: puff, age: i * 0.25, speed: 0.65 });
    }

    // Cozy Sage Sofa & Coffee Table
    this.group.add(createVoxelBox(3.4, 0.42, 1.0, COZY_PALETTE.sage, { x: -8.5, y: 0.21, z: 7.4 }));
    this.group.add(createVoxelBox(3.4, 0.65, 0.25, COZY_PALETTE.sageDark, { x: -8.5, y: 0.55, z: 7.82 }));
    this.group.add(createVoxelBox(1.6, 0.38, 0.9, COZY_PALETTE.oakLight, { x: -8.5, y: 0.19, z: 5.7 }));

    this.addWarmLamp(-11.8, 1.02, 6.4, 1.1);
    this.addPottedPlant(-6.2, 0, 7.6);
  }

  private createDeskPod(podIndex: number, animateDrop: boolean): void {
    const zBase = 1.0 + podIndex * 7.0;

    if (podIndex > 0) {
      // Extend wooden floor South to accommodate the new pod
      const extFloor = createVoxelBox(28.4, 0.3, 7.0, COZY_PALETTE.floorWoodA, {
        x: 0,
        y: -0.15,
        z: zBase + 2.5
      });
      this.floorExtensions.add(extFloor);
      for (let x = -13; x <= 13; x += 2) {
        this.floorExtensions.add(
          createVoxelBox(0.96, 0.02, 7.0, COZY_PALETTE.floorWoodB, {
            x,
            y: 0.01,
            z: zBase + 2.5,
            castShadow: false
          })
        );
      }
      this.floorExtensions.add(
        createVoxelBox(0.56, 1.1, 7.0, COZY_PALETTE.wallWainscot, {
          x: -14.08,
          y: 0.55,
          z: zBase + 2.5
        })
      );
    }

    const podGroup = new THREE.Group();
    const cols = [-2.2, 2.2];

    for (let row = 0; row < 2; row += 1) {
      const isNorthRow = row === 0;
      const deskZ = isNorthRow ? zBase + 2.0 : zBase + 3.0;
      const seatZ = isNorthRow ? zBase + 0.8 : zBase + 4.2;
      const facing = isNorthRow ? 0 : Math.PI;
      const monitorZ = isNorthRow ? deskZ + 0.22 : deskZ - 0.22;

      for (let col = 0; col < 2; col += 1) {
        const deskIndex = podIndex * 4 + row * 2 + col;
        const dx = cols[col];

        // Desk surface & legs
        podGroup.add(createVoxelBox(1.85, 0.1, 0.95, COZY_PALETTE.oakLight, { x: dx, y: 0.74, z: deskZ }));
        podGroup.add(createVoxelBox(0.1, 0.7, 0.75, COZY_PALETTE.slateDark, { x: dx - 0.8, y: 0.35, z: deskZ }));
        podGroup.add(createVoxelBox(0.1, 0.7, 0.75, COZY_PALETTE.slateDark, { x: dx + 0.8, y: 0.35, z: deskZ }));

        // Chair
        podGroup.add(createVoxelBox(0.52, 0.38, 0.52, COZY_PALETTE.slateMid, { x: dx, y: 0.19, z: seatZ }));

        // Monitor + dynamic screen
        podGroup.add(createVoxelBox(0.76, 0.48, 0.07, COZY_PALETTE.slateDark, { x: dx, y: 1.06, z: monitorZ }));
        const screenMat = new THREE.MeshStandardMaterial({
          color: COZY_PALETTE.screenDark,
          emissive: COZY_PALETTE.screenCyan,
          emissiveIntensity: 0.05,
          roughness: 0.4
        });
        podGroup.add(
          createVoxelBox(0.68, 0.4, 0.08, COZY_PALETTE.screenDark, {
            x: dx,
            y: 1.06,
            z: monitorZ + (isNorthRow ? -0.01 : 0.01),
            material: screenMat,
            castShadow: false
          })
        );

        // Warm desk lamp
        const { light, shadeMat } = this.addWarmLamp(dx + 0.68, 0.8, deskZ, 0.85, 0, podGroup);

        this.desks.push({
          index: deskIndex,
          seat: { x: dx, z: seatZ, facing, seated: true },
          monitorScreenMat: screenMat,
          lampLight: light,
          lampShadeMat: shadeMat
        });
      }
    }

    this.podsGroup.add(podGroup);

    if (animateDrop) {
      podGroup.position.y = 5.5;
      this.podAnimations.push({
        group: podGroup,
        elapsed: 0,
        duration: 0.65,
        startY: 5.5
      });
    }
  }

  private addWarmLamp(
    x: number,
    y: number,
    z: number,
    intensity: number,
    poleHeight = 0.25,
    parent: THREE.Group = this.group
  ): { light: THREE.PointLight; shadeMat: THREE.MeshStandardMaterial } {
    if (poleHeight > 0.3) {
      parent.add(createVoxelBox(0.1, poleHeight, 0.1, COZY_PALETTE.brass, { x, y: y + poleHeight / 2, z }));
    } else {
      parent.add(createVoxelBox(0.16, 0.06, 0.16, COZY_PALETTE.brass, { x, y: y + 0.03, z }));
      parent.add(createVoxelBox(0.06, 0.24, 0.06, COZY_PALETTE.brass, { x, y: y + 0.16, z }));
    }

    const shadeY = y + (poleHeight > 0.3 ? poleHeight : 0.32);
    const shadeMat = new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      emissive: 0xfbbf24,
      emissiveIntensity: 0.2,
      roughness: 0.6
    });
    parent.add(createVoxelBox(0.26, 0.2, 0.26, 0xfef3c7, { x, y: shadeY, z, material: shadeMat }));

    const light = new THREE.PointLight(0xffcf7d, intensity * 0.1, 6.5, 1.7);
    light.position.set(x, shadeY + 0.05, z);
    parent.add(light);
    this.lighting.registerLamp({ light, shadeMaterial: shadeMat, baseIntensity: intensity });
    return { light, shadeMat };
  }

  private addPottedPlant(x: number, y: number, z: number): void {
    this.group.add(createVoxelBox(0.55, 0.5, 0.55, COZY_PALETTE.terracotta, { x, y: y + 0.25, z }));
    this.group.add(createVoxelBox(0.75, 0.6, 0.75, COZY_PALETTE.sage, { x, y: y + 0.75, z }));
    this.group.add(createVoxelBox(0.45, 0.5, 0.45, COZY_PALETTE.sageDark, { x: x + 0.12, y: y + 1.15, z: z - 0.1 }));
  }

  private rebuildNavObstacles(): void {
    this.pathfinder.clearObstacles();
    this.pathfinder.setBounds(-13, 13, -11, this.getMaxZ());

    // Boss desk & dais back
    this.pathfinder.blockRect(-2.5, -9.2, 1.5, -7.0);
    // Boardroom table
    this.pathfinder.blockRect(8.0, -8.2, 11.0, -6.2);
    // Library shelves
    this.pathfinder.blockRect(12.0, -2.5, 13.5, 4.5);
    // Server glass & racks
    this.pathfinder.blockRect(-12.5, -9.8, -10.5, -3.6);
    this.pathfinder.blockRect(-7.0, -10.5, -6.5, -6.8);
    this.pathfinder.blockRect(-13.5, -3.2, -6.8, -2.8);
    // Cafe bar & sofa
    this.pathfinder.blockRect(-12.8, 4.2, -11.0, 6.8);
    this.pathfinder.blockRect(-10.2, 7.3, -6.8, 8.2);
    this.pathfinder.blockRect(-9.5, 5.2, -7.5, 6.2);

    // Modular desk spines
    for (let p = 0; p < this.podCount; p += 1) {
      const zBase = 1.0 + p * 7.0;
      this.pathfinder.blockRect(-3.4, zBase + 1.5, -1.0, zBase + 3.5);
      this.pathfinder.blockRect(1.0, zBase + 1.5, 3.4, zBase + 3.5);
    }
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
