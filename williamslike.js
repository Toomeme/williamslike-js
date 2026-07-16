const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = (v, p) => +v.toFixed(p);

/*Curve engine: shared by all three tiers */

const K = 600;

export function simulate({ weight = 0.35, overshoot = 0.2, anticipate = 0 } = {}) {
  const w = clamp(weight, 0, 1), ov = clamp(overshoot, 0, 1), an = clamp(anticipate, 0, 0.6);
  const m = 0.8 + 2.2 * w;
  const rel = ov / (1 + an);

  let zeta;
  if (rel < 0.002) zeta = 1;
  else { const L = Math.log(rel); zeta = -L / Math.sqrt(Math.PI * Math.PI + L * L); }
  zeta = clamp(zeta * (1 - 0.28 * w), 0.08, 1.2);

  const c = 2 * zeta * Math.sqrt(K * m);
  const period = 2 * Math.PI * Math.sqrt(m / K);
  const tAnt = an > 0 ? period * (0.22 + 0.3 * an) : 0;
  const lag = 0.18 * w * period;

  const dt = 1 / 600;
  let x = 0, v = 0, f = 0, t = 0, settle = -1;
  const pts = [[0, 0]];
  while (t < 6) {
    const target = t < tAnt ? -an : 1;
    f += lag > 0 ? (target - f) * Math.min(1, dt / lag) : target - f;
    const a = (K * (f - x) - c * v) / m;
    v += a * dt; x += v * dt; t += dt;
    pts.push([t, x]);
    if (t > tAnt && Math.abs(x - 1) < 0.006 && Math.abs(v) < 0.15) { settle = t; break; }
  }
  if (settle < 0) settle = t;
  const norm = pts.map(([tt, xx]) => [tt / settle, xx]);
  norm[norm.length - 1] = [1, 1];
  return { points: norm, seconds: settle };
}

function simplify(p, eps) {
  if (p.length < 3) return p;
  const [ax, ay] = p[0], [bx, by] = p[p.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  let idx = 0, max = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i];
    const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max > eps) return simplify(p.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(p.slice(idx), eps));
  return [p[0], p[p.length - 1]];
}

/* Resample the curve at uniform progress into a Float32Array. Then a frame lookup is an index and a lerp — no search, no binary search, no segment pointer to advance, no allocation. O(1) regardless of how many stops the curve has. It is keyed by progress, not time, so ONE table is shared by every element using those parameters, at any duration or delay. 256 floats = 1 KB per unique curve. */
const LUT_N = 256;

function buildLUT(points) {
  const out = new Float32Array(LUT_N);
  let j = 0;                                     // monotone pointer: O(N + M) total
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    while (j < points.length - 2 && points[j + 1][0] < t) j++;
    const [t0, v0] = points[j], [t1, v1] = points[j + 1];
    out[i] = v0 + (v1 - v0) * (t1 > t0 ? (t - t0) / (t1 - t0) : 0);
  }
  out[LUT_N - 1] = 1;
  return out;
}

const cache = new Map();

export function curve(o = {}) {
  const key = `${o.weight}|${o.overshoot}|${o.anticipate}`;
  let hit = cache.get(key);
  if (hit) return hit;
  const { points, seconds } = simulate(o);
  const keep = simplify(points, 0.0025);
  hit = {
    easing: 'linear(' + keep.map(([t, v]) => `${round(v, 4)} ${round(t * 100, 2)}%`).join(', ') + ')',
    duration: clamp(Math.round(seconds * 1000), 200, 1200),
    points, keep, stops: keep.length,
    lut: buildLUT(points),
  };
  cache.set(key, hit);
  return hit;
}

/* Motions */

export const CALM_DISTANCE = 4;

export const motions = {
  rise:          { calm: 'nudge',  shape: (d) => [`translate3d(0px,${d}px,0px)`, 'translate3d(0px,0px,0px)'] },
  fall:          { calm: 'nudge',  shape: (d) => [`translate3d(0px,${-d}px,0px)`, 'translate3d(0px,0px,0px)'] },
  'slide-left':  { calm: 'nudge',  shape: (d) => [`translate3d(${d}px,0px,0px)`, 'translate3d(0px,0px,0px)'] },
  'slide-right': { calm: 'nudge',  shape: (d) => [`translate3d(${-d}px,0px,0px)`, 'translate3d(0px,0px,0px)'] },
  pop:           { calm: 'settle', shape: (d, s) => [`scale(${clamp(s ?? 0.78, 0.05, 0.99)})`, 'scale(1)'] },
  drop:          { calm: 'nudge',  shape: (d, s) => [`translate3d(0px,${-d}px,0px) scale(${s ?? 1.08})`, 'translate3d(0px,0px,0px) scale(1)'] },
  swing:         { calm: 'fade',   shape: (d) => [`rotate(${d * 0.5}deg)`, 'rotate(0deg)'] },
  fade:          { calm: 'fade',   shape: () => null },
};

/* Compile a transform pair into literals + numbers, once. Per frame this becomes: literal + number + literal + number … No regex, no parsing, no template-literal evaluation in the hot loop. */
const NUM = /-?\d*\.?\d+/g;
const tmplCache = new Map();

function compile(from, to) {
  const key = from + '\u0000' + to;
  let hit = tmplCache.get(key);
  if (hit) return hit;

  const toNums = (to.match(NUM) || []).map(Number);
  const lits = [], f = [], d = [];
  let last = 0, i = 0;
  from.replace(NUM, (m, off) => {
    lits.push(from.slice(last, off));
    const a = parseFloat(m), b = toNums[i] ?? a;
    f.push(a); d.push(b - a);
    last = off + m.length; i++;
    return m;
  });
  lits.push(from.slice(last));

  hit = { lits, from: Float32Array.from(f), delta: Float32Array.from(d) };
  tmplCache.set(key, hit);
  return hit;
}

/* Reduced motion is a degradation, not a switch */

const mq = typeof matchMedia !== 'undefined'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false, addEventListener() {} };

export const prefersReduced = () => mq.matches;

/* Compress the authored duration rather than replacing it, so a deliberately slow 900ms hero still reads as slower than a 300ms button. A power law (p < 1) keeps the ordering while narrowing the spread: 200ms -> 147   300ms -> 189   600ms -> 293   900ms -> 379   1200ms -> 455 A flat cap would have flattened all four to the same number and thrown away the one thing `weight` still contributes once the curve is damped. */
export const calmDuration = (d) => clamp(Math.round(5.2 * Math.pow(d, 0.63)), 120, 500);

function calmDown(o, motion, authored) {
  const mode = o.reduced || motion.calm;
  if (mode === 'keep') return o;
  if (mode === 'off') return null;

  const base = {
    ...o,
    overshoot: 0,                      // oscillation — the primary trigger
    anticipate: 0,                     // reversal of direction
    weight: Math.min(o.weight, 0.25),  // no long drifting settle
    duration: calmDuration(authored),
  };

  if (mode === 'nudge') {
    // A ceiling, not a flattening: small moves shrink proportionally,
    // large ones cap. A 200px slide and a 24px rise shouldn't be identical.
    const mag = Math.min(Math.abs(o.distance) * 0.15, CALM_DISTANCE);
    return { ...base, distance: Math.sign(o.distance || 1) * mag, scale: 1 };
  }
  if (mode === 'settle') {
    return { ...base, distance: 0, scale: 1 - (1 - (o.scale ?? 0.78)) * 0.09 };
  }
  return { ...base, fadeOnly: true };
}

/* Tier detection */

const probe = typeof document !== 'undefined' ? document.createElement('div') : null;
const hasWAAPI = !!probe && typeof probe.animate === 'function';
let hasLinear = false;
if (hasWAAPI) {
  try {
    probe.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 1, easing: 'linear(0 0%, -0.1 20%, 1.2 60%, 1 100%)' }).cancel();
    hasLinear = true;
  } catch { hasLinear = false; }
}

export let TIER = !hasWAAPI ? 3 : hasLinear ? 1 : 2;
export const forceTier = (t) => { TIER = t; };   // for testing

/* Tier 3 — one rAF loop for the whole page
Everything expensive is hoisted out of the frame:
- the curve: shared Float32Array LUT, O(1) lookup
- the transform: precompiled literals + Float32Array numbers
- the track list: compacted in place; no splice, no allocation
 The loop allocates nothing per frame except the transform strings it must produce, and it never reads layout, so it never forces a reflow.*/

export const tracks = [];
const owner = new Map();   // element -> track, so a replay supersedes cleanly
let raf = 0;

function tick(now) {
  raf = 0;
  let live = 0;

  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    if (tr.dead) continue;

    const e = now - tr.start;
    if (e < 0) { tracks[live++] = tr; continue; }        // still in delay: from-state holds

    let p = e / tr.dur;
    let done = false;
    if (p >= 1) { p = 1; done = true; }

    // O(1) curve lookup. No search. The LUT is uniform in progress.
    const f = p * (LUT_N - 1);
    let i0 = f | 0;
    if (i0 > LUT_N - 2) i0 = LUT_N - 2;
    const lut = tr.lut;
    const a = lut[i0];
    const v = a + (lut[i0 + 1] - a) * (f - i0);         // eased value; may exceed [0,1]

    // Rebuild the transform from precompiled parts.
    const lits = tr.lits, from = tr.from, delta = tr.delta;
    let s = lits[0];
    for (let j = 0; j < from.length; j++) {
      s += Math.round((from[j] + delta[j] * v) * 100) / 100 + lits[j + 1];
    }
    tr.el.style.transform = s;

    if (tr.fade) {
      if (p >= tr.fadeAt) tr.el.style.opacity = '1';
      else {
        const q = 1 - p / tr.fadeAt;
        tr.el.style.opacity = String(Math.round((1 - q * q * q) * 1000) / 1000);
      }
    }

    if (done) {
      tr.el.style.willChange = '';
      owner.delete(tr.el);
    } else {
      tracks[live++] = tr;
    }
  }

  tracks.length = live;
  if (live) raf = requestAnimationFrame(tick);
}

function schedule(el, pair, c, duration, delay, fade) {
  const prev = owner.get(el);
  if (prev) prev.dead = true;

  const [from, to] = pair || ['none', 'none'];
  const t = compile(from === 'none' ? 'translate3d(0px,0px,0px)' : from,
                    to === 'none' ? 'translate3d(0px,0px,0px)' : to);

  const tr = {
    el, lut: c.lut,
    lits: t.lits, from: t.from, delta: t.delta,
    start: performance.now() + delay,
    dur: duration,
    fade,
    fadeAt: Math.min(1, 380 / duration),   // fade completes early, then holds
    dead: false,
  };

  // Only tier 3 needs a manual layer hint. WAAPI promotes on its own, and
  // a redundant will-change just burns compositor memory.
  el.style.willChange = 'transform, opacity';
  el.style.transform = from === 'none' ? '' : from;
  if (fade) el.style.opacity = '0';

  owner.set(el, tr);
  tracks.push(tr);
  if (!raf) raf = requestAnimationFrame(tick);
}

/* play() */

function readOpts(el) {
  const d = el.dataset;
  const num = (k, f) => (d[k] != null ? parseFloat(d[k]) : f);
  return {
    motion: d.anim || 'rise',
    weight: num('animWeight', 0.35),
    overshoot: num('animOvershoot', 0.2),
    anticipate: num('animAnticipate', 0),
    distance: num('animDistance', 24),
    scale: d.animScale != null ? parseFloat(d.animScale) : undefined,
    duration: d.animDuration != null ? parseFloat(d.animDuration) : null,
    delay: num('animDelay', 0),
    fade: d.animFade !== 'off',
    reduced: d.animReduced || null,
  };
}

const bakedFrames = (t, keep) =>
  keep.map(([time, v]) => {
    let s = t.lits[0];
    for (let j = 0; j < t.from.length; j++) {
      s += round(t.from[j] + t.delta[j] * v, 3) + t.lits[j + 1];
    }
    return { offset: clamp(time, 0, 1), transform: s };
  });

export function play(el, override = {}) {
  let o = { ...readOpts(el), ...override };
  const motion = motions[o.motion] || motions.rise;

  if (prefersReduced()) {
    // Resolve the authored duration before flattening the curve, so weight
    // still shapes how long the calm version runs.
    const authored = o.duration ?? curve(o).duration;
    o = calmDown(o, motion, authored);
    if (!o) { el.style.opacity = '1'; el.style.transform = 'none'; return; }
  }

  const pair = o.fadeOnly ? null : motion.shape(o.distance, o.scale);
  const c = curve(o);
  const duration = o.duration ?? c.duration;

  if (TIER === 3) { schedule(el, pair, c, duration, o.delay, o.fade); return; }

  if (pair) {
    const [from, to] = pair;
    const timing = { duration, delay: o.delay, fill: 'both' };
    const a = TIER === 1
      ? el.animate([{ transform: from }, { transform: to }], { ...timing, easing: c.easing })
      : el.animate(bakedFrames(compile(from, to), c.keep), { ...timing, easing: 'linear' });
    a.finished.then(() => { a.commitStyles(); a.cancel(); }).catch(() => {});
  }
  if (o.fade) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: Math.min(duration, 380), delay: o.delay, fill: 'both',
      easing: 'cubic-bezier(.2,0,.2,1)',
    });
  }
}

/* Triggers
Nothing here ever hides content via CSS. The from-state exists only
inside the animation, so a blocked script, a thrown error or a
suppressed animation still leaves the page readable.*/

let io = null;

function fire(el) {
  const stagger = parseFloat(el.dataset.animStagger || 0);
  if (stagger) [...el.children].forEach((kid, i) => play(kid, { delay: i * stagger }));
  else play(el);
}

export function register(root = document) {
  const els = [...root.querySelectorAll('[data-anim], [data-anim-stagger]')];
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      fire(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });

  for (const el of els) {
    const trig = el.dataset.animTrigger || 'enter';
    if (trig === 'enter') io.observe(el);
    else if (trig === 'load') fire(el);
    else if (trig === 'click') el.addEventListener('click', () => play(el));
    else if (trig === 'hover') el.addEventListener('pointerenter', () => play(el));
  }
}

mq.addEventListener?.('change', () => cache.clear());

export default {
  curve, simulate, play, register, motions,
  prefersReduced, calmDuration, CALM_DISTANCE,
  get TIER() { return TIER; }, forceTier,
};