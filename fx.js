// Эффекты на фоне сайта: снег, искры, звёзды. Холст не мешает кликам, на скрытой вкладке не рисует.
const KEY = 'bot_fx';
export const FX = [
  { id: 'off', name: 'Эффекты выключены' },
  { id: 'snow', name: 'Снег' },
  { id: 'embers', name: 'Искры' },
  { id: 'stars', name: 'Звёзды' },
];

let canvas, ctx, W = 0, H = 0, dpr = 1, raf = 0, last = 0, mode = 'off', parts = [], mx = 0.5, shooting = null;
const rnd = (a, b) => a + Math.random() * (b - a);
const light = () => document.documentElement.dataset.theme === 'light';

function load() { try { return localStorage.getItem(KEY); } catch { return null; } }
function store(v) { try { localStorage.setItem(KEY, v); } catch { /* без сохранения */ } }

export function currentFx() {
  const v = load();
  if (FX.some((f) => f.id === v)) return v;
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'snow';
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seed();
}

function count() { return Math.max(24, Math.min(mode === 'stars' ? 90 : mode === 'snow' ? 170 : 110, Math.round((W * H) / (mode === 'embers' ? 22000 : mode === 'snow' ? 8000 : 15000)))); }

function make(initial) {
  const z = Math.random(); // глубина: 0 далеко, 1 близко
  if (mode === 'snow') return { x: rnd(0, W), y: initial ? rnd(0, H) : rnd(-20, -4), z, r: 1 + z * 2.8, vy: 18 + z * 46, ph: rnd(0, 6.28), sw: rnd(.4, 1.2), a: .45 + z * .45 };
  if (mode === 'embers') return { x: rnd(0, W), y: initial ? rnd(0, H) : H + rnd(4, 30), z, r: .8 + z * 2.2, vy: -(16 + z * 44), ph: rnd(0, 6.28), sw: rnd(.5, 1.6), a: .35 + z * .6, life: rnd(.55, 1) };
  return { x: rnd(0, W), y: rnd(0, H), z, r: .5 + z * 1.4, ph: rnd(0, 6.28), sp: rnd(.6, 2.2), a: .25 + z * .6 };
}

function seed() { parts = []; if (mode === 'off') return; for (let i = 0; i < count(); i++) parts.push(make(true)); shooting = null; }

function frame(t) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(.05, (t - last) / 1000 || .016); last = t;
  ctx.clearRect(0, 0, W, H);
  const wind = (mx - .5) * 40;
  const L = light();
  if (mode === 'snow') {
    ctx.fillStyle = L ? 'rgba(120,150,195,' : 'rgba(255,255,255,';
    for (const p of parts) {
      p.ph += dt * p.sw;
      p.y += p.vy * dt;
      p.x += (Math.sin(p.ph) * 14 + wind * p.z) * dt;
      if (p.y > H + 6 || p.x < -10 || p.x > W + 10) { Object.assign(p, make(false)); if (p.x < -10 || p.x > W + 10) p.x = rnd(0, W); }
      ctx.globalAlpha = 1;
      ctx.fillStyle = (L ? 'rgba(110,140,190,' : 'rgba(255,255,255,') + p.a.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
  } else if (mode === 'embers') {
    for (const p of parts) {
      p.ph += dt * p.sw;
      p.y += p.vy * dt;
      p.x += (Math.sin(p.ph) * 18 + wind * p.z) * dt;
      p.life -= dt * .06;
      if (p.y < -10 || p.life <= 0) Object.assign(p, make(false));
      const a = Math.max(0, p.a * Math.min(1, p.life * 1.4) * (.7 + .3 * Math.sin(p.ph * 3)));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
      g.addColorStop(0, `rgba(255,${L ? 90 : 140},70,${a.toFixed(2)})`);
      g.addColorStop(.35, `rgba(255,45,58,${(a * .55).toFixed(2)})`);
      g.addColorStop(1, 'rgba(255,45,58,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, 6.283); ctx.fill();
    }
  } else if (mode === 'stars') {
    for (const p of parts) {
      p.ph += dt * p.sp;
      const a = p.a * (.5 + .5 * Math.sin(p.ph));
      ctx.fillStyle = (L ? 'rgba(224,33,46,' : 'rgba(255,255,255,') + a.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(p.x + (mx - .5) * 10 * p.z, p.y, p.r, 0, 6.283); ctx.fill();
    }
    if (!shooting && Math.random() < dt * .22) shooting = { x: rnd(W * .2, W), y: rnd(0, H * .4), vx: -rnd(420, 620), vy: rnd(180, 300), life: 1 };
    if (shooting) {
      const s = shooting; s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt * 1.3;
      const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * .18, s.y - s.vy * .18);
      g.addColorStop(0, `rgba(255,${L ? 60 : 120},90,${Math.max(0, s.life).toFixed(2)})`);
      g.addColorStop(1, 'rgba(255,45,58,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * .18, s.y - s.vy * .18); ctx.stroke();
      if (s.life <= 0 || s.x < -50 || s.y > H + 50) shooting = null;
    }
  }
}

function run() { cancelAnimationFrame(raf); if (mode === 'off' || document.hidden) { ctx?.clearRect(0, 0, W, H); return; } last = performance.now(); raf = requestAnimationFrame(frame); }

export function setFx(id) {
  if (!FX.some((f) => f.id === id)) id = 'off';
  mode = id; store(id);
  if (canvas) { canvas.hidden = id === 'off'; seed(); run(); }
  document.documentElement.dataset.fx = id;
  return id;
}

export function nextFx() {
  const i = FX.findIndex((f) => f.id === mode);
  return setFx(FX[(i + 1) % FX.length].id);
}

export function initFx() {
  canvas = document.createElement('canvas');
  canvas.id = 'fxCanvas'; canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  ctx = canvas.getContext('2d');
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { mx = e.clientX / Math.max(1, innerWidth); }, { passive: true });
  document.addEventListener('visibilitychange', run);
  mode = currentFx();
  canvas.hidden = mode === 'off';
  document.documentElement.dataset.fx = mode;
  resize(); run();
}
