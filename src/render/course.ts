/**
 * The hole: sky, turf, hills, trees, a bunker and a flag.
 *
 * All of it is low-poly primitives and canvas textures generated at boot. The
 * point is depth cues — the fairway runs from the tee to the board so the eye
 * can read distance, and the hills sit behind the fog so the board reads as a
 * near object even in the square-on shot.
 */
import * as THREE from 'three';
import { COURSE } from '../game/types';
import { SCENE, createPixelTexture, createToonMaterial, hashNoise } from './palette';

export interface Course3D {
  readonly group: THREE.Group;
  /** Idle animation: the flag ripples. */
  update(time: number): void;
  dispose(): void;
}

function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  base: number,
  fleck: number,
  density: number,
  seed: number,
): void {
  ctx.fillStyle = `#${base.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = `#${fleck.toString(16).padStart(6, '0')}`;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (hashNoise(x + seed, y - seed) < density) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function skyTexture(): THREE.CanvasTexture {
  return createPixelTexture(64, 64, (ctx) => {
    // Hard bands rather than a gradient: the quantiser would band it anyway,
    // and choosing the steps by hand keeps them evenly spaced.
    const bands = [SCENE.skyTop, 0x3c8cec, 0x6cb0ec, SCENE.skyHorizon, 0xbcbcec];
    for (let i = 0; i < bands.length; i += 1) {
      ctx.fillStyle = `#${(bands[i] ?? 0).toString(16).padStart(6, '0')}`;
      ctx.fillRect(0, Math.floor((i * 64) / bands.length), 64, Math.ceil(64 / bands.length) + 1);
    }
    // Clouds sit well below the zenith: near the pole the sphere's UVs pinch
    // and any sprite up there smears into a band.
    ctx.fillStyle = `#${SCENE.cloud.toString(16).padStart(6, '0')}`;
    const puffs: readonly (readonly [number, number, number])[] = [
      [5, 26, 4], [9, 27, 6], [14, 26, 3],
      [34, 31, 5], [39, 32, 6], [45, 31, 4],
      [22, 38, 4], [26, 39, 5],
    ];
    for (const puff of puffs) {
      ctx.fillRect(puff[0], puff[1], puff[2], 2);
      ctx.fillRect(puff[0] - 1, puff[1] + 2, puff[2] + 2, 2);
    }
  });
}

/** Builds the course. Everything is positioned from `COURSE`, never guessed. */
export function createCourse3D(): Course3D {
  const group = new THREE.Group();
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  const track = <T extends THREE.BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const keep = <T extends THREE.Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  // --- sky -----------------------------------------------------------------
  const sky = skyTexture();
  // Tiled around the dome: one wrap would make each cloud a mile wide.
  sky.repeat.set(6, 1);
  sky.wrapT = THREE.ClampToEdgeWrapping;
  textures.push(sky);
  const skyMesh = new THREE.Mesh(
    track(new THREE.SphereGeometry(300, 16, 10)),
    keep(createToonMaterial({ map: sky, unlit: true, fogAmount: 0, side: THREE.BackSide })),
  );
  skyMesh.frustumCulled = false;
  group.add(skyMesh);

  // --- turf ----------------------------------------------------------------
  const roughTex = createPixelTexture(16, 16, (ctx) => {
    speckle(ctx, 16, SCENE.roughDark, SCENE.roughLight, 0.22, 3);
    speckle2(ctx, 16, SCENE.hillNear, 0.12, 9);
  });
  roughTex.repeat.set(90, 90);
  textures.push(roughTex);
  const rough = new THREE.Mesh(
    track(new THREE.PlaneGeometry(420, 420)),
    keep(createToonMaterial({ map: roughTex })),
  );
  rough.rotation.x = -Math.PI / 2;
  group.add(rough);

  const fairwayTex = createPixelTexture(16, 16, (ctx) => {
    for (let y = 0; y < 16; y += 1) {
      const mown = Math.floor(y / 4) % 2 === 0 ? SCENE.fairwayLight : SCENE.fairwayDark;
      ctx.fillStyle = `#${mown.toString(16).padStart(6, '0')}`;
      ctx.fillRect(0, y, 16, 1);
    }
    speckle2(ctx, 16, SCENE.greenLight, 0.08, 17);
  });
  fairwayTex.repeat.set(3, 9);
  textures.push(fairwayTex);
  const fairway = new THREE.Mesh(
    track(new THREE.PlaneGeometry(13, 30)),
    keep(createToonMaterial({ map: fairwayTex })),
  );
  fairway.rotation.x = -Math.PI / 2;
  fairway.position.set(0, 0.02, COURSE.tee.z / 2 - 1);
  group.add(fairway);

  const greenTex = createPixelTexture(16, 16, (ctx) => {
    speckle(ctx, 16, SCENE.greenLight, SCENE.fairwayLight, 0.3, 23);
  });
  greenTex.repeat.set(4, 4);
  textures.push(greenTex);
  const green = new THREE.Mesh(
    track(new THREE.CircleGeometry(6.5, 14)),
    keep(createToonMaterial({ map: greenTex })),
  );
  green.rotation.x = -Math.PI / 2;
  green.position.set(0, 0.03, COURSE.boardZ + 0.5);
  group.add(green);

  const sandTex = createPixelTexture(16, 16, (ctx) => {
    speckle(ctx, 16, SCENE.sand, 0xccd278, 0.18, 31);
  });
  sandTex.repeat.set(2, 2);
  textures.push(sandTex);
  const bunker = new THREE.Mesh(
    track(new THREE.CircleGeometry(2.6, 10)),
    keep(createToonMaterial({ map: sandTex })),
  );
  bunker.rotation.x = -Math.PI / 2;
  bunker.position.set(-6.2, 0.04, 5.5);
  bunker.scale.set(1.4, 1, 1);
  group.add(bunker);

  // --- tee box -------------------------------------------------------------
  const teeGeom = track(new THREE.BoxGeometry(0.24, 0.16, 0.24));
  const teeMat = keep(createToonMaterial({ color: SCENE.ball }));
  for (const side of [-1, 1]) {
    const marker = new THREE.Mesh(teeGeom, teeMat);
    marker.position.set(COURSE.tee.x + side * 0.9, 0.08, COURSE.tee.z);
    group.add(marker);
  }

  // --- hills ---------------------------------------------------------------
  const hillGeom = track(new THREE.ConeGeometry(1, 1, 7));
  const hillNear = keep(createToonMaterial({ color: SCENE.hillNear }));
  const hillFar = keep(createToonMaterial({ color: SCENE.hillFar }));
  const hills: readonly (readonly [number, number, number, number, boolean])[] = [
    [-52, -96, 30, 15, false],
    [-14, -120, 38, 20, false],
    [30, -104, 26, 13, false],
    [66, -88, 34, 17, false],
    [-78, -70, 22, 11, true],
    [86, -64, 20, 10, true],
  ];
  for (const hill of hills) {
    const mesh = new THREE.Mesh(hillGeom, hill[4] ? hillNear : hillFar);
    mesh.position.set(hill[0], hill[3] / 2 - 1, hill[1]);
    mesh.scale.set(hill[2], hill[3], hill[2]);
    group.add(mesh);
  }

  // --- trees ---------------------------------------------------------------
  const trunkGeom = track(new THREE.CylinderGeometry(0.16, 0.22, 1.4, 6));
  const crownGeom = track(new THREE.ConeGeometry(1.1, 2.6, 7));
  const trunkMat = keep(createToonMaterial({ color: SCENE.trunk }));
  const crownLight = keep(createToonMaterial({ color: SCENE.leafLight }));
  const crownDark = keep(createToonMaterial({ color: SCENE.leafDark }));
  for (let i = 0; i < 12; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (8.5 + hashNoise(i, 5) * 9);
    const z = -10 + hashNoise(i, 11) * 30;
    const scale = 0.85 + hashNoise(i, 19) * 0.9;
    const trunk = new THREE.Mesh(trunkGeom, trunkMat);
    trunk.position.set(x, 0.7 * scale, z);
    trunk.scale.setScalar(scale);
    group.add(trunk);
    const crown = new THREE.Mesh(crownGeom, i % 3 === 0 ? crownDark : crownLight);
    crown.position.set(x, (1.4 + 1.3) * scale, z);
    crown.scale.setScalar(scale);
    group.add(crown);
  }

  // --- flag ----------------------------------------------------------------
  const flag = new THREE.Group();
  flag.position.set(6.4, 0, COURSE.boardZ - 1.2);
  const pole = new THREE.Mesh(
    track(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6)),
    keep(createToonMaterial({ color: SCENE.flagPole })),
  );
  pole.position.y = 1.6;
  flag.add(pole);
  const cloth = new THREE.Mesh(
    track(new THREE.PlaneGeometry(0.9, 0.55)),
    keep(createToonMaterial({ color: SCENE.flagCloth, side: THREE.DoubleSide })),
  );
  cloth.position.set(0.47, 2.95, 0);
  flag.add(cloth);
  group.add(flag);

  return {
    group,
    update: (time: number) => {
      cloth.rotation.y = Math.sin(time * 2.4) * 0.35;
      cloth.position.z = Math.sin(time * 2.4) * 0.06;
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      group.clear();
    },
  };
}

/** Sprinkles a second fleck colour over an already-painted tile. */
function speckle2(
  ctx: CanvasRenderingContext2D,
  size: number,
  fleck: number,
  density: number,
  seed: number,
): void {
  ctx.fillStyle = `#${fleck.toString(16).padStart(6, '0')}`;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (hashNoise(x * 1.7 + seed, y * 2.3 - seed) < density) ctx.fillRect(x, y, 1, 1);
    }
  }
}
