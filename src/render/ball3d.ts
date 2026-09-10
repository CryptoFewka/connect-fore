/**
 * The ball, its contact shadow and the aim guide.
 *
 * The ball is an icosphere rather than a UV sphere: at this resolution the
 * facets are the point, and the toon bands break across them so the ball reads
 * as a solid even when it is four pixels wide.
 */
import * as THREE from 'three';
import { COURSE } from '../game/types';
import { SCENE, createToonMaterial } from './palette';

export interface BallView {
  x: number;
  y: number;
  z: number;
  visible: boolean;
}

export interface AimView {
  /** Radians. 0 aims at the board centre, positive is right. */
  yaw: number;
  /** Radians above horizontal. */
  loft: number;
}

export interface Ball3D {
  readonly group: THREE.Group;
  update(ball: BallView, aim: AimView | null, time: number): void;
  dispose(): void;
}

/** Builds the ball rig. One per renderer. */
export function createBall3D(): Ball3D {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const ballGeometry = new THREE.IcosahedronGeometry(COURSE.ballRadius, 1);
  const ballMaterial = createToonMaterial({ color: SCENE.ball });
  geometries.push(ballGeometry);
  materials.push(ballMaterial);
  const ball = new THREE.Mesh(ballGeometry, ballMaterial);
  group.add(ball);

  const shadowGeometry = new THREE.CircleGeometry(COURSE.ballRadius * 1.6, 10);
  const shadowMaterial = createToonMaterial({
    color: SCENE.shadow,
    unlit: true,
    opacity: 0.55,
    depthWrite: false,
    fogAmount: 0,
  });
  geometries.push(shadowGeometry);
  materials.push(shadowMaterial);
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  group.add(shadow);

  // --- aim guide -----------------------------------------------------------
  const aimGroup = new THREE.Group();
  aimGroup.visible = false;
  group.add(aimGroup);

  const chevronGeometry = new THREE.BoxGeometry(0.5, 0.04, 0.22);
  const aimMaterial = createToonMaterial({ color: SCENE.aim, unlit: true, fogAmount: 0 });
  const aimHotMaterial = createToonMaterial({ color: SCENE.aimHot, unlit: true, fogAmount: 0 });
  geometries.push(chevronGeometry);
  materials.push(aimMaterial, aimHotMaterial);

  const chevrons: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i += 1) {
    const chevron = new THREE.Mesh(chevronGeometry, aimMaterial);
    chevron.position.set(0, 0.04, -(0.9 + i * 0.75));
    chevron.scale.setScalar(1 - i * 0.12);
    aimGroup.add(chevron);
    chevrons.push(chevron);
  }

  const tipGeometry = new THREE.ConeGeometry(0.28, 0.6, 6);
  geometries.push(tipGeometry);
  const tip = new THREE.Mesh(tipGeometry, aimHotMaterial);
  tip.rotation.x = -Math.PI / 2;
  tip.position.set(0, 0.05, -4.1);
  aimGroup.add(tip);

  // The loft arm rises out of the ball at the launch angle.
  const armGeometry = new THREE.BoxGeometry(0.06, 0.06, 1.7);
  geometries.push(armGeometry);
  const arm = new THREE.Mesh(armGeometry, aimHotMaterial);
  arm.position.set(0, COURSE.ballRadius, -0.85);
  const armPivot = new THREE.Group();
  armPivot.add(arm);
  aimGroup.add(armPivot);

  const update: Ball3D['update'] = (view, aim, time) => {
    ball.visible = view.visible;
    shadow.visible = view.visible;
    if (view.visible) {
      ball.position.set(view.x, view.y, view.z);
      ball.rotation.set(time * 2.7, time * 3.4, 0);
      shadow.position.set(view.x, 0.05, view.z);
      const height = Math.max(0, view.y - COURSE.ballRadius);
      const spread = Math.max(0.35, 1 - height * 0.06);
      shadow.scale.setScalar(spread);
    }

    if (aim) {
      aimGroup.visible = true;
      aimGroup.position.set(view.x, 0, view.z);
      aimGroup.rotation.y = -aim.yaw;
      armPivot.rotation.x = aim.loft;
      const step = Math.floor(time * 6) % (chevrons.length + 1);
      for (let i = 0; i < chevrons.length; i += 1) {
        const chevron = chevrons[i];
        if (chevron) chevron.material = i === step ? aimHotMaterial : aimMaterial;
      }
    } else {
      aimGroup.visible = false;
    }
  };

  return {
    group,
    update,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      chevrons.length = 0;
      group.clear();
    },
  };
}
