import { LETTERS } from './config.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const app = () => document.getElementById('app');

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

export function mmss(ms) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 6 s before a question: 5,4,3,2,1 then "ПОЧАЛИ!" */
export function count5Label(ms) {
  const n = Math.ceil((ms - 1000) / 1000);
  return n >= 1 ? String(Math.min(5, n)) : 'ПОЧАЛИ!';
}
export const count3Label = (ms) => String(Math.max(1, Math.min(3, Math.ceil(ms / 1000))));

export function setFlood(kind) {
  document.body.className = kind ? `flood-${kind}` : '';
}

export function answersHtml(q, { clickable = false, chosen = null, reveal = false } = {}) {
  return `<div class="answers">${q.options.map((o, i) => {
    let cls = `ans c${i}`;
    if (reveal) cls += i === q.correct ? ' right' : ' dim';
    else if (chosen !== null && chosen !== i) cls += ' dim';
    const tag = clickable ? 'button' : 'div';
    const tick = reveal && i === q.correct ? '<span class="tick">✅</span>' : '';
    return `<${tag} class="${cls}" data-i="${i}"><span class="ltr">${LETTERS[i]}</span><span>${esc(o)}</span>${tick}</${tag}>`;
  }).join('')}</div>`;
}

export const ringHtml = (s) => `<div class="ring" data-t="ring"><b data-t="sec">${Math.ceil(s.ms_left / 1000)}</b></div>`;
export const barHtml = () => '<div class="bar"><i data-t="bar" style="width:100%"></i></div>';

/**
 * Re-draws every live timer on the page ~10x a second from the poller clock.
 * `onLabel(kind, label)` fires when a 5-4-3-2-1 or 3-2-1 number changes (for sounds/voice).
 */
export function startTicker(clock, onLabel) {
  const id = setInterval(() => {
    const s = clock.state;
    if (!s) return;
    const left = clock.left();
    document.querySelectorAll('[data-t]').forEach((el) => {
      const t = el.dataset.t;
      if (t === 'mmss') el.textContent = mmss(left);
      else if (t === 'sec') el.textContent = Math.ceil(left / 1000);
      else if (t === 'ring') {
        el.style.setProperty('--p', Math.min(1, left / (s.q_seconds * 1000)));
        el.classList.toggle('low', left < 10000);
      } else if (t === 'bar') el.style.width = `${Math.min(100, (left / (s.q_seconds * 1000)) * 100)}%`;
      else if (t === 'count5' || t === 'count3') {
        const label = t === 'count5' ? count5Label(left) : count3Label(left);
        if (el.dataset.v !== label) {
          el.dataset.v = label;
          el.textContent = label;
          el.classList.toggle('go', label === 'ПОЧАЛИ!');
          el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
          onLabel?.(t, label);
        }
      }
    });
  }, 100);
  return () => clearInterval(id);
}
