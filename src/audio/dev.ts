/**
 * Standalone listening bench for the APU — `bun run dev` then open
 * http://localhost:5173/src/audio/dev.html
 *
 * It drives the engine through the public `AudioEngine` surface only, so
 * whatever sounds right here is exactly what the game will get.
 */
import type { MusicTrack, SfxName } from './api';
import { createAudio } from './engine';
import { SFX_NAMES } from './sfx';
import { TRACKS } from './music';

const engine = createAudio();
const status = document.getElementById('status');
const trackNames = Object.keys(TRACKS) as MusicTrack[];

function say(message: string): void {
  if (status) status.textContent = message;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

/** Any click counts as the gesture that lets the context start. */
async function ensureRunning(): Promise<boolean> {
  if (!engine.ready()) await engine.unlock();
  if (!engine.ready()) {
    say('AudioContext is not running — Web Audio may be unavailable here.');
    return false;
  }
  return true;
}

const unlockButton = document.getElementById('unlock');
unlockButton?.addEventListener('click', () => {
  void (async () => {
    if (await ensureRunning()) say('Audio running. Pick a sound.');
  })();
});

const muteButton = document.getElementById('mute');
const syncMute = (): void => {
  muteButton?.setAttribute('aria-pressed', String(engine.isMuted()));
  if (muteButton) muteButton.textContent = engine.isMuted() ? 'MUTED' : 'MUTE';
};
muteButton?.addEventListener('click', () => {
  engine.setMuted(!engine.isMuted());
  syncMute();
  say(engine.isMuted() ? 'Muted.' : 'Unmuted.');
});
syncMute();

const volume = document.getElementById('volume');
const volumeOut = document.getElementById('volume-out');
if (volume instanceof HTMLInputElement) {
  volume.value = String(Math.round(engine.getVolume() * 100));
  if (volumeOut) volumeOut.textContent = volume.value;
  volume.addEventListener('input', () => {
    engine.setVolume(Number(volume.value) / 100);
    if (volumeOut) volumeOut.textContent = volume.value;
  });
}

const tracks = document.getElementById('tracks');
for (const name of trackNames) {
  tracks?.appendChild(
    button(name.toUpperCase(), () => {
      void (async () => {
        if (!(await ensureRunning())) return;
        engine.music(name);
        say(`Music: ${name}`);
      })();
    }),
  );
}
tracks?.appendChild(
  button('STOP', () => {
    engine.music(null);
    say('Music stopped.');
  }),
);

const sfx = document.getElementById('sfx');
for (const name of SFX_NAMES) {
  sfx?.appendChild(
    button(name, () => {
      void (async () => {
        if (!(await ensureRunning())) return;
        engine.sfx(name);
        say(`SFX: ${name}`);
      })();
    }),
  );
}

/** Fires the tick at the rate the power meter will actually use. */
function burst(name: SfxName, count: number, gapMs: number): void {
  let fired = 0;
  const id = setInterval(() => {
    engine.sfx(name);
    if (++fired >= count) clearInterval(id);
  }, gapMs);
}

document.getElementById('sweep')?.addEventListener('click', () => {
  void (async () => {
    if (!(await ensureRunning())) return;
    say('Meter sweeping…');
    burst('meter-tick', 40, 50);
    setTimeout(() => engine.sfx('meter-lock'), 2050);
  })();
});

document.getElementById('rally')?.addEventListener('click', () => {
  void (async () => {
    if (!(await ensureRunning())) return;
    say('Full shot…');
    const script: [SfxName, number][] = [
      ['swing', 0],
      ['thread', 260],
      ['drop', 620],
      ['clack', 900],
    ];
    for (const [name, delay] of script) setTimeout(() => engine.sfx(name), delay);
  })();
});
