// Drives the panel on its own, with a fake engine in place of the real one,
// so every visual state can be photographed without touching the running app
// or the mouse.
//
//   node tools/harness2.js [path-to-widget.ps1]
//
// Shots land in tools/shots/.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HERE = __dirname;
const OUT = path.join(HERE, 'shots');
const PS1 = process.argv[2] || path.join(HERE, '..', 'widget.ps1');

fs.mkdirSync(OUT, { recursive: true });

let sock = null;
let frame = 'S|1|wait|42';
const send = (l) => { if (sock && sock.writable) sock.write(l + '\n'); };

function shot(name) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'shot.ps1'),
      '-Out', path.join(OUT, name + '.png'),
    ], { encoding: 'utf8' });
    console.log('[' + name + '] ' + out.trim().split('\n')[0]);
  } catch (err) {
    console.log('[' + name + '] shot failed: ' + err.message);
  }
}

const server = net.createServer((s) => {
  sock = s;
  s.setEncoding('utf8');
  s.on('data', (d) => d.split('\n').filter(Boolean).forEach((l) => console.log('  ui -> ' + l.trim())));
  s.on('error', () => {});
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta',
    '-File', PS1,
    '-Port', String(port), '-Token', 'testtoken',
    '-X', '300', '-Y', '300',
    '-Pin', '1', '-HideFromCapture', '0', '-Expanded', '0', '-PanelShown', '1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  child.stderr.on('data', (d) => console.log('PS ERR: ' + d.toString().trim()));
  child.on('exit', (code) => { console.log('panel exited ' + code); process.exit(0); });

  const pump = setInterval(() => send(frame), 300);

  // Each shot blocks this process for about a second while PowerShell starts,
  // so leave room between changing a state and photographing it.
  const steps = [
    [3500, () => shot('v1_compact_running')],
    [4200, () => { console.log('-> CAP|1 (hidden)'); send('CAP|1'); }],
    [5600, () => shot('v2_compact_hidden')],
    [6200, () => { console.log('-> PIN|0'); send('PIN|0'); }],
    [7400, () => shot('v3_compact_unpinned')],
    [8000, () => { console.log('-> PIN|1, EXP|1'); send('PIN|1'); send('EXP|1'); }],
    [9400, () => shot('v4_expanded_running')],
    [10000, () => { console.log('-> paused'); frame = 'S|0|off|0'; }],
    [11400, () => shot('v5_expanded_paused')],
    [12000, () => { console.log('-> holding'); frame = 'S|1|hold|7'; }],
    [13400, () => shot('v6_expanded_hold')],
    [14000, () => { console.log('-> BYE'); clearInterval(pump); send('BYE'); }],
  ];
  for (const [at, fn] of steps) setTimeout(fn, at);
  setTimeout(() => process.exit(0), 16000);
});
