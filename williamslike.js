/**
 * williamslike.js
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = (v, p) => +v.toFixed(p);

/**
 * Global configuration.
 * Acts as the root of the settings cascade. Resolution follows a low-to-high order:
 * CONFIG.defaults -> data-wl-feel preset -> data-wl-tune inline -> play() override.
 * 
 * `defaults` represent shaping parameters that seed the curve calculation.
 * The remaining properties are engine-wide policies applied universally.
 */
const CONFIG = {
  defaults: { settle: 'single', preserveVolume: true },
  timeScale: 1,               // Master multiplier applied to all calculated durations
  durationRange: [200, 1200], // Minimum and maximum allowed engine duration (in milliseconds)
  reducedMotion: 'nudge',     // Strategy to apply when prefers-reduced-motion is enabled
};

// Constant stiffness for the underlying physics model
const K = 600;

/**
 * Generalized smoothstep function.
 * @param {number} u - Normalized input [0, 1]
 * @param {number} n - Steepness factor. n=1 is linear. n>1 concentrates change near the midpoint.
 * @returns {number} Interpolated value
 */
function rampN(u, n) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const a = Math.pow(u, n), b = Math.pow(1 - u, n);
  return a / (a + b);
}

/**
 * Simulates a spring-damper system to generate position and deformation curves.
 * 
 * @param {Object} config - Physics parameters
 * @param {number} config.weight - Inertia factor. Higher weight starts/stops slower but moves faster mid-arc.
 * @param {number} config.overshoot - Damping ratio control. Higher values cause larger bounds past the target.
 * @param {number} config.anticipate - Wind-back amount before the primary motion begins.
 * @param {number} config.stretch - Stretch multiplier scaling with normalized speed.
 * @param {number} config.squash - Deformation amount applied when the position exceeds the target.
 * @param {string|number} config.settle - Oscillation limit. 'spring' allows infinite oscillation, 'single' locks after one crest.
 * @returns {Object} Precalculated points, deformation points, and total duration in seconds.
 */
export function simulate({
  weight = 0.35, overshoot = 0.2, anticipate = 0,
  stretch = 0.02, squash = 0.9, settle = 'single',
} = {}) {
  const w = clamp(weight, 0, 1), ov = clamp(overshoot, 0, 1), an = clamp(anticipate, 0, 0.6);

  // Calculate standard damping ratio (zeta) based on overshoot and anticipation limits.
  const rel = ov / (1 + an);
  let zeta;
  if (rel < 0.002) {
    zeta = 1;
  } else { 
    const L = Math.log(rel); 
    zeta = -L / Math.sqrt(Math.PI * Math.PI + L * L); 
  }
  zeta = clamp(zeta, 0.12, 1.2);

  const m = 1.0 + 0.6 * w;
  const c = 2 * zeta * Math.sqrt(K * m);
  const cCrit = 2 * Math.sqrt(K * m);
  const n = 1 + 4.5 * w;
  const Tr = 0.15 + 0.24 * w;
  const tAnt = an > 0 ? 0.10 + 0.12 * an : 0;
  const antDepth = an;

  // Determine lock-after threshold for asymmetric damping.
  // Physical springs oscillate natively ('spring'). Animator transitions typically cross 
  // the target once and settle critically damped ('single').
  const lockAfter =
    settle === 'spring' ? Infinity :
    (settle === 'single' || settle == null) ? 1 :
    Math.max(1, Math.round(+settle) || 1);

  const dt = 1 / 600;
  let x = 0, v = 0, t = 0, settleT = -1;
  let cEff = c, passedTarget = false, extrema = 0, locked = false;
  const pts = [[0, 0, 0]];

  while (t < 6) {
    let r;
    if (t < tAnt) {
      r = -antDepth * rampN(t / tAnt, 2);
    } else {
      const u = clamp((t - tAnt) / Tr, 0, 1);
      r = -antDepth + (1 + antDepth) * rampN(u, n);
    }
    const prevV = v;
    const a = (K * (r - x) - cEff * v) / m;
    v += a * dt; 
    x += v * dt; 
    t += dt;
    pts.push([t, x, v]);

    if (!passedTarget && x >= 1) passedTarget = true;
    
    // Switch to critical damping upon reaching the specified extrema count.
    if (!locked && passedTarget && (prevV > 0) !== (v > 0)) {
      if (++extrema >= lockAfter) { 
        locked = true; 
        cEff = cCrit; 
      }
    }

    // Check rest condition: minimal distance from target and near-zero velocity.
    if (t > tAnt + Tr * 0.5 && Math.abs(x - 1) < 0.006 && Math.abs(v) < 0.15) { 
      settleT = t; 
      break; 
    }
  }
  if (settleT < 0) settleT = t;

  const posPts = pts.map(([tt, xx]) => [tt / settleT, xx]);
  posPts[posPts.length - 1] = [1, 1];

  // Calculate deformation track. Stretch scales with speed. Squash applies past target boundary.
  const deformPts = pts.map(([tt, xx, vv]) => {
    const vn = Math.abs(vv * settleT);
    let d = 1 + vn * stretch;
    if (xx > 1) d -= (xx - 1) * squash;
    return [tt / settleT, clamp(d, 0.5, 1.8)];
  });
  deformPts[deformPts.length - 1] = [1, 1];

  return {
    points: simplify(posPts, 0.002),
    deformPoints: simplify(deformPts, 0.002),
    seconds: round(settleT, 3),
  };
}

/**
 * Douglas-Peucker line simplification.
 * Reduces the coordinate count for smaller CSS payload generation.
 * 
 * @param {Array} p - Array of coordinate pairs [x, y]
 * @param {number} eps - Perpendicular distance threshold
 * @returns {Array} Simplified array of coordinate pairs
 */
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
  
  if (max > eps) {
    return simplify(p.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(p.slice(idx), eps));
  }
  return [p[0], p[p.length - 1]];
}

const LUT_N = 256;

/**
 * Resamples an arbitrary curve into a uniform Float32Array length of 256.
 * Provides O(1) runtime progression lookups with linear interpolation.
 * 
 * @param {Array} points - Source coordinate pairs
 * @returns {Float32Array} Uniformly sampled curve values
 */
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

/**
 * High-level curve generation and caching layer.
 * 
 * @param {Object} o - Animation parameters
 * @returns {Object} Computed curve structure containing strings, duration, arrays, and LUTs
 */
export function curve(o = {}) {
  const settle = o.settle ?? CONFIG.defaults.settle;
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

/**
 * Resolves a target node from varying input types.
 * 
 * @param {string|Element|null} target - A CSS selector, an Element, or null.
 * @returns {Element|null} The resolved DOM element.
 */
function resolveTarget(target) {
  if (target == null)
    return typeof document !== 'undefined' ? document.documentElement : null;
  if (typeof target === 'string')
    return typeof document !== 'undefined' ? document.querySelector(target) : null;
  return target;
}

const toLinear = (pts) =>
  'linear(' + pts.map(([t, v]) => `${round(v, 4)} ${round(t * 100, 2)}%`).join(', ') + ')';

/**
 * Computes a curve and applies it to CSS custom properties on a specified target.
 * Enables compositor-driven motion via standard stylesheet definitions.
 * 
 * @param {Object} config - Physics settings 
 * @param {Object} options - CSS generation settings (name, target, prefix, explicit duration)
 * @returns {Object} Handle containing the easing string, duration, generated variables, and a revert method
 */
export function defineCSSCurve(config = {}, {
  name = '',
  target = null,
  prefix = 'wl',
  duration,
} = {}) {
  const ssI = config.squash || 0;
  const c = curve({
    weight: config.weight, overshoot: config.overshoot,
    anticipate: config.anticipate ?? config.anticipation,
    stretch: 0.111 * ssI, squash: 5 * ssI,
    settle: config.settle,
  });

  const ms = duration != null ? Math.round(duration) : c.duration;
  const slug = name ? `${prefix}-${name}` : prefix;

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

/**
 * Applies a collection of named curves to an element in a single batch operation.
 * 
 * @param {Object} curves - Map of curve names to configuration objects
 * @param {Object} options - Options containing target element and prefix
 * @returns {Object} Handle containing child curves, merged variables, and a batch revert method
 */
export function defineCSSCurves(curves = {}, { target = null, prefix = 'wl' } = {}) {
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

/**
 * Updates the global configuration root. 
 * Modifying `defaults` or `durationRange` invalidates the calculation cache.
 * 
 * @param {Object} patch - Partial configuration object
 * @returns {Object} A copy of the updated global configuration
 */
export function configure(patch = {}) {
  if (patch.defaults) Object.assign(CONFIG.defaults, patch.defaults);
  if (patch.timeScale != null) CONFIG.timeScale = patch.timeScale;
  if (patch.durationRange) CONFIG.durationRange = patch.durationRange;
  if (patch.reducedMotion) CONFIG.reducedMotion = patch.reducedMotion;
  
  if (patch.defaults || patch.durationRange) cache.clear();
  return { ...CONFIG, defaults: { ...CONFIG.defaults } };
}

// Maps author-facing configuration aliases to internal engine keys.
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

const feels = new Map();

/**
 * Registers a named configuration preset (a "feel").
 * 
 * @param {string} name - Identifier for the preset
 * @param {Object} config - Physics configuration
 * @returns {Object} Normalized preset mapping
 */
export function defineFeel(name, config = {}) {
  const norm = aliasKeys(config);
  feels.set(name, norm);
  return norm;
}
export const getFeel = (name) => (name ? feels.get(name) || null : null);
export const feelNames = () => [...feels.keys()];

// Standard built-in presets
defineFeel('snap',  { weight: 0.08, overshoot: 0.14, anticipation: 0,    squash: 0    });
defineFeel('toon',  { weight: 0.35, overshoot: 0.28, anticipation: 0.16, squash: 0.18 });
defineFeel('jelly', { weight: 0.92, overshoot: 0.22, anticipation: 0.04, squash: 0.30, settle: 'spring' });
defineFeel('sober', { weight: 0.40, overshoot: 0,    anticipation: 0,    squash: 0    });

/**
 * Batch exports the provided predefined feels to CSS custom properties.
 * 
 * @param {string[]} names - Array of feel identifiers to export. Defaults to all if omitted.
 * @param {Object} opts - Additional options passed to defineCSSCurves
 * @returns {Object} Batch definition handle
 */
export function exportFeels(names, opts = {}) {
  const list = names && names.length ? names : feelNames();
  const map = {};
  for (const n of list) if (feels.has(n)) map[n] = feels.get(n);
  return defineCSSCurves(map, opts);
}

/**
 * Value coercion layer for custom element-level attribute overrides.
 */
const coerceVal = (type, raw) => {
  switch (type) {
    case 'px':   return parseFloat(raw);
    case 'ms':   return /(?:^|\d)s$/.test(raw) && !/ms$/.test(raw)
                        ? parseFloat(raw) * 1000
                        : parseFloat(raw);
    case 'num':  return parseFloat(raw);
    case 'bool': return !/^(off|no|false|0)$/i.test(raw);
    case 'flag': return !/^(off|none|false|0)$/i.test(raw);
    default:     return raw;
  }
};

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

/**
 * Parses a CSS-like string syntax into a structured configuration object.
 * Unknown property definitions are ignored for forward compatibility.
 * 
 * @param {string} str - Declaration string (e.g., "weight: 0.5; distance: 40px")
 * @param {Object} schema - Validation rules identifying expected keys and variable types
 * @returns {Object} Parsed configuration dictionary
 */
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

const STAGGER_PROPS = {
  each: { k: 'each', t: 'ms'   },
  from: { k: 'from', t: 'word' },
};

/**
 * Computes multiplier indices for child element staggering.
 * 
 * @param {number} n - Total number of elements
 * @param {string} from - Stagger origin algorithm (start, end, center, random)
 * @returns {number[]} Array of computed iteration indices
 */
function staggerOrder(n, from = 'start') {
  const idx = Array.from({ length: n }, (_, i) => i);
  switch (from) {
    case 'end':    return idx.map((i) => n - 1 - i);
    case 'center': { const mid = (n - 1) / 2; return idx.map((i) => Math.abs(i - mid)); }
    case 'random': return idx.map(() => Math.random() * Math.max(1, n - 1));
    default:       return idx;
  }
}

/**
 * Merges configuration parameters across the application cascade.
 * Execution order applies values recursively: defaults -> preset -> inline tuning -> explicit js override.
 * 
 * @param {Element} el - Target DOM node
 * @param {Object} override - Imperative JS config provided at execution time
 * @returns {Object} Fully resolved configuration object
 */
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

export const resolve = (el, override = {}) => resolveOptions(el, override);

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

const NUM = /-?\d*\.?\d+/g;
const tmplCache = new Map();

/**
 * Pre-compiles start/end transform states into string literals and numerical delta components.
 * Bypasses string evaluation limits during high-frequency loop executions.
 * 
 * @param {string} from - Initial transform string
 * @param {string} to - Final transform string
 * @returns {Object} Template components optimized for tight loop concatenation
 */
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
    f.push(a); 
    d.push(b - a);
    last = off + m.length; 
    i++;
    return m;
  });
  lits.push(from.slice(last));

  hit = { lits, from: Float32Array.from(f), delta: Float32Array.from(d) };
  tmplCache.set(key, hit);
  return hit;
}

const SS_SAMPLES = 20;

/**
 * Computes deformation coordinate components, accommodating volume preservation configuration.
 */
function deformScale(axis, d, keepVolume = true) {
  const cross = keepVolume ? round(1 / d, 4) : 1;
  if (axis === 'x') return `${round(d, 4)},${cross}`;
  return `${cross},${round(d, 4)}`;
}

/**
 * Generates an array of normalized offset keyframes integrating positional curve definitions 
 * with squash and stretch behavior into composite frames.
 */
function squashFrames(pairFrom, pairTo, c, axis, keepVolume = true) {
  const t = compile(pairFrom, pairTo);
  const { lut, deformLut } = c;
  const frames = [];
  
  for (let i = 0; i < SS_SAMPLES; i++) {
    const p = i / (SS_SAMPLES - 1);
    const li = p * (LUT_N - 1);
    let i0 = li | 0; 
    if (i0 > LUT_N - 2) i0 = LUT_N - 2;
    
    const frac = li - i0;
    const pv = lut[i0] + (lut[i0 + 1] - lut[i0]) * frac;
    const dv = deformLut[i0] + (deformLut[i0 + 1] - deformLut[i0]) * frac;

    let s = t.lits[0];
    for (let j = 0; j < t.from.length; j++) {
      s += round(t.from[j] + t.delta[j] * pv, 3) + t.lits[j + 1];
    }
    s += ` scale(${deformScale(axis, dv, keepVolume)})`;
    frames.push({ offset: p === 1 ? 1 : round(p, 4), transform: s });
  }
  return frames;
}

/**
 * Alternative export structure enabling standalone CSS definition with zero runtime JS execution.
 * Outputs generic keyframes relying solely on standard browser composition pipelines.
 */
export function generateSquashAndStretchCSS(options = {}) {
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

const mq = typeof matchMedia !== 'undefined'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false, addEventListener() {} };

export const prefersReduced = () => mq.matches;

export const calmDuration = (d) => clamp(Math.round(5.2 * Math.pow(d, 0.63)), 120, 500);

/**
 * Calculates modified configuration values representing degraded functionality under 
 * strict reduced-motion constraint scenarios.
 */
function calmDown(o, motion, authored) {
  const mode = o.reduced || motion.calm || CONFIG.reducedMotion;
  if (mode === 'keep') return o;
  if (mode === 'off') return null;

  const base = {
    ...o,
    overshoot: 0,
    anticipate: 0,
    weight: Math.min(o.weight, 0.25),
    squash: 0,
    duration: calmDuration(authored),
  };

  if (mode === 'nudge') {
    const mag = Math.min(Math.abs(o.distance) * 0.15, CALM_DISTANCE);
    return { ...base, distance: Math.sign(o.distance || 1) * mag, scale: 1 };
  }
  if (mode === 'settle') return { ...base, distance: 0, scale: 1 - (1 - (o.scale ?? 0.78)) * 0.09 };
  return { ...base, fadeOnly: true };
}

/* Rendering tier detection and implementation */

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

/**
 * Rendering fallback architecture:
 * Tier 1: WAAPI using native CSS linear() easing strings
 * Tier 2: WAAPI fallback executing against explicit keyframe offsets
 * Tier 3: RequestAnimationFrame custom update loop implementation
 */
export let TIER = !hasWAAPI ? 3 : hasLinear ? 1 : 2;
export const forceTier = (t) => { TIER = t; };

export const tracks = [];
const owner = new Map();
let raf = 0;

/**
 * Master execution loop servicing the Tier 3 animation path.
 * Minimizes overhead by processing uniform interpolation checks across active tracked objects.
 */
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

/**
 * Enqueues a new item onto the Tier 3 interpolation loop.
 */
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

const bakedFrames = (t, keep) =>
  keep.map(([time, v]) => {
    let s = t.lits[0];
    for (let j = 0; j < t.from.length; j++) s += round(t.from[j] + t.delta[j] * v, 3) + t.lits[j + 1];
    return { offset: clamp(time, 0, 1), transform: s };
  });

/**
 * Initializes and dispatches an animation sequence against a target node.
 * Evaluates the required cascade priority and determines execution via the underlying WAAPI tiers 
 * or internal simulation queue.
 * 
 * @param {Element} el - Output DOM element
 * @param {Object} override - Imperative JS config values applied above data-attribute declarations
 */
export function play(el, override = {}) {
  let o = resolveOptions(el, override);
  const motion = motions[o.motion] || motions.rise;

  if (prefersReduced()) {
    const authored = o.duration ?? curve({
      weight: o.weight, overshoot: o.overshoot, anticipate: o.anticipate, settle: o.settle,
    }).duration;
    o = calmDown(o, motion, authored);
    if (!o) { 
      el.style.opacity = '1'; 
      el.style.transform = 'none'; 
      return; 
    }
  }

  const pair = o.fadeOnly ? null : motion.shape(o.distance, o.scale);
  const ssI = o.squash || 0;
  const ssAxis = (ssI > 0 && motion.axis && pair) ? motion.axis : null;
  const keepVolume = o.preserveVolume !== false;
  
  const c = curve({
    weight: o.weight, overshoot: o.overshoot, anticipate: o.anticipate,
    stretch: 0.111 * ssI, squash: 5 * ssI, settle: o.settle,
  });
  
  const duration = Math.round((o.duration ?? c.duration) * CONFIG.timeScale);

  if (TIER === 3) { 
    schedule(el, pair, c, duration, o.delay, o.fade, ssAxis, keepVolume); 
    return; 
  }

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

let io = null;

function fire(el) {
  const stag = parseDecl(el.getAttribute('data-wl-stagger'), STAGGER_PROPS);
  if (stag.each != null) {
    const kids = [...el.children];
    const order = staggerOrder(kids.length, stag.from);
    kids.forEach((kid, i) => play(kid, { delay: order[i] * stag.each }));
  } else {
    play(el);
  }
}

/**
 * Recursively locates components matching trigger criteria within a root DOM subtree,
 * establishing internal observers and interaction event bindings.
 * 
 * @param {Document|Element} root - Search origin point
 */
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