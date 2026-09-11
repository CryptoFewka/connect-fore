/**
 * Fore! — boot and app state machine.
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
import { createTutorial } from './ui/tutorial';
import type { Tutorial } from './ui/tutorial';
import type { Session, SessionSeats } from './ui/session';
import { createCodePicker, createMenu, roomFromHash } from './ui/screens';
import { instructionLines, otherScheme, schemeHint } from './ui/instructions';
import type { ControlScheme } from './ui/instructions';
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
import { apiOrigin, shareOrigin } from './net/api-origin';
import { createNativeBridge } from './ui/native';
import type { ConnectionStatus, RoomConnection } from './net/client';

type Screen =
  | 'title'
  | 'main'
  | 'difficulty'
  | 'online'
  | 'help'
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
  const nativeBridge = createNativeBridge();

  const mainMenu = createMenu([
    // The lesson first: the shot takes some learning.
    { id: 'tutorial', label: 'TUTORIAL' },
    { id: 'range', label: 'DRIVING RANGE' },
    { id: 'solo', label: '1 PLAYER' },
    { id: 'hotseat', label: '2 PLAYER (SAME SCREEN)' },
    { id: 'online', label: 'PLAY ONLINE' },
    { id: 'help', label: 'HOW TO PLAY' },
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
  /**
   * Guards the way out of a live match. Back is easy to hit by accident on a
   * touchscreen, and losing a game in progress to a stray gesture is not a
   * mistake worth letting people make. Defaults to staying put.
   */
  const quitMenu = createMenu([
    { id: 'stay', label: 'KEEP PLAYING' },
    { id: 'quit', label: 'QUIT' },
  ] as const);

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
  let confirmingQuit = false;
  /**
   * The range and the tutorial run as the 'playing' screen rather than screens
   * of their own - touch aiming, the music resume and the deep-link guard are
   * all keyed on that, and a new screen value would quietly lose them.
   */
  /**
   * A room code from a link the app was launched by. The title screen waits for
   * a press before doing anything, so a cold-start deep link has to be parked
   * here until that happens or it is simply lost.
   */
  let pendingRoom: string | null = null;
  let practising = false;
  let tutorial: Tutorial | null = null;
  /** Which control scheme the instructions screen is showing. */
  let helpScheme: ControlScheme = 'keys';

  const beep = (): void => audio.sfx('menu-move');
  const select = (): void => audio.sfx('menu-select');

  const say = (text: string, seconds = 2.2): void => {
    banner = text;
    bannerTimer = seconds;
  };

  // -- match set-up ---------------------------------------------------------

  function startLocalMatch(mode: 'solo' | 'hotseat'): void {
    const opponent = mode === 'solo' ? `CPU ${settings.difficulty.toUpperCase()}` : 'PLAYER 2';
    const you = settings.name === DEFAULT_NAME && mode === 'hotseat' ? 'PLAYER 1' : settings.name;
    const seats: SessionSeats = {
      names: [you, opponent],
      local: mode === 'solo' ? [1] : [1, 2],
      connected: [true, true],
    };
    session = createSession({
      audio,
      haptic: nativeBridge.haptic,
      seats,
      ai: mode === 'solo' ? { seat: 2, difficulty: settings.difficulty } : undefined,
      seed: (Date.now() ^ 0x9e3779b9) >>> 0,
    });
    session.reset(newMatch());
    practising = false;
    tutorial = null;
    screen = 'playing';
    audio.music('play');
  }

  /** The driving range, with the lesson running over it or not. */
  function startPractice(withTutorial: boolean): void {
    const seats: SessionSeats = {
      names: [settings.name, 'RIVAL'],
      // Both seats count as local: a session whose turn falls to a seat that is
      // neither local nor a CPU waits for an opponent that never comes.
      local: [1, 2],
      connected: [true, true],
    };
    session = createSession({
      audio,
      haptic: nativeBridge.haptic,
      seats,
      practice: { shooter: 1, rival: 2 },
    });
    session.reset();
    practising = true;
    tutorial = withTutorial ? createTutorial() : null;
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

    try {
      connection = openConnection(code);
    } catch (err) {
      // A misconfigured build should say so, not retry an impossible URL forever.
      connectionStatus = 'closed';
      say(err instanceof Error ? err.message.slice(0, 30).toUpperCase() : 'CANNOT REACH SERVER', 5);
      screen = 'main';
    }
  }

  function openConnection(code: string): RoomConnection {
    return connectRoom(code, {
      name: settings.name,
      // Unset on the web, where the page origin is right. A bundled app is
      // given the real one at build time.
      origin: apiOrigin(),
      // An app has one "tab" and wipes session storage on every cold launch, so
      // the seat identity has to outlive the process there. On the web it must
      // stay per-tab, or two tabs would fight over one seat.
      storage: nativeBridge.isNative && typeof localStorage !== 'undefined' ? localStorage : undefined,
      onStatus: (status) => {
        connectionStatus = status;
        if (status === 'reconnecting') say('RECONNECTING...', 3);
      },
      onWelcome: (msg) => {
        localSeat = msg.seat;
        lobbyPlayers = msg.players;
        session = createSession({
          audio,
          haptic: nativeBridge.haptic,
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
    confirmingQuit = false;
    practising = false;
    tutorial = null;
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
    // Never location.origin here: inside the app that is capacitor://localhost,
    // which would mint a link nobody else can open.
    const url = challengeUrl(shareOrigin(), roomCode);
    const shared = await nativeBridge.shareLink(url, 'Play me at Fore!');
    if (shared) say(nativeBridge.isNative ? 'CHALLENGE SENT!' : 'LINK COPIED!');
    else say('COPY FAILED - USE THE CODE');
  }

  // -- per-screen update ----------------------------------------------------

  function updateTitle(): void {
    if (input.pressed('select')) {
      void audio.unlock();
      audio.music('title');
      select();
      const deepLink = pendingRoom ?? roomFromHash(location.hash);
      pendingRoom = null;
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
      if (choice === 'tutorial') {
        select();
        startPractice(true);
      } else if (choice === 'range') {
        select();
        startPractice(false);
      } else if (choice === 'solo') {
        select();
        screen = 'difficulty';
      } else if (choice === 'hotseat') {
        select();
        startLocalMatch('hotseat');
      } else if (choice === 'online') {
        select();
        screen = 'online';
      } else if (choice === 'help') {
        select();
        // Open on whichever scheme they've actually been using.
        helpScheme = input.isTouch ? 'touch' : 'keys';
        screen = 'help';
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

  function updateHelp(): void {
    // Switch with left/right on a keyboard, or a tap on a touchscreen - where
    // left/right don't exist and a swipe left already means "back".
    if (input.pressed('left') || input.pressed('right') || input.pressed('select')) {
      helpScheme = otherScheme(helpScheme);
      beep();
      return;
    }
    if (input.pressed('cancel')) {
      select();
      screen = 'main';
    }
  }

  function updateLobby(): void {
    if (input.pressed('cancel')) {
      leaveMatch();
      return;
    }
    if (input.pressed('select')) void copyChallengeLink();
  }

  function updatePlaying(dt: number): void {
    if (!session) return;

    // The prompt is modal: the match freezes underneath it rather than the
    // meter sweeping on behind a dialog nobody meant to open.
    if (confirmingQuit) {
      const choice = quitMenu.update(input, beep);
      if (choice === 'quit') {
        select();
        confirmingQuit = false;
        leaveMatch();
      } else if (choice === 'stay' || choice === '@back') {
        select();
        confirmingQuit = false;
      }
      return;
    }

    session.update(dt, input);

    if (tutorial && !tutorial.finished) {
      const advanced = tutorial.update({
        phase: session.phase,
        aim: session.aim,
        turn: session.state.turn,
        lastOutcome: session.state.lastShot?.outcome ?? null,
      });
      if (advanced) {
        audio.sfx('menu-select');
        if (tutorial.finished) say('THAT IS THE SHOT. RANGE IS YOURS.', 3.5);
      }
    }

    if (session.phase === 'over' && input.pressed('select')) {
      select();
      if (connection) {
        connection.requestRematch();
        say('REMATCH REQUESTED');
      } else {
        session.reset(newMatch());
        audio.music('play');
      }
    }
    if (input.pressed('cancel')) {
      confirmingQuit = true;
      quitMenu.reset(0);
      beep();
    }
  }

  // -- frame building -------------------------------------------------------

  function menuFrame(time: number, hud: Partial<HudState>): RenderFrame {
    return {
      board: newMatch().board,
      ball: { x: 0, y: -10, z: 0, visible: false },
      aim: null,
      camera: 'title',
      fallingDisc: null,
      explosion: null,
      collapse: null,
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
        panel: null,
        ...hud,
      },
    };
  }

  function buildFrame(time: number): RenderFrame {
    switch (screen) {
      case 'title':
        return menuFrame(time, {
          title: 'FORE!',
          subtitle: 'FOUR IN A ROW GOLF',
          hint: 'PRESS FIRE TO START',
        });

      case 'main':
        return menuFrame(time, {
          title: 'FORE!',
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

      case 'help':
        // No subtitle: the panel sits where one would be drawn, and the
        // scheme is named in its own heading instead.
        return menuFrame(time, {
          title: 'HOW TO PLAY',
          panel: { lines: instructionLines(helpScheme) },
          hint: schemeHint(helpScheme),
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

      case 'playing': {
        const coaching = tutorial?.coaching() ?? null;
        const toRival = practising ? (session?.threadsToRival ?? null) : null;
        return (
          session?.buildFrame(time, {
            roomCode,
            // One shooter, so one scoreboard panel.
            ...(practising && session
              ? {
                  players: [
                    {
                      name: settings.name,
                      player: 1 as const,
                      score: 0,
                      active: true,
                      connected: true,
                    },
                  ],
                  hint:
                    toRival === null
                      ? 'DRIVING RANGE   BACK TO LEAVE'
                      : `RIVAL PUCK IN ${toRival} THREADED SHOT${toRival === 1 ? '' : 'S'}`,
                }
              : {}),
            // The lesson talks over the range, but never over its own captions.
            ...(coaching ? { message: coaching.message, hint: coaching.hint } : {}),
            ...(banner ? { message: banner } : {}),
            ...(confirmingQuit
              ? {
                  // The title band, not the message banner: the banner sits at
                  // the same height as the menu box and the two collide.
                  title: practising ? 'LEAVE THE RANGE?' : 'QUIT THE MATCH?',
                  message: null,
                  menu: { items: quitMenu.labels, index: quitMenu.index },
                  // The meter would only invite a mistimed tap at the dialog.
                  meter: null,
                  hint: null,
                }
              : {}),
          }) ?? menuFrame(time, {})
        );
      }

      case 'error':
        return menuFrame(time, { title: 'ERROR', subtitle: fatal, hint: 'RELOAD THE PAGE' });
    }
  }

  // -- loop -----------------------------------------------------------------

  // A small window onto the running game: used by the automated play-through
  // harness, and handy for poking at a live match from the browser console.
  (window as unknown as { connectFore: () => unknown }).connectFore = () => ({
    screen,
    quitPrompt: confirmingQuit,
    practising,
    tutorialStep: tutorial?.step ?? null,
    threadsToRival: session?.threadsToRival ?? null,
    phase: session?.phase ?? null,
    turn: session?.state.turn ?? null,
    current: session?.state.current ?? null,
    status: session?.state.status ?? null,
    discs: session?.state.board.filter((cell) => cell !== 0).length ?? 0,
    lastOutcome: session?.state.lastShot?.outcome ?? null,
    aim: session?.aim ?? null,
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

    // A pointer gesture means different things at different moments: aiming
    // while lining up, nothing at all once the meter is running, and menu
    // navigation everywhere else.
    input.setDragMode(
      confirmingQuit || screen !== 'playing' || !session || session.phase === 'over'
        ? 'gesture'
        : session.phase === 'aim'
          ? 'aim'
          : 'lock',
    );

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
      case 'help':
        updateHelp();
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
      // Coming back from a background tab leaves the context suspended.
      void audio.resume();
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

  /**
   * Native deep links. A universal link (iOS) or app link (Android) is handed
   * to the page as a whole URL through the shell - it never touches the address
   * bar, so the `hashchange` above never fires for it.
   */
  function acceptDeepLink(rawUrl: string): void {
    const hash = rawUrl.slice(rawUrl.indexOf('#'));
    const code = roomFromHash(hash);
    if (!code) return;
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) return;
    if (started && screen !== 'playing') openRoom(normalized);
    else pendingRoom = normalized;
  }

  void nativeBridge.onDeepLink(acceptDeepLink);

  /**
   * Android's Back button. Left unhandled its default is to quit the app
   * outright, which would close the socket in the middle of a live match; this
   * routes it into the same confirmation prompt the touch gestures use.
   */
  void nativeBridge.onBackButton(() => input.inject('cancel'));

  /**
   * A WebView does not reliably fire `visibilitychange` when the app itself is
   * backgrounded, and the audio context comes back suspended either way.
   */
  void nativeBridge.onAppStateChange((active) => {
    paused = !active;
    if (active) {
      last = performance.now();
      void audio.resume();
      if (screen === 'playing') audio.music('play');
      else if (started) audio.music('title');
    } else {
      audio.music(null);
    }
  });

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
      ? `Fore! could not start: ${err.message}`
      : 'Fore! needs WebGL to run.';
  app.appendChild(box);
}

boot();

// A match ends when someone connects four; `MatchState` is re-exported for the
// dev console so the board can be inspected while playing.
export type { MatchState };
