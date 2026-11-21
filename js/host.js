// Host remote control (runs on the host's smartphone).
import { rpc, createPoller } from './api.js';
import { LETTERS } from './config.js';
import { app, esc, store, mmss, startTicker } from './ui.js';
import { unlockAudio, sfx, vibrate, keepAwake } from './fx.js';

const KEY = 'drone_show_host';
let poller = null, stopTicker = null, renderKey = '', prevPhase = null;

export function startHost() {
  const g = store.get(KEY);
  g ? run(g) : createScreen();
}

function createScreen() {
  poller?.stop(); stopTicker?.();
  let minutes = 10, ratio = 0.5;
  app().innerHTML = `<div class="wrap"><p class="kicker">Пульт ведучого</p><h1 class="mega l">Дрон-Шоу</h1>
    <div class="panel remote">
      <h3>Таймер до старту</h3>
      <div class="status"><button class="btn ghost" id="mm">−1</button><div class="big-num" id="mins">10 хв</div><button class="btn ghost" id="mp">+1</button></div>
      <h3>Скільки проходить далі після етапу</h3>
      <div class="seg" id="ratio"><button data-r="0.3">30%</button><button data-r="0.5" class="on">50%</button><button data-r="0.7">70%</button></div>
      <p class="small">50%: з 30 гравців → 15 → 8 → 4 → 2 → 1 переможець (5 етапів). Чим більше відсоток, тим довша гра.</p>
      <button class="btn huge wide" id="create">Створити гру</button><div class="err" id="err"></div>
    </div></div>`;
  const show = () => { document.getElementById('mins').textContent = `${minutes} хв`; };
  document.getElementById('mm').onclick = () => { minutes = Math.max(0, minutes - 1); show(); };
  document.getElementById('mp').onclick = () => { minutes = Math.min(120, minutes + 1); show(); };
  document.querySelectorAll('#ratio button').forEach((b) => b.onclick = () => {
    ratio = +b.dataset.r;
    document.querySelectorAll('#ratio button').forEach((x) => x.classList.toggle('on', x === b));
  });
  document.getElementById('create').onclick = async (e) => {
    unlockAudio(); e.target.disabled = true;
    try {
      const g = await rpc('quiz_create_game', { p_minutes: minutes, p_ratio: ratio });
      store.set(KEY, g);
      run(g);
    } catch {
      e.target.disabled = false;
      document.getElementById('err').textContent = 'Не вдалося створити гру. Перевір інтернет.';
    }
  };
}

function run(g) {
  window.__wantAwake = true; keepAwake();
  renderKey = ''; prevPhase = null;
  poller = createPoller(() => rpc('quiz_host_state', { p_game: g.game_id, p_secret: g.secret }), (s) => draw(s, g),
    () => { store.del(KEY); createScreen(); });
  stopTicker = startTicker(poller.clock);
}

async function act(g, fn, extra = {}) {
  unlockAudio(); vibrate(30);
  try {
    const s = await rpc(fn, { p_game: g.game_id, p_secret: g.secret, ...extra });
    poller.push(s);
  } catch { document.getElementById('net')?.classList.add('on'); }
}

const base = () => `${location.origin}${location.pathname}`;

function rosterHtml(s, { kick = false, answers = false } = {}) {
  return `<div class="wall" style="justify-content:flex-start">${s.roster.map((p) => {
    const out = p.out_stage != null;
    const cls = out ? 'out' : answers && p.answered ? 'ans' : '';
    const x = kick ? `<button class="x" data-kick="${p.id}" data-name="${esc(p.name)}">✕</button>` : '';
    return `<span class="tag ${cls}"><span>${esc(p.avatar)}</span>${esc(p.name)}${x}</span>`;
  }).join('')}</div>`;
}

function draw(s, g) {
  const sig = s.roster.map((p) => `${p.id}${p.out_stage}${p.answered}`).join(',');
  const key = [s.phase, s.stage, sig].join('|');
  if (key === renderKey) return;
  renderKey = key;
  const was = prevPhase; prevPhase = s.phase;
  if (was === 'lobby' && s.phase === 'ready') { sfx.alarm(); vibrate([300, 100, 300]); }

  const stageName = s.is_final ? 'ФІНАЛ' : `Етап ${s.stage}`;
  const head = `<div class="status"><span class="chip">Гра <b>${esc(s.code)}</b></span>
    <span class="chip hot">${s.phase === 'lobby' || s.phase === 'ready' ? `👥 ${s.players}` : `🔥 ${s.alive} / ${s.players}`}</span></div>`;
  let body = '';

  if (s.phase === 'lobby' || s.phase === 'ready') {
    const screenUrl = `${base()}?screen=${s.code}`;
    body = `<h3>${s.phase === 'lobby' ? 'До старту' : 'Таймер завершено — гравців сповіщено'}</h3>
      <div class="clock sm" ${s.phase === 'lobby' ? 'data-t="mmss"' : ''} style="text-align:center">${s.phase === 'lobby' ? mmss(s.ms_left) : '00:00'}</div>
      <div class="row"><button class="btn ghost" data-add="-60">−1 хв</button><button class="btn ghost" data-add="60">+1 хв</button>
        <button class="btn ghost" data-set>Задати…</button><button class="btn ghost" data-zero>На нуль</button></div>
      <button class="btn huge wide" id="start" ${s.players ? '' : 'disabled'}>🚀 Почати гру</button>
      <h3>Гравці (${s.players}) — ✕ прибрати</h3>${s.roster.length ? rosterHtml(s, { kick: true }) : '<p class="small">Поки нікого</p>'}
      <h3>Посилання для планшета</h3>
      <div class="panel" style="padding:12px;word-break:break-all;font-weight:700">${esc(screenUrl)}</div>
      <div class="row"><button class="btn blue" id="share">Надіслати / скопіювати</button></div>
      <p class="small">Або відкрий на планшеті сайт з <b>?screen</b> і введи код <b>${esc(s.code)}</b>.</p>`;
  } else if (s.phase === 'countdown' || s.phase === 'question') {
    const q = s.host_question;
    body = `<h3>${stageName} · ${s.phase === 'countdown' ? 'відлік 5…1' : 'питання'}</h3>
      <div class="status"><div class="clock sm" data-t="${s.phase === 'question' ? 'sec' : 'mmss'}">${Math.ceil(s.ms_left / 1000)}</div>
        <div class="big-num">✋ ${s.answered}/${s.alive}</div></div>
      <p class="small">Далі пройдуть: <b>${s.keep}</b></p>
      <p style="font-weight:800;font-size:18px;margin:0">${esc(q.emoji)} ${esc(q.question)}</p>
      ${q.options.map((o, i) => `<div class="opt ${i === q.correct ? 'ok' : ''}"><b>${LETTERS[i]}</b> ${esc(o)} ${i === q.correct ? '✅' : ''}</div>`).join('')}
      ${s.phase === 'question' ? '<button class="btn pink wide" id="skip">⏹ Завершити питання зараз</button>' : ''}
      <h3>Гравці (блакитні вже відповіли)</h3>${rosterHtml(s, { answers: true })}`;
  } else if (s.phase === 'reveal') {
    body = `<h3>${stageName}</h3><h1 class="mega m white blink" style="text-align:center">Результати…</h1>`;
  } else if (s.phase === 'result') {
    const r = s.result;
    const summary = s.winner ? `<h1 class="mega m" style="text-align:center">🏆 ${esc(s.winner.name)}</h1>`
      : r.no_correct ? '<p class="lead">Ніхто не відповів правильно — всі грають далі.</p>'
      : `<p class="lead">✅ Пройшли: <b>${r.passed.length}</b> · ❌ Вибули: <b>${r.out}</b></p>`;
    body = `<h3>${stageName} · результат</h3>${summary}
      <button class="btn huge wide" id="next">${s.winner ? '🏆 Оголосити переможця' : '▶ Наступний етап'}</button>
      <h3>Гравці</h3>${rosterHtml(s)}`;
  } else if (s.phase === 'finished') {
    body = `<h3>Гру завершено</h3><div class="winner-av" style="text-align:center">${esc(s.winner?.avatar || '🏆')}</div>
      <h1 class="mega m" style="text-align:center">${esc(s.winner?.name || '')}</h1>`;
  }

  app().innerHTML = `<div class="wrap top"><p class="kicker">Пульт ведучого</p><div class="panel remote">${head}${body}
    <button class="btn ghost" id="new">Нова гра</button></div></div>`;
  bind(s, g);
}

function bind(s, g) {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () =>
    act(g, 'quiz_host_lobby_time', { p_seconds: Math.max(0, Math.round(poller.clock.left() / 1000) + +b.dataset.add) }));
  document.querySelector('[data-set]')?.addEventListener('click', () => {
    const m = prompt('Скільки хвилин до старту?', '10');
    if (m !== null && !Number.isNaN(+m)) act(g, 'quiz_host_lobby_time', { p_seconds: Math.round(+m * 60) });
  });
  document.querySelector('[data-zero]')?.addEventListener('click', () => act(g, 'quiz_host_lobby_time', { p_seconds: 0 }));
  document.querySelectorAll('[data-kick]').forEach((b) => b.onclick = () => {
    if (confirm(`Прибрати гравця «${b.dataset.name}»?`)) act(g, 'quiz_host_kick', { p_player: b.dataset.kick });
  });
  on('start', () => {
    if (s.phase === 'lobby' && !confirm('Таймер ще йде. Почати гру зараз?')) return;
    act(g, 'quiz_host_start');
  });
  on('skip', () => { if (confirm('Завершити питання? Хто не відповів — вибуває.')) act(g, 'quiz_host_skip'); });
  on('next', () => act(g, 'quiz_host_next'));
  on('share', async () => {
    const url = `${base()}?screen=${s.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Дрон-Шоу: великий екран', url });
      else { await navigator.clipboard.writeText(url); alert('Скопійовано!'); }
    } catch { /* cancelled */ }
  });
  on('new', () => {
    if (!confirm('Створити нову гру? До цієї гри повернутися не вийде.')) return;
    poller?.stop(); stopTicker?.(); store.del(KEY); createScreen();
  });
}
