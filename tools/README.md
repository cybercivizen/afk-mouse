# tools

Manual harnesses for working on the panel. None of this ships or runs in CI;
it exists so UI changes can be looked at rather than guessed at.

| file | does |
|---|---|
| `harness2.js` | runs `widget.ps1` against a fake engine and photographs six states |
| `animtest.js` | fires the expand animation and photographs it frame by frame |
| `shot.ps1` | one `PrintWindow` capture of the panel, printing rect and display affinity |
| `burst.ps1` | a burst of captures at a fixed interval, for animations |

Shots land in `tools/shots/` and are git-ignored.

```
node tools/harness2.js
node tools/animtest.js
```

## Two tricks you will need

**Photographing a panel that is hidden from capture.** You cannot —
`PrintWindow` returns black, which is the whole point of the feature. The
harnesses start the panel with `-HideFromCapture 0`, but that also means the
*hidden* visuals (struck-through eye, lit "hide in shares" row) never show up.
Make a scratch copy whose affinity call reports success without applying it,
and run the harness against that:

```js
const fs = require('fs');
const s = fs.readFileSync('widget.ps1', 'utf8');
fs.writeFileSync('/tmp/widget-viz.ps1', s.replace(
  '      $got = [Native.Win]::SetWindowDisplayAffinity($form.Handle, $WDA_EXCLUDEFROMCAPTURE)',
  '      $got = $true   # viz copy'));
```

```
node tools/harness2.js /tmp/widget-viz.ps1
```

**Photographing the animation.** At 14 steps it lasts ~210ms while each
capture costs ~90ms, so make a copy with `$script:animSteps = 45` and point
`animtest.js` at it. The painting behaviour is identical; only the clock
changes.

Magnifying a shot 4x with `InterpolationMode.NearestNeighbor` is how the 12px
icons were judged — at 1:1 you cannot tell a good chevron from a bad one.
