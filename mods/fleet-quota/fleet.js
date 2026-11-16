// One quota reading per machine, from the records Omarchy already writes there. Everything about how a host is
// reached arrives through the injected API: this module never imports `herdr`, never builds a command from a
// machine name, and never talks to a provider. Readings stay per host — accounts are never merged or summed.
import { parseQuota } from "./model.js";

export const LOCAL_LABEL = "This computer";
const LOCAL_STATE = "local";
const MAX_NAME_LENGTH = 128;
const MAX_CONCURRENCY = 4;

function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A machine name we are willing to hand back: non-empty, bounded, and free of control characters. */
function isSafeName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_NAME_LENGTH && !/[\x00-\x1f\x7f]/.test(name);
}

function clampConcurrency(value) {
  const requested = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : MAX_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, requested));
}

/** No measurable quota was reported. */
function noData(plan, previousHost) {
  return {
    name: plan.name,
    label: plan.label,
    status: "no-data",
    rows: [],
    errors: 0,
    truncated: 0,
    truncatedWindows: 0,
    lastSuccessAt: Number.isFinite(previousHost?.lastSuccessAt) ? previousHost.lastSuccessAt : null,
  };
}

/** Keep the last reading while marking the host offline or failed. */
function carry(plan, previousHost, status, reason = "", now = Date.now()) {
  const rows = Array.isArray(previousHost?.rows) ? previousHost.rows.map((row) => {
    const windows = Array.isArray(row.windows) ? row.windows.map((window) => {
      const reset = Date.parse(window.resetsAt);
      return !window.isBalance && Number.isFinite(reset) && reset <= now
        ? { ...window, used: null, capacity: "unknown", remainingPercent: null, reason: "Awaiting reading after reset" }
        : window;
    }) : [];
    const current = windows.filter((window) => typeof window.used === "number" && Number.isFinite(window.used)).map((window) => window.used);
    return { ...row, windows, stale: true, used: row.incomplete ? null : windows.length ? (current.length ? Math.max(...current) : null) : row.used };
  }) : [];
  return {
    name: plan.name,
    label: plan.label,
    status,
    reason,
    rows,
    errors: Number.isFinite(previousHost?.errors) ? previousHost.errors : 0,
    truncated: Number.isFinite(previousHost?.truncated) ? previousHost.truncated : 0,
    truncatedWindows: Number.isFinite(previousHost?.truncatedWindows) ? previousHost.truncatedWindows : 0,
    lastSuccessAt: Number.isFinite(previousHost?.lastSuccessAt) ? previousHost.lastSuccessAt : null,
  };
}

/** A bounded worker pool: `limit` readers at once, results written back in the plan's order. */
async function readBounded(plans, limit, read) {
  const results = new Array(plans.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < plans.length; index = next++) {
      results[index] = await read(plans[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, plans.length) }, worker));
  return results;
}

/**
 * The fleet's quotas, local machine first and then by name. `listMachines` is the hc list ({name, state,
 * temporary?}), `readHost` takes null for this computer or a machine name and resolves {code, stdout}. Each host:
 * {name, label, status: ok|no-data|offline|error, rows, errors, lastSuccessAt}. A discovery failure is reported in
 * `discoveryError` and leaves the previous remote hosts visible as offline; the local read still happens.
 */
export async function collectFleet({ listMachines, readHost, previous = [], now = Date.now(), concurrency = MAX_CONCURRENCY } = {}) {
  if (typeof readHost !== "function") throw new TypeError("collectFleet needs readHost");
  const at = Number.isFinite(now) ? now : Date.now();

  const cached = new Map();
  for (const host of Array.isArray(previous) ? previous : []) {
    if (!host || (host.name !== null && typeof host.name !== "string")) continue;
    if (host.name !== null && !isSafeName(host.name)) continue;
    if (!cached.has(host.name)) cached.set(host.name, host);
  }

  let discoveryError = false;
  let discovered = false;
  let machines = [];
  if (typeof listMachines !== "function") {
    discoveryError = true;
  } else {
    try {
      machines = await listMachines();
      discovered = true;
    } catch {
      discoveryError = true;
    }
  }

  const plans = [{ name: null, label: LOCAL_LABEL, state: LOCAL_STATE }];
  if (discovered && !Array.isArray(machines)) {
    discoveryError = true;
    discovered = false;
  }
  if (discovered) {
    const seen = new Set();
    const listed = [];
    for (const machine of machines) {
      const name = machine?.name;
      if (!isSafeName(name)) {
        discoveryError = true;
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      listed.push({ name, label: name, state: typeof machine.state === "string" ? machine.state : "" });
    }
    listed.sort((a, b) => compareNames(a.name, b.name));
    plans.push(...listed);
  } else {
    const names = [...cached.keys()].filter((name) => name !== null).sort(compareNames);
    for (const name of names) plans.push({ name, label: name, state: "offline" });
  }

  const hosts = await readBounded(plans, clampConcurrency(concurrency), async (plan) => {
    const previousHost = cached.get(plan.name) ?? null;
    if (plan.state !== LOCAL_STATE && plan.state !== "connected") return carry(plan, previousHost, "offline", "", at);
    let response;
    try {
      response = await readHost(plan.name);
    } catch {
      return carry(plan, previousHost, "error", "Could not reach this machine.", at);
    }
    const code = typeof response?.code === "number" ? response.code : null;
    if (code === 4) return noData(plan, previousHost);
    if (code !== 0) {
      const reason = code === 5 ? "jq is not installed." : code === 6 ? "Omarchy settings could not be read." : "Quota reader failed.";
      return carry(plan, previousHost, "error", reason, at);
    }
    // READ_SCRIPT always prints its meta line, so a silent success means the read never happened.
    const stdout = typeof response.stdout === "string" ? response.stdout : "";
    if (!stdout.trim()) return carry(plan, previousHost, "error", "Quota reader returned no output.", at);
    const parsed = parseQuota(stdout, at);
    if (!parsed.rows.length) return parsed.errors ? carry(plan, previousHost, "error", "Quota data could not be parsed.", at) : noData(plan, previousHost);
    return {
      name: plan.name,
      label: plan.label,
      status: "ok",
      rows: parsed.rows,
      errors: parsed.errors,
      truncated: parsed.truncated,
      truncatedWindows: parsed.truncatedWindows,
      lastSuccessAt: at,
    };
  });

  return { hosts, discoveryError };
}
