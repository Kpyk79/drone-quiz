import { SUPABASE_URL, SUPABASE_KEY, POLL_MS } from './config.js';

export class ServerError extends Error {}

export async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch (e) {
    throw new Error('network');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ServerError((body && body.message) || `HTTP ${res.status}`);
  return body;
}

const netEl = () => document.getElementById('net');

/**
 * Polls `fetchState` and calls `onState(state)`. `clock.left()` gives the
 * server's ms_left corrected for time passed since the last answer.
 */
export function createPoller(fetchState, onState, onServerError) {
  let timer = null;
  let stopped = false;
  const clock = { state: null, at: 0, left() { return this.state ? Math.max(0, this.state.ms_left - (performance.now() - this.at)) : 0; } };

  const accept = (s) => {
    clock.state = s;
    clock.at = performance.now();
    onState(s);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const s = await fetchState();
      netEl()?.classList.remove('on');
      if (!stopped) accept(s);
    } catch (e) {
      if (e instanceof ServerError) onServerError?.(e);
      else netEl()?.classList.add('on');
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };

  tick();
  return {
    clock,
    push: accept,
    stop() { stopped = true; clearTimeout(timer); },
  };
}
