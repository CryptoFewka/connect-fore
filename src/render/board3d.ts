/**
 * The Connect Four board as a real object in the world.
 *
 * The frame is one extruded shape with 42 circular holes punched through it,
 * so an empty cell is genuinely open: you can see the sky through it and watch
 * the ball pass through. Every dimension comes from `COURSE` and `cellCenter`,
 * which is what keeps the picture and the physics agreeing about where a gap is.
 */
import * as THREE from 'three';
import type { Board, Player, WinLine } from '../game/types';
import { CELL_COUNT, COLS, COURSE, ROWS, cellCenter } from '../game/types';
import { SCENE, createPixelTexture, createToonMaterial } from './palette';

export interface FallingDiscView {
  player: Player;
  col: number;
  /** World-space centre height of the disc. */
  y: number;
}

/** A disc being destroyed; `t` runs 0 to 1 over the burst. */
export interface ExplosionView {
  readonly col: number;
  readonly row: number;
  readonly t: number;
}

/** The stack above `aboveRow` in `col`, drawn `offset` cells lower. */
export interface CollapseView {
  readonly col: number;
  readonly aboveRow: number;
  readonly offset: number;
}

export interface Board3D {
  readonly group: THREE.Group;
  update(
    board: Board,
    falling: FallingDiscView | null,
    explosion: ExplosionView | null,
    collapse: CollapseView | null,
    highlight: WinLine | null,
    time: number,
  ): void;
  dispose(): void;
}

const DISC_RADIUS = COURSE.apertureRadius;
const DISC_DEPTH = COURSE.boardHalfDepth * 2 + 0.06;
const RIM = 0.34;

/** The face of a disc: a colour, a dark rim and a symbol that survives colour blindness. */
function discFaceTexture(player: Player): THREE.CanvasTexture {
  const body = player === 1 ? SCENE.discOne : SCENE.discTwo;
  const dark = player === 1 ? SCENE.discOneDark : SCENE.discTwoDark;
  return createPixelTexture(16, 16, (ctx) => {
    ctx.fillStyle = `#${dark.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = `#${body.toString(16).padStart(6, '0')}`;
    ctx.fillRect(2, 1, 12, 14);
    ctx.fillRect(1, 2, 14, 12);
    ctx.fillStyle = `#${dark.toString(16).padStart(6, '0')}`;
    if (player === 1) {
      // A cross.
      for (let i = 0; i < 8; i += 1) {
        ctx.fillRect(4 + i, 4 + i, 1, 1);
        ctx.fillRect(4 + i, 11 - i, 1, 1);
        ctx.fillRect(5 + i, 4 + i, 1, 1);
        ctx.fillRect(5 + i, 11 - i, 1, 1);
      }
    } else {
      // A ring.
      ctx.fillRect(6, 3, 4, 2);
      ctx.fillRect(6, 11, 4, 2);
      ctx.fillRect(3, 6, 2, 4);
      ctx.fillRect(11, 6, 2, 4);
      ctx.fillRect(4, 4, 2, 2);
      ctx.fillRect(10, 4, 2, 2);
      ctx.fillRect(4, 10, 2, 2);
      ctx.fillRect(10, 10, 2, 2);
    }
  });
}

interface FrameBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** The outer rectangle of the slab, derived from the cell grid plus a rim. */
function frameBounds(): FrameBounds {
  const first = cellCenter(0, 0);
  const last = cellCenter(COLS - 1, ROWS - 1);
  const half = COURSE.cellPitch / 2;
  return {
    left: first.x - half - RIM,
    right: last.x + half + RIM,
    bottom: first.y - half - RIM,
    top: last.y + half + RIM,
  };
}

function buildFrameGeometry(): THREE.ExtrudeGeometry {
  const { left, right, bottom, top } = frameBounds();

  const shape = new THREE.Shape();
  shape.moveTo(left, bottom);
  shape.lineTo(right, bottom);
  shape.lineTo(right, top);
  shape.lineTo(left, top);
  shape.closePath();

  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const centre = cellCenter(col, row);
      const hole = new THREE.Path();
      hole.absarc(centre.x, centre.y, COURSE.apertureRadius, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
  }

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: COURSE.boardHalfDepth * 2,
    bevelEnabled: false,
    curveSegments: 12,
  });
  // Extrusion runs +z from the shape plane; centre it on the board plane.
  geometry.translate(0, 0, COURSE.boardZ - COURSE.boardHalfDepth);
  return geometry;
}

/** A moulded surround, proud of the slab on both faces. It gives the board an
 * edge to catch the light instead of reading as one flat rectangle. */
function buildRimGeometry(): THREE.ExtrudeGeometry {
  const { left, right, bottom, top } = frameBounds();
  const thickness = 0.24;
  const shape = new THREE.Shape();
  shape.moveTo(left, bottom);
  shape.lineTo(right, bottom);
  shape.lineTo(right, top);
  shape.lineTo(left, top);
  shape.closePath();
  const inner = new THREE.Path();
  inner.moveTo(left + thickness, bottom + thickness);
  inner.lineTo(left + thickness, top - thickness);
  inner.lineTo(right - thickness, top - thickness);
  inner.lineTo(right - thickness, bottom + thickness);
  inner.closePath();
  shape.holes.push(inner);

  const depth = COURSE.boardHalfDepth * 2 + 0.12;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geometry.translate(0, 0, COURSE.boardZ - depth / 2);
  return geometry;
}

/** Builds the board, its 42-disc pool and the one disc that falls. */
export function createBoard3D(): Board3D {
  const group = new THREE.Group();
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  // --- frame ---------------------------------------------------------------
  const frameGeometry = buildFrameGeometry();
  geometries.push(frameGeometry);
  const frameFace = createToonMaterial({ color: SCENE.boardFace });
  const frameSide = createToonMaterial({ color: SCENE.boardSide });
  materials.push(frameFace, frameSide);
  group.add(new THREE.Mesh(frameGeometry, [frameFace, frameSide]));

  const rimGeometry = buildRimGeometry();
  geometries.push(rimGeometry);
  const rimFace = createToonMaterial({ color: SCENE.boardRim });
  const rimSide = createToonMaterial({ color: SCENE.boardFace });
  materials.push(rimFace, rimSide);
  group.add(new THREE.Mesh(rimGeometry, [rimFace, rimSide]));

  // --- stand ---------------------------------------------------------------
  const first = cellCenter(0, 0);
  const last = cellCenter(COLS - 1, 0);
  const legTop = frameBounds().bottom;
  const legGeometry = new THREE.CylinderGeometry(0.16, 0.2, legTop, 8);
  const legMaterial = createToonMaterial({ color: SCENE.boardPost });
  geometries.push(legGeometry);
  materials.push(legMaterial);
  for (const x of [first.x + 0.4, last.x - 0.4]) {
    const leg = new THREE.Mesh(legGeometry, legMaterial);
    leg.position.set(x, legTop / 2, COURSE.boardZ);
    group.add(leg);
  }
  const baseGeometry = new THREE.BoxGeometry(last.x - first.x + 0.9, 0.3, 1.1);
  const baseMaterial = createToonMaterial({ color: SCENE.boardBase });
  geometries.push(baseGeometry);
  materials.push(baseMaterial);
  const base = new THREE.Mesh(baseGeometry, baseMaterial);
  base.position.set(0, 0.15, COURSE.boardZ);
  group.add(base);

  // A painted-on contact shadow. Cheap, and it plants the board on the turf.
  const shadowGeometry = new THREE.PlaneGeometry(last.x - first.x + 1.8, 1.9);
  const shadowMaterial = createToonMaterial({
    color: SCENE.shadow,
    unlit: true,
    opacity: 0.38,
    depthWrite: false,
    fogAmount: 0,
  });
  geometries.push(shadowGeometry);
  materials.push(shadowMaterial);
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.55, 0.06, COURSE.boardZ + 0.75);
  group.add(shadow);

  // --- discs ---------------------------------------------------------------
  const discGeometry = new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS, DISC_DEPTH, 12);
  discGeometry.rotateX(Math.PI / 2);
  geometries.push(discGeometry);

  const faceTextures: Record<Player, THREE.CanvasTexture> = {
    1: discFaceTexture(1),
    2: discFaceTexture(2),
  };
  textures.push(faceTextures[1], faceTextures[2]);

  const makeSet = (player: Player, flash: boolean): THREE.Material[] => {
    const rim = player === 1 ? SCENE.discOneDark : SCENE.discTwoDark;
    const side = createToonMaterial({ color: flash ? SCENE.discFlash : rim });
    const face = createToonMaterial({
      color: flash ? SCENE.discFlash : 0xffffff,
      map: flash ? null : faceTextures[player],
    });
    materials.push(side, face);
    return [side, face, face];
  };

  const discMaterials: Record<Player, THREE.Material[]> = { 1: makeSet(1, false), 2: makeSet(2, false) };
  const flashMaterials: Record<Player, THREE.Material[]> = { 1: makeSet(1, true), 2: makeSet(2, true) };

  const discs: THREE.Mesh[] = [];
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const centre = cellCenter(col, row);
    const mesh = new THREE.Mesh(discGeometry, discMaterials[1]);
    mesh.position.set(centre.x, centre.y, COURSE.boardZ);
    mesh.visible = false;
    discs.push(mesh);
    group.add(mesh);
  }

  const fallingMesh = new THREE.Mesh(discGeometry, discMaterials[1]);
  fallingMesh.visible = false;
  group.add(fallingMesh);

  // The blast: a handful of chunky shards thrown outward on fixed bearings, so
  // it reads as a NES explosion rather than a particle system.
  const SHARDS = 10;
  const shardGeometry = new THREE.BoxGeometry(0.26, 0.26, 0.26);
  const shardMaterial = createToonMaterial({ color: SCENE.blastCore, unlit: true, fogAmount: 0 });
  const shardFlash = createToonMaterial({ color: SCENE.blastFlash, unlit: true, fogAmount: 0 });
  geometries.push(shardGeometry);
  materials.push(shardMaterial, shardFlash);
  const shards: THREE.Mesh[] = [];
  for (let i = 0; i < SHARDS; i += 1) {
    const mesh = new THREE.Mesh(shardGeometry, shardMaterial);
    mesh.visible = false;
    shards.push(mesh);
    group.add(mesh);
  }

  // A white-hot core for the first instant of the blast.
  const flashGeometry = new THREE.BoxGeometry(1, 1, 0.2);
  geometries.push(flashGeometry);
  const flashMesh = new THREE.Mesh(flashGeometry, shardFlash);
  flashMesh.visible = false;
  group.add(flashMesh);

  const update: Board3D['update'] = (board, falling, explosion, collapse, highlight, time) => {
    const flashOn = highlight !== null && Math.floor(time * 8) % 2 === 0;
    const h0 = highlight ? highlight[0] : -1;
    const h1 = highlight ? highlight[1] : -1;
    const h2 = highlight ? highlight[2] : -1;
    const h3 = highlight ? highlight[3] : -1;

    for (let i = 0; i < CELL_COUNT; i += 1) {
      const mesh = discs[i];
      if (!mesh) continue;
      const cell = board[i] ?? 0;
      if (cell === 0) {
        mesh.visible = false;
        continue;
      }
      const col = i % COLS;
      const row = Math.floor(i / COLS);

      // The disc being blown apart is gone from the moment the burst starts.
      if (explosion && col === explosion.col && row === explosion.row) {
        mesh.visible = false;
        continue;
      }

      mesh.visible = true;
      const base = cellCenter(col, row);
      const sliding = collapse && col === collapse.col && row > collapse.aboveRow;
      mesh.position.y = sliding ? base.y - collapse.offset * COURSE.cellPitch : base.y;

      const lit = flashOn && (i === h0 || i === h1 || i === h2 || i === h3);
      const wanted = lit ? flashMaterials[cell] : discMaterials[cell];
      if (mesh.material !== wanted) mesh.material = wanted;
    }

    if (explosion) {
      const centre = cellCenter(explosion.col, explosion.row);
      const t = Math.min(1, Math.max(0, explosion.t));
      const reach = 0.2 + t * 0.95;
      const scale = Math.max(0.05, 1 - t * 0.8);
      for (let i = 0; i < SHARDS; i += 1) {
        const mesh = shards[i];
        if (!mesh) continue;
        const angle = (i / SHARDS) * Math.PI * 2 + 0.4;
        mesh.visible = true;
        mesh.position.set(
          centre.x + Math.cos(angle) * reach,
          // Gravity on the shards, so they arc instead of sliding outward flat.
          centre.y + Math.sin(angle) * reach - t * t * 0.9,
          // Thrown clear of the panel, or the board face hides the whole blast.
          COURSE.boardZ + 0.45 + t * 0.9 + Math.cos(angle * 2.3) * 0.25,
        );
        mesh.scale.setScalar(scale);
        mesh.rotation.set(angle + t * 4, t * 5, 0);
        const wanted = t < 0.35 ? shardFlash : shardMaterial;
        if (mesh.material !== wanted) mesh.material = wanted;
      }

      // The core: a hard flash that swells and is gone within a third of the burst.
      if (t < 0.4) {
        const grow = 0.6 + t * 4.2;
        flashMesh.visible = true;
        flashMesh.position.set(centre.x, centre.y, COURSE.boardZ + 0.5);
        flashMesh.scale.set(grow, grow, 1);
        const wanted = t < 0.18 ? shardFlash : shardMaterial;
        if (flashMesh.material !== wanted) flashMesh.material = wanted;
      } else {
        flashMesh.visible = false;
      }
    } else {
      for (const mesh of shards) mesh.visible = false;
      flashMesh.visible = false;
    }

    if (falling) {
      const centre = cellCenter(Math.min(COLS - 1, Math.max(0, falling.col)), 0);
      fallingMesh.visible = true;
      fallingMesh.position.set(centre.x, falling.y, COURSE.boardZ);
      const wanted = discMaterials[falling.player];
      if (fallingMesh.material !== wanted) fallingMesh.material = wanted;
    } else {
      fallingMesh.visible = false;
    }
  };

  return {
    group,
    update,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      discs.length = 0;
      group.clear();
    },
  };
}
