/**
 * A hand-drawn 5x7 bitmap font.
 *
 * The HUD is composited inside the 256x240 pixel grid, so it cannot use a real
 * typeface: browser text hinting would produce sub-pixel greys the palette
 * quantiser has no colour for. Every glyph below is therefore literal pixels.
 *
 * Glyphs are baked once into a white atlas; a tinted copy is cached per colour,
 * so drawing a string is one `drawImage` per character and allocates nothing.
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Cell-to-cell advance at scale 1 (one column of letter spacing). */
export const GLYPH_ADVANCE = GLYPH_W + 1;

/**
 * Printable stand-ins for the three UI shapes the HUD needs. They are ordinary
 * characters so that strings stay greppable and free of control codes.
 */
/** Right-pointing selection triangle, drawn for `~`. */
export const CURSOR = '~';
/** Left-pointing triangle, drawn for a backtick. */
export const CURSOR_LEFT = '`';
/** Up-pointing caret, drawn for `^`. Used by the meter's accuracy marker. */
export const CARET_UP = '^';

/** Rows run top to bottom; `#` is ink, anything else is paper. */
const GLYPHS: Readonly<Record<string, string>> = {
  ' ': '...../...../...../...../...../...../.....',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#...#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  '.': '...../...../...../...../...../.##../.##..',
  ',': '...../...../...../...../.##../.##../.#...',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  ':': '...../.##../.##../...../.##../.##../.....',
  ';': '...../.##../.##../...../.##../.##../.#...',
  "'": '..#../..#../...../...../...../...../.....',
  '"': '.#.#./.#.#./...../...../...../...../.....',
  '-': '...../...../...../#####/...../...../.....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  '=': '...../...../#####/...../#####/...../.....',
  '_': '...../...../...../...../...../...../#####',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '\\': '#..../#..../.#.../..#../...#./....#/....#',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '[': '..###/..#../..#../..#../..#../..#../..###',
  ']': '###../..#../..#../..#../..#../..#../###..',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  '*': '...../#.#.#/.###./#####/.###./#.#.#/.....',
  '%': '##..#/##.#./..#../.#.../#..##/...##/.....',
  '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  '$': '..#../.####/#.#../.###./..#.#/####./..#..',
  '|': '..#../..#../..#../..#../..#../..#../..#..',
  '~': '#..../##.../###../####./###../##.../#....',
  '`': '....#/...##/..###/.####/..###/...##/....#',
  '^': '..#../.###./##.##/...../...../...../.....',
};

const ATLAS_ORDER = Object.keys(GLYPHS);
const ATLAS_INDEX = new Map<string, number>(ATLAS_ORDER.map((ch, i) => [ch, i]));

export interface BitmapFont {
  /** Draws `text` with its top-left corner at `x, y`. */
  draw(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    scale?: number,
  ): void;
  /** Same, centred horizontally on `cx`. */
  drawCentered(
    ctx: CanvasRenderingContext2D,
    text: string,
    cx: number,
    y: number,
    color: string,
    scale?: number,
  ): void;
  /** Pixel width of `text`, excluding the trailing letter space. */
  width(text: string, scale?: number): number;
  height(scale?: number): number;
  dispose(): void;
}

function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_ORDER.length * GLYPH_W;
  canvas.height = GLYPH_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Fore!: 2D canvas is unavailable.');
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < ATLAS_ORDER.length; i += 1) {
    const ch = ATLAS_ORDER[i] ?? ' ';
    const rows = (GLYPHS[ch] ?? '').split('/');
    for (let row = 0; row < GLYPH_H; row += 1) {
      const bits = rows[row] ?? '';
      let run = 0;
      for (let col = 0; col <= GLYPH_W; col += 1) {
        if (bits[col] === '#') {
          run += 1;
          continue;
        }
        if (run > 0) {
          ctx.fillRect(i * GLYPH_W + col - run, row, run, 1);
          run = 0;
        }
      }
    }
  }
  return canvas;
}

/** Builds the atlas and returns a drawing handle. Call once per HUD layer. */
export function createFont(): BitmapFont {
  const atlas = buildAtlas();
  const tints = new Map<string, HTMLCanvasElement>();

  const tinted = (color: string): HTMLCanvasElement => {
    const cached = tints.get(color);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = atlas.width;
    canvas.height = atlas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Fore!: 2D canvas is unavailable.');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlas, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    tints.set(color, canvas);
    return canvas;
  };

  const draw: BitmapFont['draw'] = (ctx, text, x, y, color, scale = 1) => {
    const sheet = tinted(color);
    const step = GLYPH_ADVANCE * scale;
    let penX = Math.round(x);
    const penY = Math.round(y);
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] ?? ' ';
      if (ch !== ' ') {
        const index = ATLAS_INDEX.get(ch) ?? ATLAS_INDEX.get(ch.toUpperCase()) ?? -1;
        if (index >= 0) {
          ctx.drawImage(
            sheet,
            index * GLYPH_W,
            0,
            GLYPH_W,
            GLYPH_H,
            penX,
            penY,
            GLYPH_W * scale,
            GLYPH_H * scale,
          );
        }
      }
      penX += step;
    }
  };

  const width: BitmapFont['width'] = (text, scale = 1) =>
    text.length === 0 ? 0 : text.length * GLYPH_ADVANCE * scale - scale;

  return {
    draw,
    drawCentered: (ctx, text, cx, y, color, scale = 1) => {
      draw(ctx, text, Math.round(cx - width(text, scale) / 2), y, color, scale);
    },
    width,
    height: (scale = 1) => GLYPH_H * scale,
    dispose: () => {
      tints.clear();
    },
  };
}
