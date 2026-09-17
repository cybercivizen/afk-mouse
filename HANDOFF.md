# Handoff

State of play as of 17 September 2026. Read `README.md` first for what the
thing is and how to run it; this file is what you would otherwise have to
rediscover.

## Where it stands

Working and in daily use on Windows 11. It started as a terminal-only mouse
jiggler and is now a headless engine behind two front ends, a desktop panel
and a tray icon. Everything below has been exercised against the running app,
not just written.

- Two panel sizes, 128x38 compact and 196x160 expanded, with an animated
  resize between them.
- Excluded from screen capture by default, toggleable at runtime, remembered.
- Tray icon whose colour follows the state, with the full switch list on
  right-click. No taskbar button.
- Position, size, pinning, capture hiding and panel visibility all persist.

## How the pieces fit

`engine.js` decides everything and knows nothing about the UI. It emits `log`,
`change` and `hotkey` events, and exposes `snapshot()` — `{ on, phase, secs }`
where phase is `wait`, `move`, `hold` or `off`. `widget.js` owns the state
object that gets written to `.widget-state.json`, spawns `widget.ps1` and
mediates between the two. `widget.ps1` renders what it is sent and reports
what the user did; it holds no policy of its own.

State keys in `.widget-state.json`: `x`, `y`, `pinned`, `expanded`,
`hideFromCapture`, `panelShown`.

Two details in the engine that are easy to miss:

- **Shielding.** The panel sends its rectangle on every move and resize, and
  the engine ignores pointer activity inside it — otherwise dragging the panel
  would read as "the user is here" and trigger the backoff. A hidden panel
  reports `RECT|0|0|0|0`, which shields nothing and is deliberately not
  persisted as a position.
- **Backoff.** Any real input schedules the next pass 60s out on top of the
  normal 25–90s wait, so the visible countdown reaches 150s. That number is
  why the compact countdown box is 47px wide.

## Things that cost time to find out

1. **PowerShell variables are case-insensitive.** `foreach ($c in ...)`
   silently overwrote the `$C` palette hashtable, so `$C.on` was `$null` by
   the time `Set-Pin` ran and the form threw and closed before painting. The
   window simply never appeared. Loop variables in `widget.ps1` are `$ctl` and
   `$lbl` for this reason — never a single letter.
2. **New windows are clamped to the minimum tracking size** (~136x39 here),
   which is wider than the compact panel. `ClientSize` at construction is not
   honoured; `Apply-Layout` re-states the bounds through `SetBounds` once the
   handle exists, which goes via `SetWindowPos` and is not clamped.
3. **Growing a window only invalidates the strip it uncovered.** The panel
   paints its own border, so every intermediate size of the expand animation
   was left behind — a nest of rectangles inside the panel. Collapsing clips
   them away, which is why only expanding looked wrong. Fixed with
   `ResizeRedraw` plus an explicit `Invalidate()` per animation frame.
4. **Display affinity does not survive a handle recreation**, so
   `Set-Capture` is re-applied after every `TopMost` change.
5. **You cannot screenshot the panel while it is hidden from capture** —
   `PrintWindow` returns black. For UI work, either run with
   `--show-in-capture`, or use the viz-copy trick in `tools/README.md`.
6. **AltGr is Ctrl+Alt to Windows**, which matters on the AZERTY layout this
   was built on, where AltGr+E is the euro sign. Measured: `uiohook` clears
   `ctrlKey` for AltGr, so the shortcuts were never actually at risk. The
   guard in `_installHooks` stays anyway, and self-heals so a missed key-up
   cannot wedge the shortcuts off.
7. **Windows 11 files new tray icons into the overflow.** The icon is
   registered correctly; it has to be dragged out of "Show hidden icons" once
   to stay on the taskbar.
8. The panel's own spawn must not pass `-WindowStyle Hidden`: it rides along
   in STARTUPINFO and the first WinForms window inherits it, so the panel
   never paints. `windowsHide` on the Node side does the job instead.

## What is verified, and how

- Every visual state photographed through `tools/harness2.js`: compact running
  / hidden / unpinned, expanded running / paused / holding.
- The expand animation photographed frame by frame with `tools/burst.ps1` at
  ~35ms intervals against a slowed-down copy, before and after the repaint
  fix, to confirm the leftover borders are gone.
- Every shortcut driven against the live app with synthetic `Ctrl+Alt` chords,
  each one confirmed to apply and persist. One caveat: the very first chord
  sent within seconds of launch was missed once and never recurred on a warm
  app — worth a look if it shows up again.
- Capture exclusion confirmed three ways: `GetWindowDisplayAffinity` reads
  `0x11`, a screen-region capture shows the window behind it rather than a
  black box, and `PrintWindow` on the handle returns black.

## Not done

- The expanded content appears on the last animation frame rather than fading
  in as the panel opens. Deliberate — the labels would be clipped at the
  in-between sizes — but it could be done properly with per-frame opacity.
- No automated tests. `tools/` is a manual harness, not a suite, and nothing
  runs in CI.
- `package.json` still calls the project `cache-warmer`, and the source keeps
  the cache-warming vocabulary throughout. The repo name is the honest one.
- Nothing is signed or packaged, and there is no autostart entry; starting it
  at login means a shortcut to `cache-warmer.vbs` in `shell:startup`.
- `--show-in-capture` is a one-run override on purpose: it never writes itself
  into the saved settings, so a demo cannot quietly leave you visible.
