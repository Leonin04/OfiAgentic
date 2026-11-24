export interface GridPoint {
  x: number;
  z: number;
}

export class OfficePathfinder {
  private readonly blocked = new Set<string>();
  private minX = -13;
  private maxX = 13;
  private minZ = -11;
  private maxZ = 10;

  setBounds(minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
  }

  clearObstacles(): void {
    this.blocked.clear();
  }

  blockRect(x0: number, z0: number, x1: number, z1: number): void {
    const startX = Math.floor(Math.min(x0, x1));
    const endX = Math.ceil(Math.max(x0, x1));
    const startZ = Math.floor(Math.min(z0, z1));
    const endZ = Math.ceil(Math.max(z0, z1));
    for (let x = startX; x <= endX; x += 1) {
      for (let z = startZ; z <= endZ; z += 1) {
        this.blocked.add(this.key(x, z));
      }
    }
  }

  unblockPoint(x: number, z: number): void {
    this.blocked.delete(this.key(Math.round(x), Math.round(z)));
  }

  isWalkable(gx: number, gz: number): boolean {
    if (gx < this.minX || gx > this.maxX || gz < this.minZ || gz > this.maxZ) {
      return false;
    }
    return !this.blocked.has(this.key(gx, gz));
  }

  findPath(startWorld: GridPoint, goalWorld: GridPoint): GridPoint[] {
    const start = this.nearestWalkable(Math.round(startWorld.x), Math.round(startWorld.z));
    const goal = this.nearestWalkable(Math.round(goalWorld.x), Math.round(goalWorld.z));

    if (start.x === goal.x && start.z === goal.z) {
      return [{ x: goalWorld.x, z: goalWorld.z }];
    }

    const startKey = this.key(start.x, start.z);
    const goalKey = this.key(goal.x, goal.z);

    const open = new Set<string>([startKey]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    const fScore = new Map<string, number>([[startKey, this.heuristic(start, goal)]]);
    const coords = new Map<string, GridPoint>([[startKey, start]]);

    const dirs: Array<[number, number, number]> = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, 1.414],
      [-1, 1, 1.414],
      [1, -1, 1.414],
      [-1, -1, 1.414]
    ];

    let iterations = 0;
    while (open.size > 0 && iterations < 1_800) {
      iterations += 1;
      let currentKey = '';
      let lowestF = Infinity;
      for (const k of open) {
        const f = fScore.get(k) ?? Infinity;
        if (f < lowestF) {
          lowestF = f;
          currentKey = k;
        }
      }

      if (!currentKey) break;
      if (currentKey === goalKey) {
        return this.reconstruct(cameFrom, coords, currentKey, goalWorld);
      }

      open.delete(currentKey);
      const current = coords.get(currentKey)!;
      const currentG = gScore.get(currentKey) ?? Infinity;

      for (const [dx, dz, cost] of dirs) {
        const nx = current.x + dx;
        const nz = current.z + dz;
        if (!this.isWalkable(nx, nz)) continue;
        // Prevent diagonal corner cutting through blocked cells
        if (dx !== 0 && dz !== 0) {
          if (!this.isWalkable(current.x + dx, current.z) || !this.isWalkable(current.x, current.z + dz)) {
            continue;
          }
        }

        const nKey = this.key(nx, nz);
        const tentativeG = currentG + cost;
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, currentKey);
          gScore.set(nKey, tentativeG);
          fScore.set(nKey, tentativeG + this.heuristic({ x: nx, z: nz }, goal));
          coords.set(nKey, { x: nx, z: nz });
          open.add(nKey);
        }
      }
    }

    return [{ x: goalWorld.x, z: goalWorld.z }];
  }

  private reconstruct(
    cameFrom: Map<string, string>,
    coords: Map<string, GridPoint>,
    endKey: string,
    exactGoal: GridPoint
  ): GridPoint[] {
    const raw: GridPoint[] = [];
    let cur: string | undefined = endKey;
    while (cur) {
      const pt = coords.get(cur);
      if (pt) raw.unshift(pt);
      cur = cameFrom.get(cur);
    }
    // Remove starting cell and set exact final destination
    if (raw.length > 1) {
      raw.shift();
    }
    if (raw.length > 0) {
      raw[raw.length - 1] = { x: exactGoal.x, z: exactGoal.z };
    } else {
      raw.push({ x: exactGoal.x, z: exactGoal.z });
    }
    return raw;
  }

  private nearestWalkable(x: number, z: number): GridPoint {
    const cx = Math.max(this.minX, Math.min(this.maxX, x));
    const cz = Math.max(this.minZ, Math.min(this.maxZ, z));
    if (this.isWalkable(cx, cz)) return { x: cx, z: cz };

    for (let r = 1; r <= 6; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          if (this.isWalkable(cx + dx, cz + dz)) {
            return { x: cx + dx, z: cz + dz };
          }
        }
      }
    }
    return { x: cx, z: cz };
  }

  private heuristic(a: GridPoint, b: GridPoint): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  private key(x: number, z: number): string {
    return `${x},${z}`;
  }
}
