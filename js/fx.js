// Sound effects (synthesised, no files), vibration, confetti, wake lock and the voice-over.

let ctx = null;

/** Must be called from a click/tap so phones allow sound later. */
export function unlockAudio() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination); s.start(0);
  } catch { /* audio not available */ }
}
export const audioReady = () => !!ctx && ctx.state === 'running';

function tone(freq, dur, { type = 'triangle', vol = 0.22, at = 0, slide = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, { at = 0, vol = 0.15 } = {}) {
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 900;
  s.buffer = buf; g.gain.value = vol;
  s.connect(f).connect(g).connect(ctx.destination);
  s.start(ctx.currentTime + at);
}

export const sfx = {
  tick: () => tone(880, 0.12, { type: 'square', vol: 0.12 }),
  go: () => { tone(523, 0.18, { type: 'sawtooth', vol: 0.15 }); tone(784, 0.35, { type: 'sawtooth', vol: 0.15, at: 0.12 }); tone(1047, 0.5, { at: 0.24 }); },
  tap: () => tone(660, 0.08, { type: 'square', vol: 0.1 }),
  join: () => { tone(660, 0.1); tone(990, 0.15, { at: 0.08 }); },
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.28, { at: i * 0.13, type: 'square', vol: 0.14 })),
  pass: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { at: i * 0.09 })),
  fail: () => { tone(220, 0.35, { type: 'sawtooth', vol: 0.18, slide: -80 }); tone(160, 0.6, { type: 'sawtooth', vol: 0.18, at: 0.3, slide: -70 }); },
  alarm: () => { for (let i = 0; i < 6; i++) tone(i % 2 ? 740 : 988, 0.18, { type: 'square', vol: 0.16, at: i * 0.2 }); },
  drum: (sec = 3) => { for (let t = 0; t < sec; t += 0.06) noise(0.05, { at: t, vol: 0.05 + 0.12 * (t / sec) }); },
  whoosh: () => tone(200, 0.5, { type: 'sine', vol: 0.15, slide: 900 }),
};

export function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* not supported */ }
}

let lock = null;
export async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !lock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    }
  } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && lock === null && window.__wantAwake) keepAwake(); });

export function confetti(ms = 6000) {
  const cv = document.getElementById('confetti');
  if (!cv) return;
  const c = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const cols = ['#ffe600', '#ff2d87', '#00e5ff', '#1f6bff', '#00d26a', '#ffffff'];
  const bits = Array.from({ length: 220 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height, w: 6 + Math.random() * 9, h: 9 + Math.random() * 12,
    vy: 2.5 + Math.random() * 4, vx: -2 + Math.random() * 4, r: Math.random() * 6, vr: -0.2 + Math.random() * 0.4,
    col: cols[Math.floor(Math.random() * cols.length)],
  }));
  const end = performance.now() + ms;
  (function frame() {
    c.clearRect(0, 0, cv.width, cv.height);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.r += b.vr;
      if (b.y > cv.height + 20 && performance.now() < end - 1500) { b.y = -20; b.x = Math.random() * cv.width; }
      c.save(); c.translate(b.x, b.y); c.rotate(b.r); c.fillStyle = b.col; c.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); c.restore();
    }
    if (performance.now() < end) requestAnimationFrame(frame); else c.clearRect(0, 0, cv.width, cv.height);
  })();
}

/* ---------- Voice-over (Ukrainian text-to-speech of the device) ---------- */
export const voice = {
  enabled: true,
  v: null,
  init() {
    if (!('speechSynthesis' in window)) { this.enabled = false; return; }
    const pick = () => {
      const all = speechSynthesis.getVoices();
      this.v = all.find(x => /^uk/i.test(x.lang)) || null;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  },
  hasUkrainian() { return !!this.v; },
  /** Speak now, cutting anything still being said. */
  say(text, { rate = 1.02, pitch = 1 } = {}) {
    if (!this.enabled || !('speechSynthesis' in window) || !text) return;
    speechSynthesis.cancel();
    this.queue(text, { rate, pitch });
  },
  /** Speak after whatever is being said now. */
  queue(text, { rate = 1.02, pitch = 1 } = {}) {
    if (!this.enabled || !('speechSynthesis' in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'uk-UA';
    if (this.v) u.voice = this.v;
    u.rate = rate; u.pitch = pitch;
    speechSynthesis.speak(u);
  },
  stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); },
};
