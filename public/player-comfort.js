// Player comforts that belong to this device rather than the account: night mode for the sound,
// how subtitles look, and the sleep timer. Kept apart from app.js so they can be tested.
import { T } from './i18n.js';

// ---- subtitle look ----
// Size is relative to the picture, so a phone and a TV both get readable text from the same choice.
export const SUB_SIZES = [['S', 0.8, T('Small')], ['M', 1, T('Medium')], ['L', 1.25, T('Large')], ['XL', 1.55, T('Extra large')]];
// Box is the classic dark strip. Shadow and Outline keep more of the picture visible.
export const SUB_BACKGROUNDS = [['box', T('Box')], ['shadow', T('Shadow')], ['outline', T('Outline')]];
// How far the lines sit above the bottom of the picture, as a share of its height. High clears
// burnt-in captions and the lower-third graphics of news and sport.
export const SUB_POSITIONS = [['low', T('Low'), 0], ['mid', T('Mid'), 0.08], ['high', T('High'), 0.16]];

export function subLook({ size, background, position } = {}) {
  const n = Number(size);
  return {
    size: SUB_SIZES.some(([, v]) => v === n) ? n : 1,
    background: SUB_BACKGROUNDS.some(([v]) => v === background) ? background : 'box',
    position: SUB_POSITIONS.some(([v]) => v === position) ? position : 'low',
  };
}
export const subRaise = (position) => SUB_POSITIONS.find(([v]) => v === position)?.[2] ?? 0;

// The second language is never the one already showing, and only languages on offer count.
export function secondChoices(langs, primary) {
  return (langs || []).filter((l) => l?.code && l.code !== primary);
}

// ---- sleep timer ----
export const SLEEP_MINUTES = [15, 30, 45, 60, 90];
export const SLEEP_FADE_SECONDS = 20; // the sound fades out over the last seconds instead of stopping dead

export function sleepTimer(choice, now = Date.now()) {
  if (choice === 'episode') return { kind: 'episode' };
  const minutes = Number(choice);
  return SLEEP_MINUTES.includes(minutes) ? { kind: 'minutes', minutes, ends: now + minutes * 60_000 } : null;
}
export function sleepSecondsLeft(timer, now = Date.now()) {
  return timer?.kind === 'minutes' ? Math.max(0, (timer.ends - now) / 1000) : null;
}
// 1 while there is time left, then down to 0 across the fade.
export function sleepFade(timer, now = Date.now()) {
  const left = sleepSecondsLeft(timer, now);
  return left == null ? 1 : Math.min(1, Math.max(0, left / SLEEP_FADE_SECONDS));
}
export function sleepLabel(timer, now = Date.now(), endLabel = T('the end of this episode')) {
  if (!timer) return '';
  if (timer.kind === 'episode') return T('Pauses at {0}', endLabel);
  const left = Math.ceil(sleepSecondsLeft(timer, now));
  const m = Math.floor(left / 60), s = left % 60;
  return T('Pauses in {0}:{1}', m, String(s).padStart(2, '0'));
}

// ---- night mode ----
// The film's sound goes through Web Audio: rumble and booming bass are trimmed, the range where
// voices sit is lifted, and a compressor evens out loud and quiet scenes, with a limiter after it
// so nothing clips. A media element can only be captured once, so turning it off routes the
// captured sound straight to the speakers instead. The graph is built on the first switch-on,
// which must come from a click or key press (browsers start an AudioContext only from one).
export const NIGHT = {
  highpass: 70, // Hz
  bass: { frequency: 180, gain: -5 },
  voice: { frequency: 2500, Q: 0.9, gain: 5 },
  compressor: { threshold: -34, knee: 20, ratio: 6, attack: 0.004, release: 0.25 },
  makeup: 1.3,
  limiter: { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.1 },
};

export function createNightAudio(media, AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext) {
  let ctx = null, source = null, input = null, on = false;
  const set = (param, value) => { param.value = value; };
  function build() {
    ctx = new AudioCtx();
    source = ctx.createMediaElementSource(media);
    const filter = (type, frequency, gain, Q) => {
      const f = ctx.createBiquadFilter();
      f.type = type; set(f.frequency, frequency);
      if (gain != null) set(f.gain, gain);
      if (Q != null) set(f.Q, Q);
      return f;
    };
    const compressor = (opts) => {
      const c = ctx.createDynamicsCompressor();
      for (const [k, v] of Object.entries(opts)) set(c[k], v);
      return c;
    };
    const makeup = ctx.createGain();
    set(makeup.gain, NIGHT.makeup);
    const chain = [filter('highpass', NIGHT.highpass), filter('lowshelf', NIGHT.bass.frequency, NIGHT.bass.gain),
      filter('peaking', NIGHT.voice.frequency, NIGHT.voice.gain, NIGHT.voice.Q),
      compressor(NIGHT.compressor), makeup, compressor(NIGHT.limiter)];
    chain.reduce((a, b) => { a.connect(b); return b; }).connect(ctx.destination);
    input = chain[0];
  }
  const resume = () => { if (ctx && ctx.state !== 'running') ctx.resume?.()?.catch?.(() => {}); };
  return {
    supported: typeof AudioCtx === 'function',
    get on() { return on; },
    get captured() { return Boolean(source); },
    resume,
    // Returns whether night mode is now on.
    set(want) {
      want = Boolean(want);
      if (want && !source) {
        if (typeof AudioCtx !== 'function') return false;
        try { build(); } catch { ctx = source = input = null; return false; }
      }
      if (!source) return (on = false);
      source.disconnect();
      source.connect(want ? input : ctx.destination);
      on = want;
      resume();
      return on;
    },
  };
}
