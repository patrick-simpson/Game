/* ============================================================
   audio.js — Procedural Web Audio sound engine. No external
   files: every sound is synthesised at runtime. Includes a
   dynamic engine hum that tracks the car's speed and boost.
   (Improvements #1, #2, #20)
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  class SoundEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.muted = false;
      this.ready = false;
      this.engine = null; // {osc, sub, gain, filter}
      this._pingThrottle = 0;
      this._scrapeThrottle = 0;
    }

    // Must be called from a user gesture (browser autoplay policy).
    init() {
      if (this.ready) { this.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // graceful no-audio fallback
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
      this._buildEngine();
      this.ready = true;
    }

    resume() { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 0.6;
    }
    toggleMute() { this.setMuted(!this.muted); return this.muted; }

    // ---- continuous engine hum ----
    _buildEngine() {
      const c = this.ctx;
      const gain = c.createGain();
      gain.gain.value = 0;
      const filter = c.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 600;
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 60;
      const sub = c.createOscillator();
      sub.type = "sine";
      sub.frequency.value = 40;
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      osc.start();
      sub.start();
      this.engine = { osc, sub, gain, filter };
    }

    // mode = STOP|SLOW|GO|FAST, boosting bool
    setEngine(mode, boosting) {
      if (!this.ready) return;
      const map = { STOP: 0, SLOW: 1, GO: 2, FAST: 3 };
      const lvl = map[mode] || 0;
      const e = this.engine;
      const now = this.ctx.currentTime;
      const baseFreq = 50 + lvl * 26 + (boosting ? 40 : 0);
      const vol = lvl === 0 ? 0.0 : 0.05 + lvl * 0.035 + (boosting ? 0.05 : 0);
      const cutoff = 350 + lvl * 350 + (boosting ? 500 : 0);
      e.osc.frequency.setTargetAtTime(baseFreq, now, 0.15);
      e.sub.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.15);
      e.gain.gain.setTargetAtTime(vol, now, 0.2);
      e.filter.frequency.setTargetAtTime(cutoff, now, 0.2);
    }
    silenceEngine() {
      if (this.ready) this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }

    // ---- one-shot helpers ----
    _tone(freq, dur, type, vol, sweepTo) {
      if (!this.ready || this.muted) return;
      const c = this.ctx, now = c.currentTime;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, now);
      if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), now + dur);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(vol, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(g); g.connect(this.master);
      o.start(now); o.stop(now + dur + 0.02);
    }

    _noise(dur, vol, cutoff) {
      if (!this.ready || this.muted) return;
      const c = this.ctx, now = c.currentTime;
      const frames = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, frames, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff || 1200;
      const g = c.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(now);
    }

    // ---- named effects ----
    laser()   { this._tone(900, 0.18, "square", 0.18, 160); this._tone(1400, 0.08, "sawtooth", 0.06, 700); }
    jump()    { this._tone(320, 0.26, "sine", 0.2, 880); }
    land()    { this._noise(0.12, 0.18, 500); this._tone(140, 0.12, "sine", 0.12, 70); }
    crash()   { this._noise(0.3, 0.4, 900); this._tone(110, 0.25, "sawtooth", 0.22, 50); }
    warn()    { this._tone(680, 0.09, "square", 0.14); setTimeout(() => this._tone(680, 0.09, "square", 0.14), 120); }
    pickup()  { this._tone(660, 0.09, "triangle", 0.16); setTimeout(() => this._tone(990, 0.12, "triangle", 0.16), 90); }
    boost()   { this._tone(220, 0.3, "sawtooth", 0.16, 660); }
    // plunging into the void: a long descending howl + rushing air
    fall() {
      this._tone(520, 0.75, "sawtooth", 0.2, 55);
      this._tone(760, 0.75, "sine", 0.12, 70);
      this._noise(0.6, 0.22, 800);
    }
    // grinding along a wall (throttled so holding against a wall doesn't spam)
    scrape() {
      if (this._scrapeThrottle > 0) return;
      this._scrapeThrottle = 9;
      this._noise(0.09, 0.1, 2400);
    }

    ping(intensity) {
      // throttled radar ping — louder/higher as the VIP nears
      if (this._pingThrottle > 0) return;
      this._pingThrottle = Math.max(8, 40 - Math.floor(intensity * 32));
      this._tone(700 + intensity * 600, 0.07, "sine", 0.06 + intensity * 0.1);
    }
    tickPing() {
      if (this._pingThrottle > 0) this._pingThrottle--;
      if (this._scrapeThrottle > 0) this._scrapeThrottle--;
    }

    rescue() {
      const notes = [523, 659, 784, 1047];
      notes.forEach((n, i) => setTimeout(() => this._tone(n, 0.22, "triangle", 0.2), i * 130));
    }
    gameover() {
      const notes = [440, 349, 262, 196];
      notes.forEach((n, i) => setTimeout(() => this._tone(n, 0.3, "sawtooth", 0.18), i * 160));
    }
  }

  M.SoundEngine = SoundEngine;
})(window.MMR);
