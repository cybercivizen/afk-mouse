'use strict';
// preload.js — the only bridge across the renderer boundary.
//
// The renderer has no Node access. It gets two subscriptions and a short list
// of things it may ask for, which is the same deal the PowerShell panel had
// over the socket: it reports what the user did and renders what it is sent.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('warmer', {
  // main -> ui
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onFlags: (fn) => ipcRenderer.on('flags', (_e, f) => fn(f)),

  // ui -> main
  ready: () => ipcRenderer.send('ui-ready'),
  togglePause: () => ipcRenderer.send('toggle-pause'),
  quit: () => ipcRenderer.send('quit'),
  hidePanel: () => ipcRenderer.send('hide-panel'),
  minimize: () => ipcRenderer.send('minimize-window'),

  setPin: (v) => ipcRenderer.send('set-pin', !!v),
  setCapture: (v) => ipcRenderer.send('set-capture', !!v),
  setExpanded: (v) => ipcRenderer.send('set-expanded', !!v),

  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
