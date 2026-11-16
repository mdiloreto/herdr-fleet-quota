# Fleet quota

A Herdr mod that shows the AI quota each machine in your fleet has already recorded, side by side: a compact badge in a bar and a dialog with one section per machine, one row per provider or account, and one track per quota window.

> A sanitized preview image will be supplied before any public publication. This recipe deliberately does not link to a `preview.png` that does not exist yet.

## What you see

**The badge**, 118 px wide and as tall as its bar: a compact indicator plus the fleet's highest reported quota percentage. The indicator distinguishes complete coverage from incomplete coverage, and the number carries `~` when the highest reading itself is old or from an offline host and `!` when any machine, percentage or record is missing. The whole badge is a button: clicking it opens the dialog, and its tooltip and accessibility label name the host, provider and account behind the number and how many machines were read.

**The dialog**, 620×560, centered, top to bottom:

1. **Header:** the mod title beside a coverage summary — how many machines have a reading, with an in-flight note while a read is running — and, at the right, a reread control and a close control.
2. **Notice strip**, only after a failed machine listing or a failed refresh: the failure in the theme's blocked color on a bordered strip. What was read before stays below.
3. **Scrolling host list:** one card per machine, this computer first and the rest sorted by name. Each card has the machine's icon and name, its status word, and notes when records were unreadable or omitted, when the rows shown are an earlier reading, and when it was last read.
4. **Provider rows** inside each card: the provider icon and provider id, the account label and active marker when the reading is split per account, an old marker for stale rows, an incomplete marker when windows were omitted, and the record time.
5. **Quota windows** under each provider: the window label, `N% used` or `? used`, its reset time (or that the reset has passed), and a horizontal progress track whose fill follows the percentage. A prepaid balance shows its remaining amount as the label, with `no percentage` when no funded amount was recorded. Unknown windows say `? used`; they never read as 0%.
6. **Footer:** one line stating that each line is one machine's own reading and that nothing here is added up.

Type, spacing and colors come from the active Herdr theme; the mod sets no fixed palette. Only the host list scrolls: header and footer stay put.

## How it behaves

- **Refresh:** every 60 seconds, plus the dialog's reread control. One refresh at a time — a slow fleet cannot stack timers. Each refresh lists machines, reads this computer and every connected machine, up to 4 reads at once, each `exec` bounded to 8 seconds.
- **`read`:** the host answered and at least one row parsed. It does not mean fresh percentages: rows can still be marked old, and windows become unknown when their reset time passes. `lastSuccessAt` updates.
- **`no data`:** the host is connected and reachable but the collector directory is absent (exit 4), or the read parsed no records. Old rows are dropped: there is nothing to carry. Normal for a machine without the collector.
- **`offline`:** a machine Herdr lists as not connected is not read. Its previous rows stay visible, marked old; windows whose reset time has passed become unknown.
- **`error`:** the read failed (no `jq`, unreadable `shell.json`, no output, unparseable records, unreachable while listed connected). Previous rows stay, marked old; the card shows the reason. One failing machine never hides or stops the others.
- **Partial data:** valid rows beside unreadable files keep the host `read`, and `N unreadable or omitted` counts them. More than 16 accounts per provider or 20 windows per account is reported as omitted, not silently dropped.
- **Clicks:** the whole badge is a button and opens the dialog (the press does not start a window drag); the reread control rereads; the close control and Esc close. No keys are bound: the mod ships no `keys.json`. Nothing else is clickable.

## Built from

- **Layout:** one `block` node with `content: { "mod": "fleet-quota", "props": { "part": "bar" } }` and `size: { "px": 118 }` (see `examples/bar-block.json`; it is a fragment for a row, not a layout). The dialog is an overlay the mod opens itself, not a layout node.
- **`mod.json`:** `{ "place": "none", "title": "Fleet quota" }` — nothing is docked automatically; a layout must place the block.
- **`main.js`:** a gpui-kit `View`. Renders the badge when `props().part === "bar"`, otherwise the dialog panel. `openOverlay({ mod: "fleet-quota", kind: "dialog", width: 620, height: 560, props: { part: "panel" } })`. Uses `checking()` to skip all reads during `herdr-app check`, `cx.timer.every(60000, …)`, `cx.spawn`, `cx.notify`, `theme()`, `props()`, `closeOverlay`.
- **`fleet.js`:** `collectFleet({ listMachines, readHost, previous, now, concurrency })`. Local machine first, then `hc machine ls --json` names sorted; skips duplicates, invalid names and non-connected machines; bounded worker pool (max 4); carries previous rows on offline/error; `no-data` on exit 4.
- **`model.js`:** `READ_SCRIPT` (POSIX `sh` + `jq`) and `parseQuota(output, now)`. The script reads `$XDG_STATE_HOME/omarchy/agents/usage` (default `~/.local/state/omarchy/agents/usage`), at most 64 `*.json` files of at most 256 KiB each, and the optional `$XDG_CONFIG_HOME/omarchy/shell.json` for disabled providers and `refreshIntervalSec`. It refuses symlinks, oversized or invalid files, and emits only bounded quota fields.
- **Herdr functions:** `exec("sh", ["-c", READ_SCRIPT], { on: machineName, timeout: 8000 })`, `hc(["machine", "ls", "--json"])`, `openOverlay`, `closeOverlay`, `props`, `theme`, `checking`.
- **Icons:** provider icons already shipped with Herdr for claude, codex, copilot, antigravity and gemini, plus a small set of original glyphs in `mods/fleet-quota/icons/`, drawn with `svg(…)`. No other images, no fonts, no sounds.
- **Network:** no provider API and no new listener. The reads travel over Herdr's existing machine transport (`hc machine ls`, `exec(…, { on })`), which does use the network between Herdr and the listed hosts; nothing contacts a provider endpoint.

Reading semantics in one place: record percentages are fractions (`0.42` → `42% used`), clamped at 100 because overage is real; a window whose reset time has passed is unknown (`?`); a row is old when the producer says stale, its timestamp is older than the larger of 30 minutes and twice the collector interval, or it is more than 5 minutes in the future; a balance gets a percentage only when `funded` is present and the remaining amount does not exceed it.

## Watch out

- **The collector is an assumption, not a dependency to install.** No Omarchy quota records on a host means `no data`, which is a correct outcome. Do not add providers, credentials or collector files to make a host light up.
- **Unix hosts only.** The reader needs `sh` and `jq`; a Windows host cannot answer it and reads as `error`.
- **`herdr-app check` is not a live test.** It renders once with `checking()` true and no `props`, so it proves the default panel renders — not the bar, and not a live read. A live window with the bar block is needed for the badge; `herdr-app status` and a real window are needed for the rest.
- **Caps are deliberate:** 64 record files, 256 KiB per file, 20 windows per account, 16 accounts per provider, 4 concurrent hosts, 8 s per read. Raising them without changing the notices would hide data silently.
- **118 px is load-bearing.** The badge is built for that width; a narrower block truncates its number and coverage mark. The dialog is fixed at 620×560 and scrolls the host list.
- **Nothing is summed.** The same provider on two machines stays two rows, and two accounts stay separate, because the mod cannot verify whether logins share one quota.
- **Unknown is not zero.** `? used` and `no percentage` both mean "not known", never "0% used".
- **Renaming the folder** requires updating `content.mod` in the layout, the `mod` name in `main.js`'s `openOverlay` call, and the `mods/fleet-quota/…` asset paths (including `icons/`); `mod.json` places nothing by default.
- **Overlay width/height live in code**, not `mod.json`, so a fresh build should keep the `openOverlay` call in `main.js`.

## Done when

- `npm test` passes: fixture checks of the record reader, host collection and the UI, with no provider calls and no real quota files.
- `npm run check` parses every `mods/fleet-quota/*.js` file without a syntax error.
- `herdr-app check ~/.config/herdr-app/mods/fleet-quota` exits 0 for the default panel render.
- `herdr-app status` shows no error for this mod, and `herdr-app shot` shows the 118 px badge in its bar.
- Clicking the badge opens a 620×560 dialog with the header, a card per machine, provider rows, quota tracks and the footer; the reread control rereads and the close control or Esc closes.
- On a connected host with the collector, real percentages appear; on a disconnected one, its card says `offline`, keeps its last rows and sets `!` (and `~` only when that host's old reading is the highest shown); on a host without the collector, its card says `no data`; any such gap also sets `!`.
