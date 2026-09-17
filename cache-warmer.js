#!/usr/bin/env node
// cache-warmer.js — the plain-Node entry point (Node 22+).
//
// The panel is an Electron window now, so it starts through Electron:
//
//   npm start                      widget (Electron)
//   node cache-warmer.js --cli     terminal only, no Electron needed
//
// Keeping the terminal front end reachable from bare Node is deliberate: it
// is the original front end, it needs no Chromium, and it still works on any
// platform the two native modules build for.

'use strict';

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log([
    'cache-warmer — keeps hot cache slots warm so entries do not expire',
    '',
    '  npm start                     small on-screen widget (Electron)',
    '  node cache-warmer.js --cli    terminal only',
    '',
    '  Widget-only flags, passed through Electron:',
    '  npm start -- --show-in-capture   let the widget appear in screen shares',
    '                                   (it is hidden from them by default)',
    '',
    '  Ctrl+Alt+P  pause / resume',
    '  Ctrl+Alt+T  pin the widget above other windows',
    '  Ctrl+Alt+H  hide the widget from screen shares / show it again',
    '  Ctrl+Alt+E  expand / collapse the panel',
    '  Ctrl+Alt+Q  quit',
    '',
    '  The tray dot carries the same switches on right-click.',
  ].join('\n'));
  process.exit(0);
}

if (args.includes('--cli') || args.includes('-c')) {
  require('./cli.js');
} else {
  console.error('The widget runs under Electron now: use `npm start`.');
  console.error('For the terminal front end: node cache-warmer.js --cli');
  process.exit(1);
}
