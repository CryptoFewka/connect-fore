/**
 * One input surface over keyboard, mouse, touch and pen.
 *
 * The game only ever asks two questions: "which way is the player nudging?"
 * (a held axis) and "did they just commit?" (an edge-triggered press). That
 * keeps the 3-click golf meter identical on a keyboard and under a thumb.
 */

export type InputAction =
  /** Edge-triggered the instant a control goes down - the meter needs this. */
  | 'confirm'
  /** A completed tap or key press. Menus use this so a swipe isn't a choice. */
  | 'select'
  | 'cancel'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'mute';

export interface InputState {
  /** -1..1 held horizontal nudge. */
  readonly axisX: number;
  /** -1..1 held vertical nudge. */
  readonly axisY: number;
  /** True on the frame an action was pressed. */
  pressed(action: InputAction): boolean;
  /** True while a confirm-style control is held (drag or key). */
  readonly holding: boolean;
  /** Latest pointer position in 0..1 of the canvas, or null. */
  readonly pointer: { x: number; y: number } | null;
  /** Call once per frame, after the game has read the state. */
  endFrame(): void;
  dispose(): void;
}

const KEY_MAP: Record<string, InputAction> = {
  Enter: 'confirm',
  Space: 'confirm',
  KeyZ: 'confirm',
  Escape: 'cancel',
  Backspace: 'cancel',
  KeyX: 'cancel',
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  KeyM: 'mute',
};

export function createInput(target: HTMLElement): InputState {
  const held = new Set<InputAction>();
  const edges = new Set<InputAction>();
  let pointer: { x: number; y: number } | null = null;
  let pointerHeld = false;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let dragX = 0;
  let downAt = 0;

  const press = (action: InputAction): void => {
    if (!held.has(action)) edges.add(action);
    held.add(action);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    // Arrow keys and space scroll the page otherwise.
    e.preventDefault();
    if (e.repeat) {
      held.add(action);
      return;
    }
    press(action);
    if (action === 'confirm') edges.add('select');
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const action = KEY_MAP[e.code];
    if (action) held.delete(action);
  };

  const onBlur = (): void => {
    held.clear();
    pointerHeld = false;
  };

  const localPoint = (e: PointerEvent): { x: number; y: number } => {
    const rect = target.getBoundingClientRect();
    return {
      x: rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5,
      y: rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5,
    };
  };

  const onPointerDown = (e: PointerEvent): void => {
    target.setPointerCapture?.(e.pointerId);
    pointer = localPoint(e);
    pointerHeld = true;
    dragOriginX = pointer.x;
    dragOriginY = pointer.y;
    dragX = 0;
    downAt = e.timeStamp;
    press('confirm');
  };

  const onPointerMove = (e: PointerEvent): void => {
    pointer = localPoint(e);
    if (pointerHeld) dragX = pointer.x - dragOriginX;
  };

  /** A flick is worth a d-pad press; anything shorter is a tap. */
  const SWIPE = 0.06; // fraction of the canvas
  const SWIPE_MS = 600;

  const onPointerUp = (e: PointerEvent): void => {
    target.releasePointerCapture?.(e.pointerId);
    const end = localPoint(e);
    const dx = end.x - dragOriginX;
    const dy = end.y - dragOriginY;
    const quick = e.timeStamp - downAt < SWIPE_MS;

    if (quick && Math.abs(dy) > SWIPE && Math.abs(dy) > Math.abs(dx)) {
      edges.add(dy < 0 ? 'up' : 'down');
    } else if (quick && dx < -SWIPE && Math.abs(dx) > Math.abs(dy)) {
      edges.add('cancel');
    } else if (Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE) {
      // A tap in place: the menus' commit, kept off the swipe gestures.
      edges.add('select');
    }

    pointerHeld = false;
    dragX = 0;
    held.delete('confirm');
  };

  const onContextMenu = (e: Event): void => e.preventDefault();

  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointercancel', onPointerUp);
  target.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    get axisX(): number {
      let axis = 0;
      if (held.has('left')) axis -= 1;
      if (held.has('right')) axis += 1;
      // A horizontal drag doubles as an analogue nudge on touch.
      if (axis === 0 && pointerHeld) axis = Math.max(-1, Math.min(1, dragX * 6));
      return axis;
    },
    get axisY(): number {
      let axis = 0;
      if (held.has('down')) axis -= 1;
      if (held.has('up')) axis += 1;
      return axis;
    },
    get holding(): boolean {
      return pointerHeld || held.has('confirm');
    },
    get pointer(): { x: number; y: number } | null {
      return pointer;
    },
    pressed(action: InputAction): boolean {
      return edges.has(action);
    },
    endFrame(): void {
      edges.clear();
    },
    dispose(): void {
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerUp);
      target.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
