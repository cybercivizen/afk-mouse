// Fires the expand animation and photographs it frame by frame, so the
// in-between sizes can be inspected for painting artefacts.
//
//   node tools/animtest.js [path-to-widget.ps1] [outdir]
//
// Pair it with a slowed-down copy of the panel (animSteps 45 instead of 14),
// otherwise the whole animation is over in ~210ms and the camera, which needs
// ~90ms per frame, catches two frames at most. See tools/README.md.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const PS1 = process.argv[2] || path.join(HERE, '..', 'widget.ps1');
const OUT = process.argv[3] || path.join(HERE, 'shots', 'anim');

fs.mkdirSync(OUT, { recursive: true });

let sock = null;
const send = (l) => { if (sock && sock.writable) sock.write(l + '\n'); };

const server = net.createServer((s) => {
  sock = s;
  s.setEncoding('utf8');
  s.on('data', () => {});
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

  const pump = setInterval(() => send('S|1|wait|42'), 300);

  setTimeout(() => {
    // The camera runs alongside the animation rather than in front of it, and
    // says READY once it has found the window, so the expand can be timed
    // against it instead of against PowerShell's startup.
    const cam = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'burst.ps1'),
      '-Dir', OUT, '-Frames', '16', '-Every', '35',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let armed = false;
    cam.stdout.on('data', (d) => {
      process.stdout.write(d.toString());
      if (!armed && d.toString().includes('READY')) {
        armed = true;
        setTimeout(() => send('EXP|1'), 90);
      }
    });
    cam.on('exit', () => {
      clearInterval(pump);
      send('BYE');
      setTimeout(() => process.exit(0), 800);
    });
  }, 3500);
});
