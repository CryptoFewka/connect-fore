/**
 * The how-to-play text, in two flavours.
 *
 * Which one you need depends on what you're holding, and the game can't always
 * tell — a tablet with a keyboard, a laptop with a touchscreen — so the screen
 * that shows these lets you flip between them rather than guessing once and
 * being wrong for the rest of the match.
 */

export type ControlScheme = 'touch' | 'keys';

/**
 * Fourteen lines is what fits between the title and the hint bar at 256x240.
 * Anything longer is silently clipped, so keep the count if you edit this.
 */
const RULES: readonly string[] = [
  '',
  'THE SHOT:',
  '1 AIM   2 POWER   3 SWEET SPOT',
  '',
  'THREAD A GAP TO DROP A DISC.',
  'MISS AND YOU LOSE THE TURN.',
  'BLAST A RIVAL DISC AND THEIR',
  'STACK FALLS IN. FOUR WINS.',
  'NEW? TRY THE TUTORIAL.',
];

const KEYS: readonly string[] = [
  'KEYBOARD CONTROLS:',
  'AIM     ARROWS OR WASD',
  'COMMIT  ENTER, SPACE OR Z',
  'BACK    ESC OR X',
  'MUTE    M',
];

const TOUCH: readonly string[] = [
  'TOUCH CONTROLS:',
  'AIM     DRAG THE SCREEN',
  'COMMIT  TAP',
  'MENUS   SWIPE UP OR DOWN',
  'BACK    SWIPE LEFT OR HOLD',
];

export function instructionLines(scheme: ControlScheme): readonly string[] {
  return [...(scheme === 'touch' ? TOUCH : KEYS), ...RULES];
}

export function otherScheme(scheme: ControlScheme): ControlScheme {
  return scheme === 'touch' ? 'keys' : 'touch';
}

/** The prompt for switching, written in the scheme currently on screen. */
export function schemeHint(scheme: ControlScheme): string {
  return scheme === 'touch' ? 'TAP SWITCHES   SWIPE LEFT EXITS' : 'LEFT/RIGHT SWITCHES  BACK EXITS';
}
