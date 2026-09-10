/**
 * Boot. The milestone-one build puts a title card on screen so the Cloudflare
 * deploy has something to serve; the renderer, sim, audio and netcode are wired
 * in here as each lands.
 */

const CANVAS_W = 256;
const CANVAS_H = 240;

function mount(): void {
  const app = document.getElementById('app');
  if (!app) return;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Connect Fore! title screen');
  app.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const scale = (): void => {
    const factor = Math.max(
      1,
      Math.floor(Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H)),
    );
    canvas.style.width = `${CANVAS_W * factor}px`;
    canvas.style.height = `${CANVAS_H * factor}px`;
  };
  scale();
  window.addEventListener('resize', scale);

  const start = performance.now();
  const draw = (now: number): void => {
    const t = (now - start) / 1000;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b1030';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = '#1c7c3c';
    ctx.fillRect(0, 168, CANVAS_W, CANVAS_H - 168);

    ctx.font = '16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fcd830';
    ctx.fillText('CONNECT FORE!', CANVAS_W / 2, 84);
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = '#8cb4ff';
    ctx.fillText('GOLF MEETS CONNECT FOUR', CANVAS_W / 2, 104);
    if (Math.floor(t * 2) % 2 === 0) {
      ctx.fillStyle = '#e8f0ff';
      ctx.fillText('COURSE UNDER CONSTRUCTION', CANVAS_W / 2, 140);
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

mount();
