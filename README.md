# herdr-fleet-quota

A Herdr mod that tells you which AI providers still have capacity, across every machine in your Herdr fleet. A compact top-bar badge shows the providers that currently report remaining capacity; a dialog shows the detail per machine, provider and account.

These are saved quota readings, not cost estimates and not a live meter. The mod reads the usage records the Omarchy agents collector writes on each measured host. It never calls a provider itself, never adds accounts or balances together, and never installs a collector. An optional, separate helper for headless Linux hosts (below) can keep those records fresh; it is not part of the viewer install.

Status: private, unlicensed, pre-beta. This repository is the mod's development source. A separate personal configuration repository keeps a vendored copy for everyday use; that copy is updated by hand, in one direction, and no sync script ships here.

## What it shows

- **Top-bar badge** (118 px, optional): icons of the providers that currently have confirmed remaining capacity — up to three, or two plus a `+N` count when there are more. Hovering names each provider and the machine and account behind it, with the record time. There is no percentage and no warning mark. With nothing to show it says *Checking…* while the first read runs and *Unverified* afterwards; neither means zero or exhausted. Clicking opens the dialog.
- **Dialog** (620×560, "Reported quota remaining"): the available providers, then one card per machine and, inside it, one card per provider or account. Each shows how much remains in every quota window (`N% remaining`) or the prepaid balance as an amount, the exact reset time on hover, the age of the record, and a reason when it is not available (for example machine offline, read failed, provider not ready, reading stale, windows omitted, awaiting a reading after a reset). There is no fleet-wide "highest used" or "incomplete" headline.
- A provider counts as available only from a current, complete reading with capacity left in every window. An exhausted window, a stale or future-dated reading, an estimated value or an unknown percentage is never shown as available capacity, and unknown is never shown as zero.
- Every machine and every account is judged on its own. Which account is active on a host does not make another account's reading current, and nothing is added up.

## Three clocks, not one

Quota freshness involves three separate things. Keep them apart:

1. **The viewer polls saved files every 60 seconds.** Herdr runs one fixed read-only script per connected machine and parses the records. This reads files already on the host; it makes no provider request.
2. **The collector queries the provider's quota endpoint on its own schedule.** That is the stock Omarchy refresher at its configured interval, or the optional headless helper below. This is the only step that touches a provider.
3. **Each record carries the time its quota was actually fetched.** The dialog shows this age. It is what the numbers really reflect.

So a figure can be up to the collector period plus a minute old, and older still if a probe failed. A reading is treated as stale after roughly 30 minutes or twice the collector's refresh interval, whichever is longer. Nothing here is instant or guaranteed live, and the dialog's reread button rereads saved records — it does not query a provider.

## Compatibility and prerequisites

- Herdr desktop app on the machine where you look at it (Linux or macOS). The installer needs `sh` and the native `herdr-app` CLI.
- Each **measured** host needs the Omarchy collector, `sh` and `jq`. A viewer-only machine (for example a Mac looking at Linux hosts through Herdr machines) needs no local Omarchy records, no local `jq` and no local collector; nothing is copied from the host to the viewer.
- Source-verified against Omarchy 4.5.0-3 (pacman): it ships the stock `omarchy.agents` widget, which writes records to `$XDG_STATE_HOME/omarchy/agents/usage` (default `~/.local/state/omarchy/agents/usage`), and its refresher runs while that widget is enabled. The stock default configuration loads it. Collectors for Claude and Copilot exist upstream.
- You still have to be logged in to each provider's tool on the measured host. Having a provider's model or CLI installed does not prove it reports capacity.
- Not claimed: other or future Omarchy versions, a clean-machine end-to-end run, or that any login works. Verification so far is source review plus synthetic fixtures; a clean-VM run is planned for the beta. Do not expect a first reading out of the box until that has been done.

Upstream: https://github.com/omacom/omarchy

## Which path do I need?

| Measured host | What keeps its records fresh | What you install |
|---|---|---|
| Linux with the stock Omarchy desktop bar running and the agents widget enabled | Omarchy's own GUI refresher | The viewer mod only |
| Headless Linux (no bar, no GUI session) | Nothing, unless you add the optional helper | The viewer mod, plus the headless helper on that host |
| Mac (or any machine) used only to look | Not applicable: it reads the remote hosts | The viewer mod only |

An existing local GUI refresher and the headless helper may both call the native collector, which has its own short cache (about 15 seconds). No global de-duplication between upstream's refresher and this helper is promised.

## Install the viewer

```sh
sh scripts/install.sh              # read-only report; same as --check or --dry-run
sh scripts/install.sh --install    # copy the mod into the Herdr app home
herdr-app do mod.open --name fleet-quota
```

The report is the default and changes nothing. It prints the paths, the prerequisites it found and the exact actions an install would take. It makes no provider request and does not touch services.

`--install` copies only the mod's own files — `main.js`, `model.js`, `fleet.js`, `mod.json` and the eight SVGs in `icons/` — into `mods/fleet-quota` inside the Herdr app home: `$HERDR_APP_HOME`, else `~/.config/herdr-app` (the app writes its own guide, `AGENTS.md`, there; guide: https://herdr.dev/guide). The Herdr home must already exist: start Herdr once, or point `HERDR_APP_HOME` at it. Order of operations:

1. copy the files to a temporary folder;
2. run `herdr-app check` on that copy (it loads the mod once; the mod's `checking()` guard performs no reads);
3. only if that passes, create the destination folder and copy the files into it, then compare them with the repository.

Behaviour you can rely on:

- An identical existing install is left alone (extra files Herdr generated in the folder are ignored).
- A different or incomplete existing install, a symbolic link at the destination, or a link inside it is refused. Nothing is overwritten, merged or deleted; upgrade by hand (below).
- A failed `herdr-app check` installs nothing. A failure while copying, or an interrupt (Ctrl-C, SIGTERM), removes only the folder that run created and its temporary folder.
- Generated files (`jsconfig.json`, `*.d.ts`) from the check stay in the temporary folder, never in this repository or in the install.
- It never edits layouts, keys or settings, never opens or restarts the app, never needs elevated rights, downloads, the network, provider calls or collector records, and never creates `.envrc` files or switches accounts.

It finds `herdr-app` on `PATH` or at `~/.local/bin/herdr-app`. It is POSIX `sh` and has been exercised on Linux only, where `/bin/sh` is bash; it has not been run on Windows, dash, BSD or macOS, so run the report first there.

### Optional: top-bar badge

The installer does not touch layouts. To add the badge, put the block from `examples/bar-block.json` into a row of your **personal** layout. If you only have a shipped layout, clone it first (Herdr restores shipped layouts on restart):

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

The block is a fragment, not a whole layout. The dialog works without it via the `mod.open` command above. Confirm with `herdr-app status`; `herdr-app shot` saves a screenshot.

### Update and uninstall the viewer

There is no updater or rollback in this first release. To update, compare the new `mods/fleet-quota` with your installed copy, back up that one folder, remove it, and run `sh scripts/install.sh --install` again.

To uninstall, remove only the mod's folder and the manual bar block:

```sh
rm -r "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/fleet-quota"
```

Then delete the `fleet-quota` block from your personal layout. Never remove the Herdr app home itself.

## Optional: headless refresh helper (Linux hosts)

Needed only on a Linux host that has no running Omarchy bar. Install it on that host, not on the viewer. It is opt-in in two separate steps and the viewer installer never runs it.

**What it does.** `scripts/refresh.py` (Python 3.11+, standard library only) runs one pass and exits. Copilot uses the native `omarchy-agent-usage-copilot --limits-only` command. Claude uses an isolated Python adapter around the native collection entrypoint that skips local conversation statistics: the native `--limits-only` flag alone can still perform a full history scan on a cold cache. The adapter marks its output `hasLocalStats: false`, checks the expected native interface, and fails closed if that interface changes. Neither path modifies Omarchy's installed files.

Both paths retain native account/authentication, quota-probe and cache handling, with `OMARCHY_PATH` defaulting to `/usr/share/omarchy`. They read quota APIs, not LLM inference APIs, and write the records the viewer consumes. The helper never invokes the updater, account-state or auto-switch tools, changes accounts, implements token renewal, or copies credentials between machines. Authentication remains with the host's native Claude/GitHub CLI setup; credential values and arbitrary provider responses are not logged.

**Providers.** Claude and Copilot only, to start: the helper accepts just those two names and rejects anything else before making any call, and the unit names both. It does not query OpenAI or OpenRouter. Adding a provider is an explicit code change to that allowlist, because each one means a headless authenticated request. The viewer can still show other providers (for example Codex) whenever the existing collector has written a fresh record for them.

**Schedule.** A systemd user timer first becomes due 30 seconds after boot; enabling it later makes that first run due immediately. It then runs 60 seconds after each pass finishes. A lock prevents overlapping helper processes. Each collector call is bounded to 45 seconds and the service to 120.

**Failure behaviour.** Before every provider call the helper durably records the next allowed attempt; if that cannot be written, it makes no call. After a failure that provider waits 60 seconds, then 120, 240, 480 and at most 900 seconds, independently of the other provider. A success resets the wait to 60 seconds. Only a nonempty measurement stamped during that provider's invocation can confirm new quota. Cached answers, failed probes and empty responses preserve the historical values and times marked stale, so the viewer treats them as unverified. Each account's freshness is decided on its own. This is intentionally conservative if another refresher has just populated the native 15-second cache.

**Files it touches.** Installation places the helper at `~/.local/bin/herdr-fleet-quota-refresh` (0755) and two units in `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` (0644). Runtime writes the selected provider records under `$XDG_STATE_HOME/omarchy/agents/usage/` and its own backoff state/lock under `$XDG_STATE_HOME/herdr-fleet-quota/`. New runtime files and directories use private permissions (0600/0700); existing directories keep their permissions. Symbolic links and oversized records are refused.

**Requirements.**

- Linux with a systemd *user* manager running. Without linger the timer only runs while you have a session; enabling linger is your own decision and the installer never does it.
- Omarchy's native collectors present (`OMARCHY_PATH`), and the provider tools logged in on that host.
- The helper does not renew authentication. For a paused Claude access token, starting Claude Code normally can renew it; sign in again only if the CLI reports the saved sign-in has expired. Copilot uses the host's existing GitHub CLI login. Until a new quota measurement succeeds, the reading stays unverified with its older time.

**Install** (explicit opt-in, then a separate step to start it):

```sh
bash scripts/install-refresh.sh              # read-only check; same as --check
bash scripts/install-refresh.sh --install    # copy the helper and two units; starts nothing
systemctl --user daemon-reload && systemctl --user enable --now herdr-fleet-quota-refresh.timer
```

or `bash scripts/install-refresh.sh --install --enable` to do the last step for you. `--enable` needs `--install`, and `--check` cannot be combined with either. When `systemd-analyze` exists the units are verified first and nothing is copied if that fails. Existing files that are identical are left alone; a differing file or a symbolic link is refused. Installation alone starts no quota requests; enabling the timer starts the authenticated quota reads described above. Neither operation restarts a GUI or enables linger.

**Disable and remove** — scoped to what it installed:

```sh
systemctl --user disable --now herdr-fleet-quota-refresh.timer
```

then delete only these three files and reload: `~/.local/bin/herdr-fleet-quota-refresh`, `~/.config/systemd/user/herdr-fleet-quota-refresh.service` and `~/.config/systemd/user/herdr-fleet-quota-refresh.timer` (use `$XDG_CONFIG_HOME` if you set it), then `systemctl --user daemon-reload`. Its control files in `$XDG_STATE_HOME/herdr-fleet-quota/` may be deleted once the timer is off. The provider records in the Omarchy usage folder are collector output: if nothing refreshes them any more they simply become stale and the viewer says so. There is no version manager or rollback: to update, disable the timer, review the differences, remove those three files and install again. Never delete a broader folder.

**Verification status.** The helper has tests with fake collectors and synthetic fixtures (`tests/refresh.test.cjs`). It has not been run against a clean machine with real provider logins, so no out-of-the-box first reading is claimed.

## How the viewer reads

Every 60 seconds the mod asks Herdr for the machine list (`hc machine ls --json`), then runs one fixed shell script on each connected machine over Herdr's existing connection — no new ports, no provider network calls. The script reads at most 64 record files (256 KiB each) and prints only bounded quota fields: ids, timestamps, labels, used fractions, reset times, remaining balances and account labels. On each host it reads the Omarchy widget settings from the stock `omarchy.agents` entry when present, otherwise from the older `mateod.agents` entry; the same entry supplies the refresh interval and the disabled-provider list. Up to four hosts are read at once, each with an 8-second timeout.

A mod is trusted code in Herdr. This one runs `sh -c` on each measured machine and reads files under the Omarchy state and config folders. That is the whole of its access. Reads travel over Herdr's existing machine transport, which uses the network between Herdr and your hosts; nothing in the viewer contacts a provider.

## Reading the numbers

- Remaining capacity comes from the collector's used fraction, and only a current reading counts. A stale, expired, incomplete or not-ready reading is not available capacity; the dialog says why and how old it is.
- **Unknown is not zero.** A window whose reset has passed, or that has no percentage, is unknown until a new reading arrives.
- A prepaid balance is shown as an amount. No percentage is inferred unless the record also states how much was funded. An estimated value is labelled estimated and does not count as confirmed capacity.
- The bar groups qualifying readings by provider name only. The underlying machines and accounts stay separate; the mod never combines their percentages or balances or claims they are distinct subscriptions.

## Tests

`npm test` runs the data, UI, installer and refresh-helper tests with temporary fixtures: no provider calls, no real collector records, no real Herdr app and no systemd. The installer tests use a disposable `HOME` and `HERDR_APP_HOME` and a stub `herdr-app`, so the real CLI's behaviour is not exercised there; run the report and `herdr-app check` yourself for that. `npm run check` parses every mod JavaScript file, syntax-checks both installers and parses the Python helper without writing bytecode.

## License and publication

Private for now, and no license is granted for redistribution. Publishing later is the owner's decision, with a chosen license, a sanitized preview image and the `herdr-mod` repository topic. Nothing from Omarchy or any provider script is copied here.

- Herdr guide: https://herdr.dev/guide
- Herdr mods: https://herdr.dev/mods
