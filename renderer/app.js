'use strict';
// app.js — the panel holds no policy of its own. It renders what main sends
// and reports what the user did, which is the deal widget.ps1 had.

const panel = document.getElementById('panel');
const dot = document.getElementById('dot');
const stat = document.getElementById('stat');
const big = document.getElementById('big');
const cap = document.getElementById('cap');
const closeBtn = document.getElementById('close');
const minBtn = document.getElementById('minimize');
const trayBtn = document.getElementById('to-tray');
const chev = document.getElementById('chev');
const chevPath = document.getElementById('chev-path');

const GLYPH_WORK = '•••';

let flags = {
  pinned: true,
  expanded: false,
  capHidden: true,
  animating: false,
  panelShown: true,
  paused: false,
};

// ───────────────────────── Rendering ─────────────────────────
// One for one with the old Set-Phase.
function renderState(s) {
  if (s.phase === 'off') {
    dot.style.color = 'var(--off)';
    stat.textContent = 'OFF';
    stat.style.color = 'var(--dim)';
    big.textContent = 'OFF';
    big.style.color = 'var(--off)';
    cap.textContent = 'paused';
    return;
  }

  stat.textContent = 'ON';
  stat.style.color = 'var(--text)';

  if (s.phase === 'move') {
    dot.style.color = 'var(--on)';
    big.textContent = GLYPH_WORK;
    big.style.color = 'var(--on)';
    cap.textContent = 'refreshing';
  } else if (s.phase === 'hold') {
    dot.style.color = 'var(--hold)';
    big.textContent = `${s.secs}s`;
    big.style.color = 'var(--hold)';
    cap.textContent = 'you are active';
  } else {
    dot.style.color = 'var(--on)';
    big.textContent = `${s.secs}s`;
    big.style.color = 'var(--text)';
    cap.textContent = 'next refresh';
  }
}

// A chevron: down when there is more to see, up when there is less. The box
// is 16x16 and its centre is 8,8, so these are the old offsets resolved.
function drawChevron(expanded) {
  chevPath.setAttribute('d', expanded
    ? 'M3.8 10.1 L8 5.7 L12.2 10.1'
    : 'M3.8 5.9 L8 10.3 L12.2 5.9');
}

function renderFlags(f) {
  flags = f;
  panel.classList.toggle('expanded', f.expanded);
  panel.classList.toggle('compact', !f.expanded);
  panel.classList.toggle('animating', f.animating);
  panel.classList.toggle('pinned', f.pinned);
  panel.classList.toggle('cap-hidden', f.capHidden);
  panel.classList.toggle('paused', f.paused);

  drawChevron(f.expanded);
}

// ───────────────────────── Buttons ─────────────────────────
const flip = () => window.warmer.setExpanded(!flags.expanded);

for (const el of [dot, stat]) {
  el.addEventListener('click', () => window.warmer.togglePause());
}

chev.addEventListener('click', flip);
closeBtn.addEventListener('click', () => window.warmer.quit());

// Two different kinds of getting out of the way. The bar minimizes to the
// taskbar, where the button stays and brings it back. The arrow into a floor
// drops it to the tray: the window goes away entirely and the tray dot is the
// only way back.
minBtn.addEventListener('click', () => window.warmer.minimize());
trayBtn.addEventListener('click', () => window.warmer.hidePanel());

// Drag from anywhere that is not a control of its own. The state icons say
// things, they do not do things, so they drag with the rest of the body.
panel.addEventListener('dblclick', (e) => {
  if (e.target.closest('.control')) return;
  if (e.target.closest('.key') || e.target.closest('.act')) return;
  flip();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.warmer.setExpanded(false);
});

// ───────────────────────── Dragging ─────────────────────────
// Deltas from where the pointer was grabbed, which is what the old panel did
// with Cursor.Position. Coalesced onto a frame so a fast drag does not queue
// a message per mousemove.
let origin = null;
let pending = null;
let rafId = 0;

function flush() {
  rafId = 0;
  if (origin && pending) window.warmer.dragMove(pending.dx, pending.dy);
  pending = null;
}

function onMove(e) {
  if (!origin) return;
  pending = { dx: e.screenX - origin.x, dy: e.screenY - origin.y };
  if (!rafId) rafId = requestAnimationFrame(flush);
}

function onUp() {
  if (!origin) return;
  origin = null;
  pending = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  window.warmer.dragEnd();
}

panel.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (flags.animating) return;
  if (e.target.closest('.control')) return;

  origin = { x: e.screenX, y: e.screenY };
  window.warmer.dragStart();
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  e.preventDefault();
});

// Nothing here wants a page context menu or a native image drag.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());

// ───────────────────────── Link ─────────────────────────
window.warmer.onState(renderState);
window.warmer.onFlags(renderFlags);

drawChevron(false);
window.warmer.ready();
