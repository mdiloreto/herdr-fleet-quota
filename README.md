# herdr-fleet-quota

A Herdr mod that shows the AI quota each machine in your fleet has already recorded, side by side. It is a compact badge for a bar plus a dialog with the details: one section per machine, one row per provider or account, and one track per quota window.

These are quota readings, not cost estimates. The mod reads the files the Omarchy agents quota collector writes. It never calls a provider and never adds percentages together.

This repository is the mod's development source. A separate personal configuration repository keeps a vendored copy for everyday use; that copy is updated by hand, in one direction, and no sync script ships here.

## What it shows

- **Badge** (118 px wide): the highest percentage reported anywhere across the fleet, with `~` when that highest reading is old or from an offline host and `!` when coverage is incomplete. Click it to open the dialog.
- **Dialog** (620×560): a heading with how many machines have a reading, a section per machine with its status and read time, provider/account rows, and a progress track per quota window with its reset time. Unknown, old and offline readings say so.

## Requirements

- Herdr desktop app on Linux or macOS.
- The Omarchy AI quota collector already running on every host you want measured. It writes `$XDG_STATE_HOME/omarchy/agents/usage` (default `~/.local/state/omarchy/agents/usage`).
- `sh` and `jq` on each measured Unix host.
- The host must be connected in Herdr (`hc machine ls`) for a live read.

A host without the collector legitimately shows `no data`. This mod does not install providers, collectors or credentials anywhere.

## How it reads

Every 60 seconds the mod asks Herdr for the machine list (`hc machine ls --json`), then runs one fixed shell script on each connected machine over Herdr's existing connection — no new ports, no extra config, no provider network calls. The script reads at most 64 record files (256 KiB each), honours disabled providers from the optional Omarchy `shell.json`, and prints only bounded quota fields: ids, timestamps, labels, percentages, reset times, remaining balances and account labels. Up to four hosts are read at once, each with an 8-second timeout.

A mod is trusted code in Herdr. This one runs `sh -c` on each measured machine and reads files under the Omarchy state and config directories. That is the whole of its access; its source is in this repository.

## Install

1. Copy only `mods/fleet-quota` into `~/.config/herdr-app/mods/fleet-quota`. Check that destination first: if it already exists, review it and back it up instead of overwriting.
2. Add the block from `examples/bar-block.json` to a row in your layout, where the badge should sit. It is a fragment, not a whole layout — keep your own layout and `keys.json`; this repository ships neither.
3. Verify: `herdr-app check ~/.config/herdr-app/mods/fleet-quota`, then `herdr-app status` for errors, then `herdr-app shot` to see the badge.

You can also open the detail directly with `herdr-app do mod.open --name fleet-quota`.

On updates, review the changed files and back up only the mod folder. Do not rsync over `~/.config/herdr-app` or replace your layout and keys wholesale.

## Reading the numbers

- `!` — at least one machine is offline or failed, one quota percentage is unavailable, or a record was unreadable or omitted.
- `~` — the displayed highest percentage comes from an old or offline reading. Other offline hosts set `!`, not `~`.
- `?` — that window's percentage is unknown (missing, expired or reset). Unknown is never shown as zero.
- A balance is shown as the remaining amount. It gets a percentage only when the record also says how much was funded; otherwise no percentage is inferred.
- Percentages stay per machine and per account. Nothing is summed or deduplicated, because two machines signed in to the same provider may share one account and the mod cannot verify it.

## Tests

`npm test` runs fixture-based checks of the record reader, host collection and the UI, using temporary fixtures only — no provider calls and no access to real collector records. `npm run check` parses every mod JavaScript file.

## License and publication

Private for now, and no license is granted for redistribution. If it is published later, that is the owner's decision, with a chosen license, a sanitized preview image and the `herdr-mod` repository topic.

- Herdr guide: https://herdr.dev/guide
- Herdr mods: https://herdr.dev/mods
