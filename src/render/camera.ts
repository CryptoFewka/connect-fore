/**
 * The camera rig.
 *
 * Each `CameraShot` is a pure function of the frame that yields a position, a
 * look-at point and a field of view. The rig never cuts: it damps towards the
 * requested shot, so switching from `follow` to `board` when the ball threads a
 * gap sweeps round instead of jarring. Only the first frame snaps.
 */
import * as THREE from 'three';
import type { CameraShot, RenderFrame } from './api';
import { COLS, COURSE, ROWS, cellCenter } from '../game/types';

const BOARD_CENTRE = new THREE.Vector3(0, cellCenter(0, (ROWS - 1) / 2).y, COURSE.boardZ);

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** `dt` in seconds; `allowShake` is false under `prefers-reduced-motion`. */
  update(frame: RenderFrame, dt: number, allowShake: boolean): void;
  /** Jump straight to the requested shot, skipping the blend. */
  snap(frame: RenderFrame): void;
  setAspect(aspect: number): void;
}

interface Shot {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

const FOV: Readonly<Record<CameraShot, number>> = {
  title: 46,
  address: 52,
  follow: 50,
  board: 42,
  result: 42,
};

/** Cheap deterministic wobble; two incommensurate sines read as noise. */
function wobble(time: number, seed: number): number {
  return Math.sin(time * (57.3 + seed * 11.7)) * Math.sin(time * (23.1 + seed * 7.3));
}

/** Builds the rig. `aspect` is the render target's, not the viewport's. */
export function createCameraRig(aspect: number): CameraRig {
  const camera = new THREE.PerspectiveCamera(46, aspect, 0.1, 700);

  // Everything below is reused every frame; the hot path allocates nothing.
  const shot: Shot = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 46 };
  const currentPos = new THREE.Vector3(0, 6, 20);
  const currentTarget = BOARD_CENTRE.clone();
  const ball = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let currentFov = 46;
  let started = false;

  const resolve = (frame: RenderFrame): Shot => {
    ball.set(frame.ball.x, frame.ball.y, frame.ball.z);
    shot.fov = FOV[frame.camera];

    switch (frame.camera) {
      case 'title': {
        const angle = Math.sin(frame.time * 0.22) * 0.9;
        shot.position.set(Math.sin(angle) * 13.5, 6.2 + Math.sin(frame.time * 0.3) * 0.5, Math.cos(angle) * 13.5);
        shot.target.copy(BOARD_CENTRE);
        break;
      }
      case 'address': {
        const yaw = frame.aim ? frame.aim.yaw : 0;
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        // Over the right shoulder, swung round with the aim.
        scratch.set(0.6, 0, 3.4);
        shot.position.set(ball.x + scratch.x * cos - scratch.z * sin, ball.y + 1.5, ball.z + scratch.x * sin + scratch.z * cos);
        shot.target.set(ball.x + sin * 14, 3.1, ball.z - cos * 14);
        break;
      }
      case 'follow': {
        scratch.subVectors(ball, BOARD_CENTRE);
        scratch.y = 0;
        if (scratch.lengthSq() < 0.04) scratch.set(0, 0, 1);
        scratch.normalize().multiplyScalar(6.6);
        shot.position.set(ball.x + scratch.x, Math.max(1.4, ball.y + 2.1), ball.z + scratch.z);
        shot.target.lerpVectors(ball, BOARD_CENTRE, 0.42);
        break;
      }
      case 'board': {
        // Framed so the whole 7x6 grid sits between the player panels and the
        // meter, with the stand still visible underneath.
        shot.position.set(0.8, 3.5, COURSE.boardZ + 13.3);
        shot.target.set(0, 3.05, COURSE.boardZ);
        break;
      }
      case 'result': {
        centroid.copy(BOARD_CENTRE);
        if (frame.highlight) {
          let x = 0;
          let y = 0;
          for (const index of frame.highlight) {
            const centre = cellCenter(index % COLS, Math.floor(index / COLS));
            x += centre.x;
            y += centre.y;
          }
          centroid.set(x / 4, y / 4, COURSE.boardZ);
        }
        // Favour the winning line but keep the rest of the board in shot.
        centroid.lerp(BOARD_CENTRE, 0.45);
        shot.position.set(
          centroid.x * 0.5 + Math.sin(frame.time * 0.5) * 1.5,
          centroid.y + 1.6,
          COURSE.boardZ + 12.2,
        );
        shot.target.copy(centroid);
        break;
      }
    }
    return shot;
  };

  const apply = (frame: RenderFrame, allowShake: boolean): void => {
    const shake = allowShake ? Math.min(1, Math.max(0, frame.shake)) : 0;
    camera.position.copy(currentPos);
    if (shake > 0) {
      const amp = shake * 0.55;
      camera.position.x += wobble(frame.time, 1) * amp;
      camera.position.y += wobble(frame.time, 2) * amp;
      camera.position.z += wobble(frame.time, 3) * amp * 0.4;
    }
    camera.lookAt(currentTarget);
    if (shake > 0) camera.rotation.z += wobble(frame.time, 4) * shake * 0.05;
    if (camera.fov !== currentFov) {
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    }
  };

  const snap: CameraRig['snap'] = (frame) => {
    const next = resolve(frame);
    currentPos.copy(next.position);
    currentTarget.copy(next.target);
    currentFov = next.fov;
    started = true;
    apply(frame, false);
  };

  return {
    camera,
    snap,
    update: (frame, dt, allowShake) => {
      if (!started) {
        snap(frame);
        return;
      }
      const next = resolve(frame);
      const step = Math.min(1, Math.max(0, dt));
      const blend = 1 - Math.exp(-3.4 * step);
      currentPos.lerp(next.position, blend);
      currentTarget.lerp(next.target, blend);
      currentFov += (next.fov - currentFov) * blend;
      apply(frame, allowShake);
    },
    setAspect: (value) => {
      camera.aspect = value;
      camera.updateProjectionMatrix();
    },
  };
}
