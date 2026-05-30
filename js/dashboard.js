/* ============================================================
   dashboard.js — Steering wheel, speed/action buttons, cooldown
   meters, HUD, and the tactical mini-map (explored breadcrumb
   trail + viewport cone, VIP always hidden).
   (Improvements #15, #16)
   ============================================================ */

window.MMR = window.MMR || {};
(function (M) {
  "use strict";

  const U = M.U;
  const CFG = M.CONFIG;
  const MAX_WHEEL = Math.PI * 0.72;

  class Dashboard {
    constructor(game) {
      this.game = game;
      this.wheel = document.getElementById("wheel");
      this.wctx = this.wheel.getContext("2d");
      this.minimap = document.getElementById("minimap");
      this.mctx = this.minimap.getContext("2d");

      this.speedBtns = Array.from(document.querySelectorAll(".speed-btn"));
      this.laserBtn = document.getElementById("laser-btn");
      this.jumpBtn = document.getElementById("jump-btn");
      this.boostBtn = document.getElementById("boost-btn");

      this.shieldFill = document.getElementById("shield-fill");
      this.boostFill = document.getElementById("boost-fill");
      this.speedReadout = document.getElementById("speed-readout");
      this.timeReadout = document.getElementById("time-readout");
      this.scoreReadout = document.getElementById("score-readout");
      this.distReadout = document.getElementById("dist-readout");
      this.warnReadout = document.getElementById("warn-readout");
      this.warnPill = document.getElementById("warn-pill");
      this.headingVal = document.getElementById("heading-val");

      this.laserCd = document.getElementById("laser-cd");
      this.jumpCd = document.getElementById("jump-cd");
      this.boostCd = document.getElementById("boost-cd");

      this._dragging = false;
      this._grabAngle = 0;
      this._grabSteer = 0;
      this._blink = 0;

      this._wireButtons();
      this._wireWheel();
    }

    _wireButtons() {
      this.speedBtns.forEach((b) =>
        b.addEventListener("click", () => this.game.setSpeedMode(b.dataset.speed)));
      this.laserBtn.addEventListener("click", () => this.game.fireLaser());
      this.jumpBtn.addEventListener("click", () => this.game.doJump());
      this.boostBtn.addEventListener("click", () => this.game.boostBurst());
    }

    setActiveSpeed(mode) {
      this.speedBtns.forEach((b) => b.classList.toggle("active", b.dataset.speed === mode));
      this.speedReadout.textContent = mode;
    }

    flashLaser() { this._flash(this.laserBtn, 160); }
    flashJump()  { this._flash(this.jumpBtn, 220); }
    flashBoost() { this._flash(this.boostBtn, 220); }
    _flash(btn, ms) { btn.classList.add("fire"); setTimeout(() => btn.classList.remove("fire"), ms); }

    // Cooldown / charge meters (Improvement #15)
    updateCooldowns(game) {
      const laserPct = 1 - game.laser.cooldown / CFG.LASER_COOLDOWN;
      this.laserCd.style.width = (U.clamp(laserPct, 0, 1) * 100) + "%";
      this.laserBtn.classList.toggle("ready", laserPct >= 1);

      const jumpPct = game.jump.active ? 0 : 1 - game.jump.cooldown / CFG.JUMP_COOLDOWN;
      this.jumpCd.style.width = (U.clamp(jumpPct, 0, 1) * 100) + "%";
      this.jumpBtn.classList.toggle("ready", jumpPct >= 1 && !game.jump.active);

      const boostPct = game.boost.meter / game.boost.max;
      this.boostCd.style.width = (U.clamp(boostPct, 0, 1) * 100) + "%";
      this.boostBtn.classList.toggle("active", game.boost.active);
      this.boostBtn.classList.toggle("ready", boostPct >= 1);
    }

    _wireWheel() {
      const pointerAngle = (ev) => {
        const r = this.wheel.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const p = ev.touches ? ev.touches[0] : ev;
        return Math.atan2(p.clientY - cy, p.clientX - cx);
      };
      const down = (ev) => {
        this._dragging = true;
        this.wheel.classList.add("grabbing");
        this._grabAngle = pointerAngle(ev);
        this._grabSteer = this.game.steer;
        ev.preventDefault();
      };
      const move = (ev) => {
        if (!this._dragging) return;
        const delta = pointerAngle(ev) - this._grabAngle;
        this.game.steer = U.clamp(this._grabSteer + delta / MAX_WHEEL, -1, 1);
        this.game.steerHeld = true;
        ev.preventDefault();
      };
      const up = () => {
        if (!this._dragging) return;
        this._dragging = false;
        this.wheel.classList.remove("grabbing");
        this.game.steerHeld = false;
      };
      this.wheel.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      this.wheel.addEventListener("touchstart", down, { passive: false });
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
    }

    updateHud(game) {
      const sp = U.clamp(game.shield / CFG.SHIELD_MAX, 0, 1);
      this.shieldFill.style.width = (sp * 100) + "%";
      this.shieldFill.style.background =
        sp > 0.5 ? "linear-gradient(90deg,#39ff88,#2ff3ff)"
        : sp > 0.25 ? "linear-gradient(90deg,#ffb627,#ff7b2f)"
        : "linear-gradient(90deg,#ff3b53,#ff7b2f)";

      this.boostFill.style.width = (U.clamp(game.boost.meter / game.boost.max, 0, 1) * 100) + "%";
      this.warnReadout.textContent = game.pedestrianHits;
      this.scoreReadout.textContent = game.score;
      this.timeReadout.textContent = this._fmtTime(game.elapsedMs);

      if (game.world && game.world.vip) {
        const d = U.dist(game.car.x, game.car.y, game.world.vip.x, game.world.vip.y);
        this.distReadout.textContent = Math.round(d / CFG.TILE) + " blk";
      }
      this.headingVal.textContent = this._compass(game.car.angle);
    }

    _fmtTime(ms) {
      const s = Math.floor(ms / 1000);
      return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }

    flashWarning() {
      this.warnPill.classList.remove("flash");
      void this.warnPill.offsetWidth;
      this.warnPill.classList.add("flash");
    }

    _compass(angle) {
      let deg = (angle * 180 / Math.PI) % 360;
      if (deg < 0) deg += 360;
      return ["E", "SE", "S", "SW", "W", "NW", "N", "NE"][Math.round(deg / 45) % 8];
    }

    drawWheel(steer) {
      const ctx = this.wctx;
      const w = this.wheel.width, h = this.wheel.height;
      const R = 92;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(steer * MAX_WHEEL);

      ctx.lineWidth = 18; ctx.strokeStyle = "#10203a";
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

      ctx.lineWidth = 10;
      const rg = ctx.createLinearGradient(-R, -R, R, R);
      rg.addColorStop(0, "#3df0ff"); rg.addColorStop(0.5, "#1b9fd8"); rg.addColorStop(1, "#2ff3ff");
      ctx.strokeStyle = rg; ctx.shadowColor = "rgba(47,243,255,0.7)"; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;

      const spoke = (ang) => {
        ctx.save(); ctx.rotate(ang);
        ctx.fillStyle = "#22304f"; ctx.strokeStyle = "#3df0ff"; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-9, 0); ctx.lineTo(9, 0); ctx.lineTo(6, R - 12); ctx.lineTo(-6, R - 12);
        ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
      };
      spoke(0); spoke(Math.PI * 2 / 3); spoke(-Math.PI * 2 / 3);

      ctx.save();
      ctx.fillStyle = "#ff2bd6"; ctx.shadowColor = "#ff2bd6"; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(0, -R - 2); ctx.lineTo(-8, -R + 14); ctx.lineTo(8, -R + 14);
      ctx.closePath(); ctx.fill(); ctx.restore();

      const hub = ctx.createRadialGradient(0, -6, 4, 0, 0, 34);
      hub.addColorStop(0, "#39507e"); hub.addColorStop(1, "#0c1426");
      ctx.fillStyle = hub; ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#3df0ff"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#2ff3ff"; ctx.font = "bold 13px Consolas, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("UMD", 0, 0);
      ctx.restore();
    }

    // Mini-map: walls, explored breadcrumb, threats, pickups, viewport
    // cone, blinking player. The VIP is deliberately NOT shown.
    drawMinimap(world, car, explored) {
      const ctx = this.mctx;
      const w = this.minimap.width, h = this.minimap.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#021410"; ctx.fillRect(0, 0, w, h);

      const sx = w / world.gw, sy = h / world.gh;

      // explored breadcrumb glow (Improvement #16)
      if (explored && explored.size) {
        ctx.fillStyle = "rgba(57,255,136,0.10)";
        for (const key of explored) {
          const [gx, gy] = key.split(",").map(Number);
          ctx.fillRect((gx - 1) * sx, (gy - 1) * sy, sx * 3, sy * 3);
        }
      }

      // walls
      ctx.fillStyle = "rgba(47,243,255,0.55)";
      for (let gy = 0; gy < world.gh; gy++)
        for (let gx = 0; gx < world.gw; gx++)
          if (world.grid[gy][gx] === 1)
            ctx.fillRect(gx * sx, gy * sy, Math.ceil(sx), Math.ceil(sy));

      // obstacles
      ctx.fillStyle = "rgba(255,182,39,0.6)";
      for (const o of world.obstacles)
        ctx.fillRect(o.gx * sx + sx * 0.2, o.gy * sy + sy * 0.2, sx * 0.6, sy * 0.6);

      // shield pickups
      for (const p of world.pickups) {
        if (p.taken) continue;
        ctx.fillStyle = "rgba(57,255,136,0.95)";
        ctx.fillRect((p.x / world.pixelW) * w - 1.5, (p.y / world.pixelH) * h - 1.5, 3, 3);
      }

      // threats (drivers + creatures; never pedestrians or VIP)
      this._blink = (this._blink + 1) % 60;
      for (const e of world.entities) {
        if (!e.alive || e.type === "pedestrian") continue;
        ctx.fillStyle = e.type === "driver" ? "rgba(255,59,83,0.9)" : "rgba(255,120,60,0.8)";
        ctx.beginPath();
        ctx.arc((e.x / world.pixelW) * w, (e.y / world.pixelH) * h, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      const px = (car.x / world.pixelW) * w, py = (car.y / world.pixelH) * h;

      // viewport cone
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(car.angle);
      const cone = ctx.createLinearGradient(0, 0, 26, 0);
      cone.addColorStop(0, "rgba(47,243,255,0.35)");
      cone.addColorStop(1, "rgba(47,243,255,0)");
      ctx.fillStyle = cone;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.arc(0, 0, 26, -0.5, 0.5); ctx.closePath(); ctx.fill();
      ctx.restore();

      // blinking player dot
      if (this._blink < 38) {
        ctx.fillStyle = "#2ff3ff"; ctx.shadowColor = "#2ff3ff"; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  M.Dashboard = Dashboard;
})(window.MMR);
