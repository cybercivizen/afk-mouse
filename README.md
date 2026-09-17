# afk-mouse

Keeps the machine from going idle by moving the pointer along plausible,
curved paths every 25–90 seconds, and backs off the moment you touch anything
yourself. It lives in a small desktop panel rather than a console, with a
taskbar button and a tray icon.

```
● 42s  ⤒👁        ⌄          compact, 128x39
```

The panel is excluded from screen capture by default, so it does not appear in
Teams, Zoom, Meet, OBS, the Snipping Tool or PrintScreen.

## Requirements

Node 22+ and Electron. The panel targets Windows 10 2004 or newer, because
that is the floor for excluding a window from screen capture; the terminal
front end runs anywhere the native modules build.

```
npm install
npm run rebuild
```

`npm run rebuild` is the step that matters: `uiohook-napi` and the nut-js fork
are native modules and arrive built for Node's ABI, not Electron's. Without it
the main process throws on `require` at startup. Re-run it after every Electron
version bump. `node_modules` does not travel between machines.

## Running it

| what you want | do this |
|---|---|
| panel, no console window | double-click `cache-warmer.vbs` |
| panel with the log visible | `npm start`, or `cache-warmer.cmd` |
| terminal only, no Electron | `node cache-warmer.js --cli` |
| panel visible to screen capture, one run | `npm start -- --show-in-capture` |

`node cache-warmer.js --help` prints the same summary.

## Shortcuts

Global, so they work whatever has focus. The tray icon's right-click menu
carries the same switches.

| keys | does |
|---|---|
| `Ctrl+Alt+P` | pause / resume |
| `Ctrl+Alt+T` | keep the panel above other windows |
| `Ctrl+Alt+H` | hide the panel from screen capture / show it |
| `Ctrl+Alt+E` | expand the panel / collapse it |
| `Ctrl+Alt+Q` | quit |

The panel drags from anywhere, double-click flips its size, and the chevron
does the same. In compact it shows two read-only state icons: an arrow into a
ceiling (green while pinned on top) and an eye — struck through and green
while hidden from capture, open and amber while a screen share would see it.
Green is the state doing its job; amber is the one worth noticing.

Expanded, the top right carries four controls on one row: the chevron, an
arrow into a floor, a bar and a quit cross. The two middle ones are both ways
of getting out of the way, and they are not the same:

| control | does |
|---|---|
| arrow into a floor | minimize to tray — the window goes away, the tray dot brings it back |
| bar | minimize to taskbar — the button stays there and restores it |

Both the tray dot and the taskbar icon carry the state in their colour: green
while it is running, amber while it is holding off because you are active,
grey while paused.

Pinning has no button of its own any more; the lit `stay on top` row already
reports it. Toggle it with `Ctrl+Alt+T` or from the tray menu.

Only one panel runs at a time. Launching it again while it is hidden or
minimized brings the running one back instead of starting a second, which
matters because two of them would fight over the cursor.

Position, size, pinning, capture hiding and whether the panel is shown at all
are remembered in `widget-state.json` under the app's userData directory —
`%APPDATA%\cache-warmer` on Windows. A packaged build cannot write beside its
own source, which is why it no longer lives next to the code. A
`.widget-state.json` left over from the PowerShell build is read once, so a
saved position survives the port.

## Layout

| file | job |
|---|---|
| `main.js` | Electron main: owns state, the engine, the window and the tray |
| `engine.js` | the loop: scheduling, motion, activity backoff, global hotkeys |
| `preload.js` | the only bridge into the renderer |
| `renderer/` | the panel: `index.html`, `app.css`, `app.js` |
| `tray-icon.js` | the tray dot, rasterised rather than shipped as an asset |
| `cli.js` | terminal front end |
| `cache-warmer.js` | plain-Node entry; `--cli` and `--help` |
| `cache-warmer.vbs` / `.cmd` / `.sh` | launchers |

Node owns every decision; the renderer draws and reports. They talk over
Electron IPC through a context-isolated preload, which is the same split the
PowerShell panel had over a loopback socket:

```
main -> ui   state {on, phase, secs}
             flags {pinned, expanded, capHidden, animating, panelShown, paused}
ui   -> main ui-ready  toggle-pause  set-pin  set-capture  set-expanded
             quit  drag-start  drag-move  drag-end
```

A note on vocabulary: the source talks about warming cache slots — a slot is a
cursor position and warming one is moving to it. `HANDOFF.md` has the rest of
the working knowledge, including what the port changed.

## Packaging

```
npm run icon     # regenerate build/icon.ico from the tray dot
npm run pack     # unpacked directory only, for a quick look
npm run dist     # the installer and the zip, into dist/
```

`npm run dist` produces two things in `dist/`:

| file | for |
|---|---|
| `Cache Warmer-<version>-x64.exe` | an NSIS installer — double-click, per-user, no admin |
| `Cache Warmer-<version>-x64.zip` | portable — unzip anywhere and run the exe |

The zip is the better way to hand someone a prototype: nothing is installed,
and deleting the folder is the uninstall.

Neither is code-signed, so Windows SmartScreen will warn on first run with
"Windows protected your PC" and no publisher name. Getting rid of that needs a
paid certificate, and since 2023 an OV certificate has to live on a hardware
token, so it is not worth it before the thing is real.

One more thing to expect when sending it to someone: this app installs a
global keyboard hook, synthesises mouse movement and hides its own window from
screen capture. That combination is also what a keylogger looks like from the
outside, so an unsigned build arriving over the internet stands a fair chance
of being flagged by Defender or whatever else is running. That is the
antivirus reading the behaviour correctly, not a bug.

The `appx` block in `package.json` is kept for a Store submission later. It is
deliberately not in the target list: it needs the real Partner Center identity,
and `publisher` / `publisherDisplayName` are placeholders. `HANDOFF.md` has the
rest of what a Store build would need.
