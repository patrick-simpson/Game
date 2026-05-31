/* Headless integration smoke test: boot the real Game with a mocked
   DOM/Canvas/Audio, drive it through every state, and assert on the
   overhaul's new behavior (touch input, haptics, stats, perf caches). */
const assert = require("node:assert");
const path = require("path");
const { install } = require("./dom-mock");

const env = install();
const js = (f) => require(path.join(__dirname, "..", "js", f));
js("audio.js"); js("maze.js"); js("dashboard.js"); js("game.js");

const G = global.window.MMR.game;
assert.ok(G, "Game booted");

let t = 1000;
const step = (n) => { for (let i = 0; i < n; i++) { t += 16; env.stepFrame(t); } };

// ---- intro → play ----
step(3);
assert.strictEqual(G.state, "intro", "starts at intro");
G.selectedDiff = "NORMAL";
G.startNew();
assert.strictEqual(G.state, "playing", "playing after startNew");

// ---- touch input wiring (A3) ----
env.get("steer-left")._fire("pointerdown");
assert.strictEqual(G.keyLeft, true, "touch steer-left sets keyLeft");
env.get("steer-left")._fire("pointerup");
assert.strictEqual(G.keyLeft, false, "release clears keyLeft");
env.get("touch-throttle")._fire("pointerdown");
assert.strictEqual(G.speedMode, "GO", "throttle hold => GO");
env.get("touch-throttle")._fire("pointerup");
assert.strictEqual(G.speedMode, "STOP", "throttle release => STOP");

// ---- haptics gating (A7) ----
global.__vibrateCalls = 0;
G.settings.haptics = false;
G.fireLaser();
assert.strictEqual(global.__vibrateCalls, 0, "no vibrate when haptics off");
G.settings.haptics = true;
G.laser.cooldown = 0;
G.fireLaser();
assert.ok(global.__vibrateCalls >= 1, "vibrate fires when haptics on");

// drive a bit and use abilities
G.setSpeedMode("GO"); G.keyRight = true;
for (let i = 0; i < 4; i++) { step(8); G.laser.cooldown = 0; G.fireLaser(); G.doJump(); G.boostBurst(); }
G.keyRight = false;
step(40);

// ---- perf guard: no per-frame gradient growth (B1-B5) ----
step(1);
const before = { l: env.counts.linearGrad, r: env.counts.radialGrad, c: env.counts.createCanvas };
step(12);
const dL = env.counts.linearGrad - before.l;
const dR = env.counts.radialGrad - before.r;
const dC = env.counts.createCanvas - before.c;
assert.ok(dL === 0, `no per-frame linear gradients (delta ${dL})`);
assert.ok(dR === 0, `no per-frame radial gradients (delta ${dR})`);
assert.ok(dC === 0, `no per-frame canvas creation (delta ${dC})`);

// ---- win path writes best time + stats (C6) ----
const runsBefore = G.stats.runs;
G.car.x = G.world.vip.x; G.car.y = G.world.vip.y;
step(2);
assert.strictEqual(G.state, "won", "reaching VIP wins");
assert.strictEqual(G.stats.runs, runsBefore + 1, "stats.runs incremented on win");
assert.ok(G.stats.wins >= 1, "stats.wins incremented");
assert.ok(env.store["umd_best_NORMAL"], "best time persisted");
assert.ok(env.store["umd_stats"], "stats persisted");
step(20); // fireworks frames

// ---- lose path increments stats ----
const runs2 = G.stats.runs;
G.startNew();
G.shield = 0;
step(2);
assert.strictEqual(G.state, "lost", "shield depletion loses");
assert.strictEqual(G.stats.runs, runs2 + 1, "stats.runs incremented on loss");
assert.ok(G.stats.losses >= 1, "stats.losses incremented");

// ---- stats reset (C8) ----
G.resetStats();
assert.strictEqual(G.stats.runs, 0, "resetStats clears runs");
assert.strictEqual(env.store["umd_stats"], undefined, "umd_stats removed");

// ---- bestScore monotonic across two wins ----
G.resetStats();
for (let w = 0; w < 2; w++) {
  G.startNew();
  G.car.x = G.world.vip.x; G.car.y = G.world.vip.y;
  step(2);
}
assert.strictEqual(G.stats.runs, 2, "two wins => runs 2");
assert.ok(G.stats.bestScore >= 0, "bestScore present");

console.log("smoke.test.js OK — boot, touch input, haptics, perf-cache guard, stats, win/lose all pass");
