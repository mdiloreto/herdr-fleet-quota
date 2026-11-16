# Fleet quota

A Herdr mod that shows which AI providers still have capacity across every machine in your fleet: a compact badge of provider icons for a bar, and a dialog with the remaining capacity per machine, provider and account.

> A sanitized preview image will be supplied before any public publication. This recipe deliberately does not link to a `preview.png` that does not exist yet.

## What you see

**The badge**, 118 px wide and as tall as its bar: the icons of the providers that currently report remaining capacity, up to three; with more, two icons and a `+N` count. It shows provider icons only — no percentage and no warning marks. Hovering names the providers (tooltip and accessibility label). With nothing to show it says so honestly: a *Checking* state while the first read runs and an *Unverified* state when no capacity could be confirmed; neither implies zero or exhausted. The whole badge is a button that opens the dialog. Exact label wording is set in `main.js`.

**The dialog**, 620×560, centered, top to bottom:

1. **Header:** the title "Reported quota remaining" and a short status line (independent readings per machine and account, or a reading-in-progress note); at the right, a reread control (saved records only, not a provider query) and a close control. Below it, the providers currently available, or the *Unverified* state.
2. **Notice strip**, only after a failed machine listing or a failed refresh: the failure in the theme's blocked color. What was read before stays below.
3. **Scrolling host list:** one card per machine, this computer first and the rest sorted by name. Each card has the machine's icon and name and its status.
4. **Provider and account rows** inside each card: the provider icon and name, the account label and active marker when the reading is split per account, and the exact age of its reading.
5. **Quota windows and balances** under each provider: the remaining capacity of each window (`N% remaining`) with a progress track, and its exact reset time on hover; a prepaid balance is shown as an amount. Unknown values say so and never read as 0.
6. **Availability reasons:** each provider or account row says whether it is available, exhausted or unknown and why (for example offline, read failed, provider not ready, stale, windows omitted, awaiting a reading after a reset). An estimated value does not count as confirmed capacity.
7. **Footer:** one line stating these are saved quotas, not a routing guarantee, that machines may share accounts so nothing is added up, and that refresh rereads records, not providers.

There is no fleet-wide "highest used" or "incomplete" headline. Type, spacing and colors come from the active Herdr theme and provider tiles use per-provider accents; the mod ships no fixed palette beyond those. Only the host list scrolls.

## How it behaves

- **Refresh:** every 60 seconds, plus the dialog's reread control, the viewer rereads the records already saved on each host. It never queries a provider; how fresh the numbers are depends on the collector (see Watch out). One refresh at a time. Each refresh lists machines (`hc machine ls --json`), reads this computer and every connected machine, up to 4 reads at once, each `exec` bounded to 8 seconds.
- **Capacity:** only a current reading counts as remaining capacity. A stale, expired or incomplete reading is not counted for the badge and is labeled in the dialog.
- **Host states:** `read` means the host answered and at least one row parsed (rows can still be old); `no data` means no collector data or no records; `offline` means Herdr lists the machine as not connected, so it is not read and its previous rows stay visible as old; `error` means the read failed and previous rows stay as old with the reason. One failing machine never hides or stops the others.
- **Partial data:** valid rows beside unreadable files keep the host `read` and the dialog counts what was skipped. More than 16 accounts per provider or 20 windows per account is reported as omitted, not dropped silently.
- **Clicks:** the badge opens the dialog (the press does not start a window drag); the reread control rereads; the close control and Esc close. No keys are bound and the mod ships no `keys.json`.

## Built from

- **Layout:** one `block` node with `content: { "mod": "fleet-quota", "props": { "part": "bar" } }` and `size: { "px": 118 }` (see `examples/bar-block.json`; a fragment for a row of a personal layout, not a layout). The dialog is an overlay the mod opens itself.
- **`mod.json`:** `place: "none"` prevents automatic docking; `overlay: { "width": 620, "height": 560 }` sizes the dialog when opened with `herdr-app do mod.open --name fleet-quota`.
- **`main.js`:** a gpui-kit `View`. Renders the badge when `props().part === "bar"`, otherwise the dialog panel, which is also what `herdr-app check` renders. `openOverlay({ mod: "fleet-quota", kind: "dialog", width: 620, height: 560, props: { part: "panel" } })`. Uses `checking()` to skip all reads during a check, `cx.timer.every(60000, …)`, `cx.spawn`, `cx.notify`, `theme()`, `props()`, `closeOverlay`.
- **`fleet.js`:** `collectFleet({ listMachines, readHost, previous, now, concurrency })`: this computer first, then machine names sorted; skips duplicates, invalid names and machines that are not connected; bounded worker pool of 4; carries previous rows on offline or error.
- **`model.js`:** `READ_SCRIPT` (POSIX `sh` + `jq`) and the record parsing. On each host the script reads `$XDG_STATE_HOME/omarchy/agents/usage` (default `~/.local/state/omarchy/agents/usage`), at most 64 `*.json` files of at most 256 KiB each, and the Omarchy widget settings: the stock `omarchy.agents` entry when present, otherwise the older `mateod.agents` entry, for the refresh interval and disabled providers. It refuses symlinks and oversized or invalid files and emits only bounded quota fields.
- **Herdr functions:** `exec("sh", ["-c", READ_SCRIPT], { on: machineName, timeout: 8000 })`, `hc(["machine", "ls", "--json"])`, `openOverlay`, `closeOverlay`, `props`, `theme`, `checking`.
- **Art:** provider icons already shipped with Herdr plus eight original SVGs in `mods/fleet-quota/icons/` (`chevron-right`, `clock`, `close`, `desktop`, `gauge`, `provider`, `refresh`, `server`), drawn with `svg(…)`. No other images, fonts or sounds.
- **Installer:** `scripts/install.sh`, POSIX `sh`, report-only unless `--install`. Copies exactly `main.js`, `model.js`, `fleet.js`, `mod.json` and those eight icons into `<herdr app home>/mods/fleet-quota` after `herdr-app check` passes on a temporary copy. It is not part of the mod and never runs inside Herdr.
- **Optional headless helper (separate from the mod):** `scripts/refresh.py` (Python 3.11+, standard library) installed as `~/.local/bin/herdr-fleet-quota-refresh`, run by the user units `systemd/herdr-fleet-quota-refresh.service` (one-shot, `UMask=0077`, 120 s start timeout, `claude copilot`) and `.timer` (`OnBootSec=30s`, `OnUnitInactiveSec=60s`), installed by `scripts/install-refresh.sh` (bash; check by default; `--install`; `--enable` only with `--install`). Per provider it runs `$OMARCHY_PATH/bin/omarchy-agent-usage-<provider> --limits-only` (45 s limit, default `OMARCHY_PATH=/usr/share/omarchy`) and writes `<provider>.json` in the Omarchy usage folder; control state and a lock live in `$XDG_STATE_HOME/herdr-fleet-quota/`. Per-provider backoff 60 s doubling to 900 s, reserved before each call; a failed probe republishes the previous quota flagged stale. Only `claude` and `copilot` are accepted. It never runs Omarchy's updater, account-state or auto-switch tools and never reads or stores credentials. The mod itself does not call or depend on it.
- **Network:** no provider API and no new listener in the mod. Reads travel over Herdr's existing machine transport; only the optional helper's native collector calls a provider's quota endpoint, on the measured host.

Reading semantics: raw used fractions determine remaining capacity before display rounding. A positive exact balance can confirm capacity without a funded amount. Every reported constraint in an account must have positive remaining capacity; unknown, estimated, omitted or expired constraints prevent that account from qualifying. Producer/account fetch times determine freshness, with the larger of 30 minutes and twice the declared collector interval as the age limit. The bar groups provider identity only, never percentages or balances.

## Watch out

- **Clone shipped layouts before editing.** Add the bar block to an existing personal layout or to a copy made with `layout.clone`; Herdr restores shipped originals on restart. The installer never edits layouts, keys or settings.
- **Three clocks.** The viewer rereads saved files every 60 s; the collector (stock Omarchy refresher, or the optional helper) queries the provider on its own schedule; each record carries the time its quota was actually fetched. A figure can be older than the last viewer read, and nothing is instant or guaranteed live. A reading counts as stale after about 30 minutes or twice the collector interval, whichever is longer.
- **Headless hosts need a refresher.** The stock Omarchy bar refreshes only while it runs; a headless Linux host needs the optional helper or its records go stale. A Mac viewer needs no local collector. The helper is explicit opt-in, requires a systemd user manager, and covers Claude and Copilot. It does not renew authentication: starting Claude Code can renew a paused access token; a completely expired sign-in needs the normal CLI login. Only measurement timestamps inside the current collector invocation can replace historical quota; cache-only answers remain unverified. No global de-duplication with the GUI refresher is promised.
- **The collector is an assumption, not something the mod installs.** Each measured host needs the Omarchy agents collector running and the user logged in to each provider; no records means "unavailable", which is a correct outcome. Never add providers, credentials or collector files to make a host light up, and an installed provider CLI does not prove capacity. Verified so far only against Omarchy 4.5.0-3 source and synthetic fixtures; no clean-VM run and no out-of-the-box first reading is claimed.
- **A viewer needs no local records.** A machine that only looks at remote hosts needs the Herdr app and `herdr-app`, not a local Omarchy or `jq`.
- **Unix hosts only.** The reader needs `sh` and `jq`; a Windows host reads as an error.
- **`herdr-app check` is not a live test.** It renders once with `checking()` true and no `props`: it proves the default panel renders, not the badge and not a live read. Use a real window with the bar block for the badge and `herdr-app status` for errors.
- **Staged check vs final location.** The installer checks a temporary copy; icons resolve from `mods/fleet-quota/icons/` only after the copy, so run `herdr-app status` after installing.
- **Caps are deliberate:** 64 record files, 256 KiB per file, 20 windows per account, 16 accounts per provider, 4 concurrent hosts, 8 s per read. Raising them without changing the notices would hide data silently.
- **118 px is load-bearing.** The badge is built for that width. The dialog is 620×560 and scrolls the host list.
- **Nothing is summed.** The same provider on two machines stays two rows; accounts and balances are never added, because the mod cannot verify whether logins share one quota.
- **Unknown is not zero.**
- **Renaming the folder** requires updating `content.mod` in the layout, the `mod` name in `main.js`'s `openOverlay` call, the `mods/fleet-quota/…` asset paths (including `icons/`) and the installer's destination.
- **Overlay width/height** in `main.js` and `mod.json` must match: the badge uses `openOverlay`, while `mod.open` uses the manifest.
- **No updater or rollback.** Upgrades are a manual review of one folder; the installer refuses to overwrite a different install. For the helper, disable its timer first, then remove only the three files it installed before reinstalling.

## Done when

- `npm test` passes: fixture checks of the record reader, host collection, the UI, the installers and the refresh helper, with no provider calls, no real quota files, no systemd and no real Herdr app.
- `npm run check` parses every `mods/fleet-quota/*.js` file, syntax-checks `scripts/install.sh` and `scripts/install-refresh.sh`, and parses `scripts/refresh.py` without writing bytecode.
- `sh scripts/install.sh` changes nothing and reports paths, prerequisites and actions; `--install` on a fresh Herdr home creates exactly the 12 mod files, a second run is a no-op, and a changed or symlinked install is refused untouched.
- `herdr-app check` of the installed folder exits 0, and `herdr-app status` shows no error for this mod.
- `bash scripts/install-refresh.sh` (check) changes nothing; `--install` copies the helper and two units without starting anything; the timer only runs after it is enabled in a separate step; a differing or symlinked target is refused untouched.
- `herdr-app do mod.open --name fleet-quota` opens the 620×560 dialog with the header, a card per machine, provider rows with remaining capacity, ages and reset times, availability reasons and the footer; the reread control rereads and the close control or Esc closes.
- With the bar block in a personal layout, the 118 px badge shows icons only for providers with current remaining capacity (two icons and `+N` beyond three), shows *Checking* then *Unverified* when nothing can be confirmed, and carries no percentage or warning marks.
