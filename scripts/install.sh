#!/bin/sh
# Guided checker and installer for the fleet-quota Herdr mod.
#
#   sh scripts/install.sh              read-only report (same as --check / --dry-run)
#   sh scripts/install.sh --install    copy the mod into the Herdr app home
#
# It only ever writes <herdr app home>/mods/fleet-quota, and only when that folder
# does not exist yet. It never edits layouts, keys or settings, never starts or
# opens the app, never reads provider records and never uses the network.
set -eu

# Everything the mod needs, and nothing else. Generated files such as jsconfig.json
# or *.d.ts never travel. main.js is copied last.
ICONS="chevron-right clock close desktop gauge provider refresh server"
RELS="model.js fleet.js mod.json"
for name in $ICONS; do RELS="$RELS icons/$name.svg"; done
RELS="$RELS main.js"

usage() {
  echo "usage: sh scripts/install.sh [--check | --dry-run | --install]" >&2
  exit 2
}

mode=check
case $# in
  0) ;;
  1) case $1 in
       --check|--dry-run) ;;
       --install) mode=install ;;
       -h|--help) usage ;;
       *) usage ;;
     esac ;;
  *) usage ;;
esac

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(dirname -- "$script_dir")
src="$repo/mods/fleet-quota"

if [ -n "${HERDR_APP_HOME:-}" ]; then
  home=$HERDR_APP_HOME
elif [ -n "${HOME:-}" ]; then
  home="$HOME/.config/herdr-app"
else
  echo "Neither HERDR_APP_HOME nor HOME is set." >&2
  exit 1
fi
mods="$home/mods"
target="$mods/fleet-quota"

problems=0
ok() { echo "  [ok] $*"; }
info() { echo "  [..] $*"; }
bad() { problems=$((problems + 1)); echo "  [x]  $*"; }

echo "Fleet quota mod: ${mode} mode"
echo "  source:      $src"
echo "  Herdr home:  $home"
echo "  destination: $target"
echo

echo "Prerequisites"

# Source files: exactly the allowlist, as regular files.
missing_src=0
for rel in $RELS; do
  if [ -L "$src/$rel" ] || [ ! -f "$src/$rel" ]; then
    bad "source file missing or not a regular file: mods/fleet-quota/$rel"
    missing_src=1
  fi
done
[ "$missing_src" = 1 ] || ok "all 12 mod files are present in the repository"

# The native Herdr CLI is the only thing that can validate a mod.
herdr_app=
if command -v herdr-app >/dev/null 2>&1; then
  herdr_app=$(command -v herdr-app)
elif [ -n "${HOME:-}" ] && [ -f "$HOME/.local/bin/herdr-app" ] && [ -x "$HOME/.local/bin/herdr-app" ]; then
  herdr_app="$HOME/.local/bin/herdr-app"
fi
if [ -n "$herdr_app" ]; then
  ok "herdr-app found: $herdr_app"
else
  bad "herdr-app not found on PATH or at ~/.local/bin/herdr-app (installing needs it to validate the mod)"
fi

if [ -d "$home" ]; then
  ok "Herdr app home exists"
else
  bad "Herdr app home not found: start Herdr once, or set HERDR_APP_HOME to its app folder"
fi

if [ -e "$mods" ] && [ ! -d "$mods" ]; then
  bad "$mods exists but is not a directory"
fi

# Optional, informational only. Records are never opened.
if command -v jq >/dev/null 2>&1; then
  info "jq found locally (each measured Unix host needs jq; a viewer-only machine does not)"
else
  info "jq not found locally; fine for a viewer, but every measured Unix host needs it"
fi
usage_dir="${XDG_STATE_HOME:-${HOME:-}/.local/state}/omarchy/agents/usage"
if [ -d "$usage_dir" ]; then
  info "local Omarchy usage folder exists (existence only, records are not read)"
else
  info "no local Omarchy usage folder; fine for a viewer, each measured host needs the collector enabled and logged in"
fi
echo

echo "Destination"
state=fresh
if [ -L "$target" ]; then
  state=conflict
  bad "$target is a symbolic link; refusing to use it"
elif [ -e "$target" ]; then
  if [ ! -d "$target" ]; then
    state=conflict
    bad "$target exists but is not a directory"
  else
    if [ -L "$target/icons" ]; then
      state=conflict
      bad "$target/icons is a symbolic link"
    fi
    for rel in $RELS; do
      dest="$target/$rel"
      if [ -L "$dest" ]; then
        state=conflict
        bad "symbolic link in the installed mod: $rel"
      elif [ ! -e "$dest" ]; then
        state=conflict
        bad "installed mod is missing: $rel"
      elif [ ! -f "$dest" ]; then
        state=conflict
        bad "not a regular file in the installed mod: $rel"
      elif [ -f "$src/$rel" ] && ! cmp -s "$src/$rel" "$dest"; then
        state=conflict
        bad "installed file differs from this repository: $rel"
      fi
    done
    if [ "$state" = fresh ]; then
      state=identical
      ok "already installed and identical to this repository (other files in the folder are ignored)"
    fi
  fi
else
  ok "not installed yet"
fi
if [ "$state" = conflict ]; then
  echo "  Nothing is overwritten or deleted. To upgrade, review the differences yourself,"
  echo "  back up that one folder, remove it, and run the installer again."
fi
echo

echo "Actions"
case $state in
  fresh)
    echo "  1. copy the 12 allowlisted mod files to a temporary folder"
    echo "  2. run: herdr-app check <temporary folder>   (loads the mod once; the mod does not read quota in a check)"
    echo "  3. only if that passes, create $target and copy the files into it"
    echo "  Layouts, keys, settings and the running app are never touched."
    ;;
  identical) echo "  nothing to do" ;;
  *) echo "  none (see the problems above)" ;;
esac
echo

if [ "$mode" = check ]; then
  if [ "$problems" -gt 0 ]; then
    echo "Not ready: $problems problem(s). No changes were made."
    exit 1
  fi
  if [ "$state" = fresh ]; then
    echo "Ready. Nothing was changed; run with --install to perform the actions above."
  else
    echo "Nothing was changed."
  fi
  exit 0
fi

if [ "$problems" -gt 0 ]; then
  echo "Not installing: $problems problem(s). No changes were made." >&2
  exit 1
fi

next_steps() {
  echo
  echo "Open the detail dialog (the Herdr app must be running):"
  if [ -n "${HERDR_APP_HOME:-}" ]; then
    echo "  HERDR_APP_HOME='$HERDR_APP_HOME' herdr-app do mod.open --name fleet-quota"
  else
    echo "  herdr-app do mod.open --name fleet-quota"
  fi
  echo "Optional top-bar badge: add examples/bar-block.json to a row of your personal layout"
  echo "(clone a shipped layout first). The installer never edits layouts."
  echo "Confirm with: herdr-app status"
}

if [ "$state" = identical ]; then
  next_steps
  exit 0
fi

# fresh: stage, validate, then create and fill the destination.
tmp=
created=
finished=
cleanup() {
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  # Only a folder this run created, and only until the install completed.
  if [ -n "$created" ] && [ -z "$finished" ]; then rm -rf "$target"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

tmp=$(mktemp -d "${TMPDIR:-/tmp}/fleet-quota-install.XXXXXX")
stage="$tmp/fleet-quota"
mkdir "$stage" "$stage/icons"
for rel in $RELS; do
  cp "$src/$rel" "$stage/$rel"
done

echo "Checking the staged mod with herdr-app..."
if ! "$herdr_app" check "$stage"; then
  echo "herdr-app check failed. Nothing was installed." >&2
  exit 1
fi

[ -d "$mods" ] || mkdir "$mods"
# mkdir is atomic: if something appeared meanwhile it fails instead of nesting.
if ! mkdir "$target" 2>/dev/null; then
  echo "$target appeared while installing. Nothing was changed." >&2
  exit 1
fi
created=1
mkdir "$target/icons"
for rel in $RELS; do
  cp "$stage/$rel" "$target/$rel"
done
for rel in $RELS; do
  if ! cmp -s "$src/$rel" "$target/$rel"; then
    echo "Copy verification failed for $rel; removing the folder created by this run." >&2
    exit 1
  fi
done
finished=1
echo "Installed $target"
next_steps
