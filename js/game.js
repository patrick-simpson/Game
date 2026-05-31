/* ============================================================
   game.js — Main loop, state, physics, rendering, and all the
   high-quality systems: boost, pickups, beacon, particles,
   camera look-ahead, scoring, pause, settings, audio hooks.
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  const CFG = M.CONFIG;
  const U = M.U;

  class Game {
    constructor() {
      this.canvas = document.getElementById("view");
      this.ctx = this.canvas.getContext("2d");
      this.confetti = document.getElementById("confetti");
      this.cctx = this.confetti.getContext("2d");
      this.overlay = document.getElementById("overlay");
      this.pauseOverlay = document.getElementById("pause-overlay");
      this.frame = document.getElementById("windshield-frame");
      this.beacon = document.getElementById("vip-beacon");
      this.damageFlash = document.getElementById("damage-flash");
      this.helpStrip = document.getElementById("help-strip");

      this.touch = document.getElementById("touch-controls");

      this.audio = new M.SoundEngine();
      this.dashboard = new M.Dashboard(this);

      // settings (persisted)
      this.settings = this._loadSettings();
      this.audio.setMuted(this.settings.muted);

      // lifetime stats (persisted)
      this.stats = this._loadStats();

      this.dpr = 1;
      this.vw = 960; this.vh = 430;

      // cached gradients / sprites (built in _resize / lazily) — see plan B1-B4
      this._bgGrad = null; this._vignetteGrad = null;
      this._wallTile = null; this._floorTile = null;
      this._creatureSprite = null; this._driverSprite = null;

      this.world = null;
      this.car = { x: 0, y: 0, angle: -Math.PI / 2 };
      this.steer = 0; this.steerHeld = false;
      this.keyLeft = false; this.keyRight = false; this.keyBoost = false; this.keyReverse = false;

      this.speedMode = "STOP";
      this.shield = CFG.SHIELD_MAX;
      this.pedestrianHits = 0;
      this.kills = 0; this.cells = 0;
      this.score = 0; this.finalScore = 0;
      this.elapsedMs = 0;

      this.selectedDiff = "EASY"; // Fix #14: default to the gentle preset
      this.state = "intro";

      this.hitCooldown = 0;
      this.regenTimer = 0;
      this.jump = { active: false, timer: 0, cooldown: 0 };
      this.laser = { cooldown: 0, beam: null };
      this.boost = { meter: 100, max: 100, active: false, burst: 0 };
      this.explosions = [];
      this.exhaust = [];
      this.fireworks = [];
      this.shake = 0;
      this.camY = 0.62;
      this.leadX = 0; this.leadY = 0;
      this.viewCx = 480; this.viewCy = 215;
      this.flashLevel = 0;
      this.explored = new Set();

      // keep intro card to restore on "quit to menu"
      this.introCardHTML = this.overlay.querySelector(".overlay-card").innerHTML;

      this._applySettingsToUI();
      this._applyA11yClasses();
      this._bindKeys();
      this._bindUI();
      this._bindTouchControls();
      this._wireIntro();
      this._resize();
      window.addEventListener("resize", () => this._resize());
      // B7: auto-pause + silence engine when the tab is hidden
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          this.audio.silenceEngine();
          if (this.state === "playing") this.togglePause();
        }
      });
      this._showBest();
      this._renderIntroStats();

      this.lastTime = performance.now();
      this._acc = 0; // fixed-timestep accumulator (B8)
      requestAnimationFrame((t) => this._loop(t));
    }

    // ---------------- persistence / settings ----------------
    _loadSettings() {
      // Fix #1: stable north-up camera by default (rotateView off)
      let s = {
        shake: true, reducedMotion: false, muted: false, rotateView: false,
        haptics: true, highContrast: false, bigText: false
      };
      try {
        const raw = localStorage.getItem("umd_settings");
        if (raw) s = Object.assign(s, JSON.parse(raw));
      } catch (e) { /* ignore */ }
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        if (localStorage.getItem("umd_settings") === null) s.reducedMotion = true;
      }
      return s;
    }
    _saveSettings() {
      try { localStorage.setItem("umd_settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
    }

    // ---------------- lifetime stats (C6) ----------------
    _loadStats() {
      let s = {
        runs: 0, wins: 0, losses: 0, bestScore: 0,
        totalKills: 0, totalCells: 0, totalPedHits: 0, totalTimeMs: 0,
        byDiff: { EASY: 0, NORMAL: 0, HARD: 0 }
      };
      try {
        const raw = localStorage.getItem("umd_stats");
        if (raw) {
          const parsed = JSON.parse(raw);
          s = Object.assign(s, parsed);
          s.byDiff = Object.assign({ EASY: 0, NORMAL: 0, HARD: 0 }, parsed.byDiff || {});
        }
      } catch (e) { /* ignore */ }
      return s;
    }
    _saveStats() {
      try { localStorage.setItem("umd_stats", JSON.stringify(this.stats)); } catch (e) { /* ignore */ }
    }
    resetStats() {
      try { localStorage.removeItem("umd_stats"); } catch (e) { /* ignore */ }
      this.stats = this._loadStats();
      this._renderIntroStats();
    }

    // Apply accessibility theme classes to <body> (C3, C4)
    _applyA11yClasses() {
      const b = document.body;
      if (!b) return;
      b.classList.toggle("high-contrast", !!this.settings.highContrast);
      b.classList.toggle("big-text", !!this.settings.bigText);
    }

    // C7/C10: inject lifetime stats into the intro card (which is restored
    // from captured HTML, so values must be set dynamically).
    _renderIntroStats() {
      const el = document.getElementById("intro-stats");
      if (!el) return;
      const s = this.stats;
      el.innerHTML =
        `<span>RUNS <b>${s.runs}</b></span>` +
        `<span>RESCUES <b>${s.wins}</b></span>` +
        `<span>BEST SCORE <b>${s.bestScore}</b></span>`;
    }

    // A7: haptic feedback, gated by setting + device support
    _haptic(pattern) {
      if (this.settings.haptics && navigator.vibrate) {
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
      }
    }
    _applySettingsToUI() {
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
      set("opt-shake", this.settings.shake);
      set("opt-motion", this.settings.reducedMotion);
      set("opt-mute", this.settings.muted);
      set("opt-rotate", this.settings.rotateView);
      set("opt-haptics", this.settings.haptics);
      set("opt-contrast", this.settings.highContrast);
      set("opt-bigtext", this.settings.bigText);
      this._updateMuteIcon();
    }
    _bestKey() { return "umd_best_" + this.selectedDiff; }
    _showBest() {
      const el = document.getElementById("best-time");
      if (!el) return;
      const v = localStorage.getItem(this._bestKey());
      el.textContent = v ? this.dashboard._fmtTime(Number(v)) : "--";
    }

    // ---------------- responsive / high-DPI (Improvement #7) ----------------
    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      this.dpr = dpr;
      this.vw = rect.width; this.vh = rect.height;
      for (const cv of [this.canvas, this.confetti]) {
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
      }
      this._buildViewGradients();
      this._speedLines = null; // reseed against new dimensions (B5)
    }

    // B1/B2: cache the backdrop + vignette gradients (rebuilt only on resize)
    _buildViewGradients() {
      const ctx = this.ctx, W = this.vw, H = this.vh;
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0a1830"); bg.addColorStop(1, "#040810");
      this._bgGrad = bg;
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.9);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.55)");
      this._vignetteGrad = vg;
    }

    // B2: pre-render one wall + floor tile to offscreen canvases (once)
    _buildTiles() {
      const T = CFG.TILE;
      // wall tile with faux-3D bevel
      const wc = document.createElement("canvas");
      wc.width = T; wc.height = T;
      const w = wc.getContext("2d");
      const g = w.createLinearGradient(0, 0, 0, T);
      g.addColorStop(0, "#1b3a6b"); g.addColorStop(1, "#0e2348");
      w.fillStyle = g; w.fillRect(0, 0, T, T);
      // top/left highlight, bottom/right shadow → reads as raised
      w.strokeStyle = "rgba(120,200,255,0.35)"; w.lineWidth = 2;
      w.beginPath(); w.moveTo(1, T - 1); w.lineTo(1, 1); w.lineTo(T - 1, 1); w.stroke();
      w.strokeStyle = "rgba(0,0,0,0.45)";
      w.beginPath(); w.moveTo(T - 1, 1); w.lineTo(T - 1, T - 1); w.lineTo(1, T - 1); w.stroke();
      w.strokeStyle = "rgba(47,243,255,0.5)"; w.lineWidth = 2;
      w.strokeRect(1, 1, T - 2, T - 2);
      w.strokeStyle = "rgba(120,200,255,0.18)"; w.lineWidth = 1;
      w.strokeRect(5, 5, T - 10, T - 10);
      this._wallTile = wc;

      // floor tile
      const fc = document.createElement("canvas");
      fc.width = T; fc.height = T;
      const f = fc.getContext("2d");
      f.fillStyle = "#0c1626"; f.fillRect(0, 0, T, T);
      f.strokeStyle = "rgba(47,243,255,0.06)"; f.lineWidth = 1;
      f.strokeRect(0.5, 0.5, T - 1, T - 1);
      this._floorTile = fc;
    }

    // B4: pre-render creature + driver sprites (glow baked in), drawn rotated
    _buildSprites() {
      // creature: spiky magenta blob
      const cc = document.createElement("canvas"); cc.width = 40; cc.height = 40;
      const c = cc.getContext("2d"); c.translate(20, 20);
      c.fillStyle = "#ff2bd6"; c.shadowColor = "#ff2bd6"; c.shadowBlur = 10;
      c.beginPath();
      const spikes = 7, R = 13, r = 7;
      for (let i = 0; i < spikes * 2; i++) {
        const rad = i % 2 === 0 ? R : r, a = (i / (spikes * 2)) * Math.PI * 2;
        const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
        i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
      }
      c.closePath(); c.fill(); c.shadowBlur = 0;
      c.fillStyle = "#0a0010";
      c.beginPath(); c.arc(-3, -1, 2, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(3, -1, 2, 0, Math.PI * 2); c.fill();
      this._creatureSprite = cc;

      // driver: rogue red car (points "up", local -y)
      const dc = document.createElement("canvas"); dc.width = 40; dc.height = 44;
      const d = dc.getContext("2d"); d.translate(20, 22);
      d.fillStyle = "#ff3b53"; d.strokeStyle = "#ffd6dc"; d.lineWidth = 1.5;
      this._roundRect(d, -10, -15, 20, 30, 5); d.fill(); d.stroke();
      d.fillStyle = "#2a0008"; this._roundRect(d, -7, -10, 14, 9, 3); d.fill();
      d.fillStyle = "#ffd966"; d.beginPath();
      d.arc(-6, -14, 2, 0, Math.PI * 2); d.arc(6, -14, 2, 0, Math.PI * 2); d.fill();
      this._driverSprite = dc;
    }

    // ---------------- lifecycle ----------------
    startNew() {
      this.audio.init();
      this.world = new M.World(this.selectedDiff);
      const s = this.world.tileCenter(this.world.start.gx, this.world.start.gy);
      this.car.x = s.x; this.car.y = s.y; this.car.angle = -Math.PI / 2;
      this.steer = 0; this.speedMode = "STOP";
      this.shield = CFG.SHIELD_MAX;
      this.pedestrianHits = 0; this.kills = 0; this.cells = 0;
      this.score = 0; this.finalScore = 0; this.elapsedMs = 0;
      this.hitCooldown = 0;
      this.jump = { active: false, timer: 0, cooldown: 0 };
      this.laser = { cooldown: 0, beam: null };
      this.boost = { meter: 100, max: 100, active: false, burst: 0 };
      this.explosions = []; this.exhaust = []; this.fireworks = [];
      this.shake = 0; this.camY = 0.62; this.flashLevel = 0;
      this.leadX = 0; this.leadY = 0;
      this.hitCooldown = CFG.START_GRACE; // Fix #13: spawn protection
      this.regenTimer = 0;
      this.keyReverse = false; this.keyBoost = false;
      this.explored = new Set();
      this.state = "playing";
      this.dashboard.setActiveSpeed("STOP");
      this._hideOverlay();
      this.pauseOverlay.classList.remove("show");
      this._showToast("Press GO (or ↑) to drive — reach the VIP!");
      this._resize();
    }

    // Fix #19: brief onboarding / status toast
    _showToast(msg) {
      const t = document.getElementById("toast");
      if (!t) return;
      t.textContent = msg;
      t.classList.add("show");
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
    }

    _hideOverlay() { this.overlay.classList.remove("overlay-show"); this._clearConfetti(); }
    _showOverlay() { this.overlay.classList.add("overlay-show"); }

    quitToMenu() {
      this.state = "intro";
      this.world = null;
      this.audio.silenceEngine();
      this.pauseOverlay.classList.remove("show");
      const card = this.overlay.querySelector(".overlay-card");
      card.innerHTML = this.introCardHTML;
      this._wireIntro();
      this._showBest();
      this._renderIntroStats();
      this._showOverlay();
    }

    togglePause() {
      if (this.state === "playing") {
        this.state = "paused";
        this.audio.silenceEngine();
        this.pauseOverlay.classList.add("show");
      } else if (this.state === "paused") {
        this.state = "playing";
        this.pauseOverlay.classList.remove("show");
      }
    }

    // ---------------- input ----------------
    _bindKeys() {
      window.addEventListener("keydown", (e) => {
        switch (e.key) {
          case "ArrowLeft": this.keyLeft = true; e.preventDefault(); break;
          case "ArrowRight": this.keyRight = true; e.preventDefault(); break;
          case "ArrowUp": this._shiftSpeed(1); e.preventDefault(); break;
          case "ArrowDown": this._shiftSpeed(-1); e.preventDefault(); break;
          case " ": case "Spacebar": this.fireLaser(); e.preventDefault(); break;
          case "j": case "J": case "Shift": this.doJump(); break;
          case "b": case "B": this.keyBoost = true; break;
          case "r": case "R": this.keyReverse = true; break; // Fix #6: reverse
          case "g": case "G": this.setSpeedMode("GO"); break;
          case "s": case "S": this.setSpeedMode("STOP"); break;
          case "f": case "F": this.setSpeedMode("FAST"); break;
          case "p": case "P": case "Escape": if (this.state === "playing" || this.state === "paused") this.togglePause(); break;
          case "m": case "M": this._toggleMute(); break;
          case "h": case "H": this._toggleHelp(); break;
          case "Enter":
            if (this.state === "won" || this.state === "lost" || this.state === "intro") this.startNew();
            break;
        }
      });
      window.addEventListener("keyup", (e) => {
        if (e.key === "ArrowLeft") this.keyLeft = false;
        if (e.key === "ArrowRight") this.keyRight = false;
        if (e.key === "b" || e.key === "B") this.keyBoost = false;
        if (e.key === "r" || e.key === "R") this.keyReverse = false;
      });
    }

    _bindUI() {
      document.getElementById("mute-btn").addEventListener("click", () => this._toggleMute());
      document.getElementById("pause-btn").addEventListener("click", () => this.togglePause());
      document.getElementById("help-btn").addEventListener("click", () => this._toggleHelp());
      document.getElementById("resume-btn").addEventListener("click", () => this.togglePause());
      document.getElementById("quit-btn").addEventListener("click", () => this.quitToMenu());

      const bind = (id, key, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          this.settings[key] = el.checked;
          if (key === "muted") { this.audio.setMuted(el.checked); this._updateMuteIcon(); }
          if (onChange) onChange();
          this._saveSettings();
        });
      };
      bind("opt-shake", "shake");
      bind("opt-motion", "reducedMotion");
      bind("opt-mute", "muted");
      bind("opt-rotate", "rotateView");
      bind("opt-haptics", "haptics");
      bind("opt-contrast", "highContrast", () => this._applyA11yClasses());
      bind("opt-bigtext", "bigText", () => this._applyA11yClasses());

      // Stats panel (C8)
      const statsBtn = document.getElementById("stats-btn");
      if (statsBtn) statsBtn.addEventListener("click", () => this.showStats());
      const statsClose = document.getElementById("stats-close");
      if (statsClose) statsClose.addEventListener("click", () => this.hideStats());
      const statsReset = document.getElementById("stats-reset");
      if (statsReset) statsReset.addEventListener("click", () => { this.resetStats(); this.showStats(); });

      // Fix #6: reverse button (press-and-hold) via the shared touch helper
      this._touchPress(document.getElementById("reverse-btn"),
        () => { this.keyReverse = true; }, () => { this.keyReverse = false; });
    }

    // ---------------- touch controls (A1-A3) ----------------
    // Pointer Events helper: `on` fires on press, `off` on release/cancel.
    _touchPress(el, on, off) {
      if (!el) return;
      const down = (e) => { on(); e.preventDefault(); };
      const up = () => off();
      if (window.PointerEvent) {
        el.addEventListener("pointerdown", down);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        el.addEventListener("pointerleave", up);
      } else {
        el.addEventListener("mousedown", down);
        el.addEventListener("touchstart", down, { passive: false });
        window.addEventListener("mouseup", up);
        window.addEventListener("touchend", up);
      }
    }
    _touchTap(el, fn) {
      if (!el) return;
      const h = (e) => { fn(); e.preventDefault(); };
      if (window.PointerEvent) el.addEventListener("pointerdown", h);
      else { el.addEventListener("mousedown", h); el.addEventListener("touchstart", h, { passive: false }); }
    }

    _bindTouchControls() {
      this.isTouch = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
        || ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
      if (document.body) document.body.classList.toggle("touch", !!this.isTouch);

      this._touchPress(document.getElementById("steer-left"),
        () => { this.keyLeft = true; }, () => { this.keyLeft = false; });
      this._touchPress(document.getElementById("steer-right"),
        () => { this.keyRight = true; }, () => { this.keyRight = false; });
      this._touchPress(document.getElementById("touch-reverse"),
        () => { this.keyReverse = true; }, () => { this.keyReverse = false; });
      this._touchPress(document.getElementById("touch-boost"),
        () => { this.keyBoost = true; }, () => { this.keyBoost = false; });
      // hold-to-GO throttle
      this._touchPress(document.getElementById("touch-throttle"),
        () => this.setSpeedMode("GO"), () => this.setSpeedMode("STOP"));
      this._touchTap(document.getElementById("touch-laser"), () => this.fireLaser());
      this._touchTap(document.getElementById("touch-jump"), () => this.doJump());
    }

    showStats() {
      const ov = document.getElementById("stats-overlay");
      if (!ov) return;
      const body = document.getElementById("stats-body");
      if (body) {
        const s = this.stats;
        const fmt = this.dashboard._fmtTime(s.totalTimeMs || 0);
        body.innerHTML = `
          <div><span>RUNS</span><b>${s.runs}</b></div>
          <div><span>RESCUES</span><b>${s.wins}</b></div>
          <div><span>WIPEOUTS</span><b>${s.losses}</b></div>
          <div><span>BEST SCORE</span><b>${s.bestScore}</b></div>
          <div><span>THREATS DOWN</span><b>${s.totalKills}</b></div>
          <div><span>CELLS</span><b>${s.totalCells}</b></div>
          <div><span>PED. HITS</span><b>${s.totalPedHits}</b></div>
          <div><span>PLAYTIME</span><b>${fmt}</b></div>
          <div><span>EASY/NORM/HARD</span><b>${s.byDiff.EASY}/${s.byDiff.NORMAL}/${s.byDiff.HARD}</b></div>`;
      }
      ov.classList.add("show");
    }
    hideStats() {
      const ov = document.getElementById("stats-overlay");
      if (ov) ov.classList.remove("show");
    }

    _wireIntro() {
      const startBtn = document.getElementById("start-btn");
      if (startBtn) startBtn.addEventListener("click", () => this.startNew());
      document.querySelectorAll(".diff-btn").forEach((b) => {
        b.addEventListener("click", () => {
          document.querySelectorAll(".diff-btn").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          this.selectedDiff = b.dataset.diff;
          this._showBest();
        });
      });
    }

    _toggleMute() {
      this.settings.muted = this.audio.toggleMute();
      this._saveSettings();
      this._applySettingsToUI();
    }
    _updateMuteIcon() {
      const b = document.getElementById("mute-btn");
      if (b) {
        b.innerHTML = this.settings.muted ? "&#128263;" : "&#128266;";
        b.setAttribute("aria-pressed", String(this.settings.muted));
        b.setAttribute("aria-label", this.settings.muted ? "Unmute" : "Mute");
      }
    }
    _toggleHelp() { this.helpStrip.classList.toggle("hidden"); }

    _shiftSpeed(dir) {
      const order = ["STOP", "SLOW", "GO", "FAST"];
      let i = order.indexOf(this.speedMode);
      i = U.clamp(i + dir, 0, order.length - 1);
      this.setSpeedMode(order[i]);
    }
    setSpeedMode(mode) {
      if (!(mode in CFG.SPEEDS)) return;
      this.speedMode = mode;
      this.dashboard.setActiveSpeed(mode);
    }

    // ---------------- abilities ----------------
    fireLaser() {
      if (this.state !== "playing" || this.laser.cooldown > 0) return;
      this.laser.cooldown = CFG.LASER_COOLDOWN;
      this.dashboard.flashLaser();
      this.audio.laser();
      this._haptic(12);

      const a = this.car.angle, dx = Math.cos(a), dy = Math.sin(a);
      let len = CFG.LASER_RANGE;
      for (let d = 8; d <= CFG.LASER_RANGE; d += 6) {
        const px = this.car.x + dx * d, py = this.car.y + dy * d;
        if (this.world.isWallTile(Math.floor(px / CFG.TILE), Math.floor(py / CFG.TILE)) ||
            this.world.isObstacleAt(Math.floor(px / CFG.TILE), Math.floor(py / CFG.TILE))) { len = d; break; }
      }
      this.laser.beam = { x: this.car.x, y: this.car.y, a, len, life: 12 };

      for (const e of this.world.entities) {
        if (!e.alive || e.type === "pedestrian") continue;
        const rx = e.x - this.car.x, ry = e.y - this.car.y;
        const t = rx * dx + ry * dy;
        if (t < 0 || t > len) continue;
        if (Math.abs(rx * dy - ry * dx) < 18) {
          e.alive = false; this.kills++;
          this._spawnExplosion(e.x, e.y, e.type === "driver" ? "#ff3b53" : "#ff7b2f");
        }
      }
    }

    doJump() {
      if (this.state !== "playing" || this.jump.cooldown > 0 || this.jump.active) return;
      this.jump.active = true;
      this.jump.timer = CFG.JUMP_DURATION;
      this.jump.cooldown = CFG.JUMP_COOLDOWN;
      this.dashboard.flashJump();
      this.audio.jump();
      this._haptic(20);
    }

    boostBurst() {
      if (this.state !== "playing" || this.boost.meter < 25) return;
      this.boost.burst = 48;
      this.dashboard.flashBoost();
      this.audio.boost();
      this._haptic(15);
    }

    // ---------------- particles ----------------
    _spawnExplosion(x, y, color) {
      const n = this.settings.reducedMotion ? 7 : 14;
      const bits = [];
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2, spd = 1 + Math.random() * 3.5;
        bits.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, size: 4 + U.rand(6) });
      }
      this.explosions.push({ x, y, color, timer: 26, max: 26, bits });
      this._addShake(8);
      this.audio.crash();
    }

    _addShake(v) { this.shake = Math.min(this.shake + v, 16); }

    // ---------------- main update ----------------
    _update(dtMs) {
      if (this.state !== "playing") return;
      this.elapsedMs += dtMs;
      const car = this.car, w = this.world;

      // steering (Fix #7: snappier centering, responsive but stable)
      const turning = this.keyLeft || this.keyRight;
      if (this.keyLeft) this.steer = U.clamp(this.steer - 0.16, -1, 1);
      if (this.keyRight) this.steer = U.clamp(this.steer + 0.16, -1, 1);
      if (!turning && !this.steerHeld) this.steer *= 0.72;

      // boost state (forward only)
      const wantBoost = (this.keyBoost || this.boost.burst > 0);
      this.boost.active = wantBoost && !this.keyReverse && this.boost.meter > 0 && CFG.SPEEDS[this.speedMode] > 0;
      if (this.boost.burst > 0) this.boost.burst--;
      if (this.boost.active) this.boost.meter = Math.max(0, this.boost.meter - 1.2);
      else this.boost.meter = Math.min(this.boost.max, this.boost.meter + 0.35);

      // Fix #6: reverse gear takes priority over the forward speed mode
      let speed = CFG.SPEEDS[this.speedMode];
      if (this.boost.active) speed *= CFG.BOOST_MULT;
      let moveSpeed = speed, dir = 1;
      if (this.keyReverse) { moveSpeed = CFG.REVERSE_SPEED; dir = -1; }

      // turning works even while crawling so you can line up shots / escapes
      const turnFactor = moveSpeed > 0 ? 1 : 0.65;
      car.angle += this.steer * CFG.TURN_RATE * turnFactor;

      // movement + collision (Fix #2: bump-and-slide, never a forced full stop)
      if (moveSpeed > 0) {
        const vx = Math.cos(car.angle) * moveSpeed * dir;
        const vy = Math.sin(car.angle) * moveSpeed * dir;
        let crashed = false;
        const blocked = (px, py) => {
          const col = w.carCollision(px, py, CFG.CAR_RADIUS);
          if (!col) return false;
          if (col.kind === "wall") return true;
          if (col.kind === "obstacle") return !this.jump.active;
          return false;
        };
        // axis-separated so the car slides smoothly along walls
        if (!blocked(car.x + vx, car.y)) car.x += vx; else crashed = true;
        if (!blocked(car.x, car.y + vy)) car.y += vy; else crashed = true;
        if (crashed && this.hitCooldown === 0) this._damage(CFG.WALL_HIT_DAMAGE);

        // exhaust trail (behind the direction of travel)
        if (Math.random() < (this.boost.active ? 0.9 : 0.5)) {
          this.exhaust.push({
            x: car.x - Math.cos(car.angle) * 16 * dir,
            y: car.y - Math.sin(car.angle) * 16 * dir,
            vx: -Math.cos(car.angle) * 0.6 * dir + (Math.random() - 0.5),
            vy: -Math.sin(car.angle) * 0.6 * dir + (Math.random() - 0.5),
            life: 24, max: 24, boost: this.boost.active
          });
        }
      }

      // explored cells (Improvement #16)
      this.explored.add(Math.floor(car.x / CFG.TILE) + "," + Math.floor(car.y / CFG.TILE));

      // timers
      if (this.jump.active) { this.jump.timer--; if (this.jump.timer <= 0) { this.jump.active = false; this.audio.land(); } }
      if (this.jump.cooldown > 0) this.jump.cooldown--;
      if (this.laser.cooldown > 0) this.laser.cooldown--;
      if (this.laser.beam && --this.laser.beam.life <= 0) this.laser.beam = null;

      // entities + collisions
      w.updateEntities(car.x, car.y);
      this._entityCollisions();
      this._pickupCollisions();

      // particle stepping
      for (const ex of this.explosions) { ex.timer--; for (const b of ex.bits) { b.x += b.vx; b.y += b.vy; b.vx *= 0.92; b.vy *= 0.92; } }
      this.explosions = this.explosions.filter((e) => e.timer > 0);
      for (const p of this.exhaust) { p.x += p.vx; p.y += p.vy; p.life--; }
      this.exhaust = this.exhaust.filter((p) => p.life > 0);

      if (this.shake > 0) { this.shake *= 0.85; if (this.shake < 0.3) this.shake = 0; }
      if (this.flashLevel > 0) this.flashLevel = Math.max(0, this.flashLevel - 0.05);
      if (this.hitCooldown > 0) this.hitCooldown--;

      // Fix #5: shield slowly regenerates once you've avoided damage a while
      this.regenTimer++;
      if (this.regenTimer > CFG.REGEN_DELAY && this.shield < CFG.SHIELD_MAX) {
        this.shield = Math.min(CFG.SHIELD_MAX, this.shield + CFG.SHIELD_REGEN);
      }

      // camera look-ahead (Improvement #17)
      let targetCam = 0.6 + (CFG.SPEEDS[this.speedMode] / CFG.SPEEDS.FAST) * 0.08 + (this.boost.active ? 0.03 : 0);
      this.camY += (targetCam - this.camY) * 0.06;

      // engine audio (Improvement #2)
      this.audio.setEngine(this.speedMode, this.boost.active);
      this.audio.tickPing();

      // VIP beacon + ping (Improvement #11)
      this._updateBeacon();

      // live score (Improvement #12)
      this.score = Math.max(0, this.kills * 100 + this.cells * 25 - this.pedestrianHits * 20);

      // win / lose
      if (U.dist(car.x, car.y, w.vip.x, w.vip.y) < CFG.VIP_REACH) this._win();
      if (this.shield <= 0) this._lose();

      this.dashboard.updateHud(this);
      this.dashboard.updateCooldowns(this);
    }

    _damage(amount) {
      this.shield = Math.max(0, this.shield - amount);
      this.hitCooldown = CFG.HIT_COOLDOWN;
      this.regenTimer = 0; // Fix #5: pause regen after taking a hit
      this._addShake(10);
      this.flashLevel = 1; // red damage flash (Improvement #10)
      this._haptic([30, 20, 30]);
    }

    // Fix #14: push the car away from whatever it hit so you don't get
    // pinned looping into the same enemy.
    _knockback(nx, ny, amount) {
      for (let step = amount; step > 0; step -= 4) {
        const tx = this.car.x + nx * 4, ty = this.car.y + ny * 4;
        if (this.world.carCollision(tx, ty, CFG.CAR_RADIUS)) break;
        this.car.x = tx; this.car.y = ty;
      }
    }

    _entityCollisions() {
      const car = this.car;
      for (const e of this.world.entities) {
        if (!e.alive) continue;
        if (e.cool > 0) { e.cool--; continue; }
        const er = e.type === "driver" ? 16 : e.type === "creature" ? 14 : 11;
        if (U.dist(car.x, car.y, e.x, e.y) < CFG.CAR_RADIUS + er) {
          if (e.type === "pedestrian") {
            // Fix #4: pure warning — no shield loss for clipping a pedestrian
            this.pedestrianHits++;
            this.dashboard.flashWarning();
            this.audio.warn();
            e.cool = 50;
            const ang = Math.atan2(e.y - car.y, e.x - car.x);
            e.x += Math.cos(ang) * 16; e.y += Math.sin(ang) * 16;
          } else if (this.hitCooldown === 0) {
            this._damage(CFG.HOSTILE_HIT_DAMAGE);
            const ang = Math.atan2(car.y - e.y, car.x - e.x);
            this._knockback(Math.cos(ang), Math.sin(ang), 20);
            e.cool = 30;
          }
        }
      }
    }

    _pickupCollisions() {
      for (const p of this.world.pickups) {
        if (p.taken) continue;
        if (U.dist(this.car.x, this.car.y, p.x, p.y) < CFG.CAR_RADIUS + 14) {
          p.taken = true; this.cells++;
          this.shield = Math.min(CFG.SHIELD_MAX, this.shield + CFG.SHIELD_PICKUP);
          this.audio.pickup();
          this._haptic([10, 30, 10]);
          this._spawnSparkle(p.x, p.y, "#39ff88");
        }
      }
    }

    _spawnSparkle(x, y, color) {
      const bits = [];
      for (let i = 0; i < 10; i++) {
        const ang = Math.random() * Math.PI * 2, spd = 0.8 + Math.random() * 2;
        bits.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, size: 3 + U.rand(4) });
      }
      this.explosions.push({ x, y, color, timer: 22, max: 22, bits });
    }

    // Fix #11 & #20: an always-on directional compass to the VIP (it points
    // the way without ever revealing the exact tile), with a radar ping that
    // warms up as you close in.
    _updateBeacon() {
      const w = this.world, car = this.car;
      const d = U.dist(car.x, car.y, w.vip.x, w.vip.y);
      const rangePx = CFG.BEACON_RANGE * CFG.TILE;
      const intensity = U.clamp(1 - d / rangePx, 0, 1);

      const worldAng = Math.atan2(w.vip.y - car.y, w.vip.x - car.x);
      // In north-up mode screen angle == world angle; in rotating mode the
      // whole view is spun so heading points up.
      const screenAng = this.settings.rotateView
        ? worldAng - (car.angle + Math.PI / 2)
        : worldAng;
      const radius = Math.min(this.vw, this.vh) * 0.34;
      const bx = this.viewCx + Math.cos(screenAng) * radius;
      const by = this.viewCy + Math.sin(screenAng) * radius;
      this.beacon.style.left = bx + "px";
      this.beacon.style.top = by + "px";
      this.beacon.style.transform = `translate(-50%,-50%) rotate(${screenAng}rad) scale(${0.8 + intensity * 0.5})`;
      this.beacon.style.opacity = (0.45 + intensity * 0.55).toFixed(2);
      this.beacon.classList.add("on");
      if (d <= rangePx) this.audio.ping(intensity);
    }

    _win() {
      if (this.state !== "playing") return;
      this.state = "won";
      this.beacon.classList.remove("on");
      this.audio.silenceEngine();
      this.audio.rescue();
      // bonus: time + shield (Improvement #12)
      const timeBonus = Math.max(0, 600 - Math.floor(this.elapsedMs / 1000) * 3);
      const shieldBonus = Math.round(this.shield * 4);
      this.finalScore = this.score + timeBonus + shieldBonus;
      // best time
      const prev = Number(localStorage.getItem(this._bestKey()) || 0);
      const newBest = (!prev || this.elapsedMs < prev);
      if (newBest) { try { localStorage.setItem(this._bestKey(), String(Math.round(this.elapsedMs))); } catch (e) { /**/ } }
      this._recordStats(true);
      this._haptic([40, 40, 80]);
      this._seedFireworks();
      this._renderEndCard(true, newBest);
    }
    _lose() {
      if (this.state !== "playing") return;
      this.state = "lost";
      this.beacon.classList.remove("on");
      this.audio.silenceEngine();
      this.audio.gameover();
      this.finalScore = this.score;
      this._recordStats(false);
      this._haptic([80, 40, 80]);
      this._renderEndCard(false, false);
    }

    // C6: fold this run into lifetime stats and persist
    _recordStats(won) {
      const s = this.stats;
      s.runs++;
      if (won) { s.wins++; s.byDiff[this.selectedDiff] = (s.byDiff[this.selectedDiff] || 0) + 1; }
      else s.losses++;
      s.bestScore = Math.max(s.bestScore, this.finalScore);
      s.totalKills += this.kills;
      s.totalCells += this.cells;
      s.totalPedHits += this.pedestrianHits;
      s.totalTimeMs += Math.round(this.elapsedMs);
      this._saveStats();
    }

    _renderEndCard(won, newBest) {
      const card = this.overlay.querySelector(".overlay-card");
      const time = this.dashboard._fmtTime(this.elapsedMs);
      if (won) {
        card.innerHTML = `
          <h1 class="overlay-title win">VIP RESCUED!</h1>
          <p class="overlay-sub">MISSION COMPLETE</p>
          <div class="stat-grid">
            <div><span>TIME</span><b>${time}${newBest ? " &#11088;" : ""}</b></div>
            <div><span>SCORE</span><b>${this.finalScore}</b></div>
            <div><span>SHIELD</span><b>${Math.round(this.shield)}%</b></div>
            <div><span>THREATS DOWN</span><b>${this.kills}</b></div>
            <div><span>CELLS</span><b>${this.cells}</b></div>
            <div><span>PED. HITS</span><b>${this.pedestrianHits}</b></div>
          </div>
          ${newBest ? '<p class="overlay-best new">NEW BEST TIME!</p>' : ""}
          ${this._lifetimeRow()}
          <button id="again-btn" class="big-btn">PLAY AGAIN</button>
          <button id="menu-btn" class="text-btn">Change difficulty</button>`;
      } else {
        card.innerHTML = `
          <h1 class="overlay-title lose">CAR DESTROYED</h1>
          <p class="overlay-sub">MISSION FAILED</p>
          <div class="stat-grid">
            <div><span>TIME</span><b>${time}</b></div>
            <div><span>SCORE</span><b>${this.finalScore}</b></div>
            <div><span>THREATS DOWN</span><b>${this.kills}</b></div>
            <div><span>PED. HITS</span><b>${this.pedestrianHits}</b></div>
          </div>
          <p class="overlay-text">The rescue target is still out there. Try a new route.</p>
          ${this._lifetimeRow()}
          <button id="again-btn" class="big-btn">TRY AGAIN</button>
          <button id="menu-btn" class="text-btn">Change difficulty</button>`;
      }
      this._showOverlay();
      const again = document.getElementById("again-btn");
      const menu = document.getElementById("menu-btn");
      if (again) again.addEventListener("click", () => this.startNew());
      if (menu) menu.addEventListener("click", () => this.quitToMenu());
    }

    // C7/C11: compact lifetime line under the per-run stats
    _lifetimeRow() {
      const s = this.stats;
      return `<p class="lifetime-row">LIFETIME &middot; ${s.runs} runs &middot; ${s.wins} rescues &middot; best ${s.bestScore}</p>`;
    }

    // ---------------- win fireworks (Improvement #18) ----------------
    _seedFireworks() { this.fireworks = []; this._fwTimer = 0; }
    _stepFireworks() {
      if (this.settings.reducedMotion) return;
      this._fwTimer = (this._fwTimer || 0) - 1;
      if (this._fwTimer <= 0) {
        this._fwTimer = 14 + U.rand(20);
        const cx = this.vw * (0.2 + Math.random() * 0.6);
        const cy = this.vh * (0.15 + Math.random() * 0.4);
        const hue = U.rand(360);
        const n = 26;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2, sp = 1.5 + Math.random() * 3;
          this.fireworks.push({
            x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 50, max: 50, color: `hsl(${hue + U.rand(40)},100%,65%)`
          });
        }
      }
      for (const p of this.fireworks) { p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.vx *= 0.98; p.vy *= 0.98; p.life--; }
      this.fireworks = this.fireworks.filter((p) => p.life > 0);
    }
    _clearConfetti() { this.cctx.setTransform(1, 0, 0, 1, 0, 0); this.cctx.clearRect(0, 0, this.confetti.width, this.confetti.height); }
    _renderFireworks() {
      const ctx = this.cctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.vw, this.vh);
      for (const p of this.fireworks) {
        ctx.globalAlpha = p.life / p.max;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, 3, 3);
      }
      ctx.globalAlpha = 1;
    }

    // ---------------- loop ----------------
    // B8: fixed-timestep simulation so cooldowns / decay / boost feel the same
    // on 60 / 120 / 144Hz displays; rendering still runs once per frame.
    _loop(t) {
      // clamp to [0,100ms]: guards against tab-switch gaps and any
      // non-monotonic / backwards clock readings
      const frame = Math.max(0, Math.min(100, t - this.lastTime));
      this.lastTime = t;
      const STEP = 1000 / 60;
      this._acc += frame;
      let ticks = 0;
      while (this._acc >= STEP && ticks < 5) {
        this._update(STEP);
        this._acc -= STEP;
        ticks++;
      }
      if (ticks === 5) this._acc = 0; // avoid spiral of death

      this._render();
      this.dashboard.drawWheel(this.steer);
      if (this.world) this.dashboard.drawMinimap(this.world, this.car, this.explored);

      // damage flash element
      this.damageFlash.style.opacity = (this.flashLevel * 0.5).toFixed(2);

      if (this.state === "won") { this._stepFireworks(); this._renderFireworks(); }

      requestAnimationFrame((tt) => this._loop(tt));
    }

    // ---------------- render ----------------
    _render() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const W = this.vw, H = this.vh;
      ctx.clearRect(0, 0, W, H);

      if (!this._bgGrad) this._buildViewGradients();
      ctx.fillStyle = this._bgGrad; ctx.fillRect(0, 0, W, H);

      if (!this.world) { this._renderIdle(ctx, W, H); return; }

      const car = this.car;
      const rotate = this.settings.rotateView;
      const shakeAmt = (this.settings.shake && !this.settings.reducedMotion) ? this.shake : 0;
      const sxk = (Math.random() - 0.5) * shakeAmt;
      const syk = (Math.random() - 0.5) * shakeAmt;

      // Fix #1 & #17: north-up stable camera with smooth look-ahead, or the
      // optional rotating "cockpit" view.
      const speedFactor = (this.keyReverse ? 0 : CFG.SPEEDS[this.speedMode] / CFG.SPEEDS.FAST);
      let cx, cy;
      if (rotate) {
        cx = W / 2; cy = H * this.camY;
      } else {
        cx = W / 2; cy = H / 2;
        const lead = 90;
        const tlx = Math.cos(car.angle) * lead * speedFactor;
        const tly = Math.sin(car.angle) * lead * speedFactor;
        this.leadX += (tlx - this.leadX) * 0.07;
        this.leadY += (tly - this.leadY) * 0.07;
      }
      this.viewCx = cx; this.viewCy = cy;

      ctx.save();
      ctx.translate(cx + sxk, cy + syk);
      if (rotate) {
        ctx.rotate(-(car.angle + Math.PI / 2));
        ctx.translate(-car.x, -car.y);
      } else {
        ctx.translate(-(car.x + this.leadX), -(car.y + this.leadY));
      }
      this._renderWorld(ctx);
      if (!rotate) {
        // car lives in the world for the stable camera (rotates to heading)
        ctx.save();
        ctx.translate(car.x, car.y);
        ctx.rotate(car.angle + Math.PI / 2);
        this._paintCar(ctx);
        ctx.restore();
      }
      ctx.restore();

      if (rotate) {
        ctx.save();
        ctx.translate(cx + sxk, cy + syk);
        this._paintCar(ctx);
        ctx.restore();
      }

      // speed lines (Improvement #9)
      if (!this.settings.reducedMotion &&
          (this.speedMode === "FAST" || this.boost.active)) {
        this._renderSpeedLines(ctx, cx, cy);
      }

      if (!this._vignetteGrad) this._buildViewGradients();
      ctx.fillStyle = this._vignetteGrad; ctx.fillRect(0, 0, W, H);
    }

    _renderIdle(ctx, W, H) {
      // subtle moving grid behind the intro menu
      ctx.strokeStyle = "rgba(47,243,255,0.06)";
      ctx.lineWidth = 1;
      const off = (performance.now() / 40) % 48;
      for (let x = -48 + off; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = -48 + off; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }

    _renderWorld(ctx) {
      const w = this.world, T = CFG.TILE, car = this.car, range = 9;
      const cgx = Math.floor(car.x / T), cgy = Math.floor(car.y / T);
      for (let gy = cgy - range; gy <= cgy + range; gy++) {
        for (let gx = cgx - range; gx <= cgx + range; gx++) {
          if (gx < 0 || gy < 0 || gx >= w.gw || gy >= w.gh) continue;
          const x = gx * T, y = gy * T;
          if (w.grid[gy][gx] === 1) this._drawWall(ctx, x, y, T);
          else this._drawFloor(ctx, x, y, T);
        }
      }
      // exhaust (under everything mobile)
      for (const p of this.exhaust) this._drawExhaust(ctx, p);

      for (const o of w.obstacles) {
        const c = w.tileCenter(o.gx, o.gy);
        this._drawObstacle(ctx, c.x, c.y, o.type);
      }
      for (const p of w.pickups) { if (!p.taken) { p.bob += 0.08; this._drawPickup(ctx, p); } }

      w.vip.bob += 0.06;
      this._drawVip(ctx, w.vip.x, w.vip.y, w.vip.bob);

      for (const e of w.entities) {
        if (!e.alive) continue;
        if (e.type === "pedestrian") this._drawPedestrian(ctx, e);
        else if (e.type === "creature") this._drawCreature(ctx, e);
        else this._drawDriver(ctx, e);
      }
      if (this.laser.beam) this._drawBeam(ctx, this.laser.beam);
      for (const ex of this.explosions) this._drawExplosion(ctx, ex);
    }

    _drawExhaust(ctx, p) {
      const f = p.life / p.max;
      ctx.globalAlpha = f * 0.6;
      ctx.fillStyle = p.boost ? "#7fd6ff" : "#6a7790";
      const s = (1 - f) * 8 + 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, s, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // B2: blit cached tiles instead of re-creating a gradient per tile
    _drawFloor(ctx, x, y, T) {
      if (!this._floorTile) this._buildTiles();
      ctx.drawImage(this._floorTile, x, y);
    }

    _drawWall(ctx, x, y, T) {
      if (!this._wallTile) this._buildTiles();
      ctx.drawImage(this._wallTile, x, y);
    }

    _drawObstacle(ctx, x, y, type) {
      ctx.save(); ctx.translate(x, y);
      if (type === "block") {
        ctx.fillStyle = "#3a2c10"; ctx.strokeStyle = "#ffb627"; ctx.lineWidth = 3;
        const s = 20; ctx.fillRect(-s, -s, s * 2, s * 2); ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.strokeStyle = "rgba(255,182,39,0.6)"; ctx.lineWidth = 4;
        for (let i = -s; i < s; i += 10) { ctx.beginPath(); ctx.moveTo(i, -s); ctx.lineTo(i + s, 0); ctx.stroke(); }
      } else {
        ctx.strokeStyle = "#ff7b2f"; ctx.lineWidth = 6; ctx.shadowColor = "#ff7b2f"; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.moveTo(-22, -10); ctx.lineTo(22, -10); ctx.moveTo(-22, 10); ctx.lineTo(22, 10); ctx.stroke();
        ctx.lineWidth = 3; ctx.beginPath();
        ctx.moveTo(-14, -10); ctx.lineTo(-14, 10); ctx.moveTo(0, -10); ctx.lineTo(0, 10); ctx.moveTo(14, -10); ctx.lineTo(14, 10);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawPickup(ctx, p) {
      ctx.save(); ctx.translate(p.x, p.y + Math.sin(p.bob) * 3);
      const pr = 12 + Math.sin(p.bob * 1.4) * 2;
      ctx.strokeStyle = "rgba(57,255,136,0.7)"; ctx.lineWidth = 2;
      ctx.shadowColor = "#39ff88"; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#0a2418"; ctx.strokeStyle = "#39ff88"; ctx.lineWidth = 2;
      this._roundRect(ctx, -8, -8, 16, 16, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#39ff88";
      ctx.fillRect(-1.5, -5, 3, 10); ctx.fillRect(-5, -1.5, 10, 3); // plus sign
      ctx.restore();
    }

    _drawVip(ctx, x, y, bob) {
      ctx.save(); ctx.translate(x, y + Math.sin(bob) * 3);
      const pr = 22 + Math.sin(bob * 1.5) * 4;
      ctx.strokeStyle = "rgba(255,215,80,0.8)"; ctx.lineWidth = 3;
      ctx.shadowColor = "#ffd750"; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffe9a8"; ctx.beginPath(); ctx.arc(0, -8, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffd750"; ctx.beginPath();
      ctx.moveTo(-7, 12); ctx.lineTo(0, -2); ctx.lineTo(7, 12); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px Consolas, monospace"; ctx.textAlign = "center";
      ctx.fillText("VIP", 0, -20);
      ctx.restore();
    }

    _drawPedestrian(ctx, e) {
      ctx.save(); ctx.translate(e.x, e.y);
      const sway = Math.sin(e.wobble) * 2;
      ctx.fillStyle = "#bdeaff"; ctx.beginPath(); ctx.arc(sway, -6, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#6f9fd0"; ctx.beginPath();
      ctx.moveTo(-4 + sway, 8); ctx.lineTo(sway, -2); ctx.lineTo(4 + sway, 8); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // B4: blit pre-rendered sprites (glow baked in); C5: glyph cue for threats
    _drawCreature(ctx, e) {
      if (!this._creatureSprite) this._buildSprites();
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.wobble * 0.3);
      ctx.drawImage(this._creatureSprite, -20, -20);
      ctx.restore();
      if (this.settings.highContrast) this._threatGlyph(ctx, e.x, e.y);
    }

    _drawDriver(ctx, e) {
      if (!this._driverSprite) this._buildSprites();
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(Math.atan2(e.vy, e.vx) + Math.PI / 2);
      ctx.drawImage(this._driverSprite, -20, -22);
      ctx.restore();
      if (this.settings.highContrast) this._threatGlyph(ctx, e.x, e.y);
    }

    // Colorblind-safe "danger" marker, hue-independent
    _threatGlyph(ctx, x, y) {
      ctx.save();
      ctx.translate(x, y - 20);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-4, -4); ctx.lineTo(4, 4); ctx.moveTo(4, -4); ctx.lineTo(-4, 4);
      ctx.stroke();
      ctx.restore();
    }

    _drawBeam(ctx, beam) {
      ctx.save(); ctx.translate(beam.x, beam.y); ctx.rotate(beam.a);
      ctx.globalAlpha = beam.life / 12;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.shadowColor = "#ff2bd6"; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(beam.len, 0); ctx.stroke();
      ctx.strokeStyle = "rgba(255,43,214,0.6)"; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(beam.len, 0); ctx.stroke();
      ctx.restore();
    }

    _drawExplosion(ctx, ex) {
      const f = ex.timer / ex.max;
      ctx.save();
      const palette = [ex.color, "#ffffff", "#ffb627", "#ffe9a8"];
      ex.bits.forEach((b, i) => {
        ctx.globalAlpha = f; ctx.fillStyle = palette[i % palette.length];
        const s = b.size * f + 1;
        ctx.fillRect(Math.round(b.x - s / 2), Math.round(b.y - s / 2), Math.ceil(s), Math.ceil(s));
      });
      ctx.globalAlpha = f * 0.7; ctx.strokeStyle = ex.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, (1 - f) * 30 + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // B5: persistent streaming speed lines (no per-frame random jitter)
    _renderSpeedLines(ctx, cx, cy) {
      const maxR = Math.hypot(this.vw, this.vh) * 0.5;
      if (!this._speedLines) {
        this._speedLines = [];
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
          this._speedLines.push({
            a, r: 40 + Math.random() * maxR, len: 26 + Math.random() * 26,
            alpha: 0.12 + Math.random() * 0.28
          });
        }
      }
      const spd = (this.boost.active ? 18 : 11);
      ctx.save();
      ctx.strokeStyle = "rgba(180,230,255,1)";
      ctx.lineWidth = 2;
      for (const L of this._speedLines) {
        L.r += spd;
        if (L.r > maxR) { L.r = 30 + Math.random() * 30; L.a = Math.random() * Math.PI * 2; }
        ctx.globalAlpha = L.alpha;
        const c = Math.cos(L.a), s = Math.sin(L.a);
        ctx.beginPath();
        ctx.moveTo(cx + c * L.r, cy + s * L.r);
        ctx.lineTo(cx + c * (L.r + L.len), cy + s * (L.r + L.len));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Draws the car centred on the current transform origin, pointing "up"
    // (local -y). Caller positions/rotates it for the active camera mode.
    _paintCar(ctx) {
      const jumpScale = this.jump.active
        ? 1 + Math.sin((1 - this.jump.timer / CFG.JUMP_DURATION) * Math.PI) * 0.5 : 1;
      ctx.save();

      if (this.jump.active) {
        const lift = jumpScale - 1;
        ctx.save(); ctx.globalAlpha = 0.35 - lift * 0.2; ctx.fillStyle = "#000";
        ctx.beginPath(); ctx.ellipse(0, 22 + lift * 16, 16, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      ctx.scale(jumpScale, jumpScale);
      if (this.hitCooldown > 0 && Math.floor(this.hitCooldown / 4) % 2 === 0) ctx.globalAlpha = 0.5;

      // boost flames
      if (this.boost.active) {
        ctx.fillStyle = "#3df0ff"; ctx.shadowColor = "#3df0ff"; ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.moveTo(-7, 22); ctx.lineTo(0, 34 + Math.random() * 6); ctx.lineTo(7, 22); ctx.closePath(); ctx.fill();
        ctx.shadowBlur = 0;
      }

      if (!this._carGrad) {
        const g = ctx.createLinearGradient(-16, 0, 16, 0);
        g.addColorStop(0, "#1f6fb0"); g.addColorStop(0.5, "#3ad0ff"); g.addColorStop(1, "#1f6fb0");
        this._carGrad = g;
      }
      ctx.fillStyle = this._carGrad; ctx.strokeStyle = "#eafcff"; ctx.lineWidth = 2;
      this._roundRect(ctx, -15, -22, 30, 44, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#04263a"; this._roundRect(ctx, -10, -16, 20, 12, 4); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.18)"; this._roundRect(ctx, -3, -20, 6, 40, 3); ctx.fill();
      ctx.fillStyle = "#fff7c2"; ctx.shadowColor = "#fff7c2"; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(-9, -20, 2.5, 0, Math.PI * 2); ctx.arc(9, -20, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ff3b53"; ctx.beginPath();
      ctx.arc(-9, 20, 2, 0, Math.PI * 2); ctx.arc(9, 20, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
  }

  function boot() { M.game = new Game(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window.MMR);
