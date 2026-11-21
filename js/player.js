import { rpc, createPoller } from './api.js';
import { AVATARS } from './config.js';
import { app, esc, store, mmss, setFlood, answersHtml, ringHtml, startTicker } from './ui.js';
import { unlockAudio, sfx, vibrate, keepAwake, confetti } from './fx.js';
import { startThermal } from './thermal.js';

const KEY = 'drone_show_player';
let poller = null, stopTicker = null, renderKey = '', prevPhase = null, pending = null, pendingStage = 0;

export function startPlayer(params) {
  const saved = store.get(KEY);
  const code = (params.get('g') || '').trim();
  if (saved && (!code || code === saved.code)) return resumeScreen(saved);
  joinScreen(code);
}

function resumeScreen(saved) {
  setFlood(null);
  app().innerHTML = `<div class="wrap">
    <p class="kicker">Дрон-Шоу</p>
    <div class="winner-av">${esc(saved.avatar || '🚁')}</div>
    <h1 class="mega m white">${esc(saved.name || '')}</h1>
    <button class="btn huge" id="back">Повернутись у гру</button>
    <button class="btn ghost" id="other">Це не я / інша гра</button></div>`;
  document.getElementById('back').onclick = () => { unlockAudio(); window.__wantAwake = true; keepAwake(); run(saved); };
  document.getElementById('other').onclick = () => { store.del(KEY); joinScreen(saved.code); };
}

function joinScreen(code, msg = '') {
  poller?.stop(); stopTicker?.(); setFlood(null);
  let avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  app().innerHTML = `<div class="wrap">
    <p class="kicker">Вітаємо на</p>
    <h1 class="mega l">Дрон-Шоу</h1>
    <div class="panel" style="max-width:440px">
      <div class="label">Код гри</div>
      <input class="field" id="code" inputmode="numeric" maxlength="4" placeholder="0000" value="${esc(code)}">
      <div class="label">Твоє ім'я</div>
      <input class="field" id="name" maxlength="20" placeholder="Як тебе звати?" autocomplete="off">
      <div class="label">Обери героя</div>
      <div class="avatars">${AVATARS.map((a) => `<button class="av ${a === avatar ? 'sel' : ''}" data-a="${a}">${a}</button>`).join('')}</div>
      <div class="err" id="err">${esc(msg)}</div>
      <button class="btn wide huge" id="go">Я граю! 🚀</button>
    </div></div>`;
  app().querySelectorAll('.av').forEach((b) => b.onclick = () => {
    avatar = b.dataset.a;
    app().querySelectorAll('.av').forEach((x) => x.classList.toggle('sel', x === b));
  });
  const err = document.getElementById('err'), go = document.getElementById('go');
  const submit = async () => {
    unlockAudio();
    const c = document.getElementById('code').value.trim();
    const name = document.getElementById('name').value.trim();
    if (!/^\d{4}$/.test(c)) { err.textContent = 'Введи код з 4 цифр'; return; }
    if (!name) { err.textContent = "Напиши своє ім'я"; return; }
    go.disabled = true; err.textContent = '';
    try {
      const r = await rpc('quiz_join', { p_code: c, p_name: name, p_avatar: avatar });
      const me = { ...r, code: c, name, avatar };
      store.set(KEY, me);
      sfx.join(); vibrate(60);
      window.__wantAwake = true; keepAwake();
      run(me);
    } catch (e) {
      go.disabled = false;
      err.textContent = /not found/.test(e.message) ? 'Гру з таким кодом не знайдено'
        : /already started/.test(e.message) ? 'Гра вже почалась 😔 Дочекайся наступної!'
        : /network/.test(e.message) ? 'Немає інтернету. Спробуй ще раз' : 'Не вийшло приєднатись. Спробуй ще раз';
    }
  };
  go.onclick = submit;
  document.getElementById('name').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

function run(me) {
  poller?.stop(); stopTicker?.();
  renderKey = ''; prevPhase = null; pending = null;
  poller = createPoller(() => rpc('quiz_player_state', { p_game: me.game_id, p_player: me.player_id }), (s) => draw(s, me));
  stopTicker = startTicker(poller.clock, (kind, label) => {
    if (kind === 'count5') { if (label === 'ПОЧАЛИ!') { sfx.go(); vibrate(200); } else { sfx.tick(); vibrate(40); } }
    if (kind === 'count3') sfx.tick();
  });
}

function readyAlert() {
  sfx.alarm(); vibrate([300, 150, 300, 150, 600]);
  const el = document.createElement('div');
  el.className = 'alert';
  el.innerHTML = '<div><div class="mega xl">Гра<br>почина&shy;ється!</div><p class="lead" style="color:#000;margin-top:16px">Дивись на великий екран 👀</p></div>';
  document.body.appendChild(el);
  el.onclick = () => el.remove();
  setTimeout(() => el.remove(), 4000);
}

function isOut(s) {
  const o = s.me?.out_stage;
  if (o == null) return false;
  return o < s.stage || s.phase === 'finished' || (o === s.stage && !['question', 'reveal', 'result'].includes(s.phase));
}

function draw(s, me) {
  if (s.phase === 'gone' || s.phase === 'kicked') {
    store.del(KEY);
    return joinScreen(me.code, s.phase === 'kicked' ? "Ведучий попросив змінити ім'я 🙂" : 'Цієї гри вже немає');
  }
  if (s.stage !== pendingStage) { pending = null; pendingStage = s.stage; }
  const answered = s.me.answered || pending !== null;
  const out = isOut(s);
  const key = [s.phase, s.stage, answered, s.me.result, out, s.phase === 'lobby' || s.phase === 'ready' ? s.players : 0].join('|');
  if (key === renderKey) return;
  const was = prevPhase;
  renderKey = key; prevPhase = s.phase;
  if (was === 'lobby' && s.phase === 'ready') readyAlert();

  setFlood(null);
  const stageName = s.is_final ? 'ФІНАЛ' : `Етап ${s.stage}`;
  const head = `<div class="row"><span class="chip">${esc(s.me.avatar)} ${esc(s.me.name)}</span></div>`;

  if (s.phase === 'lobby' || s.phase === 'ready') {
    app().innerHTML = `<div class="wrap">${head}
      <p class="kicker">${s.phase === 'lobby' ? 'До початку гри' : 'Таймер завершено'}</p>
      ${s.phase === 'lobby' ? `<div class="clock" data-t="mmss">${mmss(s.ms_left)}</div>` : '<h1 class="mega l blink">Чекаємо<br>ведучого</h1>'}
      <span class="chip">👥 Гравців: ${s.players}</span>
      <p class="lead">Не закривай сторінку і тримай телефон увімкненим 📱</p></div>`;
    return;
  }

  if (s.phase === 'finished') {
    const won = s.winner && s.me.out_stage == null;
    setFlood(won ? 'gold' : null);
    app().innerHTML = won
      ? `<div class="wrap"><div class="winner-av">🏆</div><h1 class="mega xl white">Перемога!</h1><p class="lead" style="color:#000">Підходь до ведучого за призом! 🎁</p></div>`
      : `<div class="wrap"><p class="kicker">Переможець шоу</p><div class="winner-av">${esc(s.winner?.avatar || '🏆')}</div>
         <h1 class="mega l">${esc(s.winner?.name || '')}</h1><p class="lead">Дякуємо за гру! 💙💛</p></div>`;
    app().querySelector('.wrap').insertAdjacentHTML('beforeend',
      '<button class="btn huge pink" id="fly">🚁 Політати на дроні</button><p class="lead">Нічна рятувальна місія з тепловізором 🔥</p>');
    document.getElementById('fly').onclick = () => startThermal();
    if (won && was !== 'finished') { confetti(); sfx.win(); }
    return;
  }

  if (out) {
    app().innerHTML = `<div class="wrap">${head}
      <p class="kicker">${stageName}</p>
      <h1 class="mega m white">Вибування на етапі ${s.me.out_stage}</h1>
      <p class="lead">Але гра триває! Дивись на великий екран і вболівай 📺</p>
      <span class="chip hot">🔥 У грі: ${s.alive}</span></div>`;
    return;
  }

  if (s.phase === 'countdown') {
    app().innerHTML = `<div class="wrap"><p class="kicker">${stageName}</p><div class="count" data-t="count5"></div>
      <span class="chip hot">🔥 У грі: ${s.alive}</span></div>`;
    return;
  }

  if (s.phase === 'question') {
    const q = s.question;
    if (answered) {
      app().innerHTML = `<div class="wrap">${head}
        <h1 class="mega l white">Очікуй<br>результату</h1>
        <div class="clock sm" data-t="sec">${Math.ceil(s.ms_left / 1000)}</div>
        <p class="lead">Відповідь зараховано ✋ Чекаємо інших…</p></div>`;
      return;
    }
    app().innerHTML = `<div class="wrap top">
      <div class="row"><span class="chip">${stageName}</span><span class="chip hot">🔥 ${s.alive}</span></div>
      ${ringHtml(s)}
      <div style="font-size:48px">${esc(q.emoji)}</div>
      <p class="qtext">${esc(q.question)}</p>
      ${answersHtml(q, { clickable: true })}</div>`;
    app().querySelectorAll('button.ans').forEach((b) => b.onclick = async () => {
      if (pending !== null) return;
      pending = +b.dataset.i; sfx.tap(); vibrate(50);
      renderKey = ''; draw({ ...s, ms_left: poller.clock.left() }, me);
      try { await rpc('quiz_answer', { p_game: me.game_id, p_player: me.player_id, p_choice: pending }); }
      catch { pending = null; renderKey = ''; }
    });
    return;
  }

  if (s.phase === 'reveal') {
    app().innerHTML = `<div class="wrap"><p class="kicker">Результат через</p><div class="count" data-t="count3"></div></div>`;
    sfx.drum(3);
    return;
  }

  if (s.phase === 'result') drawResult(s, was);
}

function drawResult(s, was) {
  const r = s.me.result, sec = s.me.ms != null ? (s.me.ms / 1000).toFixed(2) : null;
  const first = was !== 'result';
  const views = {
    winner: ['gold', '🏆', 'Перемога!', 'Підходь до ведучого за призом! 🎁'],
    pass: ['green', '✅', 'Проходиш далі!', sec ? `Твій час: ${sec} с ⚡` : ''],
    saved: ['amber', '🍀', 'Ще один шанс!', 'Ніхто не відповів правильно — всі грають далі'],
    wrong: ['red', '❌', 'Вибуваєш', 'Неправильна відповідь'],
    timeout: ['red', '⏰', 'Вибуваєш', 'Час вийшов, відповіді не було'],
    slow: ['red', '🐢', 'Вибуваєш', `Відповідь правильна, але інші були швидшими${sec ? ` (${sec} с)` : ''}`],
  };
  const [flood, emo, title, sub] = views[r] || views.timeout;
  setFlood(flood);
  app().innerHTML = `<div class="wrap ${flood === 'red' && first ? 'shake' : ''}">
    <div class="winner-av" style="animation:none">${emo}</div>
    <h1 class="mega xl white">${title}</h1>
    <p class="lead" style="color:#fff;font-weight:800">${esc(sub)}</p>
    ${r === 'pass' ? `<span class="chip">🔥 Далі грають: ${s.alive}</span>` : ''}</div>`;
  if (!first) return;
  if (r === 'winner') { confetti(); sfx.win(); vibrate([200, 100, 200, 100, 500]); }
  else if (r === 'pass' || r === 'saved') { sfx.pass(); vibrate([100, 60, 100]); }
  else { sfx.fail(); vibrate(700); }
}
