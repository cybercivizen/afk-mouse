'use strict';
// main.js — the warming engine behind a small always-movable panel.
//
// Replaces the widget.js host and the policy half of the old widget.ps1
// panel. Node still owns every decision; the renderer draws what it is told
// and reports what the user did, exactly as the PowerShell panel used to.
//
//   main -> ui   state {on, phase, secs}
//                flags {pinned, expanded, capHidden, animating, panelShown, paused}
//   ui   -> main toggle-pause · set-pin · set-capture · set-expanded
//                quit · hide-panel · minimize-window · drag-start
//                drag-move · drag-end
//                ui-ready
//
// The window is excluded from screen capture by default. --show-in-capture
// puts it back for one run only; the lasting setting is the Ctrl+Alt+H toggle.

const { app, BrowserWindow, Tray, Menu, screen, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Warmer } = require('./engine');
const { dot } = require('./tray-icon');

// ───────────────────────── Flags ─────────────────────────
const ARGV = process.argv.slice(1);
const hasFlag = (...names) => names.some((n) => ARGV.includes(n));

if (hasFlag('-h', '--help')) {
  console.log([
    'cache-warmer — keeps hot cache slots warm so entries do not expire',
    '',
    '  npm start                     small on-screen widget (default)',
    '  node cache-warmer.js --cli    terminal only',
    '',
    '  --show-in-capture             let the widget appear in screen shares',
    '                                (it is hidden from them by default)',
    '',
    '  Ctrl+Alt+P  pause / resume',
    '  Ctrl+Alt+T  pin the widget above other windows',
    '  Ctrl+Alt+H  hide the widget from screen shares / show it again',
    '  Ctrl+Alt+E  expand / collapse the panel',
    '  Ctrl+Alt+Q  quit',
    '',
    '  The tray dot carries the same switches on right-click.',
  ].join('\n'));
  app.exit(0);
}

const SHOW_IN_CAPTURE = hasFlag('--show-in-capture');
const CLI_ONLY = hasFlag('--cli', '-c');

// ───────────────────────── Constants ─────────────────────────
// Tray dot tints, straight from the old panel's palette.
const TINT = {
  on: [74, 222, 128],
  hold: [251, 191, 36],
  off: [110, 114, 124],
};

// 39, not the 38 the WinForms panel managed. A transparent frameless window
// has a hard floor of 39px here — ask for anything from 30 to 39 and you get
// 39, while 40 and up come back exact. Measured, not guessed. The old panel
// beat the same clamp by re-stating its bounds through SetWindowPos; Electron
// offers no equivalent, and an opaque window reports honest bounds but carries
// an invisible 8px resize frame that would throw the shield rectangle off.
// Asking for what we will actually get is what keeps the corner anchoring
// from drifting a pixel per expand/collapse cycle. The layout hangs off the
// top edge, so the spare pixel lands under the content where nothing shows.
const COMPACT = { w: 128, h: 39 };
const EXPANDED = { w: 196, h: 160 };

// The resize is paced by the clock, not by a step count. Driving `t` off
// elapsed time means a slow frame costs a skipped position rather than a
// longer animation, so the panel always opens in ANIM_DURATION no matter what
// the compositor is doing — the old fixed-interval loop could stretch instead.
//
// ANIM_TICK is 1 for a reason worth knowing: a Node timer of 4ms or more
// falls onto Windows' coarse ~15ms timer, while 1ms takes a fast path. The
// difference is not subtle. Measured over four runs each, end to end:
//
//   tick=8  ->  13 frames / 186ms   70 fps
//   tick=4  ->  13 frames / 185ms   70 fps
//   tick=1  ->  32 frames / 184ms  173 fps
//
// So 4 and 8 both cost roughly 14ms a frame and cap out near 70 fps, which is
// half of a 143Hz display and reads as judder. 1 clears it with room spare.
const ANIM_DURATION = 180;   // ms end to end
const ANIM_TICK = 1;         // ms between attempts; frames land where time says
const EDGE_GAP = 24;      // resting distance from the working-area corner

// ───────────────────────── Host state ─────────────────────────
let STATE_FILE = null;
let ERR_LOG = null;
let ui = null;
let captureHidden = true;  // what the window is actually set to right now
let capActual = false;
let paused = false;
let animating = false;
let animTimer = null;
let dragging = false;
let dragFrom = null;
let minimized = false;
let uiReady = false;
let lastFrame = '';
let lastTint = '';
let lastTip = '';
let firstCapReport = true;

let win = null;
let tray = null;
let painter = null;
let shuttingDown = false;

const engine = new Warmer();

function note(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function bail(msg, detail) {
  const body = `[${new Date().toISOString()}] ${msg}\n${detail || ''}\n`;
  try { if (ERR_LOG) fs.appendFileSync(ERR_LOG, body); } catch {}
  console.error(msg);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

// ── Remembered window position / pinning ──
function loadUi() {
  const state = {
    x: -10000,
    y: -10000,
    pinned: true,
    expanded: false,          // compact is the resting size
    hideFromCapture: true,
    panelShown: true,
  };

  // userData, not the install directory: a packaged app cannot write beside
  // its own source. The dot-file next to the source is where the PowerShell
  // build kept it, so it is read once to carry a position across the port.
  const candidates = [STATE_FILE, path.join(__dirname, '.widget-state.json')];
  for (const file of candidates) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(saved.x)) state.x = saved.x;
      if (Number.isFinite(saved.y)) state.y = saved.y;
      for (const key of ['pinned', 'expanded', 'hideFromCapture', 'panelShown']) {
        if (typeof saved[key] === 'boolean') state[key] = saved[key];
      }
      break;
    } catch {}
  }
  return state;
}

let saveTimer = null;
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(ui)); } catch {}
  }, 400);
  if (saveTimer.unref) saveTimer.unref();
}

// ───────────────────────── Geometry ─────────────────────────
// The union of every display, which is what the old panel read out of
// SystemInformation.VirtualScreen.
function virtualScreen() {
  const all = screen.getAllDisplays().map((d) => d.bounds);
  return {
    left: Math.min(...all.map((b) => b.x)),
    top: Math.min(...all.map((b) => b.y)),
    right: Math.max(...all.map((b) => b.x + b.width)),
    bottom: Math.max(...all.map((b) => b.y + b.height)),
  };
}

// Saved spot, else bottom-right above the tray, then clamped on screen.
function placeInitial() {
  const size = ui.expanded ? EXPANDED : COMPACT;
  let x = ui.x;
  let y = ui.y;

  if (x <= -10000 || y <= -10000) {
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - size.w - EDGE_GAP;
    y = wa.y + wa.height - size.h - EDGE_GAP;
  }

  const vs = virtualScreen();
  if (x < vs.left) x = vs.left;
  if (y < vs.top) y = vs.top;
  if (x > vs.right - size.w) x = vs.right - size.w;
  if (y > vs.bottom - size.h) y = vs.bottom - size.h;

  return { x: Math.round(x), y: Math.round(y), width: size.w, height: size.h };
}

// ───────────────────────── Renderer link ─────────────────────────
function send(channel, payload) {
  if (!uiReady || !win || win.isDestroyed()) return;
  try { win.webContents.send(channel, payload); } catch {}
}

function sendFlags() {
  send('flags', {
    pinned: ui.pinned,
    expanded: ui.expanded,
    capHidden: capActual,
    animating,
    panelShown: ui.panelShown,
    paused,
  });
}

// The engine ignores pointer activity inside this rectangle, so dragging the
// panel does not read as "the user is here". A hidden panel shields nothing
// and its empty rectangle is deliberately not kept as a position.
function sendRect() {
  if (!win || win.isDestroyed()) return;
  if (!ui.panelShown || minimized) {
    engine.setShield({ x: 0, y: 0, w: 0, h: 0 });
    return;
  }
  const b = win.getBounds();
  engine.setShield({ x: b.x, y: b.y, w: b.width, h: b.height });
  ui.x = b.x;
  ui.y = b.y;
  saveUi();
}

// ───────────────────────── Rendering ─────────────────────────
// The tray dot and the taskbar icon are the same dot at two sizes, so one
// tint drives both. The taskbar button reads the window icon, which means it
// has to be re-set as the state changes rather than only at construction.
function setIcons(tint, tip) {
  if (tint !== lastTint) {
    lastTint = tint;
    try { if (tray) tray.setImage(dot(TINT[tint], 16)); } catch {}
    try { if (win && !win.isDestroyed()) win.setIcon(dot(TINT[tint], 32)); } catch {}
  }
  if (tip !== lastTip) {
    lastTip = tip;
    // The old NotifyIcon threw above 63 characters; the limit is the same here.
    try { if (tray) tray.setToolTip(tip.length > 63 ? tip.slice(0, 63) : tip); } catch {}
  }
}

function paint() {
  const s = engine.snapshot();
  const frame = `${s.on ? 1 : 0}|${s.phase}|${s.secs}`;
  if (frame === lastFrame) return;
  lastFrame = frame;

  const wasPaused = paused;
  paused = s.phase === 'off';

  send('state', s);

  if (s.phase === 'off') setIcons('off', 'Cache Warmer — paused');
  else if (s.phase === 'move') setIcons('on', 'Cache Warmer — refreshing');
  else if (s.phase === 'hold') setIcons('hold', `Cache Warmer — holding, ${s.secs}s`);
  else setIcons('on', `Cache Warmer — next refresh ${s.secs}s`);

  if (wasPaused !== paused) { sendFlags(); syncMenu(); }
}

// ───────────────────────── Tray menu ─────────────────────────
function syncMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: ui.panelShown ? 'Hide panel' : 'Show panel', click: () => setPanelShown(!ui.panelShown) },
    { label: ui.expanded ? 'Collapse' : 'Expand', click: () => setExpanded(!ui.expanded) },
    { label: paused ? 'Resume' : 'Pause', click: () => engine.togglePause() },
    { label: 'Keep on top', type: 'checkbox', checked: ui.pinned, click: () => setPin(!ui.pinned) },
    { label: 'Hide from screen capture', type: 'checkbox', checked: capActual, click: () => setCapture(!captureHidden, true) },
    { type: 'separator' },
    { label: 'Quit', click: () => shutdown(0) },
  ]));
}

// ───────────────────────── Switches ─────────────────────────
// Keep the panel out of screen shares, Teams/Zoom/Meet, the Snipping Tool and
// PrintScreen. Electron's content protection is WDA_EXCLUDEFROMCAPTURE
// underneath, but unlike the raw call it reports nothing back, so there is no
// longer a way to notice Windows refusing it.
function setCapture(v, echo) {
  captureHidden = v;
  try { win.setContentProtection(v); } catch {}
  capActual = v;

  if (echo) {
    // The first report only confirms the launch state, so a one-run
    // --show-in-capture never writes itself into the saved settings.
    const launchOverride = firstCapReport && SHOW_IN_CAPTURE;
    firstCapReport = false;
    if (launchOverride) {
      note('Visible to screen capture (--show-in-capture)');
    } else {
      note(v ? 'Hidden from screen shares and screenshots' : 'Visible to screen capture');
      ui.hideFromCapture = v;
      saveUi();
    }
  } else {
    firstCapReport = false;
  }

  sendFlags();
  syncMenu();
}

function setPin(v) {
  ui.pinned = v;
  try { win.setAlwaysOnTop(v); } catch {}
  // TopMost used to rebuild the handle and drop the affinity with it. Electron
  // does not, but re-stating it costs nothing and keeps the old guarantee.
  setCapture(captureHidden, false);
  saveUi();
  note(v ? 'Pinned above other windows' : 'Unpinned — behaves like a normal window');
  sendFlags();
  syncMenu();
}

function applyLayout() {
  const want = ui.expanded ? EXPANDED : COMPACT;
  const b = win.getBounds();
  if (b.width !== want.w || b.height !== want.h) {
    win.setBounds({ x: b.x, y: b.y, width: want.w, height: want.h });
  }
  sendFlags();
}

// There are now two ways for the panel to be off screen — hidden to the tray
// and minimized to the taskbar — and they need different undoing. Anything
// that wants the panel in front of the user goes through here.
function ensureOnScreen() {
  if (!ui.panelShown) { setPanelShown(true); return; }
  if (win.isMinimized()) win.restore();
}

function setExpanded(v) {
  ensureOnScreen();
  if (animating) return;
  if (v === ui.expanded) { syncMenu(); return; }

  ui.expanded = v;
  animating = true;
  saveUi();

  const size = v ? EXPANDED : COMPACT;
  const from = win.getBounds();

  // Grow away from the nearest corner of the desktop: a panel parked bottom
  // right opens up and to the left, one parked top left opens down and right.
  // Anchoring the same corner both ways means it never drifts across a cycle.
  const vs = virtualScreen();
  const midX = (vs.left + vs.right) / 2;
  const midY = (vs.top + vs.bottom) / 2;

  let nx = (from.x + from.width / 2) > midX ? (from.x + from.width) - size.w : from.x;
  let ny = (from.y + from.height / 2) > midY ? (from.y + from.height) - size.h : from.y;

  if (nx + size.w > vs.right) nx = vs.right - size.w;
  if (ny + size.h > vs.bottom) ny = vs.bottom - size.h;
  if (nx < vs.left) nx = vs.left;
  if (ny < vs.top) ny = vs.top;

  const to = { x: Math.round(nx), y: Math.round(ny), width: size.w, height: size.h };

  // Nothing but the dot and the countdown survives the in-between sizes, so
  // the renderer is told it is animating before the first frame lands.
  sendFlags();
  syncMenu();

  const started = Date.now();
  clearTimeout(animTimer);

  const step = () => {
    const t = Math.min(1, (Date.now() - started) / ANIM_DURATION);
    const e = 1 - Math.pow(1 - t, 3);        // ease-out cubic

    if (t >= 1) {
      animTimer = null;
      win.setBounds(to);
      animating = false;
      applyLayout();
      sendRect();
      return;
    }

    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.round(from.width + (to.width - from.width) * e),
      height: Math.round(from.height + (to.height - from.height) * e),
    });

    animTimer = setTimeout(step, ANIM_TICK);
  };

  step();
}

function setPanelShown(v) {
  ui.panelShown = v;
  if (v) {
    minimized = false;
    if (win.isMinimized()) win.restore();
    win.show();
    applyLayout();
    setCapture(captureHidden, false);
    try { win.setAlwaysOnTop(ui.pinned); } catch {}
  } else {
    win.hide();
  }
  sendRect();
  saveUi();
  note(v ? 'Panel shown' : 'Panel hidden — the tray icon brings it back');
  sendFlags();
  syncMenu();
}

// ───────────────────────── IPC ─────────────────────────
function wireIpc() {
  ipcMain.on('ui-ready', () => {
    uiReady = true;
    lastFrame = '';
    paint();
    sendFlags();
  });

  ipcMain.on('toggle-pause', () => engine.togglePause());
  ipcMain.on('set-pin', (_e, v) => setPin(!!v));
  ipcMain.on('set-capture', (_e, v) => setCapture(!!v, true));
  ipcMain.on('set-expanded', (_e, v) => setExpanded(!!v));
  ipcMain.on('quit', () => shutdown(0));
  ipcMain.on('hide-panel', () => setPanelShown(false));
  ipcMain.on('minimize-window', () => win.minimize());

  // Dragging is done by hand rather than with -webkit-app-region, because the
  // engine has to be told to hold its shield for the duration and handed the
  // new rectangle at the end. An app-region drag reports neither.
  ipcMain.on('drag-start', () => {
    if (animating) return;
    dragging = true;
    dragFrom = win.getBounds();
    engine.setShieldHold(true);
  });

  ipcMain.on('drag-move', (_e, d) => {
    if (!dragging || !dragFrom) return;
    const dx = Number(d && d.dx);
    const dy = Number(d && d.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    win.setPosition(Math.round(dragFrom.x + dx), Math.round(dragFrom.y + dy));
  });

  ipcMain.on('drag-end', () => {
    if (!dragging) return;
    dragging = false;
    dragFrom = null;
    sendRect();
    engine.setShieldHold(false);
  });
}

// ───────────────────────── Boot ─────────────────────────
function createWindow() {
  const b = placeInitial();

  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    // In the taskbar, so minimize has to work for the taskbar button to
    // behave like any other window's. The tray is now the second way back,
    // reached through the panel's own minimize glyph.
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: ui.pinned,
    title: 'Cache Warmer',
    icon: dot(TINT.on, 32),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // the countdown must keep ticking offscreen
    },
  });

  // A new window used to be clamped to the minimum tracking size, about
  // 136x39, which is wider than the compact panel. Stating no minimum keeps
  // the 128px the layout is built around.
  win.setMinimumSize(1, 1);

  win.on('move', () => { if (!dragging && !animating) sendRect(); });

  // A minimized panel is not on screen, so it shields nothing — the same deal
  // a hidden one gets. Its bounds go stale while it is down, which is why the
  // flag guards sendRect rather than letting it read them back.
  win.on('minimize', () => { minimized = true; sendRect(); });
  win.on('restore', () => { minimized = false; sendRect(); });

  win.on('closed', () => shutdown(0));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    // The painter starts before the window exists, so a tint decided in that
    // gap was recorded but never applied to a window icon. Forgetting it here
    // makes the next paint re-apply both icons for certain.
    lastTint = '';
    lastTip = '';
    if (ui.panelShown) win.show();
    setCapture(captureHidden, true);
    applyLayout();
    sendRect();
    sendFlags();
    syncMenu();
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(painter);
  clearTimeout(animTimer);
  engine.stop();
  try { if (tray) { tray.destroy(); tray = null; } } catch {}
  try { if (STATE_FILE) fs.writeFileSync(STATE_FILE, JSON.stringify(ui)); } catch {}
  try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
  setTimeout(() => app.exit(code), 150);
}

function startWidget() {
  STATE_FILE = path.join(app.getPath('userData'), 'widget-state.json');
  ERR_LOG = path.join(app.getPath('userData'), 'widget-error.log');
  ui = loadUi();
  captureHidden = SHOW_IN_CAPTURE ? false : ui.hideFromCapture;

  engine.on('log', note);
  engine.on('change', paint);
  painter = setInterval(paint, 150);

  engine.on('hotkey', (name) => {
    if (name === 'quit') return shutdown(0);
    if (name === 'pin') return setPin(!ui.pinned);
    if (name === 'capture') return setCapture(!captureHidden, true);
    if (name === 'expand') return setExpanded(!ui.expanded);
  });

  tray = new Tray(dot(TINT.on));
  tray.setToolTip('Cache Warmer');
  // Left-click brings the panel back, or flips its size if it is already on
  // screen. Right-click opens the menu on its own.
  // Off screen either way: bring it back and stop there, because that is all
  // the click was asking for. Already on screen: flip its size.
  tray.on('click', () => {
    if (!ui.panelShown || win.isMinimized()) ensureOnScreen();
    else setExpanded(!ui.expanded);
  });

  wireIpc();
  createWindow();
  syncMenu();

  note('Widget ready — with Ctrl+Alt: P pause, T pin, H hide, E expand, Q quit');
  note('Right-click the tray dot for the same switches');

  engine.run().catch((err) => {
    bail('Warming loop stopped.', err && err.stack ? err.stack : String(err));
    shutdown(1);
  });
}

if (CLI_ONLY) {
  // The terminal front end needs no window, no tray and no Chromium, and is
  // left out of the single-instance lock below: it is a separate front end,
  // not a second copy of this one.
  app.disableHardwareAcceleration();
  app.whenReady().then(() => { require('./cli.js'); });
} else if (!app.requestSingleInstanceLock()) {
  // One widget at a time. Two of them stack up, fight over the cursor, write
  // the same state file and make Chromium squabble over a shared userData
  // directory. The copy that loses the lock leaves quietly; the one already
  // running gets the second-instance event below and shows itself instead,
  // which is what you wanted by launching it again.
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (!ui.panelShown) setPanelShown(true);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(startWidget);
}

// Hiding the panel must not end the run — only the x, the menu or Ctrl+Alt+Q.
app.on('window-all-closed', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
