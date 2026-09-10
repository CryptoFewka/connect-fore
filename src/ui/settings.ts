/**
 * Player preferences that outlive a session. Audio owns its own volume/mute
 * keys; this is everything else.
 */

const KEY = 'connect-fore:settings:v1';

export interface Settings {
  name: string;
  difficulty: 'easy' | 'normal' | 'hard';
  /** Remembered so a returning player keeps their handle in online matches. */
  lastRoom: string | null;
}

const DEFAULTS: Settings = {
  name: 'PLAYER',
  difficulty: 'normal',
  lastRoom: null,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 8).toUpperCase() : DEFAULTS.name,
      difficulty:
        parsed.difficulty === 'easy' || parsed.difficulty === 'hard' || parsed.difficulty === 'normal'
          ? parsed.difficulty
          : DEFAULTS.difficulty,
      lastRoom: typeof parsed.lastRoom === 'string' ? parsed.lastRoom : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota — preferences simply don't persist.
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
