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
  const FALL_TICKS = 48; // length of the void-fall plunge (~0.8s at 60Hz)

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
      this.falls = 0;
      this.pedestrianHits = 0;
      this.kills = 0; this.cells = 0;
      this.score = 0; this.finalScore = 0;
      this.elapsedMs = 0;

      this.selectedDiff = "EASY"; // Fix #14: default to the gentle preset
      this.state = "intro";
      this.demoMode = false;

      this.hitCooldown = 0;
      this.falling = 0; // ticks left in the void-fall sequence
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
        haptics: true, highContrast: false, bigText: false, firstPerson: true
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
        totalKills: 0, totalCells: 0, totalPedHits: 0, totalFalls: 0, totalTimeMs: 0,
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
      set("opt-firstperson", this.settings.firstPerson);
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

      // first-person jungle canopy (upper) + forest-floor (lower) gradients
      const sky = ctx.createLinearGradient(0, 0, 0, H * 0.6);
      sky.addColorStop(0, "#06140a");      // dark canopy shadow
      sky.addColorStop(0.55, "#16361a");   // mid leaves
      sky.addColorStop(1, "#3f7a39");      // bright light near the horizon
      this._fpCanopy = sky;
      const floor = ctx.createLinearGradient(0, H * 0.4, 0, H);
      floor.addColorStop(0, "#4a3a22");    // sunlit dirt at the horizon
      floor.addColorStop(0.5, "#2c2415");
      floor.addColorStop(1, "#161109");    // dark dirt underfoot
      this._fpFloor = floor;
      // cockpit hood (depends on H, so rebuilt here on every resize)
      const hood = ctx.createLinearGradient(0, H * 0.82, 0, H);
      hood.addColorStop(0, "#13202f"); hood.addColorStop(0.25, "#0c1622"); hood.addColorStop(1, "#05080d");
      this._hoodGrad = hood;
    }

    // B2: pre-render the top-down jungle tiles to offscreen canvases (once):
    // mossy foliage walls, a dirt-path floor, and a deadly void pit.
    _buildTiles() {
      const T = CFG.TILE;
      // jungle wall: dense foliage over mossy stone, bevelled so it reads raised
      const wc = document.createElement("canvas");
      wc.width = T; wc.height = T;
      const w = wc.getContext("2d");
      const g = w.createLinearGradient(0, 0, 0, T);
      g.addColorStop(0, "#1f4d27"); g.addColorStop(1, "#0d2412");
      w.fillStyle = g; w.fillRect(0, 0, T, T);
      // leaf clumps
      for (let n = 0; n < 22; n++) {
        const lx = Math.random() * T, ly = Math.random() * T;
        w.fillStyle = `rgba(${24 + U.rand(36)},${80 + U.rand(80)},${36 + U.rand(36)},0.75)`;
        w.beginPath(); w.ellipse(lx, ly, 4 + Math.random() * 5, 2 + Math.random() * 3,
          Math.random() * Math.PI, 0, Math.PI * 2); w.fill();
      }
      // top/left highlight, bottom/right shadow → reads as raised hedge
      w.strokeStyle = "rgba(150,230,140,0.35)"; w.lineWidth = 2;
      w.beginPath(); w.moveTo(1, T - 1); w.lineTo(1, 1); w.lineTo(T - 1, 1); w.stroke();
      w.strokeStyle = "rgba(0,0,0,0.5)";
      w.beginPath(); w.moveTo(T - 1, 1); w.lineTo(T - 1, T - 1); w.lineTo(1, T - 1); w.stroke();
      this._wallTile = wc;

      // dirt-path floor with speckles
      const fc = document.createElement("canvas");
      fc.width = T; fc.height = T;
      const f = fc.getContext("2d");
      f.fillStyle = "#2a2113"; f.fillRect(0, 0, T, T);
      for (let n = 0; n < 18; n++) {
        f.fillStyle = `rgba(${60 + U.rand(40)},${48 + U.rand(30)},${24 + U.rand(18)},0.5)`;
        f.fillRect(U.rand(T), U.rand(T), 2 + U.rand(3), 1 + U.rand(2));
      }
      f.strokeStyle = "rgba(0,0,0,0.25)"; f.lineWidth = 1;
      f.strokeRect(0.5, 0.5, T - 1, T - 1);
      this._floorTile = fc;

      // void pit: near-black drop with a warning rim
      const vc = document.createElement("canvas");
      vc.width = T; vc.height = T;
      const v = vc.getContext("2d");
      const vg = v.createRadialGradient(T / 2, T / 2, 4, T / 2, T / 2, T * 0.7);
      vg.addColorStop(0, "#000"); vg.addColorStop(0.7, "#06040a"); vg.addColorStop(1, "#1a0a10");
      v.fillStyle = vg; v.fillRect(0, 0, T, T);
      v.strokeStyle = "rgba(255,59,83,0.7)"; v.lineWidth = 3;
      v.strokeRect(2, 2, T - 4, T - 4);
      v.strokeStyle = "rgba(255,59,83,0.25)"; v.lineWidth = 1;
      // cracked edges
      for (let n = 0; n < 5; n++) {
        const ax = U.rand(T), ay = U.rand(T);
        v.beginPath(); v.moveTo(ax, ay);
        v.lineTo(ax + U.rand(16) - 8, ay + U.rand(16) - 8); v.stroke();
      }
      this._voidTile = vc;
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
      this.car.x = s.x; this.car.y = s.y;
      this.car.angle = this.world.startAngle;
      this.steer = 0; this.speedMode = "STOP";
      this.falls = 0; this.falling = 0;
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
      this.keyReverse = false; this.keyBoost = false;
      this.demoMode = false;
      this.explored = new Set();
      this.state = "playing";
      this.dashboard.setActiveSpeed("STOP");
      this._hideOverlay();
      this.pauseOverlay.classList.remove("show");
      this._showToast("Drive the path to the VIP — take the right turns, avoid the void!");
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
      bind("opt-firstperson", "firstPerson");
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

      // Demo mode button
      const demoBtn = document.getElementById("demo-btn");
      if (demoBtn) demoBtn.addEventListener("click", () => this._toggleDemo());
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
          <div><span>VOID FALLS</span><b>${s.totalFalls || 0}</b></div>
          <div><span>BEST SCORE</span><b>${s.bestScore}</b></div>
          <div><span>THREATS DOWN</span><b>${s.totalKills}</b></div>
          <div><span>GEMS</span><b>${s.totalCells}</b></div>
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

    _toggleDemo() {
      if (this.state !== "playing") return;
      this.demoMode = !this.demoMode;
      if (this.demoMode) {
        this._showToast("DEMO MODE — automated navigation");
        // Ensure car is moving
        if (this.speedMode === "STOP") this.setSpeedMode("GO");
      } else {
        this._showToast("Demo mode disabled");
        // Stop auto-steering
        this.keyLeft = false; this.keyRight = false;
      }
      const btn = document.getElementById("demo-btn");
      if (btn) btn.classList.toggle("active", this.demoMode);
    }

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
      this.elapsedMs += dtMs; // the clock keeps running — falls cost time

      // mid-fall: the car is plunging, controls are dead until respawn
      if (this.falling > 0) {
        this.falling--;
        if (this.falling === 0) this._respawn();
        this.dashboard.updateHud(this);
        this.dashboard.updateCooldowns(this);
        return;
      }

      const car = this.car, w = this.world;

      // Demo mode auto-steering
      if (this.demoMode) {
        this._updateDemoSteering();
      } else {
        // steering (Fix #7: snappier centering, responsive but stable)
        const turning = this.keyLeft || this.keyRight;
        if (this.keyLeft) this.steer = U.clamp(this.steer - 0.16, -1, 1);
        if (this.keyRight) this.steer = U.clamp(this.steer + 0.16, -1, 1);
        if (!turning && !this.steerHeld) this.steer *= 0.72;
      }

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
        // axis-separated so the car slides smoothly along walls. Walls are
        // harmless now — they just stop you; only a void can end the run.
        if (!blocked(car.x + vx, car.y)) car.x += vx; else crashed = true;
        if (!blocked(car.x, car.y + vy)) car.y += vy; else crashed = true;
        if (crashed) {
          this.audio.scrape();
          if (this.hitCooldown === 0) {
            this._addShake(3); this.hitCooldown = 8;
            this._spawnSparkle(
              car.x + Math.cos(car.angle) * 14 * dir,
              car.y + Math.sin(car.angle) * 14 * dir, "#ffcf6e", 5);
          }
        }

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

      // win + void fall: reaching the VIP wins; driving into a void restarts you
      if (U.dist(car.x, car.y, w.vip.x, w.vip.y) < CFG.VIP_REACH) this._win();
      else if (w.isVoid(Math.floor(car.x / CFG.TILE), Math.floor(car.y / CFG.TILE))) this._fall();

      this.dashboard.updateHud(this);
      this.dashboard.updateCooldowns(this);
    }

    // The only way to fail: drive off the route into a void. We don't end the
    // run — the camera plunges, the screen fades, and you respawn at the start
    // of the SAME maze to try again (the mission clock keeps ticking).
    _fall() {
      if (this.state !== "playing" || this.falling > 0) return;
      this.falls = (this.falls || 0) + 1;
      this.falling = FALL_TICKS;
      this.setSpeedMode("STOP");
      this.boost.active = false; this.boost.burst = 0;
      this.audio.silenceEngine();
      this.audio.fall();
      this._addShake(14);
      this.flashLevel = 0.5;
      this._haptic([60, 30, 60]);
      this._showToast("You drove into the void!");
    }

    _respawn() {
      const w = this.world, s = w.tileCenter(w.start.gx, w.start.gy);
      this.car.x = s.x; this.car.y = s.y;
      this.car.angle = w.startAngle;
      this.steer = 0;
      this.keyReverse = false;
      this.hitCooldown = CFG.START_GRACE;
      this.leadX = 0; this.leadY = 0;
      this.flashLevel = 0; this.shake = 0;
      this._showToast("Back at the start — try another turn!");
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
            // hostiles are non-lethal now: they just shove you back hard
            const ang = Math.atan2(car.y - e.y, car.x - e.x);
            this._knockback(Math.cos(ang), Math.sin(ang), 24);
            this.hitCooldown = CFG.HIT_COOLDOWN;
            this.flashLevel = 0.7;
            this._addShake(10);
            this.audio.crash();
            this._haptic([30, 20, 30]);
            e.cool = 30;
          }
        }
      }
    }

    _pickupCollisions() {
      for (const p of this.world.pickups) {
        if (p.taken) continue;
        if (U.dist(this.car.x, this.car.y, p.x, p.y) < CFG.CAR_RADIUS + CFG.GEM_PICKUP) {
          p.taken = true; this.cells++; // gems count toward score
          this.audio.pickup();
          this._haptic([10, 30, 10]);
          this._spawnSparkle(p.x, p.y, "#39ff88");
        }
      }
    }

    _spawnSparkle(x, y, color, n = 10) {
      const bits = [];
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2, spd = 0.8 + Math.random() * 2;
        bits.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, size: 3 + U.rand(4) });
      }
      this.explosions.push({ x, y, color, timer: 22, max: 22, bits });
    }

    // Fix #11 & #20: an always-on directional compass to the VIP (it points
    // the way without ever revealing the exact tile), with a radar ping that
    // warms up as you close in.
    _updateDemoSteering() {
      const car = this.car, w = this.world;
      const vx = w.vip.x - car.x, vy = w.vip.y - car.y;
      const targetAngle = Math.atan2(vy, vx);
      const currentAngle = car.angle;
      let angleDiff = targetAngle - currentAngle;
      // Normalize to [-π, π]
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      // Cast rays ahead to detect hazards (5 angles: forward + 4 offsets).
      // Treat walls/obstacles AND voids as "blocked" so the demo never drives
      // itself off the route into a pit.
      const checkDistance = 60, T = CFG.TILE;
      const rays = [0, -Math.PI / 6, Math.PI / 6, -Math.PI / 3, Math.PI / 3];
      const obstacles = [];
      for (const offset of rays) {
        const checkAngle = currentAngle + offset;
        const px = car.x + Math.cos(checkAngle) * checkDistance;
        const py = car.y + Math.sin(checkAngle) * checkDistance;
        const blocked = w.carCollision(px, py, CFG.CAR_RADIUS) ||
          w.isVoid(Math.floor(px / T), Math.floor(py / T));
        obstacles.push({ offset, blocked: !!blocked });
      }

      // Find the clearest steering direction
      const center = obstacles[0]; // straight ahead
      let steerTarget = angleDiff / Math.PI; // normalized target (-1 to 1)

      if (center.blocked) {
        // Obstacle ahead: find the clearest side
        const leftClear = !obstacles[1].blocked || !obstacles[3].blocked;
        const rightClear = !obstacles[2].blocked || !obstacles[4].blocked;
        if (leftClear && !rightClear) steerTarget = -0.8;
        else if (rightClear && !leftClear) steerTarget = 0.8;
        else if (leftClear && rightClear) steerTarget = angleDiff > 0 ? -0.6 : 0.6;
        else steerTarget = angleDiff > 0 ? 0.9 : -0.9; // both bad, pick based on VIP angle
      }

      // Smoothly adjust steer (not instant)
      const steerAccel = 0.12;
      this.steer = U.clamp(this.steer + U.clamp(steerTarget - this.steer, -steerAccel, steerAccel), -1, 1);
    }

    _updateBeacon() {
      const w = this.world, car = this.car;
      const d = U.dist(car.x, car.y, w.vip.x, w.vip.y);
      const rangePx = CFG.BEACON_RANGE * CFG.TILE;
      const intensity = U.clamp(1 - d / rangePx, 0, 1);

      const worldAng = Math.atan2(w.vip.y - car.y, w.vip.x - car.x);
      // In north-up mode screen angle == world angle; in first-person and the
      // rotating cockpit the view is aligned to the heading, so the compass
      // points relative to where the car is facing.
      const screenAng = (this.settings.rotateView || this.settings.firstPerson)
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
      // bonus: faster rescues + fewer falls score higher
      const timeBonus = Math.max(0, 600 - Math.floor(this.elapsedMs / 1000) * 3);
      const fallPenalty = (this.falls || 0) * 50;
      this.finalScore = Math.max(0, this.score + timeBonus - fallPenalty);
      // best time
      const prev = Number(localStorage.getItem(this._bestKey()) || 0);
      const newBest = (!prev || this.elapsedMs < prev);
      if (newBest) { try { localStorage.setItem(this._bestKey(), String(Math.round(this.elapsedMs))); } catch (e) { /**/ } }
      this._recordStats(true);
      this._haptic([40, 40, 80]);
      this._seedFireworks();
      this._renderEndCard(newBest);
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
      s.totalFalls = (s.totalFalls || 0) + (this.falls || 0);
      s.totalTimeMs += Math.round(this.elapsedMs);
      this._saveStats();
    }

    // Only a win card now: a void fall restarts you in-place, so a run can
    // no longer end in failure.
    _renderEndCard(newBest) {
      const card = this.overlay.querySelector(".overlay-card");
      const time = this.dashboard._fmtTime(this.elapsedMs);
      card.innerHTML = `
        <h1 class="overlay-title win">VIP RESCUED!</h1>
        <p class="overlay-sub">MISSION COMPLETE</p>
        <div class="stat-grid">
          <div><span>TIME</span><b>${time}${newBest ? " &#11088;" : ""}</b></div>
          <div><span>SCORE</span><b>${this.finalScore}</b></div>
          <div><span>VOID FALLS</span><b>${this.falls || 0}</b></div>
          <div><span>THREATS DOWN</span><b>${this.kills}</b></div>
          <div><span>GEMS</span><b>${this.cells}</b></div>
          <div><span>PED. HITS</span><b>${this.pedestrianHits}</b></div>
        </div>
        ${newBest ? '<p class="overlay-best new">NEW BEST TIME!</p>' : ""}
        ${this._lifetimeRow()}
        <button id="again-btn" class="big-btn">PLAY AGAIN</button>
        <button id="menu-btn" class="text-btn">Change difficulty</button>`;
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
      const shakeAmt = (this.settings.shake && !this.settings.reducedMotion) ? this.shake : 0;
      const sxk = (Math.random() - 0.5) * shakeAmt;
      const syk = (Math.random() - 0.5) * shakeAmt;

      // First-person windshield (pseudo-3D raycaster) — the default view.
      if (this.settings.firstPerson) {
        this.viewCx = W / 2; this.viewCy = H / 2;
        this._renderFirstPerson(ctx, W, H, sxk, syk);
        if (!this.settings.reducedMotion && (this.speedMode === "FAST" || this.boost.active)) {
          this._renderSpeedLines(ctx, W / 2, H / 2);
        }
        if (!this._vignetteGrad) this._buildViewGradients();
        ctx.fillStyle = this._vignetteGrad; ctx.fillRect(0, 0, W, H);
        this._renderFallFade(ctx, W, H);
        return;
      }

      const rotate = this.settings.rotateView;
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
      this._renderFallFade(ctx, W, H);
    }

    // fade to black while plunging into a void, lifting as you respawn
    _renderFallFade(ctx, W, H) {
      if (this.falling <= 0) return;
      const p = 1 - this.falling / FALL_TICKS;
      ctx.fillStyle = "rgba(0,0,0," + (p * 0.92).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }

    _renderIdle(ctx, W, H) {
      // subtle moving grid behind the intro menu (jungle tint)
      ctx.strokeStyle = "rgba(57,255,136,0.06)";
      ctx.lineWidth = 1;
      const off = (performance.now() / 40) % 48;
      for (let x = -48 + off; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = -48 + off; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }

    // ============================================================
    // First-person pseudo-3D (raycaster). You're inside the car
    // looking down the jungle corridor; walls recede ahead, cars /
    // monsters / people grow as they approach, and a wrong turn
    // opens onto a void.
    // ============================================================
    _renderFirstPerson(ctx, W, H, sxk, syk) {
      const w = this.world, car = this.car, T = CFG.TILE;
      if (!this._fpCanopy) this._buildViewGradients();
      if (!this._jungleWall) this._buildJungleTextures();
      if (!this._spr) this._buildBillboards();

      // a little vertical bob from shake / jumping for "in the seat" feel;
      // during a void fall the whole view plunges downward
      const lift = this.jump.active
        ? Math.sin((1 - this.jump.timer / CFG.JUMP_DURATION) * Math.PI) * 40 : 0;
      const fallP = this.falling > 0 ? 1 - this.falling / FALL_TICKS : 0;
      const horizon = Math.round(H * 0.52 + syk - lift - fallP * H * 0.45);

      // canopy + forest floor
      ctx.fillStyle = this._fpCanopy; ctx.fillRect(0, 0, W, Math.max(0, horizon));
      ctx.fillStyle = this._fpFloor; ctx.fillRect(0, Math.max(0, horizon), W, H - horizon);

      const FOV = Math.PI / 3;                 // 60° field of view
      const focal = (W / 2) / Math.tan(FOV / 2);
      const tanH = Math.tan(FOV / 2);
      const STEP = 2;                          // px per cast column
      const cols = Math.ceil(W / STEP);
      if (!this._zbuf || this._zbuf.length < cols) this._zbuf = new Float32Array(cols);
      const zbuf = this._zbuf;

      const tex = this._jungleWall, voidTex = this._voidEdge;
      const posX = car.x / T, posY = car.y / T;
      const maxFog = 9 * T; // full darkness distance

      // scrolling floor bands: anchored to world distance along the heading,
      // so they stream toward you as you drive — the main sense of speed
      if (!this.settings.reducedMotion) {
        const spacing = T * 0.75;
        const proj = car.x * Math.cos(car.angle) + car.y * Math.sin(car.angle);
        const off = spacing - (((proj % spacing) + spacing) % spacing);
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        for (let m = 0; m < 14; m++) {
          const d = off + m * spacing;
          if (d < 10) continue;
          const y = horizon + (focal * (T / 2)) / d;
          if (y > H || y < horizon) continue;
          ctx.globalAlpha = U.clamp(1 - d / maxFog, 0.04, 0.5);
          ctx.lineWidth = Math.max(1, (focal * 4) / d);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      for (let i = 0; i < cols; i++) {
        const sx = i * STEP;
        const camX = ((sx + STEP / 2) / W) * 2 - 1;     // -1 .. 1
        const rayAng = car.angle + Math.atan(camX * tanH);
        const dirX = Math.cos(rayAng), dirY = Math.sin(rayAng);

        let mapX = Math.floor(posX), mapY = Math.floor(posY);
        const deltaX = dirX === 0 ? 1e30 : Math.abs(1 / dirX);
        const deltaY = dirY === 0 ? 1e30 : Math.abs(1 / dirY);
        let stepX, stepY, sideDistX, sideDistY;
        if (dirX < 0) { stepX = -1; sideDistX = (posX - mapX) * deltaX; }
        else { stepX = 1; sideDistX = (mapX + 1 - posX) * deltaX; }
        if (dirY < 0) { stepY = -1; sideDistY = (posY - mapY) * deltaY; }
        else { stepY = 1; sideDistY = (mapY + 1 - posY) * deltaY; }

        let side = 0, hit = false, guard = 0;
        let voidDist = -1;
        while (!hit && guard++ < 64) {
          if (sideDistX < sideDistY) { sideDistX += deltaX; mapX += stepX; side = 0; }
          else { sideDistY += deltaY; mapY += stepY; side = 1; }
          if (mapX < 0 || mapY < 0 || mapX >= w.gw || mapY >= w.gh) { hit = true; break; }
          const g = w.grid[mapY][mapX];
          if (g === 1) hit = true;
          else if (g === 2 && voidDist < 0) {
            voidDist = (side === 0 ? sideDistX - deltaX : sideDistY - deltaY) * T;
          }
        }
        const perp = (side === 0 ? sideDistX - deltaX : sideDistY - deltaY);
        const distPx = Math.max(1, perp * T);
        zbuf[i] = distPx;

        const sliceH = (focal * T) / distPx;
        const top = horizon - sliceH * 0.5;

        // textured wall column
        let wallX = side === 0 ? posY + perp * dirY : posX + perp * dirX;
        wallX -= Math.floor(wallX);
        let texX = Math.floor(wallX * tex.width);
        if ((side === 0 && dirX > 0) || (side === 1 && dirY < 0)) texX = tex.width - texX - 1;
        ctx.drawImage(tex, texX, 0, 1, tex.height, sx, top, STEP, sliceH);

        // distance fog + side shading
        const fog = U.clamp(distPx / maxFog, 0, 0.82) * (side === 1 ? 1 : 0.82);
        if (fog > 0.01) {
          ctx.fillStyle = "rgba(4,10,6," + fog.toFixed(3) + ")";
          ctx.fillRect(sx, top, STEP, sliceH);
        }

        // a void ahead: paint the floor of this column as a dark abyss
        if (voidDist > 0) {
          const wallBottom = top + sliceH;
          const rimY = horizon + (focal * (T / 2)) / Math.max(1, voidDist);
          const abyssTop = Math.max(horizon, wallBottom);
          if (rimY > abyssTop) {
            ctx.drawImage(voidTex, 0, 0, voidTex.width, voidTex.height, sx, abyssTop, STEP, rimY - abyssTop);
          }
        }
      }

      // ---- billboard sprites (entities, VIP, gems, obstacles) ----
      const cosA = Math.cos(car.angle), sinA = Math.sin(car.angle);
      const list = [];
      // vOff lifts the sprite off the ground (world px); wScale squashes the
      // width (used to make gems spin)
      const add = (x, y, img, worldH, floatY, vOff = 0, wScale = 1) => {
        const dx = x - car.x, dy = y - car.y;
        const depth = dx * cosA + dy * sinA;       // forward distance (px)
        if (depth < 12) return;                    // behind / on top of camera
        const sideways = -dx * sinA + dy * cosA;
        const screenX = W / 2 + (sideways / depth) * focal;
        const spriteH = (focal * worldH) / depth;
        const spriteW = spriteH * (img.width / img.height) * wScale;
        if (screenX + spriteW < 0 || screenX - spriteW > W) return;
        // feet on the floor; floating things (gems) ride at eye level
        const feetY = horizon + (focal * (T / 2)) / depth;
        let topY = floatY ? horizon - spriteH / 2 : feetY - spriteH;
        topY -= (focal * vOff) / depth;
        list.push({ depth, screenX, spriteW, spriteH, topY, img });
      };

      for (const o of w.obstacles) {
        const c = w.tileCenter(o.gx, o.gy);
        add(c.x, c.y, this._spr.log, T * 0.55, false);
      }
      for (const p of w.pickups) {
        if (p.taken) continue;
        p.bob += 0.08;
        // bob up and down and spin like a collectible should
        add(p.x, p.y, this._spr.gem, T * 0.5, true,
          Math.sin(p.bob) * 7, 0.35 + 0.65 * Math.abs(Math.cos(p.bob)));
      }
      for (const e of w.entities) {
        if (!e.alive) continue;
        const img = e.type === "driver" ? this._spr.car
          : e.type === "creature" ? this._spr.monster : this._spr.human;
        const wh = e.type === "driver" ? T * 0.85 : e.type === "creature" ? T * 0.95 : T * 1.0;
        // humans get a little walk-bounce; monsters a heavier lumber
        const bob = e.type === "pedestrian" ? Math.abs(Math.sin(e.wobble * 2)) * 3
          : e.type === "creature" ? Math.abs(Math.sin(e.wobble)) * 2 : 0;
        add(e.x, e.y, img, wh, false, bob);
      }
      w.vip.bob += 0.06;
      add(w.vip.x, w.vip.y, this._spr.vip, T * 1.05, false, Math.abs(Math.sin(w.vip.bob)) * 3);

      list.sort((a, b) => b.depth - a.depth); // far → near
      for (const s of list) this._blitBillboard(ctx, s, STEP);

      // explosions / sparkles projected into the scene (kills, gems, scrapes)
      for (const ex of this.explosions) {
        const dx = ex.x - car.x, dy = ex.y - car.y;
        const depth = dx * cosA + dy * sinA;
        if (depth < 12) continue;
        const sideways = -dx * sinA + dy * cosA;
        const screenX = W / 2 + (sideways / depth) * focal;
        const ci = Math.floor(screenX / STEP);
        if (ci < 0 || ci >= cols || depth >= zbuf[ci]) continue;
        const scale = focal / depth;
        const baseY = horizon + (focal * (T * 0.18)) / depth;
        const f = ex.timer / ex.max;
        const palette = [ex.color, "#ffffff", "#ffb627", "#ffe9a8"];
        ctx.globalAlpha = f;
        ex.bits.forEach((b, i) => {
          ctx.fillStyle = palette[i % palette.length];
          const s = Math.max(1.2, b.size * f * scale * 0.5);
          ctx.fillRect(screenX + (b.x - ex.x) * scale, baseY + (b.y - ex.y) * scale * 0.6, s, s);
        });
        ctx.globalAlpha = 1;
      }

      // laser: twin bolts from the fenders converging down-range
      if (this.laser.beam && this.laser.beam.life > 0) {
        const a = this.laser.beam.life / 12;
        const hitY = horizon + 6;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.lineCap = "round";
        for (const xo of [0.32, 0.68]) {
          ctx.strokeStyle = "rgba(255,43,214,0.55)"; ctx.lineWidth = 7;
          ctx.shadowColor = "#ff2bd6"; ctx.shadowBlur = 16;
          ctx.beginPath(); ctx.moveTo(W * xo, H * 0.84); ctx.lineTo(W / 2, hitY); ctx.stroke();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(W * xo, H * 0.84); ctx.lineTo(W / 2, hitY); ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#ffe9ff";
        ctx.beginPath(); ctx.arc(W / 2, hitY, 5 * a + 2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // ---- cockpit: hood + windshield pillars so you feel seated inside ----
      this._renderCockpit(ctx, W, H, horizon);
    }

    // draw one billboard with per-column wall occlusion via the z-buffer
    _blitBillboard(ctx, s, STEP) {
      const left = s.screenX - s.spriteW / 2;
      const img = s.img;
      for (let x = Math.floor(left); x < left + s.spriteW; x += STEP) {
        if (x < 0 || x >= this.vw) continue;
        const ci = Math.floor(x / STEP);
        if (s.depth >= (this._zbuf[ci] || 1e30)) continue; // hidden behind a wall
        const u = (x - left) / s.spriteW;
        const srcX = U.clamp(Math.floor(u * img.width), 0, img.width - 1);
        ctx.drawImage(img, srcX, 0, 1, img.height, x, s.topY, STEP, s.spriteH);
      }
    }

    _renderCockpit(ctx, W, H, horizon) {
      // subtle darkened windshield pillars
      ctx.fillStyle = "rgba(6,10,16,0.85)";
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(W * 0.13, 0); ctx.lineTo(0, H * 0.5); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(W, 0); ctx.lineTo(W * 0.87, 0); ctx.lineTo(W, H * 0.5); ctx.closePath(); ctx.fill();
      // hood / dashboard lip at the bottom
      const hoodTop = H * 0.82;
      if (!this._hoodGrad) this._buildViewGradients();
      ctx.fillStyle = this._hoodGrad;
      ctx.beginPath();
      ctx.moveTo(0, H); ctx.lineTo(0, hoodTop + 14);
      ctx.quadraticCurveTo(W / 2, hoodTop - 18, W, hoodTop + 14);
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      // hood centre seam + a glint
      ctx.strokeStyle = "rgba(120,180,255,0.18)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(W / 2, hoodTop - 6); ctx.lineTo(W / 2, H); ctx.stroke();
    }

    // B1/B2: jungle wall texture (sampled per ray column) + void abyss strip
    _buildJungleTextures() {
      const T = CFG.TILE;
      const wc = document.createElement("canvas"); wc.width = T; wc.height = T;
      const c = wc.getContext("2d");
      const g = c.createLinearGradient(0, 0, 0, T);
      g.addColorStop(0, "#0c2a14"); g.addColorStop(0.5, "#15331b"); g.addColorStop(1, "#0a1f10");
      c.fillStyle = g; c.fillRect(0, 0, T, T);
      // mossy stone blocks
      c.fillStyle = "rgba(40,60,38,0.6)";
      for (let yy = 0; yy < T; yy += 16) {
        const off = (yy / 16) % 2 === 0 ? 0 : 12;
        for (let xx = -12; xx < T; xx += 24) {
          c.fillRect(xx + off + 1, yy + 1, 22, 14);
        }
      }
      // vines + leaves
      for (let n = 0; n < 26; n++) {
        const lx = Math.random() * T, ly = Math.random() * T;
        c.fillStyle = `rgba(${30 + U.rand(40)},${90 + U.rand(80)},${40 + U.rand(40)},0.7)`;
        c.beginPath(); c.ellipse(lx, ly, 3 + Math.random() * 4, 1.5 + Math.random() * 2,
          Math.random() * Math.PI, 0, Math.PI * 2); c.fill();
      }
      c.strokeStyle = "rgba(20,40,20,0.5)"; c.lineWidth = 2;
      for (let n = 0; n < 3; n++) {
        const vx = U.rand(T);
        c.beginPath(); c.moveTo(vx, 0);
        for (let yy = 0; yy < T; yy += 8) c.lineTo(vx + Math.sin(yy * 0.3) * 5, yy);
        c.stroke();
      }
      this._jungleWall = wc;

      // void abyss vertical strip (dark with a faint hot rim at the top)
      const vc = document.createElement("canvas"); vc.width = 2; vc.height = 64;
      const v = vc.getContext("2d");
      const vg = v.createLinearGradient(0, 0, 0, 64);
      vg.addColorStop(0, "rgba(120,30,40,0.85)"); // rim glow at the near edge
      vg.addColorStop(0.12, "#0a0205");
      vg.addColorStop(1, "#000000");
      v.fillStyle = vg; v.fillRect(0, 0, 2, 64);
      this._voidEdge = vc;
    }

    // B3-B7: realistic-ish billboard sprites, drawn once, facing the camera
    _buildBillboards() {
      this._spr = {
        car: this._makeCarSprite(),
        monster: this._makeMonsterSprite(),
        human: this._makeHumanSprite(false),
        vip: this._makeHumanSprite(true),
        gem: this._makeGemSprite(),
        log: this._makeLogSprite()
      };
    }

    _makeCarSprite() {
      const cv = document.createElement("canvas"); cv.width = 96; cv.height = 96;
      const c = cv.getContext("2d");
      // shadow
      c.fillStyle = "rgba(0,0,0,0.35)"; c.beginPath();
      c.ellipse(48, 90, 38, 7, 0, 0, Math.PI * 2); c.fill();
      // body (aggressive front view) — dark red with shading
      const bg = c.createLinearGradient(0, 30, 0, 86);
      bg.addColorStop(0, "#b71f24"); bg.addColorStop(0.5, "#7c1216"); bg.addColorStop(1, "#3c0809");
      c.fillStyle = bg; c.strokeStyle = "#1a0203"; c.lineWidth = 2;
      this._roundRect(c, 12, 34, 72, 52, 10); c.fill(); c.stroke();
      // hood scoop
      c.fillStyle = "#250405"; this._roundRect(c, 38, 30, 20, 12, 3); c.fill();
      // windshield
      const ws = c.createLinearGradient(0, 38, 0, 58);
      ws.addColorStop(0, "#0a1822"); ws.addColorStop(1, "#33637a");
      c.fillStyle = ws; this._roundRect(c, 22, 40, 52, 18, 5); c.fill();
      // grille
      c.fillStyle = "#0a0506"; this._roundRect(c, 30, 62, 36, 16, 3); c.fill();
      c.strokeStyle = "#555"; c.lineWidth = 1;
      for (let gx = 34; gx < 66; gx += 5) { c.beginPath(); c.moveTo(gx, 63); c.lineTo(gx, 77); c.stroke(); }
      // bull bar
      c.strokeStyle = "#c9ccd2"; c.lineWidth = 4;
      c.beginPath(); c.moveTo(20, 80); c.lineTo(76, 80); c.stroke();
      c.lineWidth = 3;
      c.beginPath(); c.moveTo(30, 72); c.lineTo(30, 86); c.moveTo(66, 72); c.lineTo(66, 86); c.stroke();
      // glaring headlights
      for (const hx of [26, 70]) {
        const hg = c.createRadialGradient(hx, 60, 1, hx, 60, 9);
        hg.addColorStop(0, "#fffce0"); hg.addColorStop(1, "rgba(255,210,90,0)");
        c.fillStyle = hg; c.beginPath(); c.arc(hx, 60, 9, 0, Math.PI * 2); c.fill();
        c.fillStyle = "#fff7c2"; c.beginPath(); c.arc(hx, 60, 3.5, 0, Math.PI * 2); c.fill();
      }
      return cv;
    }

    _makeMonsterSprite() {
      const cv = document.createElement("canvas"); cv.width = 96; cv.height = 96;
      const c = cv.getContext("2d");
      c.fillStyle = "rgba(0,0,0,0.35)"; c.beginPath();
      c.ellipse(48, 91, 30, 6, 0, 0, Math.PI * 2); c.fill();
      // hunched beast body
      const bg = c.createLinearGradient(0, 24, 0, 90);
      bg.addColorStop(0, "#3c5a2a"); bg.addColorStop(0.6, "#274019"); bg.addColorStop(1, "#142309");
      c.fillStyle = bg; c.strokeStyle = "#0c1606"; c.lineWidth = 2;
      c.beginPath(); c.ellipse(48, 60, 30, 30, 0, 0, Math.PI * 2); c.fill(); c.stroke();
      // shoulders / arms
      c.beginPath(); c.ellipse(20, 64, 12, 18, 0.3, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(76, 64, 12, 18, -0.3, 0, Math.PI * 2); c.fill();
      // clawed hands
      c.fillStyle = "#0c1606";
      for (const hx of [16, 80]) {
        for (let k = -1; k <= 1; k++) { c.beginPath(); c.moveTo(hx + k * 4, 80); c.lineTo(hx + k * 4, 90); c.lineWidth = 2; c.stroke(); }
      }
      // head
      c.fillStyle = "#33501f"; c.beginPath(); c.ellipse(48, 36, 18, 16, 0, 0, Math.PI * 2); c.fill(); c.stroke();
      // horns
      c.fillStyle = "#d8cdb0"; c.strokeStyle = "#7a6f55";
      c.beginPath(); c.moveTo(34, 26); c.lineTo(26, 8); c.lineTo(40, 22); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(62, 26); c.lineTo(70, 8); c.lineTo(56, 22); c.closePath(); c.fill();
      // glowing eyes
      for (const ex of [41, 55]) {
        const eg = c.createRadialGradient(ex, 36, 0.5, ex, 36, 6);
        eg.addColorStop(0, "#fff2a0"); eg.addColorStop(0.5, "#ff8a1e"); eg.addColorStop(1, "rgba(255,60,0,0)");
        c.fillStyle = eg; c.beginPath(); c.arc(ex, 36, 6, 0, Math.PI * 2); c.fill();
        c.fillStyle = "#1a0a00"; c.beginPath(); c.arc(ex, 36, 1.6, 0, Math.PI * 2); c.fill();
      }
      // fangs
      c.fillStyle = "#fff";
      c.beginPath(); c.moveTo(43, 46); c.lineTo(46, 54); c.lineTo(48, 46); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(48, 46); c.lineTo(50, 54); c.lineTo(53, 46); c.closePath(); c.fill();
      return cv;
    }

    _makeHumanSprite(isVip) {
      const cv = document.createElement("canvas"); cv.width = 56; cv.height = 96;
      const c = cv.getContext("2d");
      c.fillStyle = "rgba(0,0,0,0.3)"; c.beginPath();
      c.ellipse(28, 92, 16, 5, 0, 0, Math.PI * 2); c.fill();
      if (isVip) { // glowing ground ring
        const rg = c.createRadialGradient(28, 90, 4, 28, 90, 22);
        rg.addColorStop(0, "rgba(255,215,80,0.5)"); rg.addColorStop(1, "rgba(255,215,80,0)");
        c.fillStyle = rg; c.beginPath(); c.ellipse(28, 90, 22, 8, 0, 0, Math.PI * 2); c.fill();
      }
      const shirt = isVip ? "#ffd24a" : "#3f7ec4";
      const pants = isVip ? "#5a4a14" : "#2b3a52";
      const skin = "#e8b07a";
      // legs
      c.fillStyle = pants;
      this._roundRect(c, 20, 60, 7, 28, 3); c.fill();
      this._roundRect(c, 29, 60, 7, 28, 3); c.fill();
      // torso
      c.fillStyle = shirt; this._roundRect(c, 16, 34, 24, 30, 7); c.fill();
      // arms
      c.fillStyle = shirt;
      this._roundRect(c, 10, 36, 7, 22, 3); c.fill();
      if (isVip) { // waving arm raised
        c.save(); c.translate(43, 38); c.rotate(-0.6);
        this._roundRect(c, 0, -4, 7, 22, 3); c.fill(); c.restore();
      } else {
        this._roundRect(c, 39, 36, 7, 22, 3); c.fill();
      }
      // hands
      c.fillStyle = skin;
      c.beginPath(); c.arc(13, 58, 4, 0, Math.PI * 2); c.fill();
      // head
      c.fillStyle = skin; c.beginPath(); c.arc(28, 22, 11, 0, Math.PI * 2); c.fill();
      // hair
      c.fillStyle = isVip ? "#3a2a12" : "#23344a";
      c.beginPath(); c.arc(28, 19, 11, Math.PI, 0); c.fill();
      // eyes
      c.fillStyle = "#1a1208";
      c.beginPath(); c.arc(24, 23, 1.4, 0, Math.PI * 2); c.arc(32, 23, 1.4, 0, Math.PI * 2); c.fill();
      if (isVip) {
        c.fillStyle = "#fff"; c.font = "bold 12px Consolas, monospace"; c.textAlign = "center";
        c.fillText("VIP", 28, 8);
      }
      return cv;
    }

    _makeGemSprite() {
      const cv = document.createElement("canvas"); cv.width = 40; cv.height = 48;
      const c = cv.getContext("2d");
      const g = c.createLinearGradient(0, 6, 0, 42);
      g.addColorStop(0, "#b6ffd0"); g.addColorStop(0.5, "#39ff88"); g.addColorStop(1, "#0f9a4e");
      c.fillStyle = g; c.strokeStyle = "#eafff2"; c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(20, 4); c.lineTo(34, 18); c.lineTo(20, 44); c.lineTo(6, 18); c.closePath();
      c.fill(); c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.6)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(20, 4); c.lineTo(20, 44); c.moveTo(6, 18); c.lineTo(34, 18); c.stroke();
      return cv;
    }

    _makeLogSprite() {
      const cv = document.createElement("canvas"); cv.width = 80; cv.height = 48;
      const c = cv.getContext("2d");
      c.fillStyle = "rgba(0,0,0,0.3)"; c.beginPath(); c.ellipse(40, 44, 34, 5, 0, 0, Math.PI * 2); c.fill();
      const g = c.createLinearGradient(0, 12, 0, 44);
      g.addColorStop(0, "#7a5230"); g.addColorStop(1, "#3c2814");
      c.fillStyle = g; c.strokeStyle = "#2a1c0e"; c.lineWidth = 2;
      this._roundRect(c, 6, 16, 68, 26, 12); c.fill(); c.stroke();
      // end rings
      c.fillStyle = "#9c6b3f"; c.beginPath(); c.ellipse(12, 29, 6, 13, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#5c3c1e"; c.beginPath(); c.ellipse(12, 29, 3, 7, 0, 0, Math.PI * 2); c.stroke();
      return cv;
    }

    _renderWorld(ctx) {
      const w = this.world, T = CFG.TILE, car = this.car, range = 9;
      const cgx = Math.floor(car.x / T), cgy = Math.floor(car.y / T);
      for (let gy = cgy - range; gy <= cgy + range; gy++) {
        for (let gx = cgx - range; gx <= cgx + range; gx++) {
          if (gx < 0 || gy < 0 || gx >= w.gw || gy >= w.gh) continue;
          const x = gx * T, y = gy * T;
          const gval = w.grid[gy][gx];
          if (gval === 1) this._drawWall(ctx, x, y, T);
          else if (gval === 2) this._drawVoidTile(ctx, x, y);
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

    _drawVoidTile(ctx, x, y) {
      if (!this._voidTile) this._buildTiles();
      ctx.drawImage(this._voidTile, x, y);
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

    // small human figure used for both the VIP and pedestrians in top-down
    _drawHumanFigure(ctx, stepP, shirt, pants, waving) {
      // legs (scissor as they walk)
      ctx.strokeStyle = pants; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-2, 4); ctx.lineTo(-2 - stepP * 3, 11);
      ctx.moveTo(2, 4); ctx.lineTo(2 + stepP * 3, 11);
      ctx.stroke();
      // arms (swing opposite to legs; one raised if waving)
      ctx.strokeStyle = shirt; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-5, -3); ctx.lineTo(-7, 2 + stepP * 2);
      if (waving) { ctx.moveTo(5, -3); ctx.lineTo(9, -12); }
      else { ctx.moveTo(5, -3); ctx.lineTo(7, 2 - stepP * 2); }
      ctx.stroke();
      // torso
      ctx.fillStyle = shirt;
      this._roundRect(ctx, -5, -6, 10, 12, 4); ctx.fill();
      // head + hair
      ctx.fillStyle = "#e8b07a"; ctx.beginPath(); ctx.arc(0, -10, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#23344a"; ctx.beginPath(); ctx.arc(0, -11.5, 4.5, Math.PI, 0); ctx.fill();
    }

    _drawVip(ctx, x, y, bob) {
      ctx.save(); ctx.translate(x, y + Math.sin(bob) * 3);
      const pr = 22 + Math.sin(bob * 1.5) * 4;
      ctx.strokeStyle = "rgba(255,215,80,0.8)"; ctx.lineWidth = 3;
      ctx.shadowColor = "#ffd750"; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(0, 0, pr, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      this._drawHumanFigure(ctx, Math.sin(bob * 2) * 0.4, "#ffd24a", "#5a4a14", true);
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px Consolas, monospace"; ctx.textAlign = "center";
      ctx.fillText("VIP", 0, -20);
      ctx.restore();
    }

    _drawPedestrian(ctx, e) {
      ctx.save(); ctx.translate(e.x, e.y);
      this._drawHumanFigure(ctx, Math.sin(e.wobble * 2), "#3f7ec4", "#243248", false);
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
