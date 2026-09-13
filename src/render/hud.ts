/**
 * The HUD layer: a 256x240 2D canvas composited *inside* the pixel grid.
 *
 * Nothing here is DOM text. The canvas is uploaded as a texture and blended in
 * the post pass after quantisation, so HUD pixels land exactly on the palette
 * entries chosen below while scene pixels get dithered — which is precisely how
 * a real NES separates sprites-and-background from the status bar.
 */
import type { HudPlayerView, HudState, MeterView } from './api';
import type { Player } from '../game/types';
import type { BitmapFont } from './font';
import { CURSOR, createFont } from './font';
import { INK, playerInk } from './palette';

export const HUD_W = 256;
export const HUD_H = 240;

export interface HudLayer {
  readonly canvas: HTMLCanvasElement;
  /** Repaints the whole layer. `time` is `RenderFrame.time`, in seconds. */
  draw(hud: HudState, time: number): void;
  dispose(): void;
}

// --- layout ----------------------------------------------------------------

const PANEL_W = 96;
const PANEL_H = 24;
const PANEL_Y = 4;
const PANEL_LEFT_X = 4;
const PANEL_RIGHT_X = HUD_W - PANEL_W - 4;

const METER_X = 44;
const METER_W = 168;
const METER_Y = 200;
const METER_H = 11;
/** The meter's enclosure: labels live inside it so they never sit on the turf. */
const METER_BOX_X = METER_X - 6;
const METER_BOX_Y = METER_Y - 18;
const METER_BOX_W = METER_W + 12;
const METER_BOX_H = METER_H + 30;

/** Power zones, drawn left to right. Module scope: the hot path allocates nothing. */
const METER_ZONES: readonly (readonly [number, number, string])[] = [
  [0, 0.55, INK.green],
  [0.55, 0.85, INK.gold],
  [0.85, 1, INK.red],
];

/** Row spans of a chunky 9x9 disc, as `[startX, width]` per row. */
const DISC_ROWS: readonly (readonly [number, number])[] = [
  [3, 3],
  [1, 7],
  [1, 7],
  [0, 9],
  [0, 9],
  [0, 9],
  [1, 7],
  [1, 7],
  [3, 3],
];

/** Player one wears a cross, player two a ring: the discs read without colour. */
const SYMBOL_ONE: readonly (readonly [number, number])[] = [
  [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [6, 2], [5, 3], [3, 5], [2, 6],
];
const SYMBOL_TWO: readonly (readonly [number, number])[] = [
  [3, 2], [4, 2], [5, 2], [2, 3], [6, 3], [2, 4], [6, 4], [2, 5], [6, 5],
  [3, 6], [4, 6], [5, 6],
];

function blink(time: number, hz: number, duty = 0.5): boolean {
  const phase = time * hz;
  return phase - Math.floor(phase) < duty;
}

/** Builds the HUD layer. One per renderer. */
export function createHud(): HudLayer {
  const canvas = document.createElement('canvas');
  canvas.width = HUD_W;
  canvas.height = HUD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Fore!: 2D canvas is unavailable.');
  ctx.imageSmoothingEnabled = false;
  const font: BitmapFont = createFont();

  const box = (x: number, y: number, w: number, h: number, border: string, fill: string | null): void => {
    if (fill !== null) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
    }
    ctx.fillStyle = border;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
  };

  const discIcon = (x: number, y: number, player: Player, dim: boolean): void => {
    ctx.fillStyle = dim ? INK.greySlate : playerInk(player);
    for (let row = 0; row < DISC_ROWS.length; row += 1) {
      const span = DISC_ROWS[row];
      if (!span) continue;
      ctx.fillRect(x + span[0], y + row, span[1], 1);
    }
    ctx.fillStyle = dim ? INK.greyDark : INK.black;
    const symbol = player === 1 ? SYMBOL_ONE : SYMBOL_TWO;
    for (const pixel of symbol) ctx.fillRect(x + pixel[0], y + pixel[1], 1, 1);
  };

  const playerPanel = (view: HudPlayerView, x: number, time: number): void => {
    const offline = !view.connected;
    const lit = view.active && !offline && blink(time, 2, 0.7);
    const border = offline ? INK.greyDark : lit ? INK.white : INK.greySlate;
    box(x, PANEL_Y, PANEL_W, PANEL_H, border, INK.black);
    discIcon(x + 4, PANEL_Y + 4, view.player, offline);

    const nameInk = offline ? INK.greySlate : INK.white;
    const name = view.name.slice(0, 13).toUpperCase();
    font.draw(ctx, name, x + 16, PANEL_Y + 4, nameInk);

    const scoreInk = offline ? INK.greySlate : INK.cream;
    font.draw(ctx, `WINS ${Math.max(0, Math.round(view.score))}`, x + 16, PANEL_Y + 14, scoreInk);

    if (offline) {
      font.draw(ctx, 'GONE', x + PANEL_W - 28, PANEL_Y + 14, INK.greyDark);
    } else if (view.active && blink(time, 2, 0.7)) {
      font.draw(ctx, 'TURN', x + PANEL_W - 28, PANEL_Y + 14, INK.green);
    }
  };

  /** A 7x4 solid triangle, apex up or down. Reads at a glance; a single-pixel
   * tick does not. */
  const marker = (x: number, y: number, ink: string, up: boolean): void => {
    ctx.fillStyle = ink;
    for (let row = 0; row < 4; row += 1) {
      const width = up ? row * 2 + 1 : 7 - row * 2;
      ctx.fillRect(x - (width - 1) / 2, y + row, width, 1);
    }
  };

  const meter = (view: MeterView, time: number): void => {
    const power = Math.min(1, Math.max(0, view.power));
    const cursor = Math.min(1, Math.max(0, view.cursor));
    const showAccuracy = view.phase === 'accuracy' || view.phase === 'locked';

    // Enclosure, then frame and track.
    box(METER_BOX_X, METER_BOX_Y, METER_BOX_W, METER_BOX_H, INK.white, INK.black);
    box(METER_X - 2, METER_Y - 2, METER_W + 4, METER_H + 4, INK.greySlate, INK.black);
    ctx.fillStyle = INK.greyDark;
    ctx.fillRect(METER_X, METER_Y, METER_W, METER_H);

    // Power fill, in three zones so the danger end reads red at a glance.
    const filled = Math.round(power * METER_W);
    for (const zone of METER_ZONES) {
      const from = Math.round(zone[0] * METER_W);
      const to = Math.min(filled, Math.round(zone[1] * METER_W));
      if (to > from) {
        ctx.fillStyle = zone[2];
        ctx.fillRect(METER_X + from, METER_Y, to - from, METER_H);
      }
    }

    // Sweet spot. The band that counts as a dead-straight strike is drawn as a
    // zone you can actually aim at, with the exact centre marked inside it - a
    // hairline tick would say "nick this pixel", which is not the deal.
    const centre = METER_X + Math.round(METER_W / 2);
    const halfBand = Math.max(2, Math.round((view.perfect / 2) * (METER_W - 2)));
    if (showAccuracy || view.phase === 'accuracy') {
      ctx.fillStyle = INK.greenDeep;
      ctx.fillRect(centre - halfBand, METER_Y, halfBand * 2, METER_H);
    }
    marker(centre, METER_Y - 7, INK.white, false);
    ctx.fillStyle = INK.cream;
    ctx.fillRect(centre - halfBand, METER_Y, 1, METER_H);
    ctx.fillRect(centre + halfBand, METER_Y, 1, METER_H);
    ctx.fillStyle = INK.white;
    ctx.fillRect(centre, METER_Y, 1, METER_H);

    // Accuracy marker: how far off the sweet spot the strike landed.
    if (showAccuracy) {
      const offset = Math.min(1, Math.max(-1, view.accuracy));
      const x = METER_X + Math.round((0.5 + offset * 0.5) * (METER_W - 2));
      const ink = Math.abs(offset) <= view.perfect ? INK.green : Math.abs(offset) < 0.5 ? INK.gold : INK.red;
      marker(x, METER_Y + METER_H + 3, ink, true);
      ctx.fillStyle = ink;
      ctx.fillRect(x, METER_Y + METER_H + 1, 1, 2);
    }

    // Sweeping cursor, drawn last so it is never hidden by the fill.
    if (view.phase !== 'locked') {
      const x = METER_X + Math.round(cursor * (METER_W - 2));
      ctx.fillStyle = blink(time, 12, 0.75) ? INK.white : INK.cream;
      ctx.fillRect(x, METER_Y - 3, 2, METER_H + 6);
    }

    const label =
      view.phase === 'aim' ? 'AIM' : view.phase === 'power' ? 'POWER' : view.phase === 'accuracy' ? 'SNAP!' : 'SET';
    const labelInk = view.phase === 'accuracy' ? INK.red : view.phase === 'locked' ? INK.green : INK.white;
    font.draw(ctx, label, METER_BOX_X + 4, METER_BOX_Y + 4, labelInk);

    const percent = `${Math.round(power * 100)}%`;
    font.draw(ctx, percent, METER_BOX_X + METER_BOX_W - 4 - font.width(percent), METER_BOX_Y + 4, INK.cream);
  };

  /** A full-width status band, the way a NES title card sits on the picture. */
  const band = (y: number, h: number, edge: string): void => {
    ctx.fillStyle = INK.black;
    ctx.fillRect(0, y, HUD_W, h);
    ctx.fillStyle = edge;
    ctx.fillRect(0, y, HUD_W, 1);
    ctx.fillRect(0, y + h - 1, HUD_W, 1);
  };

  const draw: HudLayer['draw'] = (hud, time) => {
    ctx.clearRect(0, 0, HUD_W, HUD_H);
    if (!hud.visible) return;

    let slot = 0;
    for (const view of hud.players) {
      playerPanel(view, slot === 0 ? PANEL_LEFT_X : PANEL_RIGHT_X, time);
      slot += 1;
      if (slot > 1) break;
    }

    if (hud.roomCode) {
      const code = hud.roomCode.toUpperCase();
      const w = Math.max(font.width('ROOM'), font.width(code)) + 8;
      box(Math.round((HUD_W - w) / 2), PANEL_Y, w, 21, INK.greySlate, INK.black);
      font.drawCentered(ctx, 'ROOM', HUD_W / 2, PANEL_Y + 3, INK.grey);
      font.drawCentered(ctx, code, HUD_W / 2, PANEL_Y + 12, INK.gold);
    }

    if (hud.title) {
      const title = hud.title.toUpperCase();
      const scale = font.width(title, 3) <= HUD_W - 10 ? 3 : font.width(title, 2) <= HUD_W - 10 ? 2 : 1;
      const lines = hud.subtitle ? font.height(scale) + 6 + font.height() : font.height(scale);
      const top = 54;
      band(top, lines + 12, INK.gold);
      const y = top + 6;
      font.drawCentered(ctx, title, HUD_W / 2 + scale, y + scale, INK.redDeep, scale);
      font.drawCentered(ctx, title, HUD_W / 2, y, INK.gold, scale);
      if (hud.subtitle) {
        font.drawCentered(ctx, hud.subtitle.toUpperCase(), HUD_W / 2, y + font.height(scale) + 6, INK.blue);
      }
    } else if (hud.subtitle) {
      band(54, font.height() + 12, INK.greySlate);
      font.drawCentered(ctx, hud.subtitle.toUpperCase(), HUD_W / 2, 60, INK.blue);
    }

    const panel = hud.panel;
    if (panel && panel.lines.length > 0) {
      const lines = panel.lines.map((line) => line.toUpperCase());
      let widest = 0;
      for (const line of lines) widest = Math.max(widest, font.width(line));
      const boxW = Math.min(HUD_W - 8, widest + 20);
      const boxX = Math.round((HUD_W - boxW) / 2);
      const step = 9;
      // The title band ends at 87; the hint bar starts at HUD_H - 16.
      const top = 94;
      // The hint bar starts at HUD_H - 16; stop one pixel short of it.
      const room = Math.floor((HUD_H - 17 - (top - 6) - 9) / step);
      const shown = lines.slice(0, Math.max(0, room));
      box(boxX, top - 6, boxW, shown.length * step + 9, INK.white, INK.blueNight);
      for (let i = 0; i < shown.length; i += 1) {
        const line = shown[i] ?? '';
        // A blank line is a spacer, and a line ending in ':' is a heading.
        const heading = line.endsWith(':');
        font.draw(
          ctx,
          heading ? line.slice(0, -1) : line,
          boxX + 10,
          top + i * step,
          heading ? INK.gold : INK.white,
        );
      }
    }

    if (hud.message) {
      const message = hud.message.toUpperCase();
      const scale = font.width(message, 2) <= HUD_W - 24 ? 2 : 1;
      const w = font.width(message, scale) + 12;
      const h = font.height(scale) + 9;
      const x = Math.round((HUD_W - w) / 2);
      const y = 110 + (blink(time, 3, 0.5) ? 0 : 1);
      box(x, y, w, h, INK.white, INK.blueNight);
      font.drawCentered(ctx, message, HUD_W / 2, y + 5, INK.white, scale);
    }

    const menu = hud.menu;
    if (menu && menu.items.length > 0) {
      let widest = 0;
      for (const item of menu.items) widest = Math.max(widest, font.width(item.toUpperCase()));
      const boxW = widest + 32;
      const boxX = Math.round((HUD_W - boxW) / 2);
      const top = 130;
      box(boxX, top - 6, boxW, menu.items.length * 12 + 9, INK.white, INK.blueNight);
      for (let i = 0; i < menu.items.length; i += 1) {
        const item = (menu.items[i] ?? '').toUpperCase();
        const y = top + i * 12;
        const selected = i === menu.index;
        font.draw(ctx, item, boxX + 21, y, selected ? INK.white : INK.grey);
        if (selected && blink(time, 3, 0.65)) {
          font.draw(ctx, CURSOR, boxX + 9, y, INK.gold);
        }
      }
    }

    if (hud.meter) meter(hud.meter, time);

    if (hud.hint) {
      const hint = hud.hint.toUpperCase();
      const w = font.width(hint) + 10;
      const y = HUD_H - 16;
      box(Math.round((HUD_W - w) / 2), y, w, 13, INK.greySlate, INK.black);
      font.drawCentered(ctx, hint, HUD_W / 2, y + 3, INK.white);
    }
  };

  return {
    canvas,
    draw,
    dispose: () => {
      font.dispose();
    },
  };
}
