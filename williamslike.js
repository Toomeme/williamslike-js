const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = (v, p) => +v.toFixed(p);

/* Global config: the root of the cascade.

   Resolution runs low -> high:
     CONFIG.defaults  ->  data-wl-feel preset  ->  data-wl-tune inline  ->  play() override

   `defaults` are SHAPING toggles — they seed the curve but any feel/tune/override
   downstream can still override them per element (a house can be single-by-default
   and still ship a 'jelly' feel that opts back into spring). The rest are POLICY —
   genuinely engine-wide, no per-element meaning: set once, forget. */
const CONFIG = {
  defaults: { settle: 'single', preserveVolume: true },  // cascade root (overridable)
  timeScale: 1,                                           // master multiplier on every duration
  durationRange: [200, 1200],                             // clamp on what the engine emits (ms)
  reducedMotion: 'nudge',                                 // default calm strategy when the OS asks for less
};

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
  stretch = 0.02, squash = 0.9, settle = 'single',
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
  const cCrit = 2 * Math.sqrt(K * m);   // zeta = 1: the monotonic, no-crossing damping
  const n = 1 + 4.5 * w;           // ramp steepness: 1 (even) -> 5.5 (centered peak)
  const Tr = 0.15 + 0.24 * w;      // ramp length grows mildly, so heavy != frozen
  const tAnt = an > 0 ? 0.10 + 0.12 * an : 0;
  const antDepth = an;

  /* settle governs follow-through vs elasticity. A real spring oscillates and
     decays; an animator's overshoot is a one-way trip — sail past once, ease
     home. We get the animator's version with asymmetric damping: run underdamped
     to earn the sail-past, then critically damp ("lock") the instant the motion
     crests past the target, so it eases back without a second crossing.
       'spring'  -> never lock (the physical spring, elastic wobble)
       'single'  -> lock after the 1st crest (default; follow-through)
        N        -> lock after N crests (room for 'settle: 2' etc. later) */
  const lockAfter =
    settle === 'spring' ? Infinity :
    (settle === 'single' || settle == null) ? 1 :
    Math.max(1, Math.round(+settle) || 1);

  const dt = 1 / 600;
  let x = 0, v = 0, t = 0, settleT = -1;
  let cEff = c, passedTarget = false, extrema = 0, locked = false;
  const pts = [[0, 0, 0]];

  while (t < 6) {
    // Reference position r(t): optional wind-back, then a weight-shaped ramp to 1.
    let r;
    if (t < tAnt) r = -antDepth * rampN(t / tAnt, 2);
    else {
      const u = clamp((t - tAnt) / Tr, 0, 1);
      r = -antDepth + (1 + antDepth) * rampN(u, n);
    }
    const prevV = v;
    const a = (K * (r - x) - cEff * v) / m;
    v += a * dt; x += v * dt; t += dt;
    pts.push([t, x, v]);

    // Lock detection: only after the mass has reached the target, count velocity
    // sign flips (extrema of the oscillation) and switch to critical damping once
    // we've allowed the configured number of them.
    if (!passedTarget && x >= 1) passedTarget = true;
    if (!locked && passedTarget && (prevV > 0) !== (v > 0)) {
      if (++extrema >= lockAfter) { locked = true; cEff = cCrit; }
    }

    if (t > tAnt + Tr * 0.5 && Math.abs(x - 1) < 0.006 && Math.abs(v) < 0.15) { settleT = t; break; }
  }
  if (settleT < 0) settleT = t;

  const posPts = pts.map(([tt, xx]) => [tt / settleT, xx]);
  posPts[posPts.length - 1] = [1, 1];        // rest exactly at 1

  // Squash & stretch falls out of the same run. Stretch scales with normalized speed (so it's duration-independent and peaks where the object is fastest, mid-arc for heavy weight); squash kicks in only where it smashes past 1.
  const deformPts = pts.map(([tt, xx, vv]) => {
    const vn = Math.abs(vv * settleT);       // dimensionless speed
    let d = 1 + vn * stretch;
    if (xx > 1) d -= (xx - 1) * squash;
    return [tt / settleT, clamp(d, 0.5, 1.8)]; // keep 1/d finite and sane
  });
  deformPts[deformPts.length - 1] = [1, 1];  // rest exactly at 1 (no deform at rest)

  return {
    points: simplify(posPts, 0.002),
    deformPoints: simplify(deformPts, 0.002),
    seconds: round(settleT, 3),
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
  // settle defaults to the global shaping default when a raw caller omits it, so
  // "single" is genuinely the default everywhere, not just through the cascade.
  const settle = o.settle ?? CONFIG.defaults.settle;
  // Position curve depends on the physics knobs and settle; the deform curve also depends on stretch/squash, so they all belong in the key.
  const key = `${o.weight}|${o.overshoot}|${o.anticipate}|${o.stretch}|${o.squash}|${settle}`;
  let hit = cache.get(key);
  if (hit) return hit;
  const { points, deformPoints, seconds } = simulate({ ...o, settle });
  const keep = simplify(points, 0.0025);
  const deformKeep = simplify(deformPoints, 0.0025);
  const [dMin, dMax] = CONFIG.durationRange;
  hit = {
    easing: 'linear(' + keep.map(([t, v]) => `${round(v, 4)} ${round(t * 100, 2)}%`).join(', ') + ')',
    duration: clamp(Math.round(seconds * 1000), dMin, dMax),
    points, keep, stops: keep.length,
    deformPoints, deformKeep,
    lut: buildLUT(points),
    deformLut: buildLUT(deformPoints),
  };
  cache.set(key, hit);
  return hit;
}

/* CSS custom-property export: the physics engine, minus the JS.

   defineCSSCurve() runs a curve once and writes it to CSS custom properties, so
   a plain stylesheet can drive momentum through transition/animation shorthands
   with nothing on the frame — the curve is precomputed, so the running animation
   is a pure compositor job.

     defineCSSCurve({ weight: 0.6, overshoot: 0.3 });
     //  :root { --wl-ease: linear(…); --wl-duration: 520ms; }

     .card { transition: transform var(--wl-duration) var(--wl-ease); }
     .card:hover { transform: translateY(-6px); }

   Pass a `name` and the properties namespace cleanly (--wl-jelly-ease,
   --wl-snap-ease …); pass a `target` to scope them to an element instead of
   :root. Returns the computed strings plus revert(), which removes them again.

   `squash` is the same single 0..~0.4 intensity play() uses. It only shapes the
   deform track, never the position curve, so it leaves --*-ease untouched and
   only adds --*-deform (a second easing string) when it's above zero. */

function resolveTarget(target) {
  if (target == null)
    return typeof document !== 'undefined' ? document.documentElement : null;
  if (typeof target === 'string')
    return typeof document !== 'undefined' ? document.querySelector(target) : null;
  return target;                       // assume an Element (anything with .style)
}

const toLinear = (pts) =>
  'linear(' + pts.map(([t, v]) => `${round(v, 4)} ${round(t * 100, 2)}%`).join(', ') + ')';

export function defineCSSCurve(config = {}, {
  name = '',
  target = null,
  prefix = 'wl',
  duration,                            // optional ms override; else the curve's own
} = {}) {
  const ssI = config.squash || 0;
  // accept either the engine key (anticipate) or the authoring alias (anticipation),
  // and forward settle so a feel's shape is identical across all three consumers.
  const c = curve({
    weight: config.weight, overshoot: config.overshoot,
    anticipate: config.anticipate ?? config.anticipation,
    stretch: 0.111 * ssI, squash: 5 * ssI,
    settle: config.settle,
  });

  const ms = duration != null ? Math.round(duration) : c.duration;
  const slug = name ? `${prefix}-${name}` : prefix;   // --wl-ease  vs  --wl-jelly-ease

  const vars = {
    [`--${slug}-ease`]: c.easing,
    [`--${slug}-duration`]: `${ms}ms`,
  };
  const deform = ssI > 0 ? toLinear(c.deformKeep) : null;
  if (deform) vars[`--${slug}-deform`] = deform;

  const el = resolveTarget(target);
  if (!el) throw new Error(`williamslike: defineCSSCurve target not found (${String(target)})`);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);

  return {
    ease: c.easing,
    duration: ms,
    deform,
    vars,
    revert() { for (const k of Object.keys(vars)) el.style.removeProperty(k); },
  };
}

/* Stamp a whole palette of named curves onto one element in a single call —
   the shape the named-curve use case usually wants:

     defineCSSCurves({
       snap:  { weight: 0.08, overshoot: 0.14 },
       jelly: { weight: 0.9,  overshoot: 0.2, squash: 0.3 },
       hero:  { weight: 0.5,  overshoot: 0.3, duration: 600 },
     });
     //  :root { --wl-snap-ease:…; --wl-jelly-ease:…; --wl-jelly-deform:…; --wl-hero-ease:…; … }

   The map is name -> curve definition; each definition is the same physics
   config defineCSSCurve() takes, and may fold in its own `duration` override.
   `target` and `prefix` are shared across the set. Returns the individual
   handles under .curves, the merged .vars, and one revert() for the lot. */

export function defineCSSCurves(curves = {}, { target = null, prefix = 'wl' } = {}) {
  // Resolve once, up front: fail before writing anything, and share the node.
  const el = resolveTarget(target);
  if (!el) throw new Error(`williamslike: defineCSSCurves target not found (${String(target)})`);

  const out = {}, vars = {};
  for (const [name, def] of Object.entries(curves)) {
    const { duration, ...config } = def || {};
    const handle = defineCSSCurve(config, { name, target: el, prefix, duration });
    out[name] = handle;
    Object.assign(vars, handle.vars);
  }

  return {
    curves: out,
    vars,
    revert() { for (const h of Object.values(out)) h.revert(); },
  };
}

/* ============================================================================
   Authoring layer: configure() + feels + the declaration cascade.
   The engine above never changes; everything here is about how a curve gets
   *requested* — from HTML attributes, a feel name, or a JS override.
   ========================================================================= */

/* configure(): set the cascade root and engine-wide policy in one place.
   Shaping defaults and durationRange affect baked curves, so we clear the
   curve cache; timeScale and reducedMotion are applied downstream and don't. */
export function configure(patch = {}) {
  if (patch.defaults) Object.assign(CONFIG.defaults, patch.defaults);
  if (patch.timeScale != null) CONFIG.timeScale = patch.timeScale;
  if (patch.durationRange) CONFIG.durationRange = patch.durationRange;
  if (patch.reducedMotion) CONFIG.reducedMotion = patch.reducedMotion;
  if (patch.defaults || patch.durationRange) cache.clear();
  return { ...CONFIG, defaults: { ...CONFIG.defaults } };
}

/* Public authoring vocabulary -> internal engine keys. The engine keeps its
   original names; only the surface is renamed for clarity, so the two never
   have to move in lockstep. */
const ALIAS = {
  anticipation: 'anticipate',
  'start-scale': 'scale',
  'preserve-volume': 'preserveVolume',
};
const aliasKeys = (obj) => {
  const o = {};
  for (const k in obj) o[ALIAS[k] || k] = obj[k];
  return o;
};

/* Feels: a named physics bundle. ONE registry, three consumers — the HTML
   attribute (data-wl-feel), the JS call (play(el,{feel})), and the CSS export
   (--wl-<name>-ease). Register once, reach it from whichever rung fits. */
const feels = new Map();

export function defineFeel(name, config = {}) {
  const norm = aliasKeys(config);
  feels.set(name, norm);
  return norm;
}
export const getFeel = (name) => (name ? feels.get(name) || null : null);
export const feelNames = () => [...feels.keys()];

// Built-ins (the old demo presets, now first-class). 'jelly' opts back into the
// physical spring via settle — the exact cascade override the design turns on.
defineFeel('snap',  { weight: 0.08, overshoot: 0.14, anticipation: 0,    squash: 0    });
defineFeel('toon',  { weight: 0.35, overshoot: 0.28, anticipation: 0.16, squash: 0.18 });
defineFeel('jelly', { weight: 0.92, overshoot: 0.22, anticipation: 0.04, squash: 0.30, settle: 'spring' });
defineFeel('sober', { weight: 0.40, overshoot: 0,    anticipation: 0,    squash: 0    });

/* Stamp every registered feel (or a named subset) into CSS custom properties in
   one call — the registry's third consumer, realized. */
export function exportFeels(names, opts = {}) {
  const list = names && names.length ? names : feelNames();
  const map = {};
  for (const n of list) if (feels.has(n)) map[n] = feels.get(n);
  return defineCSSCurves(map, opts);
}

/* ---- The declaration mini-language ----
   data-wl-tune and data-wl-stagger both read like inline CSS: "a: 1; b: 2px".
   Values carry their own units so they look like the CSS they resolve into. */

const coerceVal = (type, raw) => {
  switch (type) {
    case 'px':   return parseFloat(raw);                       // "40px" | "40"
    case 'ms':   return /(?:^|\d)s$/.test(raw) && !/ms$/.test(raw)
                        ? parseFloat(raw) * 1000               // "0.5s" -> 500
                        : parseFloat(raw);                     // "500ms" | "500"
    case 'num':  return parseFloat(raw);
    case 'bool': return !/^(off|no|false|0)$/i.test(raw);
    case 'flag': return !/^(off|none|false|0)$/i.test(raw);    // fade: off -> false
    default:     return raw;                                   // 'word': keyword passthrough
  }
};

// authoring property -> { internal key, value type }
const TUNE_PROPS = {
  weight:            { k: 'weight',         t: 'num'  },
  overshoot:         { k: 'overshoot',      t: 'num'  },
  anticipation:      { k: 'anticipate',     t: 'num'  },
  squash:            { k: 'squash',         t: 'num'  },
  distance:          { k: 'distance',       t: 'px'   },
  'start-scale':     { k: 'scale',          t: 'num'  },
  duration:          { k: 'duration',       t: 'ms'   },
  delay:             { k: 'delay',          t: 'ms'   },
  fade:              { k: 'fade',           t: 'flag' },
  reduced:           { k: 'reduced',        t: 'word' },
  settle:            { k: 'settle',         t: 'word' },
  'preserve-volume': { k: 'preserveVolume', t: 'bool' },
};

/* Parse a declaration string against a property schema. Unknown properties are
   ignored (forward-compatible), so a stray `wl-tune="wobble: 3"` is a no-op, not
   a crash. Exported because it's the single source of truth for the syntax. */
export function parseDecl(str, schema = TUNE_PROPS) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    const spec = schema[name];
    if (!spec || !raw) continue;
    out[spec.k] = coerceVal(spec.t, raw);
  }
  return out;
}

/* ---- Choreography (reserved axis) ----
   Its own attribute so secondary-motion / sequence features from the todo have
   room to grow without crowding tune. Today: `each` + `from`. */
const STAGGER_PROPS = {
  each: { k: 'each', t: 'ms'   },
  from: { k: 'from', t: 'word' },
};

// Per-index delay multipliers for a group of n children.
function staggerOrder(n, from = 'start') {
  const idx = Array.from({ length: n }, (_, i) => i);
  switch (from) {
    case 'end':    return idx.map((i) => n - 1 - i);
    case 'center': { const mid = (n - 1) / 2; return idx.map((i) => Math.abs(i - mid)); }
    case 'random': return idx.map(() => Math.random() * Math.max(1, n - 1));
    // 'start' | 'index' | anything reserved -> natural order
    default:       return idx;
  }
}

/* ---- The cascade resolver ----
   CONFIG.defaults -> feel -> tune -> JS override. Each stage overrides only the
   properties it names; everything else falls through untouched. This is the
   whole "properties cascade like CSS" idea, made literal. */
function resolveOptions(el, override = {}) {
  const attr = (name) => (el && el.getAttribute ? el.getAttribute(name) : null);
  const motion = override.motion || attr('data-wl') || 'rise';
  const feel = getFeel(override.feel || attr('data-wl-feel'));
  const tune = parseDecl(attr('data-wl-tune'));

  const base = {
    weight: 0.35, overshoot: 0.2, anticipate: 0,
    distance: 24, scale: undefined, squash: 0,
    duration: null, delay: 0, fade: true, reduced: null,
    settle: CONFIG.defaults.settle,
    preserveVolume: CONFIG.defaults.preserveVolume,
  };

  return { motion, ...base, ...(feel || {}), ...tune, ...override };
}

/* Introspection: return the fully-resolved options an element (plus optional JS
   override) would animate with — the cascade, made visible. */
export const resolve = (el, override = {}) => resolveOptions(el, override);

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

// keepVolume=true compensates the cross axis (scaleY = 1/scaleX) so area is
// conserved — the reason `squash` is one knob. keepVolume=false leaves the cross
// axis at 1: pure elongation along the travel, volume not preserved.
function deformScale(axis, d, keepVolume = true) {
  const cross = keepVolume ? round(1 / d, 4) : 1;
  if (axis === 'x') return `${round(d, 4)},${cross}`;
  return `${cross},${round(d, 4)}`;              // default: stretch along Y
}

function squashFrames(pairFrom, pairTo, c, axis, keepVolume = true) {
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
    s += ` scale(${deformScale(axis, dv, keepVolume)})`;
    frames.push({ offset: p === 1 ? 1 : round(p, 4), transform: s });
  }
  return frames;
}

export function generateSquashAndStretchCSS(options = {}) {
  // Optional: a fully self-contained CSS route for people who want zero runtime JS. It emits its own @property + keyframes. Most callers should just set squash via data-wl-tune (or a feel) and ignore this.
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
  // element override -> motion's own calm strategy -> global policy default
  const mode = o.reduced || motion.calm || CONFIG.reducedMotion;
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
      const cross = tr.keepVolume ? Math.round((1 / d) * 1000) / 1000 : 1;
      const dd = Math.round(d * 1000) / 1000;
      s += tr.axis === 'x' ? ` scale(${dd},${cross})` : ` scale(${cross},${dd})`;
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

function schedule(el, pair, c, duration, delay, fade, axis, keepVolume = true) {
  const prev = owner.get(el);
  if (prev) prev.dead = true;

  const [from, to] = pair || ['none', 'none'];
  const t = compile(from === 'none' ? 'translate3d(0px,0px,0px)' : from,
                    to === 'none' ? 'translate3d(0px,0px,0px)' : to);

  const tr = {
    el, lut: c.lut, deformLut: axis ? c.deformLut : null, axis, keepVolume,
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

/* play()
   Options come from the cascade (CONFIG.defaults -> feel -> tune -> override),
   so play(el) reads the element's attributes and play(el, {...}) layers a JS
   override on top. Same resolution either way. */

const bakedFrames = (t, keep) =>
  keep.map(([time, v]) => {
    let s = t.lits[0];
    for (let j = 0; j < t.from.length; j++) s += round(t.from[j] + t.delta[j] * v, 3) + t.lits[j + 1];
    return { offset: clamp(time, 0, 1), transform: s };
  });

export function play(el, override = {}) {
  let o = resolveOptions(el, override);
  const motion = motions[o.motion] || motions.rise;

  if (prefersReduced()) {
    const authored = o.duration ?? curve({
      weight: o.weight, overshoot: o.overshoot, anticipate: o.anticipate, settle: o.settle,
    }).duration;
    o = calmDown(o, motion, authored);
    if (!o) { el.style.opacity = '1'; el.style.transform = 'none'; return; }
  }

  const pair = o.fadeOnly ? null : motion.shape(o.distance, o.scale);
  // `squash` is a single 0..~0.4 intensity. It drives both the stretch-with-speed and the squash-on-impact so one knob reads as "how deformable is this thing". 0.18 reproduces the tuned defaults (stretch 0.02, impact-squash 0.9).
  const ssI = o.squash || 0;
  const ssAxis = (ssI > 0 && motion.axis && pair) ? motion.axis : null;
  const keepVolume = o.preserveVolume !== false;
  const c = curve({
    weight: o.weight, overshoot: o.overshoot, anticipate: o.anticipate,
    stretch: 0.111 * ssI, squash: 5 * ssI, settle: o.settle,
  });
  // timeScale is a house/debug tempo multiplier applied after the curve — it's
  // allowed to run past durationRange (e.g. 4x slow-mo for inspection).
  const duration = Math.round((o.duration ?? c.duration) * CONFIG.timeScale);

  if (TIER === 3) { schedule(el, pair, c, duration, o.delay, o.fade, ssAxis, keepVolume); return; }

  if (pair) {
    const [from, to] = pair;
    const timing = { duration, delay: o.delay, fill: 'both' };
    let a;
    if (ssAxis) {
      a = el.animate(squashFrames(from, to, c, ssAxis, keepVolume), { ...timing, easing: 'linear' });
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
  const stag = parseDecl(el.getAttribute('data-wl-stagger'), STAGGER_PROPS);
  if (stag.each != null) {
    const kids = [...el.children];
    const order = staggerOrder(kids.length, stag.from);
    kids.forEach((kid, i) => play(kid, { delay: order[i] * stag.each }));
  } else play(el);
}

export function register(root = document) {
  const els = [...root.querySelectorAll('[data-wl], [data-wl-stagger]')];
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      fire(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });

  for (const el of els) {
    const on = el.getAttribute('data-wl-on') || 'enter';
    if (on === 'enter') io.observe(el);
    else if (on === 'load') fire(el);
    else if (on === 'click') el.addEventListener('click', () => play(el));
    else if (on === 'hover') el.addEventListener('pointerenter', () => play(el));
  }
}

mq.addEventListener?.('change', () => cache.clear());

export default {
  curve, simulate, play, register, motions,
  prefersReduced, calmDuration, CALM_DISTANCE, generateSquashAndStretchCSS,
  defineCSSCurve, defineCSSCurves,
  configure, defineFeel, getFeel, feelNames, exportFeels, parseDecl, resolve,
  get TIER() { return TIER; }, forceTier,
};