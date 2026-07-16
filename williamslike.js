const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = (v, p) => +v.toFixed(p);

/* Curve engine: shared by all three tiers.

overshoot: damping ratio (bounce past the target)
anticipate: a wind-back before the move
weight: inertia. A heavy thing is slow to start and slow to stop, but hauls fast through the middle of its arc. */

const K = 600;

// Generalized smoothstep. n=1 is linear; n>1 concentrates change in the middle with near-zero slope at both ends.
function rampN(u, n) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const a = Math.pow(u, n), b = Math.pow(1 - u, n);
  return a / (a + b);
}

export function simulate({
  weight = 0.35, overshoot = 0.2, anticipate = 0,
  stretch = 0.02, squash = 0.9,
} = {}) {
  const w = clamp(weight, 0, 1), ov = clamp(overshoot, 0, 1), an = clamp(anticipate, 0, 0.6);

  // overshoot = damping ratio. Low ov => near-critical, clean landing.
  const rel = ov / (1 + an);
  let zeta;
  if (rel < 0.002) zeta = 1;
  else { const L = Math.log(rel); zeta = -L / Math.sqrt(Math.PI * Math.PI + L * L); }
  zeta = clamp(zeta, 0.12, 1.2);

  // Weight barely touches mass, just enough momentum to carry the middle. It mainly steepens the reference ramp and lengthens it a little.
  const m = 1.0 + 0.6 * w;
  const c = 2 * zeta * Math.sqrt(K * m);
  const n = 1 + 4.5 * w;           // ramp steepness: 1 (even) -> 5.5 (centered peak)
  const Tr = 0.15 + 0.24 * w;      // ramp length grows mildly, so heavy != frozen
  const tAnt = an > 0 ? 0.10 + 0.12 * an : 0;
  const antDepth = an;

  const dt = 1 / 600;
  let x = 0, v = 0, t = 0, settle = -1;
  const pts = [[0, 0, 0]];

  while (t < 6) {
    // Reference position r(t): optional wind-back, then a weight-shaped ramp to 1.
    let r;
    if (t < tAnt) r = -antDepth * rampN(t / tAnt, 2);
    else {
      const u = clamp((t - tAnt) / Tr, 0, 1);
      r = -antDepth + (1 + antDepth) * rampN(u, n);
    }
    const a = (K * (r - x) - c * v) / m;
    v += a * dt; x += v * dt; t += dt;
    pts.push([t, x, v]);

    if (t > tAnt + Tr * 0.5 && Math.abs(x - 1) < 0.006 && Math.abs(v) < 0.15) { settle = t; break; }
  }
  if (settle < 0) settle = t;

  const posPts = pts.map(([tt, xx]) => [tt / settle, xx]);
  posPts[posPts.length - 1] = [1, 1];        // rest exactly at 1

  // Squash & stretch falls out of the same run. Stretch scales with normalized speed (so it's duration-independent and peaks where the object is fastest, mid-arc for heavy weight); squash kicks in only where it smashes past 1.
  const deformPts = pts.map(([tt, xx, vv]) => {
    const vn = Math.abs(vv * settle);        // dimensionless speed
    let d = 1 + vn * stretch;
    if (xx > 1) d -= (xx - 1) * squash;
    return [tt / settle, clamp(d, 0.5, 1.8)]; // keep 1/d finite and sane
  });
  deformPts[deformPts.length - 1] = [1, 1];  // rest exactly at 1 (no deform at rest)

  return {
    points: simplify(posPts, 0.002),
    deformPoints: simplify(deformPts, 0.002),
    seconds: round(settle, 3),
  };
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
  let j = 0;
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    while (j < points.length - 2 && points[j + 1][0] < t) j++;
    const [t0, v0] = points[j], [t1, v1] = points[j + 1];
    out[i] = v0 + (v1 - v0) * (t1 > t0 ? (t - t0) / (t1 - t0) : 0);
  }
  out[LUT_N - 1] = points[points.length - 1][1];
  return out;
}

const cache = new Map();

export function curve(o = {}) {
  // Position curve depends only on the three physics knobs; the deform curve also depends on stretch/squash, so they belong in the key too.
  const key = `${o.weight}|${o.overshoot}|${o.anticipate}|${o.stretch}|${o.squash}`;
  let hit = cache.get(key);
  if (hit) return hit;
  const { points, deformPoints, seconds } = simulate(o);
  const keep = simplify(points, 0.0025);
  const deformKeep = simplify(deformPoints, 0.0025);
  hit = {
    easing: 'linear(' + keep.map(([t, v]) => `${round(v, 4)} ${round(t * 100, 2)}%`).join(', ') + ')',
    duration: clamp(Math.round(seconds * 1000), 200, 1200),
    points, keep, stops: keep.length,
    deformPoints, deformKeep,
    lut: buildLUT(points),
    deformLut: buildLUT(deformPoints),
  };
  cache.set(key, hit);
  return hit;
}

/* Motions
`axis` names the travel direction so squash & stretch can stretch ALONG it
and squash across it (volume-preserving). Motions with no linear travel
('pop','swing','fade') carry axis:null and simply ignore squash. */

export const CALM_DISTANCE = 4;

export const motions = {
  rise:          { calm: 'nudge',  axis: 'y', shape: (d) => [`translate3d(0px,${d}px,0px)`, 'translate3d(0px,0px,0px)'] },
  fall:          { calm: 'nudge',  axis: 'y', shape: (d) => [`translate3d(0px,${-d}px,0px)`, 'translate3d(0px,0px,0px)'] },
  'slide-left':  { calm: 'nudge',  axis: 'x', shape: (d) => [`translate3d(${d}px,0px,0px)`, 'translate3d(0px,0px,0px)'] },
  'slide-right': { calm: 'nudge',  axis: 'x', shape: (d) => [`translate3d(${-d}px,0px,0px)`, 'translate3d(0px,0px,0px)'] },
  pop:           { calm: 'settle', axis: null, shape: (d, s) => [`scale(${clamp(s ?? 0.78, 0.05, 0.99)})`, 'scale(1)'] },
  drop:          { calm: 'nudge',  axis: 'y', shape: (d, s) => [`translate3d(0px,${-d}px,0px) scale(${s ?? 1.08})`, 'translate3d(0px,0px,0px) scale(1)'] },
  swing:         { calm: 'fade',   axis: null, shape: (d) => [`rotate(${d * 0.5}deg)`, 'rotate(0deg)'] },
  fade:          { calm: 'fade',   axis: null, shape: () => null },
};

/* Compile a transform pair into literals + numbers, once. Per frame this becomes literal + number + literal + number ... no regex, no parsing, no template evaluation in the hot loop. */
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

/* Squash & stretch

The deform curve is different from the position curve, so it can't ride a single easing string. Instead we bake: sample both curves at uniform progress, precompute scaleY = 1/scaleX per sample (volume preserved at bake time, so no runtime calc()/@property), and emit combined transform keyframes. A transform keyframe animation with linear timing still runs on the compositor, so this stays off the main thread in tiers 1 and 2. */

const SS_SAMPLES = 20;

function deformScale(axis, d) {
  if (axis === 'x') return `${round(d, 4)},${round(1 / d, 4)}`;
  return `${round(1 / d, 4)},${round(d, 4)}`;   // default: stretch along Y
}

function squashFrames(pairFrom, pairTo, c, axis) {
  const t = compile(pairFrom, pairTo);
  const { lut, deformLut } = c;
  const frames = [];
  for (let i = 0; i < SS_SAMPLES; i++) {
    const p = i / (SS_SAMPLES - 1);
    const li = p * (LUT_N - 1);
    let i0 = li | 0; if (i0 > LUT_N - 2) i0 = LUT_N - 2;
    const frac = li - i0;
    const pv = lut[i0] + (lut[i0 + 1] - lut[i0]) * frac;
    const dv = deformLut[i0] + (deformLut[i0 + 1] - deformLut[i0]) * frac;

    let s = t.lits[0];
    for (let j = 0; j < t.from.length; j++) s += round(t.from[j] + t.delta[j] * pv, 3) + t.lits[j + 1];
    s += ` scale(${deformScale(axis, dv)})`;
    frames.push({ offset: p === 1 ? 1 : round(p, 4), transform: s });
  }
  return frames;
}

export function generateSquashAndStretchCSS(options = {}) {
  // Optional: a fully self-contained CSS route for people who want zero runtime JS. It emits its own @property + keyframes. Most callers should just use data-anim-squash and ignore this.
  const { points, deformPoints, seconds } = simulate(options);
  const axis = options.axis === 'x' ? 'x' : 'y';
  const toLinear = (pts) => `linear(${pts.map(([t, v]) => `${round(v, 3)} ${round(t * 100, 1)}%`).join(', ')})`;
  const travel = options.distance ?? 300;
  const along = axis === 'x' ? 'X' : 'Y', cross = axis === 'x' ? 'Y' : 'X';
  return {
    duration: `${seconds}s`,
    positionEasing: toLinear(points),
    deformEasing: toLinear(deformPoints),
    css:
`@property --kx { syntax:"<number>"; inherits:false; initial-value:0; }
@property --kd { syntax:"<number>"; inherits:false; initial-value:1; }
@keyframes k-move { from { --kx:0 } to { --kx:1 } }
@keyframes k-deform { from { --kd:1 } to { --kd:1 } }
.k-squash {
  transform: translate${along}(calc(var(--kx) * ${travel}px))
             scale${along}(var(--kd)) scale${cross}(calc(1 / var(--kd)));
  animation: k-move ${seconds}s ${toLinear(points)} both,
             k-deform ${seconds}s ${toLinear(deformPoints)} both;
}`,
  };
}

/* Reduced motion is a degradation, not a switch */

const mq = typeof matchMedia !== 'undefined'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false, addEventListener() {} };

export const prefersReduced = () => mq.matches;

export const calmDuration = (d) => clamp(Math.round(5.2 * Math.pow(d, 0.63)), 120, 500);

function calmDown(o, motion, authored) {
  const mode = o.reduced || motion.calm;
  if (mode === 'keep') return o;
  if (mode === 'off') return null;

  const base = {
    ...o,
    overshoot: 0,
    anticipate: 0,
    weight: Math.min(o.weight, 0.25),
    squash: 0,                          // deformation is displacement
    duration: calmDuration(authored),
  };

  if (mode === 'nudge') {
    const mag = Math.min(Math.abs(o.distance) * 0.15, CALM_DISTANCE);
    return { ...base, distance: Math.sign(o.distance || 1) * mag, scale: 1 };
  }
  if (mode === 'settle') return { ...base, distance: 0, scale: 1 - (1 - (o.scale ?? 0.78)) * 0.09 };
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
export const forceTier = (t) => { TIER = t; };

/* Tier 3: one rAF loop for the whole page. Carries an optional deform LUT so squash & stretch works here too (no WAAPI at all). */

export const tracks = [];
const owner = new Map();
let raf = 0;

function tick(now) {
  raf = 0;
  let live = 0;

  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    if (tr.dead) continue;

    const e = now - tr.start;
    if (e < 0) { tracks[live++] = tr; continue; }

    let p = e / tr.dur;
    let done = false;
    if (p >= 1) { p = 1; done = true; }

    const f = p * (LUT_N - 1);
    let i0 = f | 0;
    if (i0 > LUT_N - 2) i0 = LUT_N - 2;
    const frac = f - i0;
    const lut = tr.lut;
    const v = lut[i0] + (lut[i0 + 1] - lut[i0]) * frac;

    const lits = tr.lits, from = tr.from, delta = tr.delta;
    let s = lits[0];
    for (let j = 0; j < from.length; j++) {
      s += Math.round((from[j] + delta[j] * v) * 100) / 100 + lits[j + 1];
    }

    if (tr.deformLut) {
      const dl = tr.deformLut;
      const d = dl[i0] + (dl[i0 + 1] - dl[i0]) * frac;
      const inv = Math.round((1 / d) * 1000) / 1000, dd = Math.round(d * 1000) / 1000;
      s += tr.axis === 'x' ? ` scale(${dd},${inv})` : ` scale(${inv},${dd})`;
    }
    tr.el.style.transform = s;

    if (tr.fade) {
      if (p >= tr.fadeAt) tr.el.style.opacity = '1';
      else { const q = 1 - p / tr.fadeAt; tr.el.style.opacity = String(Math.round((1 - q * q * q) * 1000) / 1000); }
    }

    if (done) { tr.el.style.willChange = ''; owner.delete(tr.el); }
    else tracks[live++] = tr;
  }

  tracks.length = live;
  if (live) raf = requestAnimationFrame(tick);
}

function schedule(el, pair, c, duration, delay, fade, axis) {
  const prev = owner.get(el);
  if (prev) prev.dead = true;

  const [from, to] = pair || ['none', 'none'];
  const t = compile(from === 'none' ? 'translate3d(0px,0px,0px)' : from,
                    to === 'none' ? 'translate3d(0px,0px,0px)' : to);

  const tr = {
    el, lut: c.lut, deformLut: axis ? c.deformLut : null, axis,
    lits: t.lits, from: t.from, delta: t.delta,
    start: performance.now() + delay,
    dur: duration, fade,
    fadeAt: Math.min(1, 380 / duration),
    dead: false,
  };

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
    squash: num('animSquash', 0),          // 0 = off. >0 enables squash & stretch.
    duration: d.animDuration != null ? parseFloat(d.animDuration) : null,
    delay: num('animDelay', 0),
    fade: d.animFade !== 'off',
    reduced: d.animReduced || null,
  };
}

const bakedFrames = (t, keep) =>
  keep.map(([time, v]) => {
    let s = t.lits[0];
    for (let j = 0; j < t.from.length; j++) s += round(t.from[j] + t.delta[j] * v, 3) + t.lits[j + 1];
    return { offset: clamp(time, 0, 1), transform: s };
  });

export function play(el, override = {}) {
  let o = { ...readOpts(el), ...override };
  const motion = motions[o.motion] || motions.rise;

  if (prefersReduced()) {
    const authored = o.duration ?? curve({ weight: o.weight, overshoot: o.overshoot, anticipate: o.anticipate }).duration;
    o = calmDown(o, motion, authored);
    if (!o) { el.style.opacity = '1'; el.style.transform = 'none'; return; }
  }

  const pair = o.fadeOnly ? null : motion.shape(o.distance, o.scale);
  // `squash` is a single 0..~0.4 intensity. It drives both the stretch-with-speed and the squash-on-impact so one knob reads as "how deformable is this thing". 0.18 reproduces the tuned defaults (stretch 0.02, impact-squash 0.9).
  const ssI = o.squash || 0;
  const ssAxis = (ssI > 0 && motion.axis && pair) ? motion.axis : null;
  const c = curve({
    weight: o.weight, overshoot: o.overshoot, anticipate: o.anticipate,
    stretch: 0.111 * ssI, squash: 5 * ssI,
  });
  const duration = o.duration ?? c.duration;

  if (TIER === 3) { schedule(el, pair, c, duration, o.delay, o.fade, ssAxis); return; }

  if (pair) {
    const [from, to] = pair;
    const timing = { duration, delay: o.delay, fill: 'both' };
    let a;
    if (ssAxis) {
      a = el.animate(squashFrames(from, to, c, ssAxis), { ...timing, easing: 'linear' });
    } else if (TIER === 1) {
      a = el.animate([{ transform: from }, { transform: to }], { ...timing, easing: c.easing });
    } else {
      a = el.animate(bakedFrames(compile(from, to), c.keep), { ...timing, easing: 'linear' });
    }
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
   Nothing here ever hides content via CSS. The from-state exists only inside the animation, so a blocked script, a thrown error or a suppressed animation still leaves the page readable. */

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
  prefersReduced, calmDuration, CALM_DISTANCE, generateSquashAndStretchCSS,
  get TIER() { return TIER; }, forceTier,
};