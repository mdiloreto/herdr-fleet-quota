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
  selected=$(jq -c '[.. | objects | select(.id? == "omarchy.agents" or .id? == "mateod.agents")] |
    (map(select(.id == "omarchy.agents"))[0] // .[0] // {}) |
    {disabled: [.providers? // {} | if type == "object" then to_entries[] |
      select((.value | type) == "object" and .value.enabled == false) | .key else empty end],
     interval: (if (.refreshIntervalSec | type) == "number" then .refreshIntervalSec else null end)}' "$settings") || exit 6
  disabled=$(printf '%s' "$selected" | jq -c '.disabled') || exit 6
  interval=$(printf '%s' "$selected" | jq -c '.interval') || exit 6
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
  def limits: if type == "array" then [.[:20][] | if type == "object" then {
    label: (if (.label | type) == "string" then .label[:80] else "Limit" end),
    title: (if (.title | type) == "string" then .title[:80] else null end),
    percent: (if (.percent | type) == "number" then .percent else null end),
    resetsAt: (if (.resetsAt | type) == "string" then .resetsAt[:64] else null end),
    estimated: (.estimated == true),
    invalid: (.resetsAt != null and (.resetsAt | type) != "string")
  } else {invalid:true} end] elif . == null then [] else [{invalid:true}] end;
  def balance: if . == null then null elif type == "object" then {
    remaining: (if (.remaining | type) == "number" then .remaining else null end),
    funded: (if (.funded | type) == "number" then .funded else null end),
    currency: (if (.currency | type) == "string" then .currency[:8] else null end),
    estimated: (.estimated == true)
  } else {invalid:true} end;
  def limits_truncated: if type == "array" then length > 20 else false end;
  if type != "object" then {error:"invalid-record"}
  elif (.id as $id | ($disabled | index($id)) != null) then empty else {
    id: (if (.id | type) == "string" then .id[:64] else null end),
    updatedAt: (if (.updatedAt | type) == "string" then .updatedAt[:64] else null end),
    ready: (if (.ready | type) == "boolean" then .ready else null end),
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
  } + (if has("limitsFetchedAt") then {
    limitsFetchedAt: (if (.limitsFetchedAt | type) == "number" then .limitsFetchedAt else null end)
  } else {} end) end' "$file" 2>/dev/null || printf '%s\\n' '{"error":"invalid-record"}'
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

export function availabilityOf(row, { hostStatus, now = Date.now() } = {}) {
  const unknown = (reason) => ({ state: "unknown", reason });
  if (hostStatus !== "ok") return unknown(hostStatus === "offline" ? "Machine is offline"
    : hostStatus === "error" ? "Quota read failed" : "No current machine reading");
  if (!row || row.ready === false) return unknown(row ? "Provider is not ready" : "No quota data");
  if (!Number.isFinite(now) || !Number.isFinite(row.freshUntil)) return unknown("Quota reading time unknown");
  if (Date.parse(row.updatedAt) - now > MAX_FUTURE_MS) return unknown("Quota reading time is in the future");
  if (row.stale || now > row.freshUntil) return unknown("Saved quota reading is stale");
  if (row.incomplete) return unknown("Some quota windows were omitted");
  const windows = Array.isArray(row.windows) ? row.windows : [];
  if (!windows.length) return unknown("No quota reported");
  for (const window of windows) {
    if (!window || typeof window !== "object") return unknown("Quota data is malformed");
    const reset = Date.parse(window.resetsAt);
    if (!window.isBalance && Number.isFinite(reset) && reset <= now) return unknown("Awaiting reading after reset");
    if (window.capacity !== "available" && window.capacity !== "exhausted") return unknown(window.reason || "Quota remaining is unknown");
    const remaining = window.isBalance ? window.remaining : window.remainingPercent;
    if (!Number.isFinite(remaining) || remaining < 0 || window.estimated
      || (window.capacity === "available" && remaining === 0)) return unknown("Quota remaining is unknown");
  }
  if (windows.some((window) => window.capacity === "exhausted")) return { state: "exhausted", reason: "A reported quota is exhausted" };
  return { state: "available", reason: "Reported quota remaining" };
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
      const hasFetched = !!account || Object.prototype.hasOwnProperty.call(record, "limitsFetchedAt");
      const fetchedAt = account ? account.fetchedAt : record.limitsFetchedAt;
      const fetched = Number.isFinite(fetchedAt) && fetchedAt > 0 ? new Date(fetchedAt) : null;
      const updatedAt = hasFetched
        ? fetched && Number.isFinite(fetched.getTime()) ? fetched.toISOString() : ""
        : typeof record.updatedAt === "string" ? record.updatedAt.slice(0, 64).replace(/[\x00-\x1f\x7f]/g, " ") : "";
      const updated = Date.parse(updatedAt);
      const maxAgeMs = Math.max(MIN_MAX_AGE_MS, refreshSec * 2000);
      const stale = (account ? account.stale === true : record.limitsStale === true)
        || !Number.isFinite(updated) || now - updated > maxAgeMs || updated - now > MAX_FUTURE_MS;
      const windows = (Array.isArray(source.limits) ? source.limits.slice(0, 20) : source.limits == null ? [] : [null])
      .map((w) => {
        const valid = w !== null && typeof w === "object" && !Array.isArray(w);
        const resetsAt = valid && typeof w.resetsAt === "string" ? w.resetsAt.slice(0, 64).replace(/[\x00-\x1f\x7f]/g, " ") : "";
        const reset = Date.parse(resetsAt);
        const malformed = !valid || w.invalid === true || (w.resetsAt != null && w.resetsAt !== "" && !Number.isFinite(reset));
        const known = valid && Number.isFinite(w.percent) && w.percent >= 0;
        const expired = Number.isFinite(reset) && reset <= now;
        const estimated = valid && w.estimated === true;
        const reason = malformed ? "Quota data is malformed" : !known ? "Quota percentage unavailable"
          : expired ? "Awaiting reading after reset" : estimated ? "Quota is estimated" : "";
        return {
          label: String(valid && (w.title || w.label) || "Limit").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80),
          used: known && !malformed && !expired ? usedPercent(w.percent) : null,
          capacity: reason ? "unknown" : w.percent >= 1 ? "exhausted" : "available",
          remainingPercent: known && !malformed && !expired ? Math.max(0, (1 - w.percent) * 100) : null,
          estimated,
          reason,
          resetsAt,
        };
      });
      const balance = source.balance;
      if (balance != null) {
        const valid = typeof balance === "object" && !Array.isArray(balance) && balance.invalid !== true && Number.isFinite(balance.remaining) && balance.remaining >= 0;
        const currency = typeof balance.currency === "string" && /^[A-Z]{3}$/.test(balance.currency) ? balance.currency : "";
        const amount = valid ? `${balance.remaining.toFixed(2)}${currency ? ` ${currency}` : ""}` : "unknown";
        const funded = Number.isFinite(balance.funded) && balance.funded > 0 ? balance.funded : null;
        const metered = valid && funded !== null && balance.remaining <= funded;
        const mismatch = valid && funded !== null && balance.remaining > funded ? " (funding mismatch)" : "";
        const estimated = balance.estimated === true;
        windows.push({
          label: `Balance ${amount}${estimated ? " (estimated)" : ""}${mismatch}`,
          used: metered ? usedPercent(1 - balance.remaining / funded) : null,
          resetsAt: "", isBalance: true, unmetered: !metered,
          capacity: !valid || estimated ? "unknown" : balance.remaining > 0 ? "available" : "exhausted",
          remaining: valid ? balance.remaining : null, currency, estimated,
          reason: !valid ? "Balance is malformed" : estimated ? "Balance is estimated" : "",
        });
      }
      if (!windows.length && !account) continue;
      const current = windows.filter((w) => w.used !== null).map((w) => w.used);
      const accountLabel = account && typeof account.label === "string" ? account.label.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80) : "";
      rows.push({
        id: record.id,
        accountLabel: account ? accountLabel || `Account ${index + 1}` : "",
        accountActive: !!account && account.active === true,
        updatedAt: Number.isFinite(updated) ? updatedAt : "",
        freshUntil: Number.isFinite(updated) ? updated + maxAgeMs : null,
        ready: !account && typeof record.ready === "boolean" ? record.ready : null,
        used: !incomplete && current.length ? Math.max(...current) : null,
        stale,
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
