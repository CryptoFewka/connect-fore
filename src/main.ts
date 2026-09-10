/**
 * Connect Fore! — boot and app state machine.
 *
 * Owns the render loop, moves between the title screen, the menus, the online
 * lobby and a live match, and keeps the renderer, the audio engine and the
 * netcode talking to one another. Everything about a *shot* lives in
 * `ui/session.ts`; everything about the *rules* lives in `game/`.
 */
import { createRenderer } from './render/renderer';
import type { HudState, RenderFrame, Renderer } from './render/api';
import { createAudio } from './audio/engine';
import type { AudioEngine } from './audio/api';
import { createInput } from './ui/input';
import type { InputState } from './ui/input';
import { createSession } from './ui/session';
import type { Session, SessionSeats } from './ui/session';
import { createCodePicker, createMenu, roomFromHash } from './ui/screens';
import type { CodePicker } from './ui/screens';
import { DEFAULT_NAME, loadSettings, saveSettings } from './ui/settings';
import type { Settings } from './ui/settings';
import { newMatch } from './game/match';
import type { Difficulty, MatchState, Player } from './game/types';
import {
  challengeUrl,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from './net/protocol';
import type { PlayerInfo } from './net/protocol';
import { connectRoom } from './net/client';
import type { ConnectionStatus, RoomConnection } from './net/client';

type Screen =
  | 'title'
  | 'main'
  | 'difficulty'
  | 'online'
  | 'code'
  | 'lobby'
  | 'playing'
  | 'error';

const MAX_FRAME_DT = 1 / 20;

function boot(): void {
  const app = document.getElementById('app');
  if (!app) return;

  let renderer: Renderer;
  try {
    renderer = createRenderer(app);
  } catch (err) {
    showFatal(app, err);
    return;
  }

  const audio: AudioEngine = createAudio();
  const input: InputState = createInput(renderer.canvas);
  const settings: Settings = loadSettings();

  const mainMenu = createMenu([
    { id: 'solo', label: '1 PLAYER' },
    { id: 'hotseat', label: '2 PLAYER (SAME SCREEN)' },
    { id: 'online', label: 'PLAY ONLINE' },
  ] as const);
  const difficultyMenu = createMenu([
    { id: 'easy', label: 'EASY' },
    { id: 'normal', label: 'NORMAL' },
    { id: 'hard', label: 'HARD' },
  ] as const);
  const onlineMenu = createMenu([
    { id: 'create', label: 'CREATE CHALLENGE' },
    { id: 'join', label: 'ENTER A CODE' },
  ] as const);
  const codePicker: CodePicker = createCodePicker();

  let screen: Screen = 'title';
  let session: Session | null = null;
  let connection: RoomConnection | null = null;
  let connectionStatus: ConnectionStatus = 'closed';
  let roomCode: string | null = null;
  let lobbyPlayers: readonly PlayerInfo[] = [];
  let localSeat: Player | null = null;
  let banner: string | null = null;
  let bannerTimer = 0;
  const fatal: string | null = null;
  let started = false;

  const beep = (): void => audio.sfx('menu-move');
  const select = (): void => audio.sfx('menu-select');

  const say = (text: string, seconds = 2.2): void => {
    banner = text;
    bannerTimer = seconds;
  };

  // -- match set-up ---------------------------------------------------------

  function startLocalMatch(mode: 'solo' | 'hotseat'): void {
    const opponent = mode === 'solo' ? `CPU ${settings.difficulty.toUpperCase()}` : 'PLAYER 2';
    const seats: SessionSeats = {
      names: [settings.name, opponent],
      local: mode === 'solo' ? [1] : [1, 2],
      connected: [true, true],
    };
    session = createSession({
      audio,
      seats,
      ai: mode === 'solo' ? { seat: 2, difficulty: settings.difficulty } : undefined,
      seed: (Date.now() ^ 0x9e3779b9) >>> 0,
    });
    session.reset(newMatch());
    screen = 'playing';
    audio.music('play');
  }

  function seatsFrom(players: readonly PlayerInfo[], seat: Player | null): SessionSeats {
    const nameFor = (n: Player): string => {
      const found = players.find((p) => p.seat === n)?.name;
      if (!found) return n === 1 ? 'PLAYER 1' : 'WAITING...';
      // Two strangers who both kept the default handle need telling apart.
      return found === DEFAULT_NAME ? `${DEFAULT_NAME} ${n}` : found;
    };
    const connectedFor = (n: Player): boolean =>
      players.find((p) => p.seat === n)?.connected ?? false;
    return {
      names: [nameFor(1), nameFor(2)],
      local: seat ? [seat] : [],
      connected: [connectedFor(1), connectedFor(2)],
    };
  }

  function openRoom(code: string): void {
    connection?.close();
    roomCode = code;
    settings.lastRoom = code;
    saveSettings(settings);
    if (location.hash !== `#/r/${code}`) history.replaceState(null, '', `#/r/${code}`);
    screen = 'lobby';
    connectionStatus = 'connecting';

    connection = connectRoom(code, {
      name: settings.name,
      onStatus: (status) => {
        connectionStatus = status;
        if (status === 'reconnecting') say('RECONNECTING...', 3);
      },
      onWelcome: (msg) => {
        localSeat = msg.seat;
        lobbyPlayers = msg.players;
        session = createSession({
          audio,
          seats: seatsFrom(msg.players, msg.seat),
          score: msg.score,
          hooks: {
            submitShot: (turn, params) => connection?.sendShot(turn, params),
          },
        });
        session.setState(msg.state);
        if (msg.role === 'spectator') say('SPECTATING', 3);
        if (bothSeated(msg.players)) enterOnlineMatch();
      },
      onPlayers: (players) => {
        const wasReady = bothSeated(lobbyPlayers);
        lobbyPlayers = players;
        session?.setSeats(seatsFrom(players, localSeat));
        if (!wasReady && bothSeated(players)) {
          audio.sfx('join');
          enterOnlineMatch();
        } else if (wasReady && !bothSeated(players)) {
          audio.sfx('leave');
          say('OPPONENT DISCONNECTED', 3);
        }
      },
      onResolve: (record, state) => session?.acceptResolve(record, state),
      onRematch: (state) => {
        session?.reset(state);
        say('REMATCH!');
      },
      onError: (code, message) => say(`${code.toUpperCase()}: ${message}`.slice(0, 30), 3),
    });
  }

  function bothSeated(players: readonly PlayerInfo[]): boolean {
    return players.filter((p) => p.connected).length >= 2;
  }

  function enterOnlineMatch(): void {
    if (screen === 'lobby') {
      screen = 'playing';
      audio.music('play');
    }
  }

  function leaveMatch(): void {
    connection?.close();
    connection = null;
    session = null;
    roomCode = null;
    localSeat = null;
    lobbyPlayers = [];
    if (location.hash) history.replaceState(null, '', location.pathname);
    screen = 'main';
    audio.music('title');
  }

  async function copyChallengeLink(): Promise<void> {
    if (!roomCode) return;
    const url = challengeUrl(location.origin, roomCode);
    try {
      await navigator.clipboard.writeText(url);
      say('LINK COPIED!');
    } catch {
      say('COPY FAILED - USE THE CODE');
    }
  }

  // -- per-screen update ----------------------------------------------------

  function updateTitle(): void {
    if (input.pressed('confirm')) {
      void audio.unlock();
      audio.music('title');
      select();
      const deepLink = roomFromHash(location.hash);
      if (deepLink) {
        const code = normalizeRoomCode(deepLink);
        if (isValidRoomCode(code)) {
          openRoom(code);
          return;
        }
      }
      screen = 'main';
    }
  }

  function updateMenus(): void {
    if (screen === 'main') {
      const choice = mainMenu.update(input, beep);
      if (choice === 'solo') {
        select();
        screen = 'difficulty';
      } else if (choice === 'hotseat') {
        select();
        startLocalMatch('hotseat');
      } else if (choice === 'online') {
        select();
        screen = 'online';
      }
      return;
    }

    if (screen === 'difficulty') {
      const choice = difficultyMenu.update(input, beep);
      if (choice === '@back') {
        screen = 'main';
      } else if (choice) {
        settings.difficulty = choice as Difficulty;
        saveSettings(settings);
        select();
        startLocalMatch('solo');
      }
      return;
    }

    if (screen === 'online') {
      const choice = onlineMenu.update(input, beep);
      if (choice === '@back') {
        screen = 'main';
      } else if (choice === 'create') {
        select();
        openRoom(generateRoomCode());
      } else if (choice === 'join') {
        select();
        codePicker.reset(settings.lastRoom ?? undefined);
        screen = 'code';
      }
      return;
    }

    if (screen === 'code') {
      const result = codePicker.update(input, beep);
      if (result === '@back') {
        screen = 'online';
      } else if (result) {
        if (isValidRoomCode(result)) {
          select();
          openRoom(result);
        } else {
          say('BAD CODE');
        }
      }
    }
  }

  function updateLobby(): void {
    if (input.pressed('cancel')) {
      leaveMatch();
      return;
    }
    if (input.pressed('confirm')) void copyChallengeLink();
  }

  function updatePlaying(dt: number): void {
    if (!session) return;
    session.update(dt, input);

    if (session.phase === 'over' && input.pressed('confirm')) {
      select();
      if (connection) {
        connection.requestRematch();
        say('REMATCH REQUESTED');
      } else {
        session.reset(newMatch());
        audio.music('play');
      }
    }
    if (input.pressed('cancel')) leaveMatch();
  }

  // -- frame building -------------------------------------------------------

  function menuFrame(time: number, hud: Partial<HudState>): RenderFrame {
    return {
      board: newMatch().board,
      ball: { x: 0, y: -10, z: 0, visible: false },
      aim: null,
      camera: 'title',
      fallingDisc: null,
      highlight: null,
      shake: 0,
      time,
      hud: {
        visible: true,
        title: null,
        subtitle: null,
        message: banner,
        players: [],
        meter: null,
        roomCode,
        hint: null,
        menu: null,
        ...hud,
      },
    };
  }

  function buildFrame(time: number): RenderFrame {
    switch (screen) {
      case 'title':
        return menuFrame(time, {
          title: 'CONNECT FORE!',
          subtitle: 'GOLF MEETS CONNECT FOUR',
          hint: 'PRESS FIRE TO START',
        });

      case 'main':
        return menuFrame(time, {
          title: 'CONNECT FORE!',
          menu: { items: mainMenu.labels, index: mainMenu.index },
          hint: 'ARROWS MOVE   FIRE SELECTS',
        });

      case 'difficulty':
        return menuFrame(time, {
          title: 'CPU SKILL',
          menu: { items: difficultyMenu.labels, index: difficultyMenu.index },
          hint: 'BACK CANCELS',
        });

      case 'online':
        return menuFrame(time, {
          title: 'PLAY ONLINE',
          menu: { items: onlineMenu.labels, index: onlineMenu.index },
          hint: 'BACK CANCELS',
        });

      case 'code': {
        const marked = [...codePicker.code]
          .map((ch, i) => (i === codePicker.slot ? `[${ch}]` : ` ${ch} `))
          .join('');
        return menuFrame(time, {
          title: 'ENTER CODE',
          subtitle: marked,
          hint: 'UP/DOWN PICK   FIRE ACCEPTS',
        });
      }

      case 'lobby':
        return menuFrame(time, {
          title: 'CHALLENGE READY',
          subtitle: roomCode,
          message: banner ?? statusLine(connectionStatus, lobbyPlayers),
          hint: 'FIRE COPIES THE LINK   BACK EXITS',
        });

      case 'playing':
        return (
          session?.buildFrame(time, {
            roomCode,
            ...(banner ? { message: banner } : {}),
          }) ?? menuFrame(time, {})
        );

      case 'error':
        return menuFrame(time, { title: 'ERROR', subtitle: fatal, hint: 'RELOAD THE PAGE' });
    }
  }

  // -- loop -----------------------------------------------------------------

  // A small window onto the running game: used by the automated play-through
  // harness, and handy for poking at a live match from the browser console.
  (window as unknown as { connectFore: () => unknown }).connectFore = () => ({
    screen,
    phase: session?.phase ?? null,
    turn: session?.state.turn ?? null,
    current: session?.state.current ?? null,
    status: session?.state.status ?? null,
    discs: session?.state.board.filter((cell) => cell !== 0).length ?? 0,
    lastOutcome: session?.state.lastShot?.outcome ?? null,
    winner: session?.state.winner ?? null,
    connection: connectionStatus,
    room: roomCode,
    seat: localSeat,
  });

  let last = performance.now();
  let paused = false;

  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, MAX_FRAME_DT);
    last = now;
    if (paused) return;

    if (input.pressed('mute')) {
      audio.setMuted(!audio.isMuted());
      say(audio.isMuted() ? 'SOUND OFF' : 'SOUND ON', 1.2);
    }
    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) banner = null;
    }
    if (started && !audio.ready() && input.holding) void audio.unlock();

    switch (screen) {
      case 'title':
        updateTitle();
        started = true;
        break;
      case 'main':
      case 'difficulty':
      case 'online':
      case 'code':
        updateMenus();
        break;
      case 'lobby':
        updateLobby();
        break;
      case 'playing':
        updatePlaying(dt);
        break;
      case 'error':
        break;
    }

    renderer.render(buildFrame(now / 1000));
    input.endFrame();
  };

  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (document.hidden) {
      audio.music(null);
    } else {
      last = performance.now();
      if (screen === 'playing') audio.music('play');
      else if (started) audio.music('title');
    }
  });

  window.addEventListener('hashchange', () => {
    const code = roomFromHash(location.hash);
    if (code && isValidRoomCode(normalizeRoomCode(code)) && screen !== 'playing') {
      openRoom(normalizeRoomCode(code));
    }
  });

  window.addEventListener('pagehide', () => connection?.close());

  requestAnimationFrame(loop);
}

function statusLine(status: ConnectionStatus, players: readonly PlayerInfo[]): string {
  if (status === 'connecting') return 'CONNECTING...';
  if (status === 'reconnecting') return 'RECONNECTING...';
  if (status === 'closed') return 'DISCONNECTED';
  return players.filter((p) => p.connected).length >= 2
    ? 'CHALLENGER FOUND!'
    : 'WAITING FOR CHALLENGER';
}

function showFatal(app: HTMLElement, err: unknown): void {
  const box = document.createElement('div');
  box.id = 'fallback';
  box.textContent =
    err instanceof Error && err.message
      ? `Connect Fore! could not start: ${err.message}`
      : 'Connect Fore! needs WebGL to run.';
  app.appendChild(box);
}

boot();

// A match ends when someone connects four; `MatchState` is re-exported for the
// dev console so the board can be inspected while playing.
export type { MatchState };
