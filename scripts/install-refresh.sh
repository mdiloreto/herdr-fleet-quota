#!/bin/bash
# Optional headless refresher installer. Default (or --check): read-only check.
#   --install  copy helper + 2 user units (refuses differing/symlink targets)
#   --enable   after --install, systemctl --user enable --now the timer
set -u
umask 022
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bindir="$HOME/.local/bin"
unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
svc=herdr-fleet-quota-refresh.service
tim=herdr-fleet-quota-refresh.timer
pairs=(
  "$src/scripts/refresh.py|$bindir/herdr-fleet-quota-refresh|755"
  "$src/systemd/$svc|$unitdir/$svc|644"
  "$src/systemd/$tim|$unitdir/$tim|644"
)
do_install=0; do_enable=0; do_check=0
for a in "$@"; do
  case "$a" in
    --install) do_install=1 ;;
    --enable) do_enable=1 ;;
    --check) do_check=1 ;;
    *) echo "usage: install-refresh.sh [--check | --install [--enable]]" >&2; exit 2 ;;
  esac
done
if [ $do_check -eq 1 ] && [ $((do_install + do_enable)) -gt 0 ]; then
  echo "--check cannot be combined with --install or --enable" >&2; exit 2
fi
if [ $do_enable -eq 1 ] && [ $do_install -eq 0 ]; then
  echo "--enable requires --install" >&2; exit 2
fi

for pair in "${pairs[@]}"; do
  IFS='|' read -r from _ _ <<<"$pair"
  [ -f "$from" ] || { echo "missing source: $from" >&2; exit 2; }
done

# Validate the units before any copy, with the not-yet-installed %h helper
# path replaced by the repo script so ExecStart resolves.
if command -v systemd-analyze >/dev/null 2>&1; then
  tmp="$(mktemp -d)" || exit 1
  trap 'rm -rf "$tmp"' EXIT
  cp "$src/systemd/$svc" "$src/systemd/$tim" "$tmp/"
  sed -i "s#%h/.local/bin/herdr-fleet-quota-refresh#$src/scripts/refresh.py#" "$tmp/$svc"
  if systemd-analyze --user verify "$tmp/$svc" "$tmp/$tim" >&2; then
    echo "units verified (ExecStart path substituted with the repo script)"
  else
    echo "unit verification failed; nothing installed" >&2; exit 1
  fi
else
  echo "note: systemd-analyze not found; units were NOT verified" >&2
fi

rc=0
todo=()
for pair in "${pairs[@]}"; do
  IFS='|' read -r from to _ <<<"$pair"
  if [ -L "$to" ]; then
    echo "refuse: $to is a symlink" >&2; rc=1
  elif [ -e "$to" ]; then
    if cmp -s "$from" "$to"; then echo "ok (identical): $to"
    else echo "refuse: $to exists and differs (upgrade manually)" >&2; rc=1; fi
  else
    echo "would install: $to"; todo+=("$pair")
  fi
done
[ $rc -ne 0 ] && exit $rc

if [ $do_install -eq 1 ]; then
  mkdir -p "$bindir" "$unitdir" || exit 1
  for pair in "${todo[@]}"; do
    IFS='|' read -r from to mode <<<"$pair"
    install -m "$mode" "$from" "$to" || exit 1
    echo "installed: $to"
  done
  if [ $do_enable -eq 1 ]; then
    systemctl --user daemon-reload && systemctl --user enable --now "$tim"
    exit $?
  fi
elif [ ${#todo[@]} -gt 0 ]; then
  echo "dry run; pass --install to install"
fi
echo "to activate: systemctl --user daemon-reload && systemctl --user enable --now $tim"
