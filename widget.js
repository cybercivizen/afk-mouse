'use strict';
// widget.js — runs the warming engine behind a small always-movable panel.
//
// The panel itself is widget.ps1 (WinForms, borderless). Node owns all the
// logic; the two talk newline-delimited text over a loopback socket:
//
//   node -> ui   S|<on>|<phase>|<secs>  PIN|<0|1>  CAP|<0|1>  EXP|<0|1>  BYE
//   ui   -> node HELLO|<token>  TOGGLE  PIN|<0|1>  CAP|<0|1>  EXP|<0|1>
//                VIS|<0|1>  RECT|x|y|w|h  DRAG|<0|1>  QUIT

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Warmer } = require('./engine');

// The panel is excluded from screen capture by default. --show-in-capture puts
// it back for one run only; the lasting setting is the Ctrl+Alt+H toggle.
const SHOW_IN_CAPTURE = process.argv.slice(2).includes('--show-in-capture');

const HERE = __dirname;
const PS1 = path.join(HERE, 'widget.ps1');
const STATE_FILE = path.join(HERE, '.widget-state.json');
const ERR_LOG = path.join(HERE, 'widget-error.log');

// ── Remembered window position / pinning ──
function loadUi() {
  const ui = {
    x: -10000,
    y: -10000,
    pinned: true,
    expanded: false,          // compact is the resting size
    hideFromCapture: true,
    panelShown: true,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(saved.x)) ui.x = saved.x;
    if (Number.isFinite(saved.y)) ui.y = saved.y;
    for (const key of ['pinned', 'expanded', 'hideFromCapture', 'panelShown']) {
      if (typeof saved[key] === 'boolean') ui[key] = saved[key];
    }
  } catch {}
  return ui;
}

const ui = loadUi();

// What the panel is actually set to right now. It starts from the saved
// setting unless --show-in-capture overrides this one run, and only a real
// toggle writes it back to the saved settings.
let captureHidden = SHOW_IN_CAPTURE ? false : ui.hideFromCapture;
let saveTimer = null;
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(ui)); } catch {}
  }, 400);
  saveTimer.unref();
}

function note(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function bail(msg, detail) {
  const body = `[${new Date().toISOString()}] ${msg}\n${detail || ''}\n`;
  try { fs.appendFileSync(ERR_LOG, body); } catch {}
  console.error(msg);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

// ───────────────────────── Engine ─────────────────────────
const engine = new Warmer();
engine.on('log', note);

let sock = null;
let child = null;
let shuttingDown = false;
let lastFrame = '';

function send(line) {
  if (sock && !sock.destroyed && sock.writable) sock.write(line + '\n');
}

function paint() {
  const s = engine.snapshot();
  const frame = `S|${s.on ? 1 : 0}|${s.phase}|${s.secs}`;
  if (frame === lastFrame) return;
  lastFrame = frame;
  send(frame);
}

engine.on('change', paint);
const painter = setInterval(paint, 150);

engine.on('hotkey', (name) => {
  if (name === 'quit') return shutdown(0);
  if (name === 'pin') {
    ui.pinned = !ui.pinned;
    send(`PIN|${ui.pinned ? 1 : 0}`);
    saveUi();
    note(ui.pinned ? 'Pinned above other windows' : 'Unpinned — behaves like a normal window');
  }
  // The panel owns these two: it applies the change and reports what it got.
  if (name === 'capture') send(`CAP|${captureHidden ? 0 : 1}`);
  if (name === 'expand') send(`EXP|${ui.expanded ? 0 : 1}`);
});

// ───────────────────────── UI link ─────────────────────────
const token = crypto.randomBytes(9).toString('hex');

let firstCapReport = true;

function wire(s) {
  let buf = '';
  let greeted = false;

  s.setEncoding('utf8');
  s.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line) continue;

      if (!greeted) {
        if (line !== `HELLO|${token}`) { s.destroy(); return; }
        greeted = true;
        sock = s;
        lastFrame = '';
        paint();
        continue;
      }

      const p = line.split('|');
      switch (p[0]) {
        case 'TOGGLE':
          engine.togglePause();
          break;
        case 'PIN':
          ui.pinned = p[1] === '1';
          saveUi();
          break;
        case 'RECT': {
          const [x, y, w, h] = p.slice(1, 5).map(Number);
          if ([x, y, w, h].every(Number.isFinite)) {
            engine.setShield({ x, y, w, h });
            // An empty rectangle means the panel is hidden, not a position.
            if (w > 0 && h > 0) {
              ui.x = x;
              ui.y = y;
              saveUi();
            }
          }
          break;
        }
        case 'EXP':
          ui.expanded = p[1] === '1';
          saveUi();
          break;
        case 'VIS':
          ui.panelShown = p[1] === '1';
          saveUi();
          note(ui.panelShown ? 'Panel shown' : 'Panel hidden — the tray icon brings it back');
          break;
        case 'CAP': {
          const hidden = p[1] === '1';
          // The first report only confirms the launch state, so a one-run
          // --show-in-capture never writes itself into the saved settings.
          const launchOverride = firstCapReport && SHOW_IN_CAPTURE;
          const asked = captureHidden;
          firstCapReport = false;
          captureHidden = hidden;
          if (launchOverride) {
            note('Visible to screen capture (--show-in-capture)');
            break;
          }
          if (hidden) note('Hidden from screen shares and screenshots');
          else if (asked) note('Warning: Windows would not hide the widget from screen capture');
          else note('Visible to screen capture');
          ui.hideFromCapture = hidden;
          saveUi();
          break;
        }
        case 'DRAG':
          engine.setShieldHold(p[1] === '1');
          break;
        case 'QUIT':
          return shutdown(0);
      }
    }
  });

  s.on('error', () => {});
  s.on('close', () => { if (s === sock) shutdown(0); });
}

const server = net.createServer((s) => {
  if (sock) { s.destroy(); return; }   // one panel only
  wire(s);
});

server.on('error', (err) => bail('Could not open the widget link.', String(err)));

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // No -WindowStyle Hidden here: it rides along in STARTUPINFO and the first
  // WinForms window of the process inherits it, so the panel never paints.
  // windowsHide keeps the console away on its own.
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta',
    '-File', PS1,
    '-Port', String(port),
    '-Token', token,
    '-X', String(ui.x),
    '-Y', String(ui.y),
    '-Pin', ui.pinned ? '1' : '0',
    '-HideFromCapture', captureHidden ? '1' : '0',
    '-Expanded', ui.expanded ? '1' : '0',
    '-PanelShown', ui.panelShown ? '1' : '0',
  ];

  child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  child.on('error', (err) => {
    bail('Could not start the widget (powershell.exe not found?). Try: node cache-warmer.js --cli', String(err));
    engine.stop();
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (shuttingDown) return;
    if (code !== 0 && stderr.trim()) bail(`Widget exited with code ${code}.`, stderr);
    shutdown(code === 0 ? 0 : 1);
  });

  note('Widget ready — with Ctrl+Alt: P pause, T pin, H hide, E expand, Q quit');
  note('Right-click the tray dot for the same switches');
});

// ───────────────────────── Lifecycle ─────────────────────────
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(painter);
  send('BYE');
  engine.stop();
  try { if (sock) sock.end(); } catch {}
  try { server.close(); } catch {}
  try { if (child && child.exitCode === null) child.kill(); } catch {}
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(ui)); } catch {}
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

engine.run().catch((err) => {
  bail('Warming loop stopped.', err && err.stack ? err.stack : String(err));
  shutdown(1);
});
