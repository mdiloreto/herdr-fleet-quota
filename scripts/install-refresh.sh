#!/bin/bash
# Optional headless refresher installer. Default (or --check): read-only check.
#   --install  copy helper + 2 user units (refuses differing/symlink targets)
#   --enable   after --install, systemctl --user enable --now the timer
#   --providers "<ids>"
#              space-separated provider ids for the unit's ExecStart, each
#              matching ^[a-z][a-z0-9]*$ and at most 32 chars; duplicates are
#              dropped, order is kept. The id `update` is reserved and refused:
#              omarchy-agent-usage-update is Omarchy's batch updater, not a
#              collector. Without --providers the repo unit is copied as is.
set -u
umask 022
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bindir="$HOME/.local/bin"
unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
svc=herdr-fleet-quota-refresh.service
tim=herdr-fleet-quota-refresh.timer
exec_prefix='ExecStart=%h/.local/bin/herdr-fleet-quota-refresh'
usage='usage: install-refresh.sh [--check | --install [--enable]] [--providers "<ids>"]'
do_install=0; do_enable=0; do_check=0; have_providers=0; providers=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) do_install=1 ;;
    --enable) do_enable=1 ;;
    --check) do_check=1 ;;
    --providers)
      [ $# -ge 2 ] || { echo "refuse: --providers needs at least one id matching ^[a-z][a-z0-9]*\$ (at most 32 chars, space-separated)" >&2; exit 2; }
      have_providers=1; providers="$2"; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift
done
if [ $do_check -eq 1 ] && [ $((do_install + do_enable)) -gt 0 ]; then
  echo "--check cannot be combined with --install or --enable" >&2; exit 2
fi
if [ $do_enable -eq 1 ] && [ $do_install -eq 0 ]; then
  echo "--enable requires --install" >&2; exit 2
fi

providers_rule="refuse: each provider id must match ^[a-z][a-z0-9]*\$ (lowercase letter first, then lowercase letters or digits, at most 32 characters)"
list=""
if [ $have_providers -eq 1 ]; then
  seen=" "
  for id in $providers; do
    if ! [[ "$id" =~ ^[a-z][a-z0-9]*$ ]] || [ ${#id} -gt 32 ]; then
      echo "$providers_rule" >&2; exit 2
    fi
    if [ "$id" = update ]; then
      echo "refusing 'update': that is Omarchy's batch updater, not a provider" >&2; exit 2
    fi
    case "$seen" in *" $id "*) continue ;; esac
    seen="$seen$id "
    list="${list:+$list }$id"
  done
  [ -n "$list" ] || { echo "$providers_rule" >&2; exit 2; }
fi

for f in "$src/scripts/refresh.py" "$src/systemd/$svc" "$src/systemd/$tim"; do
  [ -f "$f" ] || { echo "missing source: $f" >&2; exit 2; }
done

tmp=""
cleanup() { [ -z "$tmp" ] || rm -rf "$tmp"; }
trap cleanup EXIT
svc_from="$src/systemd/$svc"
if [ $have_providers -eq 1 ] || command -v systemd-analyze >/dev/null 2>&1; then
  tmp="$(mktemp -d)" || exit 1
fi
# Generate the unit under the temp dir, replacing only the provider list on the
# ExecStart line; every other byte, including the trailing newline, is kept.
if [ $have_providers -eq 1 ]; then
  svc_from="$tmp/$svc"
  sed "s#^$exec_prefix .*#$exec_prefix $list#" "$src/systemd/$svc" > "$svc_from" || exit 1
  grep -qxF "$exec_prefix $list" "$svc_from" \
    || { echo "refuse: repo unit has no provider list on its ExecStart line" >&2; exit 2; }
  # The service must outlast every collector it runs: each one is bounded by
  # the helper's own timeout, and a cold local-stats scan can take a while.
  helper_timeout=$(sed -n 's/^TIMEOUT = \([0-9][0-9]*\).*/\1/p' "$src/scripts/refresh.py")
  case "$helper_timeout" in
    ''|*[!0-9]*) echo "refuse: cannot read the collector timeout from scripts/refresh.py" >&2; exit 2 ;;
  esac
  count=0
  for id in $list; do count=$((count + 1)); done
  service_timeout=$((60 + helper_timeout * count))
  sed -i "s/^TimeoutStartSec=.*/TimeoutStartSec=$service_timeout/" "$svc_from" || exit 1
  grep -qxF "TimeoutStartSec=$service_timeout" "$svc_from" \
    || { echo "refuse: repo unit has no TimeoutStartSec line" >&2; exit 2; }
fi
pairs=(
  "$src/scripts/refresh.py|$bindir/herdr-fleet-quota-refresh|755"
  "$svc_from|$unitdir/$svc|644"
  "$src/systemd/$tim|$unitdir/$tim|644"
)

# Validate the units before any copy, with the not-yet-installed %h helper
# path replaced by the repo script so ExecStart resolves.
if command -v systemd-analyze >/dev/null 2>&1; then
  mkdir -p "$tmp/verify"
  cp "$svc_from" "$src/systemd/$tim" "$tmp/verify/"
  sed -i "s#%h/.local/bin/herdr-fleet-quota-refresh#$src/scripts/refresh.py#" "$tmp/verify/$svc"
  if systemd-analyze --user verify "$tmp/verify/$svc" "$tmp/verify/$tim" >&2; then
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

# Retained state is reported for --check and the default run only: nothing is
# written, no collector is executed and no record is read.
if [ $do_install -eq 0 ]; then
  if [ $have_providers -eq 1 ]; then
    echo "providers: $list"
  else
    echo "providers (repo unit): $(sed -n "s#^$exec_prefix ##p" "$src/systemd/$svc")"
  fi
  omarchy="${OMARCHY_PATH:-/usr/share/omarchy}"
  existing=()
  for c in "$omarchy"/bin/omarchy-agent-usage-*; do
    [ -e "$c" ] || continue
    id="${c##*/omarchy-agent-usage-}"
    # Not a provider: `update` is Omarchy's batch updater, so it is never listed.
    [ "$id" = update ] && continue
    existing+=("$id")
  done
  if [ ${#existing[@]} -gt 0 ]; then
    echo "collectors: ${existing[*]}"
  else
    echo "collectors: none of omarchy-agent-usage-* in $omarchy/bin"
  fi
fi
echo "to activate: systemctl --user daemon-reload && systemctl --user enable --now $tim"
