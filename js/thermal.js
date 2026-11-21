// Mini-game: night search & rescue with a thermal camera (inspired by Matrice 4T).
import { sfx, vibrate, confetti, unlockAudio } from './fx.js';
import { esc } from './ui.js';

const WORLD = 2200;
const GAME_SEC = 90;
const SPEED = 260;           // world px per second at full stick
const SCAN_RADIUS = 46;      // how close the crosshair must be
const SCAN_TIME = 0.8;       // seconds of hovering to "find"
const TARGETS = [
  { e: '🧒', name: 'дитину', temp: 36.6 }, { e: '👵', name: 'бабусю', temp: 36.4 },
  { e: '🧑‍🌾', name: 'грибника', temp: 36.7 }, { e: '🐕', name: 'собаку', temp: 38.5 },
  { e: '🐈', name: 'кицю', temp: 38.2 }, { e: '🦌', name: 'оленя', temp: 38.9 },
  { e: '🦔', name: 'їжачка', temp: 35.4 }, { e: '🐄', name: 'корову', temp: 38.6 },
];

// Ironbow-style palette: 0 = cold (black/purple) … 1 = hot (white-yellow)
const STOPS = [[0, [8, 4, 30]], [0.25, [52, 14, 110]], [0.45, [150, 30, 120]], [0.65, [230, 70, 40]], [0.82, [252, 165, 30]], [1, [255, 255, 225]]];
const cache = new Map();
function iron(t) {
  const k = Math.round(t * 100);
  if (cache.has(k)) return cache.get(k);
  let i = 0;
  while (i < STOPS.length - 2 && t > STOPS[i + 1][0]) i++;
  const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1];
  const f = Math.min(1, Math.max(0, (t - a) / (b - a)));
  const c = `rgb(${ca.map((v, j) => Math.round(v + (cb[j] - v) * f)).join(',')})`;
  cache.set(k, c);
  return c;
}
const toC = (t) => (t * 40 - 8).toFixed(1); // fake °C for the readout

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function makeWorld(seed) {
  const r = rng(seed);
  const river = [];
  for (let y = -100, x = WORLD * (0.3 + r() * 0.4); y <= WORLD + 100; y += 120) { river.push([x, y]); x += (r() - 0.5) * 220; }
  const roadY = WORLD * (0.25 + r() * 0.5);
  const road = [[-100, roadY], [WORLD * 0.35, roadY + (r() - 0.5) * 300], [WORLD * 0.7, roadY + (r() - 0.5) * 300], [WORLD + 100, roadY]];
  const distToRiver = (x, y) => Math.min(...river.map(([rx, ry]) => Math.hypot(rx - x, ry - y)));
  const houses = [];
  for (let i = 0; i < 9; i++) {
    const x = 150 + r() * (WORLD - 300), y = 150 + r() * (WORLD - 300);
    if (distToRiver(x, y) > 140) houses.push({ x, y, w: 70 + r() * 50, h: 60 + r() * 40, warm: 0.5 + r() * 0.12 });
  }
  const trees = [];
  for (let i = 0; i < 520; i++) {
    const x = r() * WORLD, y = r() * WORLD;
    if (distToRiver(x, y) > 80 && !houses.some((h) => Math.abs(h.x - x) < h.w && Math.abs(h.y - y) < h.h)) trees.push({ x, y, s: 14 + r() * 20, t: 0.3 + r() * 0.08 });
  }
  const start = { x: WORLD / 2, y: WORLD / 2 };
  const targets = [];
  let guard = 0;
  while (targets.length < TARGETS.length && guard++ < 5000) {
    const x = 120 + r() * (WORLD - 240), y = 120 + r() * (WORLD - 240);
    if (distToRiver(x, y) < 90) continue;
    if (Math.hypot(x - start.x, y - start.y) < 350) continue;
    if (targets.some((t) => Math.hypot(t.x - x, t.y - y) < 330)) continue;
    targets.push({ ...TARGETS[targets.length], x, y, found: false, scan: 0 });
  }
  return { river, road, houses, trees, targets, start };
}

export function startThermal({ onExit } = {}) {
  unlockAudio();
  const root = document.createElement('div');
  root.className = 'mg';
  root.innerHTML = `
    <canvas class="mg-cv"></canvas>
    <div class="mg-hud">
      <span class="chip" id="mg-bat">🔋 100%</span>
      <span class="chip gold" id="mg-count">🔍 0 / ${TARGETS.length}</span>
      <button class="btn ghost mg-x" id="mg-exit" aria-label="Вийти">✕</button>
    </div>
    <div class="mg-temp" id="mg-temp"></div>
    <div class="mg-toast" id="mg-toast"></div>
    <button class="mg-mode" id="mg-mode">🔥 Тепловізор</button>
    <div class="mg-panel" id="mg-panel"></div>`;
  document.body.appendChild(root);
  const cv = root.querySelector('canvas'), ctx = cv.getContext('2d');
  const $ = (id) => root.querySelector('#' + id);

  let W = 0, H = 0, dpr = 1;
  const resize = () => { dpr = Math.min(2, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; };
  resize(); addEventListener('resize', resize);

  let world, drone, thermal, timeLeft, running, raf, last, toastT, prop = 0;
  const stick = { on: false, ox: 0, oy: 0, x: 0, y: 0 };
  const keys = new Set();

  function toast(html, ms = 1800) {
    const el = $('mg-toast'); el.innerHTML = html; el.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms);
  }

  function setMode(on) {
    thermal = on;
    $('mg-mode').classList.toggle('on', on);
    $('mg-mode').textContent = on ? '🌙 Звичайна камера' : '🔥 Тепловізор';
    root.classList.toggle('thermal', on);
    sfx.tap(); vibrate(30);
  }

  function briefing() {
    running = false;
    $('mg-panel').className = 'mg-panel on';
    $('mg-panel').innerHTML = `<div class="panel" style="max-width:440px">
      <p class="kicker">Рятувальна місія</p><h2 class="mega m white">Нічний пошук</h2>
      <p class="lead" style="color:#fff">Вночі в лісі загубились люди й тварини 🌲🌙<br>Знайди всіх ${TARGETS.length}, поки не сяде батарея!</p>
      <p class="lead">☝️ Тягни пальцем — дрон летить<br>🔥 Увімкни <b>тепловізор</b> — він бачить тепло<br>🎯 Наведи приціл на теплу пляму й потримай</p>
      <button class="btn huge wide" id="mg-go">🚁 Злітаємо!</button></div>`;
    $('mg-go').onclick = begin;
  }

  function begin() {
    world = makeWorld((Date.now() & 0xffff) + 7);
    drone = { x: world.start.x, y: world.start.y, vx: 0, vy: 0 };
    timeLeft = GAME_SEC; running = true; setMode(false);
    $('mg-panel').className = 'mg-panel';
    $('mg-count').textContent = `🔍 0 / ${TARGETS.length}`;
    sfx.go(); toast('Темно… нічого не видно? Увімкни 🔥 тепловізор!', 3200);
    last = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  }

  function finish(reason) {
    running = false;
    const n = world.targets.filter((t) => t.found).length, all = n === TARGETS.length;
    const title = all ? 'Супер-рятувальник!' : n >= TARGETS.length / 2 ? 'Чудовий пілот!' : 'Гарна спроба!';
    const list = world.targets.map((t) => `<span class="tag ${t.found ? '' : 'out'}"><span>${t.e}</span>${esc(t.name)}</span>`).join('');
    $('mg-panel').className = 'mg-panel on';
    $('mg-panel').innerHTML = `<div class="panel" style="max-width:460px">
      <p class="kicker">${reason === 'battery' ? '🔋 Батарея сіла — дрон повернувся додому' : 'Місію виконано!'}</p>
      <h2 class="mega m">${title}</h2>
      <div class="big-num" style="font-size:40px">Знайдено ${n} з ${TARGETS.length}</div>
      <div class="wall" style="margin:14px 0">${list}</div>
      <div class="row"><button class="btn" id="mg-again">🔁 Ще раз</button><button class="btn ghost" id="mg-back">← Назад</button></div></div>`;
    $('mg-again').onclick = begin;
    $('mg-back').onclick = exit;
    if (all) { confetti(); sfx.win(); } else sfx.pass();
  }

  function exit() {
    cancelAnimationFrame(raf); removeEventListener('resize', resize); removeEventListener('keydown', kd); removeEventListener('keyup', ku);
    root.remove(); onExit?.();
  }

  // ---- input ----
  cv.addEventListener('pointerdown', (e) => { if (!running) return; stick.on = true; stick.ox = stick.x = e.clientX; stick.oy = stick.y = e.clientY; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => { if (stick.on) { stick.x = e.clientX; stick.y = e.clientY; } });
  const up = () => { stick.on = false; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  const kd = (e) => keys.add(e.key), ku = (e) => keys.delete(e.key);
  addEventListener('keydown', kd); addEventListener('keyup', ku);
  $('mg-mode').onclick = () => running && setMode(!thermal);
  $('mg-exit').onclick = exit;

  function input() {
    let ax = 0, ay = 0;
    if (stick.on) {
      const dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.hypot(dx, dy), m = Math.min(1, d / 70);
      if (d > 6) { ax = (dx / d) * m; ay = (dy / d) * m; }
    }
    if (keys.has('ArrowLeft') || keys.has('a')) ax -= 1;
    if (keys.has('ArrowRight') || keys.has('d')) ax += 1;
    if (keys.has('ArrowUp') || keys.has('w')) ay -= 1;
    if (keys.has('ArrowDown') || keys.has('s')) ay += 1;
    const m = Math.hypot(ax, ay); if (m > 1) { ax /= m; ay /= m; }
    return [ax, ay];
  }

  // ---- loop ----
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (running) update(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  function update(dt) {
    const [ax, ay] = input();
    drone.vx += (ax * SPEED - drone.vx) * Math.min(1, dt * 4);
    drone.vy += (ay * SPEED - drone.vy) * Math.min(1, dt * 4);
    drone.x = Math.max(40, Math.min(WORLD - 40, drone.x + drone.vx * dt));
    drone.y = Math.max(40, Math.min(WORLD - 40, drone.y + drone.vy * dt));
    prop += dt * 40;

    const prev = Math.ceil(timeLeft);
    timeLeft -= dt;
    if (Math.ceil(timeLeft) !== prev && timeLeft <= 10 && timeLeft > 0) sfx.tick();
    const bat = Math.max(0, Math.ceil((timeLeft / GAME_SEC) * 100));
    $('mg-bat').textContent = `🔋 ${bat}%`;
    $('mg-bat').classList.toggle('hot', bat <= 15);

    let near = null;
    for (const t of world.targets) {
      if (t.found) continue;
      const d = Math.hypot(t.x - drone.x, t.y - drone.y);
      if (d < SCAN_RADIUS) near = t; else t.scan = Math.max(0, t.scan - dt);
    }
    const tempEl = $('mg-temp');
    if (near && thermal) {
      near.scan += dt;
      tempEl.textContent = `${near.temp}°C`; tempEl.className = 'mg-temp hot';
      if (near.scan >= SCAN_TIME) {
        near.found = true; sfx.pass(); vibrate([60, 40, 60]);
        const n = world.targets.filter((t) => t.found).length;
        $('mg-count').textContent = `🔍 ${n} / ${TARGETS.length}`;
        toast(`${near.e} Знайдено ${esc(near.name)}! Рятувальники вже їдуть 🚒`);
        if (n === TARGETS.length) return finish('all');
      }
    } else {
      tempEl.textContent = thermal ? `${toC(0.2)}°C` : '';
      tempEl.className = 'mg-temp';
      if (near && !thermal && near.scan === 0) { near.scan = 0.001; toast('Тут щось є… Увімкни 🔥 тепловізор!'); }
    }
    if (timeLeft <= 0) { sfx.fail(); finish('battery'); }
  }

  // ---- render ----
  const col = (t, night) => (thermal ? iron(t) : night);

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = thermal ? iron(0.15) : '#07130f';
    ctx.fillRect(0, 0, W, H);
    if (!world) return;
    const cx = drone.x - W / 2, cy = drone.y - H / 2;
    const vis = (x, y, m = 80) => x > cx - m && x < cx + W + m && y > cy - m && y < cy + H + m;
    ctx.save(); ctx.translate(-cx, -cy);

    // river and road
    const path = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
    ctx.lineCap = ctx.lineJoin = 'round';
    path(world.river); ctx.strokeStyle = col(0.05, '#061426'); ctx.lineWidth = 110; ctx.stroke();
    path(world.road); ctx.strokeStyle = col(0.33, '#14171b'); ctx.lineWidth = 34; ctx.stroke();

    for (const h of world.houses) {
      if (!vis(h.x, h.y, 120)) continue;
      ctx.fillStyle = col(h.warm, '#1b1d26'); ctx.fillRect(h.x - h.w / 2, h.y - h.h / 2, h.w, h.h);
      ctx.fillStyle = col(h.warm + 0.2, '#e8c35a55'); ctx.fillRect(h.x - 8, h.y - 8, 16, 16);
    }
    for (const t of world.trees) {
      if (!vis(t.x, t.y)) continue;
      ctx.fillStyle = col(t.t, '#0b2218'); ctx.beginPath(); ctx.arc(t.x, t.y, t.s, 0, 7); ctx.fill();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of world.targets) {
      if (!vis(t.x, t.y)) continue;
      if (thermal || t.found) {
        const g = ctx.createRadialGradient(t.x, t.y, 2, t.x, t.y, 40);
        g.addColorStop(0, thermal ? iron(1) : 'rgba(0,210,106,.5)'); g.addColorStop(0.5, thermal ? iron(0.8) : 'rgba(0,210,106,.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(t.x, t.y, 40, 0, 7); ctx.fill();
        ctx.globalAlpha = t.found ? 1 : 0.55; ctx.font = '30px serif'; ctx.fillText(t.e, t.x, t.y); ctx.globalAlpha = 1;
        if (t.found) { ctx.strokeStyle = '#00d26a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(t.x, t.y, 30, 0, 7); ctx.stroke(); }
      }
    }
    ctx.restore();

    // vignette (darker at night)
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, thermal ? 'rgba(0,0,0,.45)' : 'rgba(0,0,0,.85)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);

    drawDrone();
    drawCrosshair();
  }

  function drawDrone() {
    const x = W / 2, y = H / 2 + 58, a = Math.atan2(drone.vy, drone.vx || 0.0001), tilt = Math.min(1, Math.hypot(drone.vx, drone.vy) / SPEED);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a * tilt * 0.15);
    ctx.fillStyle = '#e9ecf5'; ctx.strokeStyle = '#e9ecf5'; ctx.lineWidth = 5;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(dx * 22, dy * 16); ctx.stroke();
      ctx.save(); ctx.translate(dx * 22, dy * 16); ctx.rotate(prop * (dx * dy));
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(-12, -2, 24, 4); ctx.restore();
    }
    ctx.fillStyle = '#ffe600'; ctx.fillRect(-11, -8, 22, 16);
    ctx.fillStyle = '#ff2b3d'; ctx.beginPath(); ctx.arc(0, -8, 3, 0, 7); ctx.fill();
    ctx.restore();
  }

  function drawCrosshair() {
    const x = W / 2, y = H / 2;
    ctx.strokeStyle = thermal ? '#ffffff' : '#00e5ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, SCAN_RADIUS * 0.75, 0, 7); ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath(); ctx.moveTo(x + dx * 12, y + dy * 12); ctx.lineTo(x + dx * 24, y + dy * 24); ctx.stroke();
    }
    const scanning = world?.targets.find((t) => !t.found && t.scan > 0.01 && thermal);
    if (scanning) {
      ctx.strokeStyle = '#00d26a'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(x, y, SCAN_RADIUS * 0.75 + 6, -Math.PI / 2, -Math.PI / 2 + (scanning.scan / SCAN_TIME) * Math.PI * 2); ctx.stroke();
    }
    if (stick.on) {
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(stick.ox, stick.oy, 70, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.beginPath();
      const dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.hypot(dx, dy), k = d > 70 ? 70 / d : 1;
      ctx.arc(stick.ox + dx * k, stick.oy + dy * k, 26, 0, 7); ctx.fill();
    }
  }

  root.debugState = () => ({ world, drone, running, timeLeft });
  briefing();
  raf = requestAnimationFrame((t) => { last = t; loop(t); });
}
