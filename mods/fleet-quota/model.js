// Reads the AI quota records Omarchy already writes, on whichever machine the caller targets.
// The script touches only the bounded fields a bar needs, so no credentials leave a host.
export const READ_SCRIPT = `
dir="\${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agents/usage"
[ -d "$dir" ] || exit 4
command -v jq >/dev/null 2>&1 || exit 5
settings="\${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/shell.json"
disabled='[]'
meta='{"quotaMeta":{"refreshIntervalSec":null}}'
if [ -e "$settings" ]; then
  [ -f "$settings" ] && [ ! -L "$settings" ] || exit 6
  bytes=$(wc -c < "$settings") || exit 6
  [ "$bytes" -le 262144 ] || exit 6
  disabled=$(jq -c '[.. | objects | select(.id? == "mateod.agents") | .providers? // {} |
    if type == "object" then to_entries[] | select((.value | type) == "object" and .value.enabled == false) | .key else empty end] | unique' "$settings") || exit 6
  interval=$(jq -c '[.. | objects | select(.id? == "mateod.agents") | .refreshIntervalSec? | select(type == "number")] | .[0] // null' "$settings") || exit 6
  meta=$(printf '{"quotaMeta":{"refreshIntervalSec":%s}}' "$interval")
fi
printf '%s\\n' "$meta"
count=0
for file in "$dir"/*.json; do
  [ -f "$file" ] || continue
  count=$((count + 1))
  [ "$count" -le 64 ] || { printf '%s\\n' '{"error":"too-many-records"}'; break; }
  [ ! -L "$file" ] || { printf '%s\\n' '{"error":"symlink-record"}'; continue; }
  bytes=$(wc -c < "$file") || { printf '%s\\n' '{"error":"unreadable-record"}'; continue; }
  [ "$bytes" -le 262144 ] || { printf '%s\\n' '{"error":"large-record"}'; continue; }
  jq -c --argjson disabled "$disabled" '
  def limits: if type == "array" then [.[:20][] | select(type == "object") | {
    label: (if (.label | type) == "string" then .label[:80] else "Limit" end),
    title: (if (.title | type) == "string" then .title[:80] else null end),
    percent: (if (.percent | type) == "number" then .percent else null end),
    resetsAt: (if (.resetsAt | type) == "string" then .resetsAt[:64] else null end)
  }] else [] end;
  def balance: if type == "object" then {
    remaining: (if (.remaining | type) == "number" then .remaining else null end),
    funded: (if (.funded | type) == "number" then .funded else null end),
    currency: (if (.currency | type) == "string" then .currency[:8] else null end),
    estimated: (.estimated == true)
  } else null end;
  def limits_truncated: if type == "array" then length > 20 else false end;
  if type != "object" then {error:"invalid-record"}
  elif (.id as $id | ($disabled | index($id)) != null) then empty else {
    id: (if (.id | type) == "string" then .id[:64] else null end),
    updatedAt: (if (.updatedAt | type) == "string" then .updatedAt[:64] else null end),
    limitsStale: (.limitsStale == true),
    limits: (.limits | limits),
    limitsTruncated: (.limits | limits_truncated),
    balance: (.balance | balance),
    accountsTruncated: (if (.accounts | type) == "array" then (.accounts | length) > 16 else false end),
    accounts: (if (.accounts | type) == "array" then [.accounts[:16][] |
      if type == "object" then {
        label: (if (.label | type) == "string" then .label[:80] else null end),
        active: (.active == true), stale: (.stale == true),
        fetchedAt: (if (.fetchedAt | type) == "number" then .fetchedAt else null end),
        limits: (.limits | limits), limitsTruncated: (.limits | limits_truncated), balance: (.balance | balance)
      } else {error:"invalid-account"} end] else [] end)
  } end' "$file" 2>/dev/null || printf '%s\\n' '{"error":"invalid-record"}'
done
`;

const DEFAULT_REFRESH_SEC = 900;
const MIN_REFRESH_SEC = 30;
const MAX_REFRESH_SEC = 3600;
const MIN_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

function normalizeRefreshSec(value) {
  return Number.isFinite(value) && value >= MIN_REFRESH_SEC && value <= MAX_REFRESH_SEC
    ? value
    : DEFAULT_REFRESH_SEC;
}

// Percentages above 100% are real overages: clamp the display, never drop the window.
function usedPercent(percent) {
  return Math.min(100, Math.round(percent * 100));
}

export function parseQuota(output, now = Date.now()) {
  const rows = [];
  let errors = 0;
  let truncated = 0;
  let truncatedWindows = 0;
  let refreshSec = DEFAULT_REFRESH_SEC;
  for (const line of String(output).split("\n").slice(0, 66)) {
    if (!line.trim()) continue;
    if (line.length > 262144) { errors++; continue; }
    let record;
    try { record = JSON.parse(line); } catch { errors++; continue; }
    if (record && record.quotaMeta && typeof record.quotaMeta === "object") {
      refreshSec = normalizeRefreshSec(record.quotaMeta.refreshIntervalSec);
      continue;
    }
    if (!record || record.error || typeof record.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(record.id)) {
      errors++;
      continue;
    }
    const accounts = Array.isArray(record.accounts) ? record.accounts.slice(0, 16) : [];
    if (record.accountsTruncated === true || (Array.isArray(record.accounts) && record.accounts.length > 16)) {
      errors++;
      truncated++;
    }
    const sources = accounts.length ? accounts : [null];
    for (let index = 0; index < sources.length; index++) {
      const account = sources[index];
      if (accounts.length && (!account || typeof account !== "object" || Array.isArray(account) || account.error)) { errors++; continue; }
      const source = account || record;
      const incomplete = source.limitsTruncated === true || (Array.isArray(source.limits) && source.limits.length > 20);
      if (incomplete) { errors++; truncatedWindows++; }
      const fetched = account && typeof account.fetchedAt === "number" && Number.isFinite(account.fetchedAt) && account.fetchedAt > 0
        ? new Date(account.fetchedAt) : null;
      const updatedAt = fetched && Number.isFinite(fetched.getTime()) ? fetched.toISOString()
        : typeof record.updatedAt === "string" ? record.updatedAt.slice(0, 64).replace(/[\x00-\x1f\x7f]/g, " ") : "";
      const updated = Date.parse(updatedAt);
      const maxAgeMs = Math.max(MIN_MAX_AGE_MS, refreshSec * 2000);
      const stale = (account ? account.stale === true : record.limitsStale === true)
        || !Number.isFinite(updated) || now - updated > maxAgeMs || updated - now > MAX_FUTURE_MS;
      const windows = (Array.isArray(source.limits) ? source.limits.slice(0, 20) : [])
      .filter((w) => typeof w?.percent === "number" && Number.isFinite(w.percent) && w.percent >= 0)
      .map((w) => {
        const resetsAt = typeof w.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt)) ? w.resetsAt.slice(0, 64).replace(/[\x00-\x1f\x7f]/g, " ") : "";
        const reset = Date.parse(resetsAt);
        return {
          label: String(w.title || w.label || "Limit").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80),
          used: Number.isFinite(reset) && reset <= now ? null : usedPercent(w.percent),
          resetsAt,
        };
      });
      const balance = source.balance;
      if (balance && Number.isFinite(balance.remaining) && balance.remaining >= 0) {
        const currency = typeof balance.currency === "string" && /^[A-Z]{3}$/.test(balance.currency) ? ` ${balance.currency}` : "";
        const amount = `${balance.remaining.toFixed(2)}${currency}`;
        const funded = Number.isFinite(balance.funded) && balance.funded > 0 ? balance.funded : null;
        const metered = funded !== null && balance.remaining <= funded;
        const mismatch = funded !== null && balance.remaining > funded ? " (funding mismatch)" : "";
        const estimated = balance.estimated ? " (estimated)" : "";
        windows.push({ label: `Balance ${amount}${estimated}${mismatch}`, used: metered ? usedPercent(1 - balance.remaining / funded) : null, resetsAt: "", isBalance: true, unmetered: !metered });
      }
      if (!windows.length && !account) continue;
      const current = windows.filter((w) => w.used !== null).map((w) => w.used);
      const accountLabel = account && typeof account.label === "string" ? account.label.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80) : "";
      rows.push({
        id: record.id,
        accountLabel: account ? accountLabel || `Account ${index + 1}` : "",
        accountActive: !!account && account.active === true,
        updatedAt: Number.isFinite(updated) ? updatedAt : "",
        used: !incomplete && current.length ? Math.max(...current) : null,
        stale: stale || windows.some((window) => window.used === null && !window.unmetered),
        incomplete,
        windows,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.used === null || b.used === null) {
      if (a.used === b.used) return a.id.localeCompare(b.id);
      return a.used === null ? 1 : -1;
    }
    return b.used - a.used || a.id.localeCompare(b.id);
  });
  return { rows, errors, truncated, truncatedWindows };
}
