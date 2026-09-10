/**
 * Menu plumbing for the front end of the game: a cursor-driven list, and the
 * five-slot room-code picker used to type a challenge code with nothing but a
 * d-pad (or a thumb).
 */
import { ROOM_ALPHABET, ROOM_CODE_LENGTH } from '../net/protocol';
import type { InputState } from './input';

export interface MenuItem<T extends string> {
  id: T;
  label: string;
  /** Rendered but unselectable, e.g. an online option while offline. */
  disabled?: boolean;
}

export interface Menu<T extends string> {
  readonly items: readonly MenuItem<T>[];
  readonly index: number;
  readonly labels: readonly string[];
  /** Returns the chosen id on a confirm press, `'@back'` on cancel, else null. */
  update(input: InputState, onMove: () => void): T | '@back' | null;
  reset(index?: number): void;
}

export function createMenu<T extends string>(items: readonly MenuItem<T>[]): Menu<T> {
  let index = items.findIndex((item) => !item.disabled);
  if (index < 0) index = 0;

  const step = (delta: number): void => {
    for (let i = 0; i < items.length; i++) {
      index = (index + delta + items.length) % items.length;
      if (!items[index]?.disabled) return;
    }
  };

  return {
    items,
    get index(): number {
      return index;
    },
    get labels(): readonly string[] {
      return items.map((item) => item.label);
    },
    update(input: InputState, onMove: () => void): T | '@back' | null {
      if (input.pressed('up')) {
        step(-1);
        onMove();
      }
      if (input.pressed('down')) {
        step(1);
        onMove();
      }
      if (input.pressed('cancel')) return '@back';
      if (input.pressed('confirm')) {
        const item = items[index];
        if (item && !item.disabled) return item.id;
      }
      return null;
    },
    reset(next = 0): void {
      index = next;
    },
  };
}

/**
 * Five character slots from the room alphabet. Up/down cycles the letter,
 * left/right moves between slots, confirm on the last slot submits — the same
 * pattern as entering initials on an arcade high-score table.
 */
export interface CodePicker {
  readonly code: string;
  readonly slot: number;
  /** Returns the finished code on submit, `'@back'` on cancel, else null. */
  update(input: InputState, onMove: () => void): string | '@back' | null;
  reset(seed?: string): void;
}

export function createCodePicker(): CodePicker {
  const letters = new Array<number>(ROOM_CODE_LENGTH).fill(0);
  let slot = 0;

  const code = (): string => letters.map((i) => ROOM_ALPHABET[i] ?? '2').join('');

  return {
    get code(): string {
      return code();
    },
    get slot(): number {
      return slot;
    },
    update(input: InputState, onMove: () => void): string | '@back' | null {
      const current = letters[slot] ?? 0;
      if (input.pressed('up')) {
        letters[slot] = (current + 1) % ROOM_ALPHABET.length;
        onMove();
      }
      if (input.pressed('down')) {
        letters[slot] = (current - 1 + ROOM_ALPHABET.length) % ROOM_ALPHABET.length;
        onMove();
      }
      if (input.pressed('left')) {
        slot = Math.max(0, slot - 1);
        onMove();
      }
      if (input.pressed('right')) {
        slot = Math.min(ROOM_CODE_LENGTH - 1, slot + 1);
        onMove();
      }
      if (input.pressed('cancel')) return '@back';
      if (input.pressed('confirm')) {
        if (slot < ROOM_CODE_LENGTH - 1) {
          slot += 1;
          onMove();
          return null;
        }
        return code();
      }
      return null;
    },
    reset(seed?: string): void {
      slot = 0;
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        const ch = seed?.[i];
        const at = ch ? ROOM_ALPHABET.indexOf(ch) : -1;
        letters[i] = at >= 0 ? at : 0;
      }
    },
  };
}

/** `#/r/ABCDE` -> `ABCDE`. */
export function roomFromHash(hash: string): string | null {
  const match = /^#\/r\/([0-9A-Za-z]+)$/.exec(hash);
  return match?.[1] ?? null;
}
