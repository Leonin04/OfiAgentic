import * as THREE from 'three';

export type LightingMode = 'auto' | 'day' | 'sunset' | 'night';

export interface LampHandle {
  light: THREE.PointLight;
  shadeMaterial: THREE.MeshStandardMaterial;
  baseIntensity: number;
}

interface LightingPreset {
  label: string;
  skyColor: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  sunPos: THREE.Vector3;
  lampFactor: number;
}

const DAY_PRESET: LightingPreset = {
  label: 'Día',
  skyColor: new THREE.Color(0xe9dfd1),
  hemiSky: new THREE.Color(0xfffaf0),
  hemiGround: new THREE.Color(0xc4a88b),
  hemiIntensity: 0.95,
  sunColor: new THREE.Color(0xfff5e4),
  sunIntensity: 1.35,
  sunPos: new THREE.Vector3(18, 28, 16),
  lampFactor: 0.1
};

const SUNSET_PRESET: LightingPreset = {
  label: 'Atardecer',
  skyColor: new THREE.Color(0xd99b78),
  hemiSky: new THREE.Color(0xffcfa8),
  hemiGround: new THREE.Color(0x7c5a4a),
  hemiIntensity: 0.75,
  sunColor: new THREE.Color(0xff944d),
  sunIntensity: 1.15,
  sunPos: new THREE.Vector3(-24, 12, 18),
  lampFactor: 0.72
};

const NIGHT_PRESET: LightingPreset = {
  label: 'Noche',
  skyColor: new THREE.Color(0x161b29),
  hemiSky: new THREE.Color(0x4b6396),
  hemiGround: new THREE.Color(0x1f1c1a),
  hemiIntensity: 0.48,
  sunColor: new THREE.Color(0x88a8e8),
  sunIntensity: 0.35,
  sunPos: new THREE.Vector3(-12, 24, -14),
  lampFactor: 1.0
};

export class LightingCycle {
  private mode: LightingMode = 'auto';
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly lamps: LampHandle[] = [];
  private currentLampFactor = 0.1;

  constructor(private readonly scene: THREE.Scene) {
    this.hemiLight = new THREE.HemisphereLight(0xfffaf0, 0xc4a88b, 0.95);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff5e4, 1.35);
    this.sunLight.position.set(18, 28, 16);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -26;
    this.sunLight.shadow.camera.right = 26;
    this.sunLight.shadow.camera.top = 26;
    this.sunLight.shadow.camera.bottom = -26;
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 85;
    this.sunLight.shadow.bias = -0.0008;
    this.scene.add(this.sunLight);
  }

  registerLamp(handle: LampHandle): void {
    this.lamps.push(handle);
  }

  setMode(mode: LightingMode): void {
    this.mode = mode;
  }

  getMode(): LightingMode {
    return this.mode;
  }

  getActivePhaseLabel(): string {
    const resolved = this.resolvePreset();
    return resolved.label;
  }

  update(dt: number): void {
    const target = this.resolvePreset();
    const alpha = Math.min(1, dt * 2.5);

    if (!(this.scene.background instanceof THREE.Color)) {
      this.scene.background = target.skyColor.clone();
    } else {
      this.scene.background.lerp(target.skyColor, alpha);
    }

    this.hemiLight.color.lerp(target.hemiSky, alpha);
    this.hemiLight.groundColor.lerp(target.hemiGround, alpha);
    this.hemiLight.intensity += (target.hemiIntensity - this.hemiLight.intensity) * alpha;

    this.sunLight.color.lerp(target.sunColor, alpha);
    this.sunLight.intensity += (target.sunIntensity - this.sunLight.intensity) * alpha;
    this.sunLight.position.lerp(target.sunPos, alpha);

    this.currentLampFactor += (target.lampFactor - this.currentLampFactor) * alpha;
    for (const lamp of this.lamps) {
      lamp.light.intensity = lamp.baseIntensity * this.currentLampFactor;
      lamp.shadeMaterial.emissiveIntensity = 0.15 + this.currentLampFactor * 1.1;
    }
  }

  private resolvePreset(): LightingPreset {
    if (this.mode === 'day') return DAY_PRESET;
    if (this.mode === 'sunset') return SUNSET_PRESET;
    if (this.mode === 'night') return NIGHT_PRESET;

    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    if (hour >= 8 && hour < 17.5) {
      return DAY_PRESET;
    }
    if (hour >= 17.5 && hour < 20.5) {
      return SUNSET_PRESET;
    }
    return NIGHT_PRESET;
  }
}
