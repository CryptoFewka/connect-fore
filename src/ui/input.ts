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

export type DragMode = 'gesture' | 'aim' | 'lock';

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
  /** How far the pointer moved this frame, in fractions of the canvas. */
  readonly dragDeltaX: number;
  readonly dragDeltaY: number;
  /** True once the player has touched the screen rather than clicked it. */
  readonly isTouch: boolean;
  /**
   * What a pointer gesture means right now.
   *
   * - `gesture` (menus, result screen): flicks move the cursor and go back, a
   *   tap in place commits.
   * - `aim`: a drag steers the shot, so flicks must stand down or swinging the
   *   aim left would quit the match. A tap in place commits; a press held in
   *   place is the way out, since no flick is safe here.
   * - `lock` (power, accuracy, and while a shot plays out): the press itself
   *   already did the work, so releasing must do nothing at all.
   */
  setDragMode(mode: DragMode): void;
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
  let lastX = 0;
  let lastY = 0;
  let deltaX = 0;
  let deltaY = 0;
  let downAt = 0;
  let touched = false;
  let dragMode: DragMode = 'gesture';
  /** Total distance travelled this gesture, not just the net displacement. */
  let pathLen = 0;

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
    // Capture keeps a drag alive if the finger leaves the canvas, but it throws
    // for a pointer the browser no longer considers active - and losing the rest
    // of this handler would leave input dead.
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable; the drag still works, it just won't track off-canvas */
    }
    pointer = localPoint(e);
    pointerHeld = true;
    dragOriginX = pointer.x;
    dragOriginY = pointer.y;
    lastX = pointer.x;
    lastY = pointer.y;
    deltaX = 0;
    deltaY = 0;
    pathLen = 0;
    downAt = e.timeStamp;
    if (e.pointerType === 'touch') touched = true;
    press('confirm');
  };

  const onPointerMove = (e: PointerEvent): void => {
    pointer = localPoint(e);
    if (e.pointerType === 'touch') touched = true;
    if (!pointerHeld) return;
    const stepX = pointer.x - lastX;
    const stepY = pointer.y - lastY;
    lastX = pointer.x;
    lastY = pointer.y;
    pathLen += Math.abs(stepX) + Math.abs(stepY);
    // A tap is never perfectly still. Swallow the first scrap of movement so
    // the finger that commits a shot doesn't shove the aim on its way down.
    if (pathLen < DEAD_ZONE) return;
    // Accumulated, because several moves can arrive between two frames.
    deltaX += stepX;
    deltaY += stepY;
  };

  /** A flick is worth a d-pad press; anything shorter is a tap. */
  const SWIPE = 0.06; // fraction of the canvas
  const SWIPE_MS = 600;
  /** Movement below this is tap jitter, not aiming. */
  const DEAD_ZONE = 0.012;
  /**
   * Held this long in place, a touch means "get me out of here". It has to sit
   * well clear of a slow tap: at 550ms an unhurried thumb was reading as Back
   * and quitting matches.
   */
  const HOLD_MS = 900;

  const onPointerUp = (e: PointerEvent): void => {
    try {
      target.releasePointerCapture?.(e.pointerId);
    } catch {
      /* never captured */
    }
    const end = localPoint(e);
    const dx = end.x - dragOriginX;
    const dy = end.y - dragOriginY;
    const quick = e.timeStamp - downAt < SWIPE_MS;

    // Net displacement alone would call a drag that wandered out and came back
    // "still", committing a shot the player was only lining up.
    const still = pathLen < SWIPE && Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE;
    if (dragMode === 'lock') {
      // The press already committed; the release must not do anything else.
    } else if (dragMode === 'aim') {
      // Everything here is aiming, so no flick can mean "back" - a press held
      // in place does instead.
      if (still) edges.add(e.timeStamp - downAt >= HOLD_MS ? 'cancel' : 'select');
    } else if (quick && Math.abs(dy) > SWIPE && Math.abs(dy) > Math.abs(dx)) {
      edges.add(dy < 0 ? 'up' : 'down');
    } else if (quick && dx < -SWIPE && Math.abs(dx) > Math.abs(dy)) {
      edges.add('cancel');
    } else if (still) {
      // A tap in place: the menus' commit, kept off the swipe gestures.
      edges.add('select');
    }

    pointerHeld = false;
    deltaX = 0;
    deltaY = 0;
    pathLen = 0;
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
    get dragDeltaX(): number {
      return deltaX;
    },
    get dragDeltaY(): number {
      return deltaY;
    },
    get isTouch(): boolean {
      return touched;
    },
    setDragMode(mode: DragMode): void {
      dragMode = mode;
    },
    pressed(action: InputAction): boolean {
      return edges.has(action);
    },
    endFrame(): void {
      edges.clear();
      deltaX = 0;
      deltaY = 0;
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
