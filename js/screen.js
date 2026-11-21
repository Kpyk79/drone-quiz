// Big screen (tablet / projector): QR code, synced timers, question, results and the voice-over.
import { rpc, createPoller } from './api.js';
import { LETTERS } from './config.js';
import { app, esc, mmss, setFlood, answersHtml, ringHtml, barHtml, startTicker } from './ui.js';
import { unlockAudio, sfx, confetti, voice, keepAwake } from './fx.js';

let poller = null, renderKey = '', prev = { phase: null, stage: 0 }, seenPlayers = null, said = new Set();

export function startScreen(params) {
  const code = (params.get('screen') || '').trim();
  if (/^\d{4}$/.test(code)) return gate(code);
  app().innerHTML = `<div class="wrap"><p class="kicker">Великий екран</p><h1 class="mega l">Дрон-Шоу</h1>
    <div class="panel" style="max-width:420px"><div class="label">Код гри (з телефона ведучого)</div>
    <input class="field" id="code" inputmode="numeric" maxlength="4" placeholder="0000">
    <button class="btn wide" id="go" style="margin-top:14px">Показати</button></div></div>`;
  document.getElementById('go').onclick = () => {
    const c = document.getElementById('code').value.trim();
    if (/^\d{4}$/.test(c)) history.replaceState(null, '', `?screen=${c}`), gate(c);
  };
}

function gate(code) {
  voice.init();
  app().innerHTML = `<div class="overlay"><div><p class="kicker">Великий екран · гра ${esc(code)}</p>
    <h1 class="mega l">Дрон-Шоу</h1><p class="lead" style="margin:18px auto">Увімкни звук на планшеті та натисни кнопку</p>
    <button class="btn huge" id="on">🔊 Увімкнути шоу</button></div></div>`;
  document.getElementById('on').onclick = () => {
    unlockAudio(); window.__wantAwake = true; keepAwake();
    document.documentElement.requestFullscreen?.().catch(() => {});
    voice.say('Вітаємо на Дрон-Шоу!');
    run(code);
  };
}

function run(code) {
  poller = createPoller(() => rpc('quiz_screen_state', { p_code: code }), draw);
  startTicker(poller.clock, (kind, label) => {
    if (kind === 'count5') { if (label === 'ПОЧАЛИ!') { sfx.go(); voice.say('Почали!'); } else sfx.tick(); }
    if (kind === 'count3') sfx.tick();
  });
  // One-off timed lines during the lobby and the question.
  setInterval(() => {
    const s = poller.clock.state; if (!s) return;
    const left = poller.clock.left();
    const once = (id, text) => { if (!said.has(id)) { said.add(id); voice.say(text); } };
    if (s.phase === 'lobby' && left < 60500 && left > 55000) once(`lobby60-${s.code}`, 'Залишилась одна хвилина до початку! Скануйте QR-код!');
    if (s.phase === 'lobby' && left < 10500 && left > 8000) once(`lobby10-${s.code}`, 'Десять секунд!');
    if (s.phase === 'question' && left < 10500 && left > 8000) once(`q10-${s.stage}`, 'Десять секунд!');
  }, 250);
}

function toolbar() {
  return `<div class="toolbar"><button class="btn ghost" id="mute">${voice.enabled ? '🗣️ Голос' : '🔇 Без голосу'}</button>
    <button class="btn ghost" id="fs">⛶</button></div>`;
}
function bindToolbar() {
  document.getElementById('mute').onclick = (e) => { voice.enabled = !voice.enabled; voice.stop(); e.target.textContent = voice.enabled ? '🗣️ Голос' : '🔇 Без голосу'; };
  document.getElementById('fs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {});
}

function joinUrl(code) { return `${location.origin}${location.pathname}?g=${code}`; }

function announceJoins(s) {
  const names = (s.lobby || []).map((p) => p.name);
  if (seenPlayers === null) { seenPlayers = new Set(names); return; }
  const fresh = names.filter((n) => !seenPlayers.has(n));
  fresh.forEach((n) => seenPlayers.add(n));
  if (!fresh.length) return;
  sfx.join();
  if (fresh.length <= 2) fresh.forEach((n) => voice.queue(`Вітаємо, ${n}!`));
  else voice.queue(`До нас приєдналися ще ${fresh.length} гравців! Нас уже ${s.players}!`);
}

function narrate(s, was) {
  const q = s.question;
  if (s.phase === 'ready' && was === 'lobby') voice.say('Час вийшов! Усі гравці, приготуйтесь! Ведучий ось-ось почне гру!');
  if (s.phase === 'countdown') {
    voice.say(s.is_final
      ? `Фінал! У грі залишилось ${s.alive}. Переможе лише один!`
      : `Етап ${s.stage}! У грі ${s.alive} гравців. Далі пройдуть лише ${s.keep}!`, { rate: 1.08 });
  }
  if (s.phase === 'question' && q) {
    voice.say(`${q.question} ${q.options.map((o, i) => `${LETTERS[i]}: ${o}.`).join(' ')}`, { rate: 0.98 });
  }
  if (s.phase === 'result' && s.result) {
    const right = q ? `Правильна відповідь: ${q.options[q.correct]}.` : '';
    if (s.winner) voice.say(`${right} У нас є переможець! Вітаємо, ${s.winner.name}!`);
    else if (s.result.no_correct) voice.say(`${right} Ніхто не відповів правильно! Тому всі отримують ще один шанс!`);
    else {
      const fast = s.result.passed[0];
      voice.say(`${right} Далі проходять ${s.result.passed.length}. ${fast ? `Найшвидшою була відповідь гравця ${fast.name}!` : ''}`);
    }
  }
  if (s.phase === 'finished' && s.winner) voice.say(`Переможець Дрон-Шоу — ${s.winner.name}! Оплески!`);
}

function draw(s) {
  if (s.phase === 'gone') { app().innerHTML = '<div class="wrap"><h1 class="mega m">Гру не знайдено</h1></div>'; return; }
  if (s.phase === 'lobby' || s.phase === 'ready') announceJoins(s);
  const key = [s.phase, s.stage, s.players, s.answered, s.phase === 'result' ? JSON.stringify(s.result) : ''].join('|');
  if (key === renderKey) return;
  const was = prev.phase, stageChanged = prev.stage !== s.stage;
  renderKey = key;
  const phaseChanged = was !== s.phase || stageChanged;
  prev = { phase: s.phase, stage: s.stage };
  if (phaseChanged) narrate(s, was);

  setFlood(null);
  const stageName = s.is_final ? 'ФІНАЛ' : `Етап ${s.stage}`;

  if (s.phase === 'lobby' || s.phase === 'ready') {
    const url = joinUrl(s.code);
    const wall = (s.lobby || []).slice(-60).map((p) => `<span class="tag"><span>${esc(p.avatar)}</span>${esc(p.name)}</span>`).join('');
    app().innerHTML = `<div class="wrap"><div class="lobby-grid">
      <div class="qr"><div id="qr"></div>
        <div class="hint">Немає сканера? Відкрий сайт</div>
        <div class="url">${esc(url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').replace(/\/(index\.html)?$/, ''))}</div>
        <div class="hint">і введи код</div><div class="code">${esc(s.code)}</div></div>
      <div style="display:flex;flex-direction:column;gap:18px;align-items:center">
        <p class="kicker">Скануй · Грай · Вигравай</p>
        <h1 class="mega xl">Дрон-Шоу</h1>
        ${s.phase === 'lobby' ? `<p class="kicker" style="color:#fff">До початку гри</p><div class="clock" data-t="mmss">${mmss(s.ms_left)}</div>`
          : '<h2 class="mega l white blink">Чекаємо<br>ведучого</h2>'}
        <span class="chip gold">👥 Гравців: ${s.players}</span>
        <div class="wall">${wall}</div>
      </div></div></div>${toolbar()}`;
    new window.QRCode(document.getElementById('qr'), { text: url, width: 640, height: 640, correctLevel: window.QRCode.CorrectLevel.M });
    if (was === 'lobby' && s.phase === 'ready') sfx.alarm();
  } else if (s.phase === 'countdown') {
    app().innerHTML = `<div class="wrap"><p class="kicker">${stageName}</p>
      <div class="row"><span class="chip hot">🔥 У грі: ${s.alive}</span><span class="chip gold">➜ Далі пройдуть: ${s.keep}</span></div>
      <div class="count" data-t="count5"></div></div>${toolbar()}`;
    if (phaseChanged) sfx.whoosh();
  } else if (s.phase === 'question') {
    const q = s.question;
    app().innerHTML = `<div class="wrap">
      <div class="row"><span class="chip">${stageName}</span><span class="chip hot">🔥 У грі: ${s.alive}</span>
        <span class="chip">✋ Відповіли: ${s.answered} / ${s.alive}</span><span class="chip gold">➜ Пройдуть: ${s.keep}</span></div>
      ${barHtml()}
      <div class="row" style="gap:24px"><div style="font-size:clamp(50px,9vw,110px)">${esc(q.emoji)}</div>${ringHtml(s)}</div>
      <p class="qtext">${esc(q.question)}</p>
      ${answersHtml(q)}</div>${toolbar()}`;
  } else if (s.phase === 'reveal') {
    app().innerHTML = `<div class="wrap"><p class="kicker">Хто пройде далі?</p><h1 class="mega l white">Результати</h1>
      <div class="count" data-t="count3"></div></div>${toolbar()}`;
    if (phaseChanged) sfx.drum(3);
  } else if (s.phase === 'result') {
    drawResult(s, stageName, phaseChanged);
  } else if (s.phase === 'finished') {
    setFlood('gold');
    app().innerHTML = `<div class="wrap"><p class="kicker" style="color:#000">Переможець Дрон-Шоу</p>
      <div class="winner-av">${esc(s.winner?.avatar || '🏆')}</div>
      <h1 class="mega xl white">${esc(s.winner?.name || '')}</h1>
      <span class="chip gold" style="font-size:24px">🏆 Вітаємо! 🏆</span></div>${toolbar()}`;
    if (phaseChanged) { confetti(12000); sfx.win(); }
  }
  if (document.getElementById('mute')) bindToolbar();
}

function drawResult(s, stageName, first) {
  const r = s.result, q = s.question;
  let body;
  if (s.winner) {
    setFlood('gold');
    body = `<p class="kicker" style="color:#000">У нас є переможець!</p><div class="winner-av">${esc(s.winner.avatar)}</div>
      <h1 class="mega xl white">${esc(s.winner.name)}</h1>`;
    if (first) { confetti(10000); sfx.win(); }
  } else if (r.no_correct) {
    body = `<h1 class="mega l">Ніхто не вгадав!</h1><p class="lead">Всі ${s.alive} гравців отримують ще один шанс 🍀</p>`;
    if (first) sfx.fail();
  } else {
    const wall = r.passed.map((p) => `<span class="tag"><span>${esc(p.avatar)}</span>${esc(p.name)} <time>${(p.ms / 1000).toFixed(2)}с</time></span>`).join('');
    body = `<div class="row"><span class="chip" style="background:var(--green);border:0">✅ Пройшли далі: ${r.passed.length}</span>
      <span class="chip" style="background:var(--red);border:0">❌ Вибули: ${r.out}</span></div><div class="wall">${wall}</div>`;
    if (first) sfx.pass();
  }
  app().innerHTML = `<div class="wrap"><p class="kicker">${stageName} · Правильна відповідь</p>
    ${s.winner ? '' : `<p class="qtext">${esc(q.question)}</p>${answersHtml(q, { reveal: true })}`}
    ${body}</div>${toolbar()}`;
}
