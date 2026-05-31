/* Headless DOM / Canvas2D / AudioContext mock for Node tests.
   Lets the real game scripts boot and run without a browser.
   Exposes counters so tests can assert on per-frame allocations. */

const counts = { linearGrad: 0, radialGrad: 0, createCanvas: 0 };

function makeCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const target = {
    canvas: { width: 960, height: 430 },
    createLinearGradient: () => { counts.linearGrad++; return grad; },
    createRadialGradient: () => { counts.radialGrad++; return grad; },
    setTransform: noop, save: noop, restore: noop, translate: noop, rotate: noop,
    scale: noop, clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, ellipse: noop, closePath: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, rect: noop, clip: noop,
    fill: noop, stroke: noop, fillText: noop, drawImage: noop,
    measureText: () => ({ width: 10 })
  };
  return new Proxy(target, {
    get(t, p) { return p in t ? t[p] : (t[p] = t[p] ?? 0); },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id, _html: "", _text: "", checked: false, value: "",
    width: 960, height: 430, offsetWidth: 0, dataset: {}, style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    getContext: () => makeEl._ctx || (makeEl._ctx = makeCtx()),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, append() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 430 }),
    querySelector() { return el._card || (el._card = makeEl(id + ":card")); },
    querySelectorAll() { return []; },
    // test helper to dispatch an event
    _fire(type) {
      (listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, touches: [{ clientX: 0, clientY: 0 }], clientX: 0, clientY: 0 }));
    }
  };
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(v) { el._html = v; } });
  Object.defineProperty(el, "textContent", { get() { return el._text; }, set(v) { el._text = String(v); } });
  return el;
}

function install() {
  const elCache = {};
  const get = (id) => elCache[id] || (elCache[id] = makeEl(id));

  const body = makeEl("body");

  global.document = {
    readyState: "complete",
    hidden: false,
    body,
    getElementById: get,
    querySelector: (s) => get(s),
    querySelectorAll: () => [],
    createElement: (t) => { if (t === "canvas") counts.createCanvas++; return makeEl(t); },
    addEventListener() {}
  };

  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };

  const param = () => ({ value: 0, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
  global.AudioContext = function () {
    return {
      currentTime: 0, sampleRate: 44100, state: "running", destination: {},
      resume() {}, createGain: () => ({ gain: param(), connect() {} }),
      createOscillator: () => ({ type: "", frequency: param(), connect() {}, start() {}, stop() {} }),
      createBiquadFilter: () => ({ type: "", frequency: param(), connect() {} }),
      createBuffer: () => ({ getChannelData: () => new Float32Array(64) }),
      createBufferSource: () => ({ buffer: null, connect() {}, start() {} })
    };
  };

  let rafcb = null;
  global.requestAnimationFrame = (cb) => { rafcb = cb; return 1; };
  global.performance = { now: () => Date.now() };
  global.matchMedia = () => ({ matches: false });
  global.devicePixelRatio = 1;
  global.PointerEvent = function () {};
  // Node 22 exposes a read-only `navigator` global; override it explicitly.
  Object.defineProperty(global, "navigator", {
    value: { vibrate: () => { global.__vibrateCalls = (global.__vibrateCalls || 0) + 1; return true; }, maxTouchPoints: 0 },
    configurable: true, writable: true
  });

  global.window = global;
  global.window.AudioContext = global.AudioContext;
  global.window.matchMedia = global.matchMedia;
  global.window.PointerEvent = global.PointerEvent;
  global.addEventListener = () => {};

  return {
    get: get,
    counts,
    store,
    stepFrame(t) { const cb = rafcb; rafcb = null; if (cb) cb(t); }
  };
}

module.exports = { install };
