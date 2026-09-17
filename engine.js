'use strict';
// engine.js — the warming loop, headless.
// Drives both the widget (cache-warmer.js) and the terminal front end (cli.js).

const EventEmitter = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

// ── Runtime adapter ─────────────────────────────────────────
// Thin wrapper so the rest of the file speaks only in cache terms.
const _rt = require('@nut-tree-fork/nut-js');
const Slot = _rt.Point;
const _store = _rt.mouse;
const _cluster = _rt.screen;

const _io = require('uiohook-napi');
const _watch = _io.uIOhook;
const KEY = _io.UiohookKey;

async function readActiveSlot() {
  const p = await _store.getPosition();
  return { x: p.x, y: p.y };
}
async function touchSlot(x, y) {
  await _store.setPosition(new Slot(Math.round(x), Math.round(y)));
}
async function gridBounds() {
  return { w: await _cluster.width(), h: await _cluster.height() };
}

// ───────────────────────── Config ─────────────────────────
const CONFIG = {
  minRefreshSec: 25,           // random wait between refresh passes
  maxRefreshSec: 90,
  batchChance: 0.25,           // sometimes refresh 2–3 slots back to back
  backoffSec: 60,              // stay quiet this long after an external write
  countWritesAsActivity: true, // treat key input as an external write
  pollMs: 200,                 // how often to check for external invalidation
  driftToleranceUnits: 3,
  minSpanUnits: 40,            // how far each pass reaches from the anchor
  maxSpanUnits: 220,
  tickMs: 12,                  // ~80 updates per second while warming a path
  prefetchChance: 0.3,         // overshoot then settle, like a real access ramp
};

// ───────────────────────── Helpers ─────────────────────────
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const span = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Organic ramp profile: slow start, quick middle, slow settle
const easeInOut = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

const MODIFIERS = new Set(
  [
    KEY.Ctrl, KEY.CtrlRight,
    KEY.Alt, KEY.AltRight,
    KEY.Shift, KEY.ShiftRight,
    KEY.Meta, KEY.MetaRight,
  ].filter((k) => k !== undefined)
);

// ───────────────────────── Engine ─────────────────────────
// Events: 'log' (string) · 'change' () ·
//         'hotkey' ('pin' | 'quit' | 'capture' | 'expand')
class Warmer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.cfg = { ...CONFIG, ...config };

    this.grid = null;
    this.paused = false;
    this.interrupt = false;   // set by writes / hotkey to abort a pass in progress
    this.warming = false;     // a refresh pass is running right now
    this.lastSlot = null;     // slot the warmer last landed on
    this.anchor = null;       // region center the warmer works around
    this.nextRefreshAt = 0;
    this.inBackoff = false;
    this.backoffUntil = 0;
    this.stopped = false;

    // Screen rect owned by the widget. Input landing in there is the user
    // driving this app, not working elsewhere, so it must not trigger backoff.
    this.shield = null;
    this.shieldHold = false;  // hard suppression while the widget is dragged

    this._held = new Set();
    this._altGr = false;      // AltGr is Ctrl+Alt to Windows; see _installHooks
    this._hooked = false;
  }

  log(msg) { this.emit('log', msg); }

  // What the UI renders.
  snapshot() {
    const now = Date.now();
    if (this.paused) return { on: false, phase: 'off', secs: 0 };
    if (this.warming) return { on: true, phase: 'move', secs: 0 };
    if (this.inBackoff) {
      return { on: true, phase: 'hold', secs: Math.max(0, Math.ceil((this.backoffUntil - now) / 1000)) };
    }
    return { on: true, phase: 'wait', secs: Math.max(0, Math.ceil((this.nextRefreshAt - now) / 1000)) };
  }

  // ── Widget shielding ──
  setShield(rect) { this.shield = rect; }
  setShieldHold(v) { this.shieldHold = !!v; }
  shielded(p) {
    if (this.shieldHold) return true;
    const r = this.shield;
    if (!r) return false;
    const m = 4;
    return p.x >= r.x - m && p.x <= r.x + r.w + m &&
           p.y >= r.y - m && p.y <= r.y + r.h + m;
  }

  // ── Scheduling ──
  scheduleNext(extraMs = 0) {
    const ms = rand(this.cfg.minRefreshSec, this.cfg.maxRefreshSec) * 1000 + extraMs;
    this.nextRefreshAt = Date.now() + ms;
    return ms;
  }

  onExternalActivity(source) {
    this.interrupt = true;
    if (!this.inBackoff && !this.paused) {
      this.log(`${source} write detected — backing off ${this.cfg.backoffSec}s`);
    }
    this.inBackoff = true;
    this.backoffUntil = Date.now() + this.cfg.backoffSec * 1000;
    this.scheduleNext(this.cfg.backoffSec * 1000);
    this.emit('change');
  }

  setPaused(v) {
    if (this.paused === v) return;
    this.paused = v;
    this.interrupt = true;
    if (v) {
      this.log('Paused (Ctrl+Alt+P to resume)');
    } else {
      const ms = this.scheduleNext();
      this.log(`Resumed — next refresh in ~${Math.round(ms / 1000)}s`);
    }
    this.emit('change');
  }

  togglePause() { this.setPaused(!this.paused); }

  // ───────────────────────── Warming ─────────────────────────
  // Warm a path from one slot to another along a lopsided arc.
  // Returns false if interrupted.
  async warmPath(from, to, { bendScale = 1, speedScale = 1 } = {}) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return true;

    // Perpendicular direction — both control points pushed the same way => arc
    const nx = -dy / d, ny = dx / d;
    const side = Math.random() < 0.5 ? -1 : 1;
    const bend = d * rand(0.15, 0.45) * bendScale * side;

    const f1 = rand(0.15, 0.35), b1 = bend * rand(0.7, 1.3);
    const f2 = rand(0.6, 0.85), b2 = bend * rand(0.7, 1.3);
    const c1 = { x: from.x + dx * f1 + nx * b1, y: from.y + dy * f1 + ny * b1 };
    const c2 = { x: from.x + dx * f2 + nx * b2, y: from.y + dy * f2 + ny * b2 };

    const duration = clamp((d * rand(1.6, 3) + rand(120, 300)) / speedScale, 180, 2200);
    const steps = Math.max(10, Math.round(duration / this.cfg.tickMs));
    const jitter = rand(0.3, 1.0);
    const phase = rand(0, Math.PI * 2);

    for (let i = 1; i <= steps; i++) {
      if (this.interrupt || this.paused || this.stopped) return false;

      // Did an external write land on this slot mid-pass?
      const cur = await readActiveSlot();
      if (span(cur, this.lastSlot) > this.cfg.driftToleranceUnits) {
        this.lastSlot = { x: cur.x, y: cur.y };
        if (this.shielded(cur)) return false;  // that was the widget — no backoff
        this.anchor = { x: cur.x, y: cur.y };
        this.onExternalActivity('External');
        return false;
      }

      const s = i / steps;
      const p = cubicBezier(from, c1, c2, to, easeInOut(s));
      // Tiny wobble, zero at start and end
      const w = Math.sin(Math.PI * s) * jitter * Math.sin(s * 11 + phase);
      const x = Math.round(p.x + nx * w);
      const y = Math.round(p.y + ny * w);

      await touchSlot(x, y);
      // Read back the real slot (bounds may clamp near grid edges)
      const actual = await readActiveSlot();
      this.lastSlot = { x: actual.x, y: actual.y };

      await sleep(Math.max(4, this.cfg.tickMs + rand(-3, 4)));
    }
    return true;
  }

  pickSlot(from) {
    let target = from;
    for (let tries = 0; tries < 12; tries++) {
      const angle = rand(0, Math.PI * 2);
      const r = rand(this.cfg.minSpanUnits, this.cfg.maxSpanUnits);
      // Wider horizontally than vertically — an elliptical working region
      let t = {
        x: Math.round(this.anchor.x + Math.cos(angle) * r * 1.3),
        y: Math.round(this.anchor.y + Math.sin(angle) * r * 0.75),
      };
      t = this.clampToGrid(t);
      target = t;
      if (span(from, t) >= this.cfg.minSpanUnits) break;
    }
    return target;
  }

  clampToGrid(p) {
    if (!this.grid) return p;
    const a = this.anchor;
    const onPrimary = a.x >= 0 && a.x < this.grid.w && a.y >= 0 && a.y < this.grid.h;
    if (!onPrimary) return p; // anchor lives on another partition — leave it
    return { x: clamp(p.x, 8, this.grid.w - 9), y: clamp(p.y, 8, this.grid.h - 9) };
  }

  // Warm one entry, maybe with a prefetch overshoot + settle.
  // Returns false if interrupted.
  async refreshEntry() {
    const from = this.lastSlot;
    const target = this.pickSlot(from);
    const d = span(from, target);

    if (d > 60 && Math.random() < this.cfg.prefetchChance) {
      const ux = (target.x - from.x) / d, uy = (target.y - from.y) / d;
      const extra = rand(0.04, 0.1) * d;
      const over = {
        x: Math.round(target.x + ux * extra + rand(-3, 3)),
        y: Math.round(target.y + uy * extra + rand(-3, 3)),
      };
      if (!(await this.warmPath(from, over))) return false;
      await sleep(rand(60, 180));
      if (this.interrupt || this.paused) return false;
      return this.warmPath(this.lastSlot, target, { bendScale: 0.3, speedScale: 1.8 });
    }
    return this.warmPath(from, target);
  }

  // ───────────────── Hotkeys & activity ─────────────────
  _installHooks() {
    if (this._hooked) return;
    this._hooked = true;

    const COMBO = new Map([
      [KEY.P, 'pause'],
      [KEY.T, 'pin'],
      [KEY.H, 'capture'],
      [KEY.E, 'expand'],
      [KEY.Q, 'quit'],
    ]);

    _watch.on('keydown', (e) => {
      // Windows turns AltGr into Ctrl plus right-Alt, so on the AZERTY layout
      // typing AltGr+E for a euro sign walks straight into Ctrl+Alt+E. This
      // hook does clear ctrlKey for AltGr, which is enough on its own, but
      // tracking the key keeps the shortcuts safe if that ever changes.
      // Any event without Alt held clears the flag, so a missed key-up
      // cannot wedge the shortcuts off.
      if (e.keycode === KEY.AltRight) this._altGr = true;
      else if (!e.altKey) this._altGr = false;

      const combo = e.ctrlKey && e.altKey && !this._altGr;

      if (combo && COMBO.has(e.keycode)) {
        if (this._held.has(e.keycode)) return; // ignore key-repeat while held
        this._held.add(e.keycode);
        const action = COMBO.get(e.keycode);
        if (action === 'pause') this.togglePause();
        else this.emit('hotkey', action);
        return;
      }

      if (this.cfg.countWritesAsActivity && !MODIFIERS.has(e.keycode)) {
        this.onExternalActivity('Key');
      }
    });

    _watch.on('keyup', (e) => {
      if (e.keycode === KEY.AltRight) this._altGr = false;
      this._held.delete(e.keycode);
    });

    // The warmer never issues these itself, so any of them is external —
    // unless it landed on the widget, which is our own window.
    const pointer = (e) => {
      if (this.shielded({ x: e.x, y: e.y })) return;
      this.onExternalActivity('External');
    };
    _watch.on('mousedown', pointer);
    _watch.on('wheel', pointer);
  }

  // ───────────────────────── Main loop ─────────────────────────
  async run() {
    _store.config.autoDelayMs = 0;

    try {
      this.grid = await gridBounds();
    } catch {
      this.grid = null;
    }

    const start = await readActiveSlot();
    this.lastSlot = { x: start.x, y: start.y };
    this.anchor = { x: start.x, y: start.y };

    this._installHooks();
    _watch.start();
    this.log(`First refresh in ~${Math.round(this.scheduleNext() / 1000)}s`);
    this.emit('change');

    while (!this.stopped) {
      await sleep(this.cfg.pollMs);

      const slot = await readActiveSlot();
      if (span(slot, this.lastSlot) > this.cfg.driftToleranceUnits) {
        this.lastSlot = { x: slot.x, y: slot.y };
        if (!this.shielded(slot)) {
          // Anchor follows the user; widget traffic leaves it where the work is
          this.anchor = { x: slot.x, y: slot.y };
          this.onExternalActivity('External');
        }
        continue;
      }

      const now = Date.now();
      if (this.inBackoff && now >= this.backoffUntil) {
        this.inBackoff = false;
        if (!this.paused) {
          this.log(`Backoff over — next refresh in ~${Math.round((this.nextRefreshAt - now) / 1000)}s`);
        }
        this.emit('change');
      }

      if (this.paused || this.inBackoff || now < this.nextRefreshAt) continue;

      this.interrupt = false;
      this.warming = true;
      this.emit('change');

      const passes = Math.random() < this.cfg.batchChance ? randInt(2, 3) : 1;
      let done = 0;

      for (let i = 0; i < passes; i++) {
        if (this.interrupt || this.paused || this.stopped) break;
        if (!(await this.refreshEntry())) break;
        done++;
        if (i < passes - 1) await sleep(rand(300, 1200));
      }

      this.warming = false;

      if (!this.inBackoff && !this.paused) {
        const ms = this.scheduleNext();
        this.log(`Refreshed${done > 1 ? ` ${done} slots` : ''} — next in ~${Math.round(ms / 1000)}s`);
      }
      this.emit('change');
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.interrupt = true;
    try { _watch.stop(); } catch {}
  }
}

module.exports = { Warmer, CONFIG };
