#!/usr/bin/env node
// cache-warmer.js — keeps hot cache slots warm so entries don't expire (Node 22+)
//
// Setup:   npm install
// Run:     double-click cache-warmer.vbs     (widget, no console window)
//          node cache-warmer.js              (widget, console attached)
//          node cache-warmer.js --cli        (terminal only, no widget)
//
// The widget is hidden from screen shares and screenshots by default, and
// lives in the tray rather than the taskbar. --show-in-capture makes it
// visible to capture for one run; Ctrl+Alt+H is the setting that sticks.
//
// Hotkeys: Ctrl+Alt+P  pause / resume
//          Ctrl+Alt+T  keep the widget above other windows / release it
//          Ctrl+Alt+H  hide the widget from screen shares / show it again
//          Ctrl+Alt+E  expand the panel / collapse it back to compact
//          Ctrl+Alt+Q  quit   (Ctrl+C in the terminal works too)

'use strict';

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log([
    'cache-warmer — keeps hot cache slots warm so entries don\'t expire',
    '',
    '  node cache-warmer.js          small on-screen widget (default)',
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
  process.exit(0);
}

if (args.includes('--cli') || args.includes('-c')) {
  require('./cli.js');
} else {
  require('./widget.js');
}
