# afk-mouse

Keeps the machine from going idle by moving the pointer along plausible,
curved paths every 25–90 seconds, and backs off the moment you touch anything
yourself. It lives in a small desktop panel and a tray icon, not a console.

```
● 42s  ⤒👁        ⌄          compact, 128x38
```

The panel is excluded from screen capture by default, so it does not appear in
Teams, Zoom, Meet, OBS, the Snipping Tool or PrintScreen.

## Requirements

Node 22+. The panel is WinForms, so it needs Windows 10 2004 or newer;
elsewhere only the terminal front end runs.

```
npm install
```

`uiohook-napi` and the nut-js fork are native modules — they build per
platform, so `node_modules` does not travel between machines.

## Running it

| what you want | do this |
|---|---|
| panel, no console window | double-click `cache-warmer.vbs` |
| panel with the log visible | `cache-warmer.cmd`, or `node cache-warmer.js` |
| terminal only, no panel | `node cache-warmer.js --cli` |
| panel visible to screen capture, one run | `node cache-warmer.js --show-in-capture` |

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
ceiling (green while pinned on top) and an eye (struck through and grey while
hidden from capture, open and amber while a screen share would see it).

Position, size, pinning, capture hiding and whether the panel is shown at all
are remembered in `.widget-state.json` next to the source.

## Layout

| file | job |
|---|---|
| `cache-warmer.js` | entry point; parses flags and hands off |
| `engine.js` | the loop: scheduling, motion, activity backoff, global hotkeys |
| `widget.js` | host: owns state, spawns the panel, talks to it over a socket |
| `widget.ps1` | the panel and the tray icon; renders what it is sent |
| `cli.js` | terminal front end |
| `cache-warmer.vbs` / `.cmd` / `.sh` | launchers |
| `tools/` | harnesses for driving the panel while developing it |

Node owns every decision; the panel renders and reports. They talk in
newline-delimited text over a loopback socket, authenticated with a token
passed on the command line:

```
node -> ui   S|<on>|<phase>|<secs>  PIN|<0|1>  CAP|<0|1>  EXP|<0|1>  BYE
ui   -> node HELLO|<token>  TOGGLE  PIN|<0|1>  CAP|<0|1>  EXP|<0|1>
             VIS|<0|1>  RECT|x|y|w|h  DRAG|<0|1>  QUIT
```

A note on vocabulary: the source talks about warming cache slots — a slot is a
cursor position and warming one is moving to it. `HANDOFF.md` has the rest of
the working knowledge.
