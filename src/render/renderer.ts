/**
 * The renderer.
 *
 * The whole game is drawn as a real 3D scene into a 256x240 render target and
 * then put through one post pass that does three things in order: a 4x4 Bayer
 * dither, a nearest-colour snap to the NES palette, and an alpha composite of
 * the HUD layer. Only after that is the result scaled to the viewport by an
 * integer factor, so every pixel on screen is an exact square of one of the 54
 * colours a 2C02 could produce. The low resolution is the art direction, not a
 * performance measure.
 */
import * as THREE from 'three';
import type { RenderFrame, Renderer } from './api';
import { createBall3D } from './ball3d';
import { createBoard3D } from './board3d';
import { createCameraRig } from './camera';
import { createCourse3D } from './course';
import { HUD_H, HUD_W, createHud } from './hud';
import { NES_COLORS, SCENE, nesPaletteVectors } from './palette';

/**
 * Native NES framebuffer. Taken from the HUD layer so the two can never drift:
 * the HUD is authored in the same pixel grid the scene is rendered into.
 */
export const NATIVE_W = HUD_W;
export const NATIVE_H = HUD_H;

// Colour management off: every colour in this renderer is already an sRGB
// palette entry, and letting three convert to linear and back would drift the
// values just enough for the quantiser to pick a neighbouring hue.
THREE.ColorManagement.enabled = false;

const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const POST_VERTEX = /* glsl */ `
  varying vec2 vTexCoord;
  void main() {
    vTexCoord = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function postFragment(paletteSize: number): string {
  return /* glsl */ `
  #define PALETTE_SIZE ${paletteSize}
  uniform sampler2D uScene;
  uniform sampler2D uHud;
  uniform sampler2D uBayer;
  uniform vec3 uPalette[PALETTE_SIZE];
  uniform float uDither;
  varying vec2 vTexCoord;

  void main() {
    vec3 color = texture2D(uScene, vTexCoord).rgb;

    // Ordered dither first: the palette is coarse, and nudging each pixel by a
    // fixed pattern before matching is what turns a flat band into a texture.
    float threshold = texture2D(uBayer, gl_FragCoord.xy / 4.0).r;
    color += (threshold - 0.46875) * uDither;

    // Nearest palette entry, weighted a little towards luminance so the match
    // preserves perceived brightness rather than raw channel distance.
    vec3 best = uPalette[0];
    float bestDistance = 1e9;
    for (int i = 0; i < PALETTE_SIZE; i++) {
      vec3 candidate = uPalette[i];
      vec3 delta = color - candidate;
      delta *= delta;
      float distance = dot(delta, vec3(0.36, 0.48, 0.16));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }

    // The HUD is composited after quantisation so its colours stay exact.
    vec4 hud = texture2D(uHud, vTexCoord);
    gl_FragColor = vec4(mix(best, hud.rgb, hud.a), 1.0);
  }
`;
}

function bayerTexture(): THREE.DataTexture {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    const value = Math.round((((BAYER_4X4[i] ?? 0) + 0.5) / 16) * 255);
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function assertWebGL(): void {
  const probe = document.createElement('canvas');
  const context =
    probe.getContext('webgl2') ??
    probe.getContext('webgl') ??
    probe.getContext('experimental-webgl');
  if (!context) {
    throw new Error('Connect Fore! needs WebGL, and this browser did not provide a context.');
  }
}

/**
 * Creates the renderer and attaches its canvas to `container`.
 *
 * @throws if WebGL is unavailable, so the caller can show a fallback.
 */
export function createRenderer(container: HTMLElement): Renderer {
  assertWebGL();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
  } catch (cause) {
    throw new Error(`Connect Fore! could not start WebGL: ${String(cause)}`);
  }

  renderer.setPixelRatio(1);
  renderer.setSize(NATIVE_W, NATIVE_H, false);
  renderer.setClearColor(SCENE.skyHorizon, 1);

  const canvas = renderer.domElement;
  canvas.width = NATIVE_W;
  canvas.height = NATIVE_H;
  canvas.style.display = 'block';
  canvas.style.imageRendering = 'pixelated';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Connect Fore! game view');
  container.appendChild(canvas);

  // --- scene ---------------------------------------------------------------
  const scene = new THREE.Scene();
  const course = createCourse3D();
  const board = createBoard3D();
  const ball = createBall3D();
  scene.add(course.group, board.group, ball.group);
  const rig = createCameraRig(NATIVE_W / NATIVE_H);

  // --- post pass -----------------------------------------------------------
  const target = new THREE.WebGLRenderTarget(NATIVE_W, NATIVE_H, {
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  target.texture.generateMipmaps = false;

  const hud = createHud();
  const hudTexture = new THREE.CanvasTexture(hud.canvas);
  hudTexture.magFilter = THREE.NearestFilter;
  hudTexture.minFilter = THREE.NearestFilter;
  hudTexture.generateMipmaps = false;

  const bayer = bayerTexture();
  const postMaterial = new THREE.ShaderMaterial({
    vertexShader: POST_VERTEX,
    fragmentShader: postFragment(NES_COLORS.length),
    uniforms: {
      uScene: { value: target.texture },
      uHud: { value: hudTexture },
      uBayer: { value: bayer },
      uPalette: { value: nesPaletteVectors() },
      uDither: { value: 0.09 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const postGeometry = new THREE.PlaneGeometry(2, 2);
  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(postGeometry, postMaterial);
  postQuad.frustumCulled = false;
  postScene.add(postQuad);

  // --- viewport ------------------------------------------------------------
  const resize = (): void => {
    const width = container.clientWidth || window.innerWidth || NATIVE_W;
    const height = container.clientHeight || window.innerHeight || NATIVE_H;
    // Integer scaling keeps every NES pixel square, but on a phone the next
    // integer down throws away most of the screen - a 393px-wide handset would
    // play at 1x. Below 2x, fit the viewport instead and let the browser
    // nearest-neighbour the remainder.
    const fit = Math.min(width / NATIVE_W, height / NATIVE_H);
    const scale = fit >= 2 ? Math.floor(fit) : Math.max(1, fit);
    canvas.style.width = `${NATIVE_W * scale}px`;
    canvas.style.height = `${NATIVE_H * scale}px`;
    // The letterbox is whatever `container` shows around the scaled canvas;
    // margin auto centres it even when the container is not a flex/grid box.
    canvas.style.margin = 'auto';
  };
  resize();

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => resize());
    observer.observe(container);
  }
  window.addEventListener('resize', resize);

  // --- motion preference ---------------------------------------------------
  const motionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  let allowShake = !(motionQuery?.matches ?? false);
  const onMotionChange = (): void => {
    allowShake = !(motionQuery?.matches ?? false);
  };
  motionQuery?.addEventListener('change', onMotionChange);

  let lastTime = -1;
  let disposed = false;

  const render = (frame: RenderFrame): void => {
    if (disposed) return;
    const dt = lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, frame.time - lastTime));
    lastTime = frame.time;

    course.update(frame.time);
    board.update(
      frame.board,
      frame.fallingDisc,
      frame.explosion,
      frame.collapse,
      frame.highlight,
      frame.time,
    );
    ball.update(frame.ball, frame.aim, frame.time);
    rig.update(frame, dt, allowShake);

    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, rig.camera);

    hud.draw(frame.hud, frame.time);
    hudTexture.needsUpdate = true;

    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    motionQuery?.removeEventListener('change', onMotionChange);

    course.dispose();
    board.dispose();
    ball.dispose();
    hud.dispose();

    postGeometry.dispose();
    postMaterial.dispose();
    hudTexture.dispose();
    bayer.dispose();
    target.dispose();
    scene.clear();
    postScene.clear();

    renderer.dispose();
    canvas.remove();
  };

  return { canvas, render, resize, dispose };
}
