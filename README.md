# herdr-fleet-quota

A Herdr mod that tells you which AI providers still have capacity, across every machine in your Herdr fleet. A compact top-bar badge shows the providers that currently report remaining capacity; a dialog shows the detail per machine, provider and account.

These are real quota readings, not cost estimates. The mod reads the usage records the Omarchy agents widget already writes on each measured host. It never calls a provider, never adds accounts or balances together, and never installs a collector.

Status: private, unlicensed, pre-beta. This repository is the mod's development source. A separate personal configuration repository keeps a vendored copy for everyday use; that copy is updated by hand, in one direction, and no sync script ships here.

## What it shows

- **Top-bar badge** (118 px, optional): icons of the providers that currently report remaining capacity — up to three, or two plus a `+N` count when there are more. Hovering names them. It shows no percentage and no warning marks. With nothing to show it says so honestly: *Checking* while the first read runs, *Unverified* when no capacity could be confirmed (no collector data, offline, stale). Neither means zero or exhausted. Clicking opens the dialog.
- **Dialog** (620×560): per machine, then per provider or account, the remaining capacity of each quota window or balance, the exact age of the reading and its reset time, and, for a host or account without a usable reading, why it is unavailable (for example offline, no collector data, stale or incomplete record). There is no fleet-wide "highest" or "incomplete" headline.

## Compatibility and prerequisites

- Herdr desktop app on the machine where you look at it (Linux or macOS). The installer needs `sh` and the native `herdr-app` CLI.
- Each **measured** host needs the Omarchy AI quota collector running, `sh`, and `jq`. A viewer-only machine (for example a Mac looking at Linux hosts through Herdr machines) needs no local Omarchy records, no local `jq` and no local collector.
- Source-verified against Omarchy 4.5.0-3 (pacman): it ships the stock `omarchy.agents` widget, which writes records to `$XDG_STATE_HOME/omarchy/agents/usage` (default `~/.local/state/omarchy/agents/usage`), and its refresher runs while that widget is enabled. The stock default configuration loads it. Collectors for Claude and Copilot exist upstream.
- You still have to be logged in to each provider's tool on the measured host. Having a provider's model or CLI installed does not prove it reports capacity. A host without records shows as unavailable, which is a correct outcome.
- Not claimed: other or future Omarchy versions, a clean-machine end-to-end run, or that any login works. Verification so far is source review plus synthetic fixtures; a clean-machine run is planned for the beta.

The mod does not install providers, collectors or credentials and does not read credentials. Upstream: https://github.com/omacom/omarchy

## Install

```sh
sh scripts/install.sh              # read-only report; same as --check or --dry-run
sh scripts/install.sh --install    # copy the mod into the Herdr app home
herdr-app do mod.open --name fleet-quota
```

The report is the default and changes nothing. It prints the paths, the prerequisites it found and the exact actions an install would take.

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

### Update and uninstall

There is no updater or rollback in this first release. To update, compare the new `mods/fleet-quota` with your installed copy, back up that one folder, remove it, and run `sh scripts/install.sh --install` again.

To uninstall, remove only the mod's folder and the manual bar block:

```sh
rm -r "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/fleet-quota"
```

Then delete the `fleet-quota` block from your personal layout. Never remove the Herdr app home itself.

## How it reads

Every 60 seconds the mod asks Herdr for the machine list (`hc machine ls --json`), then runs one fixed shell script on each connected machine over Herdr's existing connection — no new ports, no provider network calls. The script reads at most 64 record files (256 KiB each) and prints only bounded quota fields: ids, timestamps, labels, used fractions, reset times, remaining balances and account labels. On each host it reads the Omarchy widget settings from the stock `omarchy.agents` entry when present, otherwise from the older `mateod.agents` entry; the same entry supplies the refresh interval and the disabled-provider list. Up to four hosts are read at once, each with an 8-second timeout.

A mod is trusted code in Herdr. This one runs `sh -c` on each measured machine and reads files under the Omarchy state and config folders. That is the whole of its access. Reads travel over Herdr's existing machine transport, which uses the network between Herdr and your hosts; nothing contacts a provider.

## Reading the numbers

- Remaining capacity comes from the collector's used fraction and is only counted for a current reading. A stale, expired or incomplete reading is never presented as available capacity; the dialog says how old it is.
- **Unknown is not zero.** A window whose reset has passed, or that has no percentage, is unknown.
- A prepaid balance is shown as an amount. No percentage is inferred unless the record also states how much was funded.
- Nothing is summed or deduplicated. The same provider on two machines, or two accounts, stay separate, because the mod cannot verify whether logins share one quota. Balances of different accounts are never added.

## Tests

`npm test` runs the data, UI and installer tests with temporary fixtures: no provider calls, no collector records, no real Herdr app. The installer tests use a disposable `HOME` and `HERDR_APP_HOME` and a stub `herdr-app`, so the real CLI's behaviour is not exercised there; run the report and `herdr-app check` yourself for that. `npm run check` parses every mod JavaScript file and syntax-checks `scripts/install.sh`.

## License and publication

Private for now, and no license is granted for redistribution. Publishing later is the owner's decision, with a chosen license, a sanitized preview image and the `herdr-mod` repository topic. Nothing from Omarchy or any provider script is copied here.

- Herdr guide: https://herdr.dev/guide
- Herdr mods: https://herdr.dev/mods
