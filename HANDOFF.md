# Handoff

State of play as of 18 September 2026. Read `README.md` first for what the
thing is and how to run it; this file is what you would otherwise have to
rediscover.

## Where it stands

Working on Windows 11. It started as a terminal-only mouse jiggler, became a
headless engine behind a WinForms panel driven over a loopback socket, and is
now the same engine behind an Electron window. Everything below has been
exercised against the running app, not just written.

- Two panel sizes, 128x39 compact and 196x160 expanded, with an animated
  resize between them.
- Excluded from screen capture by default, toggleable at runtime, remembered.
- Tray dot and taskbar icon both follow the state in colour — green running,
  amber holding, grey paused — and the tray carries the full switch list on
  right-click.
- Two separate ways off screen: the bar minimizes to the taskbar, the arrow
  into a floor hides to the tray. One panel at a time — a second launch shows
  the running one instead.
- Position, size, pinning, capture hiding and panel visibility all persist.

## How the pieces fit

`engine.js` decides everything and knows nothing about the UI. It came through
the port unchanged. It emits `log`, `change` and `hotkey` events, and exposes
`snapshot()` — `{ on, phase, secs }` where phase is `wait`, `move`, `hold` or
`off`.

`main.js` is the Electron main process. It owns the state object written to
`widget-state.json`, the window, the tray and every switch. `renderer/` draws
what it is sent and reports what the user did; it holds no policy of its own,
which is the same split the PowerShell panel had. `preload.js` is the only
bridge, context-isolated.

State keys in `widget-state.json`, under `app.getPath('userData')`: `x`, `y`,
`pinned`, `expanded`, `hideFromCapture`, `panelShown`. The names are unchanged
from the PowerShell build, and a leftover `.widget-state.json` beside the
source is read once so a saved position survives the port.

Two details in the engine that are easy to miss:

- **Shielding.** The window's rectangle goes to the engine on every move and
  at the end of every resize, and the engine ignores pointer activity inside
  it — otherwise dragging the panel would read as "the user is here" and
  trigger the backoff. A hidden panel reports an empty rectangle, which
  shields nothing and is deliberately not persisted as a position. A
  *minimized* panel does the same, and needs its own flag to do it: its bounds
  go stale while it is down, so reading them back would shield a rectangle the
  window is no longer in.
- **Backoff.** Any real input schedules the next pass 60s out on top of the
  normal 25–90s wait, so the visible countdown reaches 150s. That number is
  why the compact countdown box is 47px wide.

## Things that cost time to find out

1. **Native modules must be rebuilt for Electron's ABI.** `npm install` alone
   leaves you with modules built for Node, and the main process throws on
   `require` at startup. `npm run rebuild` fixes it, and has to be re-run
   after every Electron bump. Only `uiohook-napi` actually rebuilds — the
   nut-js fork's `libnut-win32` is Node-API and portable across both ABIs.
2. **Electron's own binary download can silently not happen.** `npm install`
   exited 0 with `node_modules/electron/dist` absent and no `path.txt`.
   Running `node node_modules/electron/install.js` fetched it. Check that
   `dist/electron.exe` exists before concluding anything else is broken.
3. **A Node timer of 4ms or more falls onto Windows' coarse ~15ms timer**,
   while 1ms takes a fast path, and for anything animating a window this is
   the difference between smooth and not. Measured over four runs each, on a
   143Hz display, for the 180ms expand:

   ```
   tick=8  ->  13 frames / 186ms    70 fps
   tick=4  ->  13 frames / 185ms    70 fps
   tick=1  ->  32 frames / 184ms   173 fps
   ```

   8 and 4 both cost about 14ms a frame no matter what you ask for, capping at
   roughly half the refresh rate, which is what "the animation is a bit laggy"
   turned out to mean. `ANIM_TICK` is 1 for this reason. The animation is also
   paced off elapsed time rather than a step count, so a slow frame costs a
   skipped position instead of a longer animation — the old fixed-interval
   loop could stretch well past its nominal duration under load.
4. **A transparent frameless window has a hard floor of 39px tall.** Measured
   across a range, asking for 30 through 39 all yield 39, while 40 and up come
   back exact:

   ```
   asked 30 36 38 39 40 41 50 160
   got   39 39 39 39 40 41 50 160
   ```

   This is the old minimum-tracking-size clamp in new clothing. The WinForms
   panel beat it by re-stating its bounds through `SetWindowPos`; Electron has
   no equivalent, and `setMinimumSize(1, 1)`, `minHeight` in the constructor,
   `resizable`, `thickFrame` and `setContentSize` all make no difference. So
   the compact panel is 128x39 and asks for exactly that. Asking for 38 and
   getting 39 is what made the corner anchoring drift a pixel per
   expand/collapse cycle, because the anchor was computed from a height the
   window never had.
5. **An opaque frameless window reports honest bounds but is not the answer.**
   It gives a true 128x38, but `GetWindowRect` comes back 144x46 — an
   invisible resize frame around it — which would feed a wrong rectangle to
   the engine's shield and put the panel 8px off where it looks. Transparency
   costs a pixel of height and buys bounds you can trust.
6. **`setContentProtection` reports nothing back.** The raw
   `SetWindowDisplayAffinity` returned a bool, so the old panel could notice
   Windows refusing to hide it and say so. Electron's wrapper returns void, so
   that warning path is gone; the app now assumes the state it asked for.
   `GetWindowDisplayAffinity` still reads `0x11` from outside if you want to
   check.
7. **You cannot screenshot the panel while it is hidden from capture** — a
   screen-region capture shows straight through to whatever is behind it,
   which is the whole point of the feature. For UI work, run with
   `--show-in-capture`. This also means the *hidden* visuals — struck-through
   eye, lit "hide in shares" row — cannot be photographed at all; drive them
   from DevTools by adding the `cap-hidden` class to `#panel` by hand.
8. **CSP blocks inline `style` attributes.** The shortcut rows were originally
   placed with `style="top:100px"`, which silently did nothing. Row offsets
   live in `app.css` as `nth-child` rules instead.
9. **Two ways off screen need two ways back.** Hidden to the tray is
   `panelShown: false`; minimized to the taskbar leaves `panelShown` true and
   only `isMinimized()` set. Anything that wants the panel in front of the
   user has to handle both, which is what `ensureOnScreen()` is for — without
   it, clicking the tray icon while minimized animates a window nobody can
   see. A minimized panel also has to shield nothing, and needs its own flag
   to do it, because its bounds go stale while it is down.
10. **The expanded controls share one centre line, y=19.** That is where the
    dot, the countdown and the compact state icons already sit. The chevron
    was on 19 while the close cross sat on 16, a 3px step that nobody noticed
    with two items and everybody noticed with four. They are 22x22 boxes on a
    22px pitch so the hit-boxes butt together without overlapping — at the old
    20px pitch two of them shared 2px and stole each other's clicks.
11. **The two shortcut columns span the whole panel.** `.keys` and `.acts` are
    `inset: 0` so their rows can be placed by `top` alone, which means they
    cover everything and must be `pointer-events: none`, with the rows
    themselves `auto`. Miss that and dragging the background stops working the
    moment the panel opens.
12. **Dragging is done by hand, not with `-webkit-app-region: drag`.** An
    app-region drag fires no events, and the engine has to be told to hold its
    shield for the duration and handed the new rectangle at the end. The
    renderer sends pointer deltas coalesced onto a frame; main applies them to
    the bounds it captured at grab time, which is what the old panel did with
    `Cursor.Position`.
13. **AltGr is Ctrl+Alt to Windows**, which matters on the AZERTY layout this
    was built on, where AltGr+E is the euro sign. Measured: `uiohook` clears
    `ctrlKey` for AltGr, so the shortcuts were never actually at risk. The
    guard in `_installHooks` stays anyway, and self-heals so a missed key-up
    cannot wedge the shortcuts off. Keeping `uiohook` for the shortcuts rather
    than moving to Electron's `globalShortcut` is deliberate: the same hook
    already has to see every key for the activity backoff, and one source
    keeps the two from disagreeing.
14. **A window icon has to be re-set, not just constructed.** `icon:` in the
    BrowserWindow options is a one-off; the taskbar button reads the window
    icon, so following the state means calling `win.setIcon()` on every change
    the way the tray gets `setImage()`. Both come from the same generated dot,
    at 32px and 16px. One wrinkle: the painter starts before the window
    exists, so a tint decided in that gap would be recorded in `lastTint` and
    never applied — `ready-to-show` clears `lastTint` so the next paint
    re-applies for certain.
15. **The backoff log only fires on the way in.** `onExternalActivity` logs
    only when it is not already backing off, so continuous input extends the
    window silently and the log looks idle while nothing is happening. The
    only outward sign is the countdown jumping back up — `secs` going 33 then
    52 means fresh input, not a bug. This cost real time while checking the
    icon colours: the panel looked stuck in amber and the log said nothing,
    because the machine was simply in use.
16. **Windows 11 files new tray icons into the overflow.** The icon is
    registered correctly; it has to be dragged out of "Show hidden icons" once
    to stay on the taskbar.

## What is verified, and how

Against the running app, this build:

- Compact and expanded photographed by capturing the window's screen region
  while running with `--show-in-capture`; both match the WinForms layout.
- Expanded geometry exact at 196x160. Compact exact at 128x39.
- **No drift**: repeated expand/collapse cycles driven by real `Ctrl+Alt+E`
  chords land on identical coordinates every time — `1768,1017 128x39` and
  `1700,896 196x160`, repeating.
- Capture exclusion confirmed two ways: `GetWindowDisplayAffinity` reads
  `0x11` after `Ctrl+Alt+H` and `0x00` after a second press, and a
  screen-region capture while hidden shows the window behind it. It also
  survives a pause and is correctly *not* forced back on by an unpin.
- Every shortcut driven with synthetic `Ctrl+Alt` chords: P (grey dot, `OFF`),
  T (pin arrow goes green to grey), H, E, Q (exits clean, no processes left).
- The **first-chord miss** from the WinForms build reproduced once here: a
  `Ctrl+Alt+Q` sent 17s after a cold start was logged as `Key write detected`
  rather than matching the combo, and the very next one quit immediately. It
  lives in `engine.js`, which the port did not touch, so it is the same
  pre-existing flake and not a regression — but there are now two sightings,
  both on a cold app. If it ever needs chasing, the suspects are the AltGr
  guard seeing a synthetic right-Alt and `uiohook`'s modifier flags settling
  late after `start()`.
- Persistence: all six keys written to `%APPDATA%\cache-warmer`, and a
  one-run `--show-in-capture` confirmed not to write itself into them.
- Taskbar presence read off the window itself: `WS_EX_TOOLWINDOW` clear, which
  is what keeps a window out of the taskbar.
- The minimize bar clicked at its real screen coordinates: the window went
  `IsWindowVisible` false and `panelShown` false, and `Ctrl+Alt+E` brought it
  back to the canonical compact spot.
- Taskbar icon colour read back out of the live window with `WM_GETICON` and
  sampled: `(74,222,128)` green 0.7s after launch, `(251,191,36)` amber once
  real input arrived, `(110,114,124)` grey while paused. Those are the exact
  palette values, so the taskbar is tracking the same three states as the tray.
- Single instance: a second launch exits 0 and leaves exactly one window with
  a main handle. Launched while the first was hidden, the first logged `Panel
  shown` and flipped `panelShown` back to true rather than a duplicate
  appearing.
- The two minimize paths are genuinely different, clicked at their real screen
  coordinates: the bar gives `IsIconic` true with `panelShown` still true, the
  floor arrow gives `IsWindowVisible` false with `panelShown` false.
- Animation holds a fixed duration: `184ms / 180ms / 185ms` across runs, at 32
  frames, which is 173fps against a 143Hz display. It cannot stretch under
  load the way the old step-counted loop could.
- Animation timing measured from inside the app rather than by polling from
  outside, which matters: a PowerShell poll loop with `Start-Sleep
  -Milliseconds 3` actually sleeps ~15ms and gave numbers that were wrong by
  more than a factor of two.

## Not done

- The expanded content still appears on the last animation frame rather than
  fading in. In WinForms that was forced — the labels were clipped at the
  in-between sizes. Electron does not clip, so this is now only a one-line
  change: drop the `.animating` rule at the foot of `app.css` and give
  `.panel-only` a transition. Left as it was to keep the port behaviour-for-
  behaviour.
- No automated tests. `tools/` is a manual harness for the *retired*
  PowerShell panel and does not drive this build; DevTools replaces it.
- `package.json` still calls the project `cache-warmer`, and the source keeps
  the cache-warming vocabulary throughout. The repo name is the honest one.
  This matters more than it used to: Microsoft Store policy 10.1 requires the
  listing to reflect what the product actually does, so the name has to change
  before any submission.
- Nothing is signed, so every build trips SmartScreen on a machine that did
  not build it. An OV certificate has needed a hardware token since 2023, so
  this waits until the thing is real.
- The `.exe` icon is generated, not committed: `scripts/make-icon.js` writes
  `build/icon.ico` in pure Node — a supersampled circle, PNG-encoded with
  zlib, wrapped in an ICO container — from the same dot and the same `on`
  tint the tray uses. `build/icon.ico` is git-ignored and `npm run dist`
  regenerates it. One quirk if you ever verify it: `System.Drawing.Icon`
  cannot read PNG-compressed 256px entries and silently hands back the 128px
  one instead, so a size check from PowerShell under-reports. The Windows
  shell reads them fine.
- `appx` is configured but kept out of the target list: it needs the real
  Partner Center identity, and `publisher` / `publisherDisplayName` are
  placeholders.
- No autostart entry. A packaged build should use the MSIX
  `windows.startupTask` extension rather than a `shell:startup` shortcut.
- The pin has no button of its own now that `ON TOP` is gone. `Ctrl+Alt+T`
  and the tray menu still toggle it, and the lit `stay on top` row still
  reports it, but there is no mouse-only path. Making that row clickable would
  be the obvious fix if it turns out to matter.
