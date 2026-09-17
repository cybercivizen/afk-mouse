'use strict';
// cli.js — the original terminal front end. `node cache-warmer.js --cli`

const { Warmer } = require('./engine');

const engine = new Warmer();

engine.on('log', (msg) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
});

engine.on('hotkey', (name) => {
  if (name === 'quit') shutdown(0);
});

function shutdown(code = 0) {
  console.log(`[${new Date().toLocaleTimeString()}] Stopping.`);
  engine.stop();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));

console.log('Cache warmer running. Ctrl+Alt+P = pause/resume, Ctrl+Alt+Q = quit');
engine.run().catch((err) => {
  console.error(err);
  shutdown(1);
});
