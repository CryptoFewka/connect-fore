/**
 * The look: the NES master palette plus the toon shading every scene object
 * uses.
 *
 * Two things live here because they are the same decision. Everything is
 * rendered into a 256x240 buffer and then snapped to the ~54 colours a real
 * 2C02 could put on screen, so it is pointless for a material to compute a
 * smooth gradient the post pass will only throw away. The materials are
 * therefore deliberately crude: a base colour, two or three hard light bands
 * and a flat fog mix, all in raw sRGB with colour management switched off so
 * that what a material writes is what the quantiser sees.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The NES palette
// ---------------------------------------------------------------------------

/** The 64 entries of the 2C02 master palette, in hardware order ($00..$3F). */
const NES_MASTER: readonly number[] = [
  0x545454, 0x001e74, 0x081090, 0x300088, 0x440064, 0x5c0030, 0x540400, 0x3c1800,
  0x202a00, 0x083a00, 0x004000, 0x003c00, 0x00323c, 0x000000, 0x000000, 0x000000,
  0x989698, 0x084cc4, 0x3032ec, 0x5c1ee4, 0x8814b0, 0xa01464, 0x982220, 0x783c00,
  0x545a00, 0x287200, 0x087c00, 0x007628, 0x006678, 0x000000, 0x000000, 0x000000,
  0xececec, 0x4c9aec, 0x787cec, 0xb062ec, 0xe454ec, 0xe458b4, 0xe46858, 0xd48820,
  0xa0aa00, 0x74c400, 0x4cd020, 0x38cc6c, 0x38b4cc, 0x3c3c3c, 0x000000, 0x000000,
  0xececec, 0xa8ccec, 0xbcbcec, 0xd4b2ec, 0xecaeec, 0xecaed4, 0xecb4b0, 0xe4c490,
  0xccd278, 0xb4de78, 0xa8e290, 0x98e2b4, 0xa0d6e4, 0xa0a2a0, 0x000000, 0x000000,
];

/**
 * Hardware indices that are black on real silicon ($0D is "blacker than black"
 * and is unsafe on a CRT). $0F is kept as the one true black.
 */
const FORCED_BLACK = new Set([0x0d, 0x0e, 0x1d, 0x1e, 0x1f, 0x2e, 0x2f, 0x3e, 0x3f]);

/** The usable palette: 54 distinct colours the post pass may pick from. */
export const NES_COLORS: readonly number[] = (() => {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < NES_MASTER.length; i += 1) {
    if (FORCED_BLACK.has(i)) continue;
    const hex = NES_MASTER[i] ?? 0;
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
})();

/** `#rrggbb`, for the 2D HUD canvas. */
export function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** Raw 0..1 sRGB components. Never goes through `THREE.Color`, which would
 * apply a colour-space conversion and drift the palette. */
export function rgbOf(hex: number, target: THREE.Vector3): THREE.Vector3 {
  return target.set(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  );
}

/** The palette as `vec3[]`, for the quantiser's uniform. Built once. */
export function nesPaletteVectors(): THREE.Vector3[] {
  return NES_COLORS.map((hex) => rgbOf(hex, new THREE.Vector3()));
}

// ---------------------------------------------------------------------------
// Named colours
// ---------------------------------------------------------------------------

/** Scene colours, all real palette entries so quantisation is a no-op on them. */
export const SCENE = {
  skyTop: 0x4c9aec,
  skyHorizon: 0xa8ccec,
  cloud: 0xececec,
  fog: 0xbcbcec,

  roughLight: 0x74c400,
  roughDark: 0x287200,
  fairwayLight: 0x4cd020,
  fairwayDark: 0x087c00,
  greenLight: 0xb4de78,
  hillNear: 0x007628,
  hillFar: 0x38b4cc,
  sand: 0xe4c490,

  trunk: 0x783c00,
  leafLight: 0x287200,
  leafDark: 0x004000,

  boardFace: 0x084cc4,
  boardRim: 0x3032ec,
  boardSide: 0x001e74,
  boardPost: 0x084cc4,
  boardBase: 0x001e74,

  discOne: 0xe46858,
  discOneDark: 0x982220,
  discTwo: 0xd48820,
  discTwoDark: 0x783c00,
  discFlash: 0xececec,

  ball: 0xececec,
  ballShade: 0xa0a2a0,
  shadow: 0x004000,

  flagPole: 0xececec,
  flagCloth: 0xe46858,
  aim: 0xececec,
  aimHot: 0xd48820,
} as const;

/** HUD ink, as CSS strings for the 2D layer. */
export const INK = {
  black: cssHex(0x000000),
  white: cssHex(0xececec),
  grey: cssHex(0x989698),
  greyDark: cssHex(0x3c3c3c),
  greySlate: cssHex(0x545454),
  blue: cssHex(0x4c9aec),
  blueDeep: cssHex(0x084cc4),
  blueNight: cssHex(0x001e74),
  red: cssHex(0xe46858),
  redDeep: cssHex(0x982220),
  gold: cssHex(0xd48820),
  cream: cssHex(0xe4c490),
  green: cssHex(0x4cd020),
  greenDeep: cssHex(0x007628),
  purple: cssHex(0xb062ec),
} as const;

/** The HUD colour a player's furniture is drawn in. */
export function playerInk(player: 1 | 2): string {
  return player === 1 ? INK.red : INK.gold;
}

// ---------------------------------------------------------------------------
// Procedural pixel textures
// ---------------------------------------------------------------------------

/**
 * A tiny canvas texture, point sampled. Every image in the game is drawn by
 * one of these at boot; the repo ships no binary assets.
 */
export function createPixelTexture(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Connect Fore!: 2D canvas is unavailable.');
  ctx.imageSmoothingEnabled = false;
  paint(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Deterministic hash noise, so the course looks the same on every machine. */
export function hashNoise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// ---------------------------------------------------------------------------
// Toon shading
// ---------------------------------------------------------------------------

/** Sun direction, world space. Matches the shadow offsets used on the course. */
export const SUN = new THREE.Vector3(-0.45, 0.78, 0.44).normalize();

const TOON_VERTEX = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec2 vTexCoord;
  varying float vViewDepth;
  void main() {
    vTexCoord = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    vViewDepth = -viewPos.z;
    gl_Position = projectionMatrix * viewPos;
  }
`;

const TOON_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform float uUnlit;
  uniform float uFlash;
  uniform float uOpacity;
  uniform vec3 uLight;
  uniform vec3 uFogColor;
  uniform vec2 uFogRange;
  uniform float uFogAmount;
  varying vec3 vWorldNormal;
  varying vec2 vTexCoord;
  varying float vViewDepth;

  void main() {
    vec3 base = uColor;
    if (uUseMap > 0.5) {
      base *= texture2D(uMap, vTexCoord).rgb;
    }

    // Three hard bands. No smooth term anywhere: a ramp would only be
    // destroyed by the palette quantiser, and banding it here keeps the
    // silhouette of every facet readable at 256x240.
    float lambert = dot(normalize(vWorldNormal), uLight);
    float band = lambert > 0.42 ? 1.0 : (lambert > -0.06 ? 0.72 : 0.5);
    band = mix(band, 1.0, uUnlit);

    vec3 color = base * band;
    color = mix(color, vec3(1.0), uFlash);

    float fog = clamp((vViewDepth - uFogRange.x) / max(uFogRange.y - uFogRange.x, 0.001), 0.0, 1.0);
    color = mix(color, uFogColor, fog * uFogAmount);

    gl_FragColor = vec4(color, uOpacity);
  }
`;

export interface ToonOptions {
  /** Base tint, multiplied by `map` when one is given. */
  color?: number;
  map?: THREE.Texture | null;
  /** Skip the light bands entirely (sky, aim guides, shadows). */
  unlit?: boolean;
  opacity?: number;
  /** 0 disables aerial perspective for this material. */
  fogAmount?: number;
  side?: THREE.Side;
  depthWrite?: boolean;
}

/** A flat-shaded material. Every solid in the scene uses one. */
export function createToonMaterial(options: ToonOptions = {}): THREE.ShaderMaterial {
  const opacity = options.opacity ?? 1;
  const material = new THREE.ShaderMaterial({
    vertexShader: TOON_VERTEX,
    fragmentShader: TOON_FRAGMENT,
    uniforms: {
      uColor: { value: rgbOf(options.color ?? 0xffffff, new THREE.Vector3()) },
      uMap: { value: options.map ?? null },
      uUseMap: { value: options.map ? 1 : 0 },
      uUnlit: { value: options.unlit ? 1 : 0 },
      uFlash: { value: 0 },
      uOpacity: { value: opacity },
      uLight: { value: SUN.clone() },
      uFogColor: { value: rgbOf(SCENE.fog, new THREE.Vector3()) },
      uFogRange: { value: new THREE.Vector2(34, 150) },
      uFogAmount: { value: options.fogAmount ?? 1 },
    },
    transparent: opacity < 1,
    side: options.side ?? THREE.FrontSide,
  });
  if (options.depthWrite === false) material.depthWrite = false;
  return material;
}

/** Recolour a toon material in place; used for the win-line flash. */
export function setToonColor(material: THREE.ShaderMaterial, hex: number): void {
  const uniform = material.uniforms.uColor;
  if (uniform) rgbOf(hex, uniform.value as THREE.Vector3);
}
