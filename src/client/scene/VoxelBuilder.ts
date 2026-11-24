import * as THREE from 'three';

const unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

export function getVoxelMaterial(
  colorHex: number,
  options?: {
    roughness?: number;
    metalness?: number;
    emissiveHex?: number;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
  }
): THREE.MeshStandardMaterial {
  const key = [
    colorHex,
    options?.roughness ?? 0.78,
    options?.metalness ?? 0.06,
    options?.emissiveHex ?? -1,
    options?.emissiveIntensity ?? 0,
    options?.transparent ? 1 : 0,
    options?.opacity ?? 1
  ].join(':');

  const cached = materialCache.get(key);
  if (cached) return cached;

  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: options?.roughness ?? 0.78,
    metalness: options?.metalness ?? 0.06,
    emissive: options?.emissiveHex ?? 0x000000,
    emissiveIntensity: options?.emissiveIntensity ?? 0,
    transparent: options?.transparent ?? false,
    opacity: options?.opacity ?? 1
  });
  materialCache.set(key, mat);
  return mat;
}

export function createVoxelBox(
  w: number,
  h: number,
  d: number,
  colorHex: number,
  options?: {
    x?: number;
    y?: number;
    z?: number;
    roughness?: number;
    metalness?: number;
    emissiveHex?: number;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    castShadow?: boolean;
    receiveShadow?: boolean;
    material?: THREE.MeshStandardMaterial;
  }
): THREE.Mesh {
  const mat =
    options?.material ??
    getVoxelMaterial(colorHex, {
      roughness: options?.roughness,
      metalness: options?.metalness,
      emissiveHex: options?.emissiveHex,
      emissiveIntensity: options?.emissiveIntensity,
      transparent: options?.transparent,
      opacity: options?.opacity
    });

  const mesh = new THREE.Mesh(unitBoxGeometry, mat);
  mesh.scale.set(w, h, d);
  mesh.position.set(options?.x ?? 0, options?.y ?? 0, options?.z ?? 0);
  mesh.castShadow = options?.castShadow ?? true;
  mesh.receiveShadow = options?.receiveShadow ?? true;
  return mesh;
}

export const COZY_PALETTE = {
  floorWoodA: 0xd9b38c,
  floorWoodB: 0xcfa57c,
  floorDarkTrim: 0x6b4b35,
  wallCream: 0xf4ece1,
  wallWainscot: 0xb98d68,
  walnut: 0x5c3d28,
  oakLight: 0xdab88b,
  terracotta: 0xc2593f,
  sage: 0x6b9078,
  sageDark: 0x3b634a,
  slateDark: 0x262b33,
  slateMid: 0x3f4754,
  metalSilver: 0xadb5bd,
  glassBlue: 0x93c5fd,
  screenDark: 0x111827,
  screenCyan: 0x38bdf8,
  screenWarm: 0xfde68a,
  brass: 0xd4a345,
  coffeeDark: 0x3e2723,
  bookColors: [0xd95d39, 0x2b6cb0, 0x2f855a, 0xd69e2e, 0x805ad5, 0xb83280]
};
