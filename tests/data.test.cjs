const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const dir = path.join(__dirname, "../mods/fleet-quota");
const modelPromise = import(pathToFileURL(path.join(dir, "model.js")));
const fleetPromise = import(pathToFileURL(path.join(dir, "fleet.js")));
const now = Date.parse("2026-11-15T12:00:00Z");
const recent = "2026-11-15T11:50:00Z";

const line = (id, percent, extra = {}) => JSON.stringify({
  id,
  updatedAt: recent,
  limits: [{ label: "Session", percent, resetsAt: "2026-11-15T13:00:00Z" }],
  ...extra,
});
const ok = (stdout) => ({ code: 0, stdout });
const names = (fleet) => fleet.hosts.map((host) => host.name);
const asOld = (rows) => rows.map((row) => ({ ...row, stale: true }));

test("rejects unusable records, preserves unknown windows and clamps overage", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  const output = [
    line("claude", 1.4, { limits: [{ label: "Session", percent: 1.4 }, { label: "Weekly", percent: 0.5 }] }),
    line("codex", 2),
    line("gemini", -0.2),
    "not json",
    JSON.stringify({ id: "bad id\n" }),
    JSON.stringify({ id: 7, limits: [{ percent: 0.5 }] }),
    JSON.stringify([1, 2]),
    "",
  ].join("\n");
  const result = parseQuota(output, now);
  assert.deepEqual(result.rows.map((row) => [row.id, row.used, row.stale]), [
    ["claude", 100, false], ["codex", 100, false], ["gemini", null, false],
  ]);
  assert.equal(result.rows[0].windows[0].used, 100);
  assert.equal(result.rows[0].updatedAt, recent);
  assert.equal(result.errors, 4);
  assert.equal(availabilityOf(result.rows[2], { hostStatus: "ok", now }).state, "unknown");
});

test("marks stale producer data and old or future timestamps without inventing a zero", async () => {
  const { parseQuota } = await modelPromise;
  const records = [
    { id: "stale-flag", updatedAt: new Date(now).toISOString(), limitsStale: true, limits: [{ percent: 0.3 }] },
    { id: "quiet", updatedAt: new Date(now).toISOString(), limitsStale: false, limits: [{ percent: 0.4 }] },
    { id: "old", updatedAt: "2026-11-14T11:00:00Z", limits: [{ percent: 0.9 }] },
    { id: "future", updatedAt: "2026-11-15T12:30:00Z", limits: [{ percent: 0.1 }] },
  ];
  const result = parseQuota(records.map(JSON.stringify).join("\n"), now);
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.deepEqual([byId["stale-flag"].used, byId["stale-flag"].stale], [30, true]);
  assert.deepEqual([byId.quiet.used, byId.quiet.stale], [40, false]);
  assert.deepEqual([byId.old.used, byId.old.stale], [90, true]);
  assert.deepEqual([byId.future.used, byId.future.stale], [10, true]);
  assert.equal(byId.old.updatedAt, "2026-11-14T11:00:00Z");
  assert.equal(result.errors, 0);
});

test("expired windows stay unknown without mislabelling a fresh producer reading as stale", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  const records = [
    { id: "mixed", updatedAt: recent, limits: [
      { label: "Session", percent: 0.2, resetsAt: "2026-11-15T11:00:00Z" },
      { label: "Weekly", percent: 0.6, resetsAt: "2026-11-20T00:00:00Z" },
    ] },
    { id: "z-expired", updatedAt: recent, limits: [{ label: "Session", percent: 0.9, resetsAt: "2026-11-15T11:00:00Z" }] },
    { id: "a-expired", updatedAt: recent, limits: [{ percent: 0.8, resetsAt: "2026-11-15T11:00:00Z" }] },
  ];
  const result = parseQuota(records.map(JSON.stringify).join("\n"), now);
  const mixed = result.rows.find((row) => row.id === "mixed");
  assert.deepEqual(mixed.windows.map((w) => [w.label, w.used]), [["Session", null], ["Weekly", 60]]);
  assert.deepEqual([mixed.used, mixed.stale], [60, false]);
  assert.deepEqual(result.rows.map((row) => [row.id, row.used, row.stale]), [
    ["mixed", 60, false], ["a-expired", null, false], ["z-expired", null, false],
  ]);
  for (const row of result.rows) assert.deepEqual(availabilityOf(row, { hostStatus: "ok", now }), {
    state: "unknown", reason: "Awaiting reading after reset",
  });
});

test("prepaid balances remain visible without inventing a funded percentage", async (t) => {
  const { READ_SCRIPT, parseQuota } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-balance-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  const records = [
    { id: "funded", balance: { remaining: 5, funded: 20, currency: "USD", estimated: true } },
    { id: "unfunded", balance: { remaining: 25, currency: "USD" } },
    { id: "mismatch", balance: { remaining: 25, funded: 20, currency: "USD" } },
    { id: "mixed", limits: [{ label: "Session", percent: 0.4 }], balance: { remaining: 9, funded: 10, currency: "USD" } },
  ];
  for (const record of records) fs.writeFileSync(path.join(usage, `${record.id}.json`), JSON.stringify({ ...record, updatedAt: recent }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  const result = parseQuota(output, now);
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.equal(byId.funded.used, 75);
  assert.match(byId.funded.windows[0].label, /5\.00 USD \(estimated\)/);
  assert.equal(byId.unfunded.used, null);
  assert.equal(byId.unfunded.stale, false);
  assert.match(byId.unfunded.windows[0].label, /25\.00 USD/);
  assert.equal(byId.mismatch.used, null);
  assert.match(byId.mismatch.windows[0].label, /funding mismatch/);
  assert.deepEqual(byId.mixed.windows.map((window) => window.used), [40, 10]);
  assert.equal(result.errors, 0);
});

test("the reader emits bounded quota fields only, honouring disabled providers and bad records", async (t) => {
  const { READ_SCRIPT, parseQuota } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-reader-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  const config = path.join(temp, "config/omarchy");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "shell.json"), JSON.stringify({
    bar: { layout: { right: [{ id: "mateod.agents", providers: { codex: { enabled: false } } }] } },
  }));
  fs.writeFileSync(path.join(usage, "claude.json"), JSON.stringify({
    id: "claude", updatedAt: recent, secret: "SENTINEL-MUST-NOT-LEAVE",
    limits: [{ label: "Session", percent: 0.45, resetsAt: "2026-11-15T13:00:00Z", private: "SENTINEL-MUST-NOT-LEAVE" }],
  }));
  fs.writeFileSync(path.join(usage, "codex.json"), JSON.stringify({ id: "codex", limits: [{ percent: 0.9 }] }));
  fs.writeFileSync(path.join(usage, "invalid.json"), "not json");
  fs.writeFileSync(path.join(usage, "large.json"), "x".repeat(262145));
  fs.symlinkSync(path.join(usage, "claude.json"), path.join(usage, "link.json"));
  const env = { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") };
  const output = execFileSync("sh", ["-c", READ_SCRIPT], { env, encoding: "utf8" });
  assert.doesNotMatch(output, /SENTINEL-MUST-NOT-LEAVE/);
  const result = parseQuota(output, now);
  assert.deepEqual(result.rows.map((row) => [row.id, row.used]), [["claude", 45]]);
  assert.equal(result.errors, 3);
  assert.equal(spawnSync("sh", ["-c", READ_SCRIPT], { env: { ...process.env, XDG_STATE_HOME: path.join(temp, "missing") } }).status, 4);
  assert.equal(spawnSync("/bin/sh", ["-c", READ_SCRIPT], { env: { ...process.env, ...env, PATH: "/nonexistent" } }).status, 5);
  fs.writeFileSync(path.join(config, "shell.json"), "not json");
  assert.equal(spawnSync("sh", ["-c", READ_SCRIPT], { env }).status, 6);
});

test("the real reader keeps accounts separate without sending email, IDs or credentials", async (t) => {
  const { READ_SCRIPT, parseQuota } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-accounts-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, "claude.json"), JSON.stringify({
    id: "claude", updatedAt: recent, limits: [{ percent: 0.99 }],
    accounts: [
      { id: "SECRET-ID", email: "SECRET-EMAIL", label: "Work", active: true, stale: false,
        fetchedAt: now - 60000, limits: [{ label: "Session", percent: 0.2 }], token: "SECRET-TOKEN" },
      { id: "SECRET-ID-2", label: "Personal", active: false, stale: true,
        fetchedAt: now - 120000, limits: [{ label: "Week", percent: 0.6 }], authHelpText: "SECRET-HELP" },
      { label: "Pending", limits: [] },
    ],
  }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  assert.doesNotMatch(output, /SECRET-(ID|EMAIL|TOKEN|HELP)/);
  const result = parseQuota(output, now);
  assert.deepEqual(result.rows.map((row) => [row.accountLabel, row.used, row.accountActive, row.stale]), [
    ["Personal", 60, false, true], ["Work", 20, true, false], ["Pending", null, false, true],
  ]);
  assert.equal(result.rows[1].updatedAt, new Date(now - 60000).toISOString());
  assert.equal(result.rows[2].updatedAt, "");
  assert.equal(result.rows[2].freshUntil, null);
  assert.equal(result.errors, 0);
});

test("account truncation is reported instead of silently hiding extra subscriptions", async (t) => {
  const { READ_SCRIPT, parseQuota } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-account-cap-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  const accounts = Array.from({ length: 17 }, (_, i) => ({ label: `Account ${i + 1}`, limits: [{ percent: 0.1 }] }));
  fs.writeFileSync(path.join(usage, "claude.json"), JSON.stringify({ id: "claude", updatedAt: recent, accounts }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  const result = parseQuota(output, now);
  assert.equal(result.rows.length, 16);
  assert.equal(result.errors, 1);
  assert.equal(result.truncated, 1);
});

test("omitted quota windows are reported and never produce a false maximum", async (t) => {
  const { READ_SCRIPT, parseQuota } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-window-cap-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  const limits = Array.from({ length: 21 }, (_, i) => ({ label: `Window ${i}`, percent: i === 20 ? 0.99 : 0.1 }));
  fs.writeFileSync(path.join(usage, "claude.json"), JSON.stringify({ id: "claude", updatedAt: recent, limits }));
  fs.writeFileSync(path.join(usage, "codex.json"), JSON.stringify({
    id: "codex", updatedAt: recent, accounts: [
      { label: "Work", limits }, { label: "Personal", limits: [{ percent: 0.4 }] },
    ],
  }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  const result = parseQuota(output, now);
  assert.equal(result.truncatedWindows, 2);
  assert.equal(result.errors, 2);
  assert.deepEqual(result.rows.map((row) => [row.id, row.accountLabel, row.used, row.incomplete]), [
    ["codex", "Personal", 40, false], ["claude", "", null, true], ["codex", "Work", null, true],
  ]);
});

test("reads every listed machine on its own, local first and temporaries included", async () => {
  const { collectFleet } = await fleetPromise;
  const calls = [];
  const records = {
    local: [line("claude", 0.4)],
    "linux-a": [line("claude", 0.9)],
    "linux-b": [line("claude", 0.2), line("codex", 0.5)],
    "linux-tmp": [line("gemini", 0.1)],
  };
  const readHost = async (name) => {
    calls.push(name);
    if (name === "linux-c") throw new Error("must not read a host that is not connected");
    return ok(records[name === null ? "local" : name].join("\n"));
  };
  const machines = [
    { name: "linux-b", state: "connected" },
    { name: "linux-a", state: "connected" },
    { name: "linux-tmp", state: "connected", temporary: true },
    { name: "linux-c", state: "disconnected" },
    { name: "linux-a", state: "connected" },
  ];
  const fleet = await collectFleet({ listMachines: async () => machines, readHost, now });
  assert.deepEqual(names(fleet), [null, "linux-a", "linux-b", "linux-c", "linux-tmp"]);
  assert.deepEqual(fleet.hosts.map((host) => host.label), ["This computer", "linux-a", "linux-b", "linux-c", "linux-tmp"]);
  assert.deepEqual(fleet.hosts.map((host) => host.status), ["ok", "ok", "ok", "offline", "ok"]);
  assert.equal(calls[0], null);
  assert.deepEqual(calls.slice().sort((a, b) => String(a).localeCompare(String(b))), [null, "linux-a", "linux-b", "linux-tmp"].sort((a, b) => String(a).localeCompare(String(b))));
  assert.equal(fleet.discoveryError, false);
  for (const host of fleet.hosts.filter((item) => item.status === "ok")) assert.equal(host.lastSuccessAt, now);
  assert.equal(fleet.hosts[3].lastSuccessAt, null);
  assert.deepEqual(fleet.hosts[3].rows, []);
  assert.equal(fleet.hosts[3].errors, 0);
});

test("the same provider on two machines keeps two percentages, never a sum", async () => {
  const { collectFleet } = await fleetPromise;
  const readHost = async (name) => ok(line("claude", name === null ? 0.35 : 0.8));
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost,
    now,
  });
  assert.deepEqual(fleet.hosts.map((host) => host.rows.length), [1, 1]);
  assert.deepEqual(fleet.hosts.map((host) => host.rows[0].used), [35, 80]);
  assert.deepEqual(fleet.hosts.map((host) => host.rows[0].id), ["claude", "claude"]);
});

test("a connected machine with no active space reports no-data and keeps no old rows", async () => {
  const { collectFleet } = await fleetPromise;
  const previous = [{
    name: "hc-empty", label: "hc-empty", status: "ok",
    rows: [{ id: "claude", used: 55, stale: false, windows: [] }], errors: 0, lastSuccessAt: now - 60000,
  }];
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "hc-empty", state: "connected" }],
    readHost: async (name) => (name === null ? ok(line("codex", 0.4)) : { code: 4, stdout: "" }),
    previous,
    now,
  });
  assert.deepEqual(fleet.hosts.map((host) => host.status), ["ok", "no-data"]);
  assert.deepEqual(fleet.hosts[1].rows, []);
  assert.equal(fleet.hosts[1].errors, 0);
  assert.equal(fleet.hosts[1].lastSuccessAt, now - 60000);
});

test("a disconnected machine keeps its last readings, marked offline and not current", async () => {
  const { collectFleet } = await fleetPromise;
  const cachedRows = [{ id: "claude", used: 30, stale: false, windows: [{ label: "Session", used: 30, resetsAt: "" }] }];
  const previous = [
    { name: null, label: "This computer", status: "ok", rows: cachedRows, errors: 0, lastSuccessAt: now - 120000 },
    { name: "linux-a", label: "linux-a", status: "ok", rows: cachedRows, errors: 2, lastSuccessAt: now - 300000 },
  ];
  const calls = [];
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "disconnected" }],
    readHost: async (name) => { calls.push(name); return ok(line("claude", 0.6)); },
    previous,
    now,
  });
  assert.deepEqual(calls, [null]);
  assert.deepEqual(names(fleet), [null, "linux-a"]);
  assert.equal(fleet.hosts[1].status, "offline");
  assert.deepEqual(fleet.hosts[1].rows, asOld(cachedRows));
  assert.equal(fleet.hosts[1].errors, 2);
  assert.equal(fleet.hosts[1].lastSuccessAt, now - 300000);
  assert.equal(fleet.hosts[0].status, "ok");
  assert.equal(fleet.hosts[0].rows[0].used, 60);
});

test("cached windows become unknown after reset for both offline and failed hosts", async () => {
  const { collectFleet } = await fleetPromise;
  const rows = [{ id: "claude", used: 90, stale: false, windows: [
    { label: "Session", used: 90, resetsAt: "2026-11-15T11:00:00Z" },
    { label: "Week", used: 20, resetsAt: "2026-11-15T13:00:00Z" },
  ] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "ok", rows, errors: 0, lastSuccessAt: now - 60000 }];
  for (const state of ["disconnected", "connected"]) {
    const fleet = await collectFleet({
      listMachines: async () => [{ name: "linux-a", state }],
      readHost: async (name) => { if (name === null) return ok(line("claude", 0.1)); throw new Error("offline"); },
      previous,
      now,
    });
    assert.equal(fleet.hosts[1].rows[0].stale, true);
    assert.equal(fleet.hosts[1].rows[0].used, 20);
    assert.deepEqual(fleet.hosts[1].rows[0].windows.map((window) => window.used), [null, 20]);
    assert.equal(rows[0].windows[0].used, 90, "the previous snapshot is not mutated");
  }
});

test("a reconnected machine replaces the cached readings and stamps the new success", async () => {
  const { collectFleet } = await fleetPromise;
  const stale = [{ id: "claude", used: 10, stale: true, windows: [] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "offline", rows: stale, errors: 1, lastSuccessAt: now - 600000 }];
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost: async (name) => (name === null ? ok(line("codex", 0.2)) : ok(line("claude", 0.8))),
    previous,
    now,
  });
  assert.equal(fleet.hosts[1].status, "ok");
  assert.deepEqual(fleet.hosts[1].rows.map((row) => [row.id, row.used]), [["claude", 80]]);
  assert.equal(fleet.hosts[1].errors, 0);
  assert.equal(fleet.hosts[1].lastSuccessAt, now);
});

test("one failing machine is isolated and keeps what it last read", async () => {
  const { collectFleet } = await fleetPromise;
  const cached = [{ id: "claude", used: 30, stale: false, windows: [] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "ok", rows: cached, errors: 0, lastSuccessAt: now - 90000 }];
  const readHost = async (name) => {
    if (name === null) return ok(line("claude", 0.15));
    if (name === "linux-a") throw new Error("ssh died");
    if (name === "linux-b") return { code: 5, stdout: "" };
    return ok("not json");
  };
  const fleet = await collectFleet({
    listMachines: async () => [
      { name: "linux-a", state: "connected" },
      { name: "linux-b", state: "connected" },
      { name: "linux-d", state: "connected" },
    ],
    readHost,
    previous,
    now,
  });
  assert.deepEqual(fleet.hosts.map((host) => host.status), ["ok", "error", "error", "error"]);
  assert.deepEqual(fleet.hosts[1].rows, asOld(cached));
  assert.equal(fleet.hosts[1].lastSuccessAt, now - 90000);
  assert.deepEqual(fleet.hosts[2].rows, []);
  assert.equal(fleet.hosts[2].reason, "jq is not installed.");
  assert.equal(fleet.hosts[2].lastSuccessAt, null);
  assert.deepEqual(fleet.hosts[3].rows, []);
  assert.equal(fleet.hosts[3].reason, "Quota data could not be parsed.");
  assert.equal(fleet.hosts[3].lastSuccessAt, null);
  assert.equal(fleet.hosts[0].rows[0].used, 15);
});

test("a discovery failure is reported, keeps previous remotes offline and still reads locally", async () => {
  const { collectFleet } = await fleetPromise;
  const cached = [{ id: "claude", used: 45, stale: false, windows: [] }];
  const previous = [
    { name: "linux-b", label: "linux-b", status: "ok", rows: cached, errors: 0, lastSuccessAt: now - 1000 },
    { name: "linux-a", label: "linux-a", status: "ok", rows: cached, errors: 0, lastSuccessAt: now - 2000 },
  ];
  const calls = [];
  const fleet = await collectFleet({
    listMachines: async () => { throw new Error("hub unreachable"); },
    readHost: async (name) => { calls.push(name); return ok(line("claude", 0.7)); },
    previous,
    now,
  });
  assert.equal(fleet.discoveryError, true);
  assert.deepEqual(calls, [null]);
  assert.deepEqual(names(fleet), [null, "linux-a", "linux-b"]);
  assert.deepEqual(fleet.hosts.map((host) => host.status), ["ok", "offline", "offline"]);
  assert.deepEqual(fleet.hosts[1].rows, asOld(cached));
  assert.equal(fleet.hosts[1].lastSuccessAt, now - 2000);
  assert.equal(fleet.hosts[0].rows[0].used, 70);
});

test("invalid machine names are reported and never handed to a reader", async () => {
  const { collectFleet } = await fleetPromise;
  const calls = [];
  const fleet = await collectFleet({
    listMachines: async () => [
      { name: "bad\nname", state: "connected" },
      { name: "x".repeat(129), state: "connected" },
      { name: "", state: "connected" },
      { name: 7, state: "connected" },
      { name: null, state: "connected" },
      { name: "ok", state: "connected" },
      { name: "ok", state: "connected" },
    ],
    readHost: async (name) => { calls.push(name); return ok(line("claude", 0.5)); },
    now,
  });
  assert.equal(fleet.discoveryError, true);
  assert.deepEqual(names(fleet), [null, "ok"]);
  assert.deepEqual(calls.sort((a, b) => String(a).localeCompare(String(b))), [null, "ok"].sort((a, b) => String(a).localeCompare(String(b))));

  const notAList = await collectFleet({ listMachines: async () => "linux-a", readHost: async () => ok(line("claude", 0.1)), now });
  assert.equal(notAList.discoveryError, true);
  assert.deepEqual(names(notAList), [null]);
});

test("never runs more than four reads at once and never drops a host", async () => {
  const { collectFleet } = await fleetPromise;
  const machines = Array.from({ length: 12 }, (_, index) => ({ name: `hc-${String(index).padStart(2, "0")}`, state: "connected" }));
  const run = async (concurrency) => {
    let inFlight = 0;
    let peak = 0;
    let reads = 0;
    const readHost = async () => {
      reads++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return ok(line("claude", 0.5));
    };
    const fleet = await collectFleet({ listMachines: async () => machines, readHost, now, ...(concurrency === undefined ? {} : { concurrency }) });
    return { peak, reads, fleet };
  };

  const capped = await run(99);
  assert.equal(capped.peak, 4);
  assert.equal(capped.reads, 13);
  assert.equal(capped.fleet.hosts.length, 13);
  assert.ok(capped.fleet.hosts.every((host) => host.status === "ok"));

  const serial = await run(0);
  assert.equal(serial.peak, 1);
  assert.equal(serial.reads, 13);

  const two = await run(2);
  assert.equal(two.peak, 2);
  assert.equal(two.fleet.hosts.length, 13);
});

test("a success with missing or empty stdout is an error that keeps the cache", async () => {
  const { collectFleet } = await fleetPromise;
  const cached = [{ id: "claude", used: 42, stale: false, windows: [] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "ok", rows: cached, errors: 0, lastSuccessAt: now - 45000 }];
  const fleet = await collectFleet({
    listMachines: async () => [
      { name: "linux-a", state: "connected" },
      { name: "linux-b", state: "connected" },
      { name: "linux-c", state: "connected" },
    ],
    readHost: async (name) => {
      if (name === null) return ok(line("claude", 0.2));
      if (name === "linux-a") return { code: 0, stdout: "" };
      if (name === "linux-b") return { code: 0 };
      return { code: 0, stdout: "  \n\n" };
    },
    previous,
    now,
  });
  assert.deepEqual(fleet.hosts.map((host) => host.status), ["ok", "error", "error", "error"]);
  assert.deepEqual(fleet.hosts[1].rows, asOld(cached));
  assert.equal(fleet.hosts[1].lastSuccessAt, now - 45000);
  assert.deepEqual(fleet.hosts[2].rows, []);
  assert.deepEqual(fleet.hosts[3].rows, []);
  assert.notEqual(fleet.hosts[1].lastSuccessAt, now);
});

test("records that all fail to parse leave the host in error, never as data", async () => {
  const { collectFleet } = await fleetPromise;
  const cached = [{ id: "codex", used: 25, stale: true, windows: [] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "ok", rows: cached, errors: 2, lastSuccessAt: now - 7000 }];
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost: async (name) => (name === null
      ? ok(line("claude", 0.2))
      : ok(`${JSON.stringify({ error: "invalid-record" })}\nnot json\n`)),
    previous,
    now,
  });
  assert.equal(fleet.hosts[1].status, "error");
  assert.deepEqual(fleet.hosts[1].rows, asOld(cached));
  assert.equal(fleet.hosts[1].errors, 2);
  assert.equal(fleet.hosts[1].lastSuccessAt, now - 7000);
});

test("a clean read with no records is no-data, not a host with quotas", async () => {
  const { collectFleet } = await fleetPromise;
  const cached = [{ id: "claude", used: 88, stale: false, windows: [] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "ok", rows: cached, errors: 0, lastSuccessAt: now - 1000 }];
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost: async (name) => (name === null
      ? ok(line("claude", 0.2))
      : ok(JSON.stringify({ quotaMeta: { refreshIntervalSec: 900 } }))),
    previous,
    now,
  });
  assert.deepEqual(fleet.hosts.map((host) => host.status), ["ok", "no-data"]);
  assert.deepEqual(fleet.hosts[1].rows, []);
  assert.equal(fleet.hosts[1].errors, 0);
  assert.deepEqual(fleet.hosts.filter((host) => host.rows.length).map((host) => host.name), [null]);
});

test("valid rows beside unreadable records stay ok, with the errors kept visible", async () => {
  const { collectFleet } = await fleetPromise;
  const { availabilityOf } = await modelPromise;
  const cached = [{ id: "claude", used: 10, stale: false, windows: [] }];
  const previous = [{ name: "linux-a", label: "linux-a", status: "ok", rows: cached, errors: 0, lastSuccessAt: now - 1000 }];
  const fleet = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost: async (name) => (name === null
      ? ok(line("codex", 0.3))
      : ok(`${line("claude", 0.65)}\nnot json\n`)),
    previous,
    now,
  });
  assert.equal(fleet.hosts[1].status, "ok");
  assert.deepEqual(fleet.hosts[1].rows.map((row) => [row.id, row.used]), [["claude", 65]]);
  assert.equal(fleet.hosts[1].errors, 1);
  assert.equal(fleet.hosts[1].lastSuccessAt, now);
  assert.equal(availabilityOf(fleet.hosts[1].rows[0], { hostStatus: fleet.hosts[1].status, now }).state, "available");
});

test("availability uses raw limits, not rounded display percentages, and requires every constraint", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  const cases = [
    ["near-limit", [{ percent: 0.996 }], "available"],
    ["zero-use", [{ percent: 0 }], "available"],
    ["reached", [{ percent: 1 }], "exhausted"],
    ["overage", [{ percent: 1.4 }], "exhausted"],
    ["positive", [{ percent: 0.2 }, { percent: 0.6 }], "available"],
    ["one-reached", [{ percent: 0.2 }, { percent: 1 }], "exhausted"],
    ["missing", [{ percent: 0.2 }, { label: "Weekly" }], "unknown"],
    ["null", [{ percent: 0.2 }, null], "unknown"],
    ["string", [{ percent: 0.2 }, "invalid"], "unknown"],
    ["array", [{ percent: 0.2 }, []], "unknown"],
    ["negative", [{ percent: 1 }, { percent: -0.1 }], "unknown"],
    ["invalid-number", [{ percent: 0.2 }, { percent: "0.1" }], "unknown"],
    ["estimated", [{ percent: 0.2, estimated: true }], "unknown"],
    ["bad-reset", [{ percent: 0.2, resetsAt: "not a date" }], "unknown"],
    ["bad-reset-type", [{ percent: 0.2, resetsAt: 123 }], "unknown"],
  ];
  for (const [id, limits, state] of cases) {
    const row = parseQuota(line(id, 0, { limits }), now).rows[0];
    assert.equal(row.windows.length, limits.length, id);
    assert.equal(row.stale, false, `${id}: missing capacity is not producer staleness`);
    assert.equal(availabilityOf(row, { hostStatus: "ok", now }).state, state, id);
    if (id === "near-limit") {
      assert.equal(row.used, 100, "legacy display remains compatible");
      assert.equal(row.windows[0].capacity, "available");
      assert.ok(Math.abs(row.windows[0].remainingPercent - 0.4) < 1e-10);
    }
  }
});

test("balances retain raw amounts and cannot override other constraints", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  const cases = [
    ["unfunded", { remaining: 5, currency: "USD" }, [], "available"],
    ["sub-cent", { remaining: 0.001, funded: 20 }, [], "available"],
    ["funding-mismatch", { remaining: 25, funded: 20 }, [], "available"],
    ["empty", { remaining: 0 }, [], "exhausted"],
    ["negative", { remaining: -1 }, [], "unknown"],
    ["missing", {}, [{ percent: 0.1 }], "unknown"],
    ["malformed", "five", [{ percent: 0.1 }], "unknown"],
    ["estimated", { remaining: 5, estimated: true }, [], "unknown"],
    ["mixed-positive", { remaining: 5 }, [{ percent: 0.1 }], "available"],
    ["mixed-limit", { remaining: 5 }, [{ percent: 1 }], "exhausted"],
    ["mixed-balance", { remaining: 0 }, [{ percent: 0.1 }], "exhausted"],
    ["mixed-unknown", { remaining: 5 }, [{ percent: null }], "unknown"],
    ["unknown-before-exhaustion", {}, [{ percent: 1 }], "unknown"],
  ];
  for (const [id, balance, limits, state] of cases) {
    const row = parseQuota(line(id, 0, { limits, balance }), now).rows[0];
    const window = row.windows.at(-1);
    assert.equal(availabilityOf(row, { hostStatus: "ok", now }).state, state, id);
    assert.equal(window.remaining, typeof balance.remaining === "number" && balance.remaining >= 0 ? balance.remaining : null, id);
    assert.equal(window.currency, balance.currency || "", id);
    assert.equal(window.estimated, balance.estimated === true, id);
    if (id === "unfunded") assert.equal(window.used, null);
    if (id === "sub-cent") assert.equal(window.capacity, "available");
  }
});

test("freshness and readiness are evaluated independently of capacity and at render time", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  const row = parseQuota(line("claude", 0.2), now).rows[0];
  assert.equal(row.freshUntil, Date.parse(recent) + 30 * 60 * 1000);
  assert.equal(availabilityOf(row, { hostStatus: "ok", now: row.freshUntil }).state, "available");
  assert.deepEqual(availabilityOf(row, { hostStatus: "ok", now: row.freshUntil + 1 }), {
    state: "unknown", reason: "Saved quota reading is stale",
  });
  for (const hostStatus of ["offline", "error", "no-data", undefined]) {
    assert.equal(availabilityOf(row, { hostStatus, now }).state, "unknown", String(hostStatus));
  }
  for (const extra of [
    { ready: false }, { limitsStale: true }, { updatedAt: "" }, { updatedAt: "invalid" },
    { updatedAt: new Date(now - 31 * 60 * 1000).toISOString() },
    { updatedAt: new Date(now + 6 * 60 * 1000).toISOString() }, { limitsTruncated: true },
  ]) {
    const invalid = parseQuota(line("claude", 1, extra), now).rows[0];
    assert.equal(availabilityOf(invalid, { hostStatus: "ok", now }).state, "unknown", JSON.stringify(extra));
  }
  const notReady = parseQuota(line("claude", 0.2, { ready: false }), now).rows[0];
  assert.equal(availabilityOf(notReady, { hostStatus: "ok", now }).reason, "Provider is not ready");
  const resetting = parseQuota(line("claude", 0.2, {
    limits: [{ percent: 0.2, resetsAt: new Date(now + 1000).toISOString() }],
  }), now).rows[0];
  const before = JSON.stringify(resetting);
  assert.equal(availabilityOf(resetting, { hostStatus: "ok", now }).state, "available");
  assert.equal(availabilityOf(resetting, { hostStatus: "ok", now: now + 1000 }).reason, "Awaiting reading after reset");
  assert.equal(JSON.stringify(resetting), before, "classification does not mutate the snapshot");
  assert.equal(availabilityOf(row, { hostStatus: "ok", now: Date.parse(recent) - 6 * 60 * 1000 }).state, "unknown", "clock rollback cannot make future data current");
  for (const invalidNow of [NaN, Infinity, -Infinity]) {
    assert.equal(availabilityOf(row, { hostStatus: "ok", now: invalidNow }).state, "unknown");
  }
});

test("provider fetch timestamps take precedence and invalid supplied timestamps never fall back", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  for (const fetchedAt of [null, 0, -1, "invalid", recent, 1e20, now - 31 * 60 * 1000]) {
    const row = parseQuota(line("copilot", 0.2, { updatedAt: new Date(now).toISOString(), limitsFetchedAt: fetchedAt }), now).rows[0];
    assert.equal(availabilityOf(row, { hostStatus: "ok", now }).state, "unknown", String(fetchedAt));
  }
  const fresh = parseQuota(line("copilot", 0.2, { updatedAt: "2000-01-01T00:00:00Z", limitsFetchedAt: now - 1000 }), now).rows[0];
  assert.equal(fresh.updatedAt, new Date(now - 1000).toISOString());
  assert.equal(availabilityOf(fresh, { hostStatus: "ok", now }).state, "available");
  const legacy = parseQuota(line("claude", 0.2), now).rows[0];
  assert.equal(availabilityOf(legacy, { hostStatus: "ok", now }).state, "available");
  const accounts = parseQuota(line("claude", 0.2, {
    limitsFetchedAt: now, accounts: [
      { label: "Fresh", fetchedAt: now, limits: [{ percent: 0.2 }] },
      { label: "Missing time", limits: [{ percent: 0.2 }] },
      { label: "Invalid time", fetchedAt: "invalid", limits: [{ percent: 0.2 }] },
      { label: "No quota", fetchedAt: now, limits: [] },
    ],
  }), now).rows;
  assert.deepEqual(accounts.map((row) => availabilityOf(row, { hostStatus: "ok", now }).state), ["available", "unknown", "unknown", "unknown"]);
  assert.equal(accounts[1].updatedAt, "");
  assert.equal(accounts[2].updatedAt, "");
});

test("account truncation does not negate known accounts, but omitted constraints do", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  const accounts = Array.from({ length: 17 }, (_, index) => ({
    label: `Account ${index + 1}`, fetchedAt: now, active: index === 0, limits: [{ percent: index === 1 ? 1 : 0.2 }],
  }));
  accounts[2].limits = Array.from({ length: 21 }, () => ({ percent: 0.2 }));
  const result = parseQuota(line("claude", 0.99, { accounts }), now);
  assert.equal(result.truncated, 1);
  assert.equal(result.truncatedWindows, 1);
  const byLabel = Object.fromEntries(result.rows.map((row) => [row.accountLabel, row]));
  assert.equal(availabilityOf(byLabel["Account 1"], { hostStatus: "ok", now }).state, "available");
  assert.equal(availabilityOf(byLabel["Account 2"], { hostStatus: "ok", now }).state, "exhausted");
  assert.equal(availabilityOf(byLabel["Account 3"], { hostStatus: "ok", now }).state, "unknown");
  assert.equal(availabilityOf(byLabel["Account 4"], { hostStatus: "ok", now }).state, "available", "inactive is not the same as no capacity");
});

test("non-finite constraints never imply remaining capacity", async () => {
  const { parseQuota, availabilityOf } = await modelPromise;
  for (const fields of [
    '"limits":[{"percent":1e400}]', '"limits":[{"percent":-1e400}]',
    '"balance":{"remaining":1e400}', '"balance":{"remaining":-1e400}',
    '"limits":[{"percent":0.2}],"limitsFetchedAt":1e400',
  ]) {
    const row = parseQuota(`{"id":"claude","updatedAt":"${recent}",${fields}}`, now).rows[0];
    assert.equal(availabilityOf(row, { hostStatus: "ok", now }).state, "unknown", fields);
  }
  const malformed = parseQuota(`{"id":"claude","updatedAt":"${recent}","limits":[{"percent":NaN}]}`, now);
  assert.equal(malformed.rows.length, 0);
  assert.equal(malformed.errors, 1);
});

test("the reader selects native settings first without mixing fork settings", async (t) => {
  const { READ_SCRIPT, parseQuota, availabilityOf } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-settings-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  const config = path.join(temp, "config/omarchy");
  fs.mkdirSync(usage, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  for (const id of ["claude", "codex"]) fs.writeFileSync(path.join(usage, `${id}.json`), line(id, 0.2, {
    updatedAt: new Date(now - 45 * 60 * 1000).toISOString(),
  }));
  const native = { id: "omarchy.agents", refreshIntervalSec: 3600, providers: { codex: { enabled: false } } };
  const fork = { id: "mateod.agents", refreshIntervalSec: 30, providers: { claude: { enabled: false } } };
  for (const [widgets, ids, state] of [
    [[native], ["claude"], "available"],
    [[fork], ["codex"], "unknown"],
    [[fork, native], ["claude"], "available"],
    [[native, fork], ["claude"], "available"],
    [[fork, { id: "omarchy.agents" }], ["claude", "codex"], "unknown"],
  ]) {
    fs.writeFileSync(path.join(config, "shell.json"), JSON.stringify({ bar: { layout: { right: widgets } } }));
    const output = execFileSync("sh", ["-c", READ_SCRIPT], {
      env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
    });
    const rows = parseQuota(output, now).rows;
    assert.deepEqual(rows.map((row) => row.id), ids);
    for (const row of rows) assert.equal(availabilityOf(row, { hostStatus: "ok", now }).state, state);
  }
});

test("native Claude and Copilot schema fixtures preserve fetch evidence and exclude local estimates", async (t) => {
  const { READ_SCRIPT, parseQuota, availabilityOf } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-native-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  // Shapes from native base_record/account_entry and the two allowance collectors; values are synthetic.
  const records = [
    { schemaVersion: 1, id: "claude", ready: true, limitsStale: false, limitsFetchedAt: now - 1000,
      limits: [{ label: "Session", percent: 0.2 }], accounts: [
        { id: "SENTINEL-ID", email: "SENTINEL-EMAIL", label: "Work", primary: true, active: true,
          fetchedAt: now - 1000, stale: false, limits: [{ label: "Session", percent: 0.2 }, { label: "Weekly", percent: 0.5 }] },
        { label: "Personal", active: false, fetchedAt: now - 2000, stale: false, limits: [{ percent: 1 }] },
      ] },
    { schemaVersion: 1, id: "copilot", ready: true, limitsStale: false, limitsFetchedAt: now - 1000,
      limits: [{ label: "Monthly allowance", percent: 0.996, resetsAt: "2026-12-01T00:00:00Z" }] },
    { id: "copilot-local", ready: true, limitsStale: false, limitsFetchedAt: 0,
      limits: [{ label: "Monthly allowance (est.)", percent: 0.2, resetsAt: "2026-12-01T00:00:00Z" }] },
    { id: "explicit-estimate", ready: true, limitsFetchedAt: now - 1000,
      limits: [{ label: "Monthly allowance", percent: 0.2, estimated: true }] },
    { id: "not-ready", ready: false, limitsFetchedAt: now, limits: [{ percent: 0.2 }] },
    { id: "bad-timestamp", ready: true, limitsFetchedAt: "invalid", limits: [{ percent: 0.2 }] },
    { id: "empty", ready: false, limitsFetchedAt: 0, limits: [] },
  ];
  for (const record of records) fs.writeFileSync(path.join(usage, `${record.id}.json`), JSON.stringify({
    ...record, updatedAt: new Date(now).toISOString(), token: "SENTINEL-TOKEN", authHelpText: "SENTINEL-HELP",
  }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  assert.doesNotMatch(output, /SENTINEL/);
  const rows = parseQuota(output, now).rows;
  const state = (id, label = "") => availabilityOf(rows.find((row) => row.id === id && row.accountLabel === label), { hostStatus: "ok", now }).state;
  assert.equal(state("claude", "Work"), "available");
  assert.equal(state("claude", "Personal"), "exhausted");
  assert.equal(state("copilot"), "available");
  for (const id of ["copilot-local", "explicit-estimate", "not-ready", "bad-timestamp"]) assert.equal(state(id), "unknown", id);
  assert.equal(rows.some((row) => row.id === "empty"), false);
});

test("native root readiness does not hide a different account with remaining quota", async (t) => {
  const { READ_SCRIPT, parseQuota, availabilityOf } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-account-ready-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, "claude.json"), JSON.stringify({
    id: "claude", updatedAt: recent, ready: false, limits: [], limitsFetchedAt: 0,
    accounts: [
      { label: "Active", active: true, fetchedAt: 0, stale: false, limits: [] },
      { label: "Other", active: false, fetchedAt: now - 1000, stale: false, limits: [{ percent: 0.2 }] },
    ],
  }));
  fs.writeFileSync(path.join(usage, "copilot.json"), line("copilot", 0.2, { ready: false, limitsFetchedAt: now - 1000 }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  const { rows } = parseQuota(output, now);
  const active = rows.find((row) => row.accountLabel === "Active");
  const other = rows.find((row) => row.accountLabel === "Other");
  const root = rows.find((row) => row.id === "copilot");
  assert.equal(availabilityOf(other, { hostStatus: "ok", now }).state, "available");
  assert.equal(other.accountActive, false);
  assert.equal(other.ready, null);
  assert.equal(active.ready, null);
  assert.equal(availabilityOf(active, { hostStatus: "ok", now }).state, "unknown");
  assert.equal(root.ready, false);
  assert.deepEqual(availabilityOf(root, { hostStatus: "ok", now }), {
    state: "unknown", reason: "Provider is not ready",
  });
});

test("the real reader preserves malformed constraints beside valid ones", async (t) => {
  const { READ_SCRIPT, parseQuota, availabilityOf } = await modelPromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fleet-unknown-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const usage = path.join(temp, "omarchy/agents/usage");
  fs.mkdirSync(usage, { recursive: true });
  const records = [
    { id: "null-limit", limits: [{ percent: 0.2 }, null] },
    { id: "missing-percent", limits: [{ percent: 0.2 }, { label: "Weekly" }] },
    { id: "bad-container", limits: {}, balance: { remaining: 5 } },
    { id: "bad-balance", limits: [{ percent: 0.2 }], balance: "invalid" },
    { id: "missing-amount", limits: [{ percent: 0.2 }], balance: {} },
    { id: "bad-reset", limits: [{ percent: 0.2, resetsAt: 123 }] },
  ];
  for (const record of records) fs.writeFileSync(path.join(usage, `${record.id}.json`), JSON.stringify({ ...record, updatedAt: recent }));
  const output = execFileSync("sh", ["-c", READ_SCRIPT], {
    env: { ...process.env, XDG_STATE_HOME: temp, XDG_CONFIG_HOME: path.join(temp, "config") }, encoding: "utf8",
  });
  const rows = parseQuota(output, now).rows;
  assert.equal(rows.length, records.length);
  for (const row of rows) assert.equal(availabilityOf(row, { hostStatus: "ok", now }).state, "unknown", row.id);
});

test("decisive usage reports the window that runs out first", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const row = parseQuota(line("claude", 0, { limits: [
    { label: "Session", percent: 0.25 },
    { label: "Weekly", percent: 0.8 },
    { label: "Monthly", percent: 0.4 },
  ] }), now).rows[0];
  assert.deepEqual(decisiveUsage(row), { used: 80, label: "Weekly", remaining: null, currency: "" });
  const tied = parseQuota(line("codex", 0, { limits: [
    { label: "Session", percent: 0.6 },
    { label: "Weekly", percent: 0.6 },
  ] }), now).rows[0];
  assert.deepEqual(decisiveUsage(tied), { used: 60, label: "Session", remaining: null, currency: "" });
});

test("decisive usage keeps the balance amount beside the decisive percent", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const row = parseQuota(line("mixed", 0, {
    limits: [{ label: "Session", percent: 0.4 }], balance: { remaining: 9, funded: 10, currency: "USD" },
  }), now).rows[0];
  assert.deepEqual(decisiveUsage(row), { used: 40, label: "Session", remaining: 9, currency: "USD" });
});

test("decisive usage keeps sub-integer headroom instead of rounding to fully used", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const row = parseQuota(line("claude", 0, { limits: [
    { label: "Session", percent: 0.9 },
    { label: "Weekly", percent: 0.995 },
  ] }), now).rows[0];
  assert.equal(row.windows[1].used, 100, "the window percentage stays a rounded integer");
  assert.equal(row.used, 100, "the legacy row percentage stays a rounded integer");
  assert.deepEqual(decisiveUsage(row), { used: 99.5, label: "Weekly", remaining: null, currency: "" });
});

test("a credit balance never reads as fully used while credit is left", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const row = parseQuota(line("fireworks", 0, {
    limits: [], balance: { remaining: 0.001, funded: 20, currency: "USD" },
  }), now).rows[0];
  assert.equal(row.windows[0].used, 100, "the row sort key stays a rounded integer");
  assert.equal(row.windows[0].label, "Balance <0.01 USD", "the same sub-cent rule the viewer uses");
  assert.deepEqual(decisiveUsage(row), { used: null, label: "", remaining: 0.001, currency: "USD" });
});

test("decisive usage never turns a credit balance into a percentage", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const half = parseQuota(line("half", 0, {
    limits: [], balance: { remaining: 5, funded: 10, currency: "USD" },
  }), now).rows[0];
  assert.equal(half.used, 50, "the legacy row percentage is unchanged");
  assert.deepEqual(decisiveUsage(half), { used: null, label: "", remaining: 5, currency: "USD" });
  const metered = parseQuota(line("metered", 0, {
    limits: [], balance: { remaining: 5, funded: 20, currency: "USD" },
  }), now).rows[0];
  assert.equal(metered.windows[0].remainingPercent, undefined);
  assert.equal(metered.windows[0].used, 75, "the window percentage is unchanged");
  assert.deepEqual(decisiveUsage(metered), { used: null, label: "", remaining: 5, currency: "USD" });
});

test("decisive usage keeps the exact window percent beside a funded balance", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const exact = parseQuota(line("copilot", 0, { limits: [{ label: "Monthly", percent: 0.995 }] }), now).rows[0];
  assert.equal(exact.windows[0].used, 100, "the window percentage stays a rounded integer");
  assert.deepEqual(decisiveUsage(exact), { used: 99.5, label: "Monthly", remaining: null, currency: "" });
  const mixed = parseQuota(line("mixed", 0, {
    limits: [{ label: "Monthly", percent: 0.995 }], balance: { remaining: 0.001, funded: 20, currency: "USD" },
  }), now).rows[0];
  assert.deepEqual(decisiveUsage(mixed), { used: 99.5, label: "Monthly", remaining: 0.001, currency: "USD" });
});

test("decisive usage claims no percentage when every window is unknown", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const unfunded = parseQuota(line("unfunded", 0, { limits: [], balance: { remaining: 25, currency: "USD" } }), now).rows[0];
  assert.equal(unfunded.windows[0].used, null);
  assert.deepEqual(decisiveUsage(unfunded), { used: null, label: "", remaining: 25, currency: "USD" });
  const unknown = parseQuota(line("missing", 0, { limits: [{ label: "Weekly" }, { percent: null }] }), now).rows[0];
  assert.deepEqual(decisiveUsage(unknown), { used: null, label: "", remaining: null, currency: "" });
});

test("decisive usage never throws on malformed rows and windows", async () => {
  const { decisiveUsage } = await modelPromise;
  const empty = { used: null, label: "", remaining: null, currency: "" };
  for (const row of [
    null, undefined, {}, { windows: null }, { windows: "nope" }, { windows: {} },
    { windows: [null, "x", [], { used: "40" }, { used: null }, { used: NaN }, { used: Infinity },
      { used: -1 }, { used: 101 }, { remaining: -5 }, { remaining: "5" }, { remaining: null }] },
  ]) assert.deepEqual(decisiveUsage(row), empty, JSON.stringify(row));
  assert.deepEqual(decisiveUsage({ windows: [{ used: 40, label: "Session", remaining: -1 }] }), empty,
    "a rounded used alone never decides the percentage");
  assert.deepEqual(decisiveUsage({ windows: [{ used: 40, label: "Session", remainingPercent: 101 }] }), empty,
    "an out-of-range remainingPercent is not a percentage");
  assert.deepEqual(decisiveUsage({ windows: [{ used: 40, label: "Session", remainingPercent: 60 }] }), {
    used: 40, label: "Session", remaining: null, currency: "",
  });
});

test("decisive usage leaves the row it is given untouched", async () => {
  const { parseQuota, decisiveUsage } = await modelPromise;
  const row = parseQuota(line("claude", 0, {
    limits: [{ label: "Session", percent: 0.2 }, { label: "Weekly", percent: 0.7 }],
    balance: { remaining: 5, funded: 20, currency: "USD" },
  }), now).rows[0];
  const before = JSON.stringify(row);
  decisiveUsage(row);
  assert.equal(JSON.stringify(row), before);
});

test("cached capacity never qualifies after a failed read and reset invalidation preserves the old snapshot", async () => {
  const { collectFleet } = await fleetPromise;
  const { availabilityOf } = await modelPromise;
  const initial = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost: async () => ok(line("claude", 0.2, { limits: [{ percent: 0.2, resetsAt: new Date(now + 1000).toISOString() }] })),
    now,
  });
  const cached = JSON.stringify(initial);
  const failed = await collectFleet({
    listMachines: async () => [{ name: "linux-a", state: "connected" }],
    readHost: async () => { throw new Error("unreachable"); },
    previous: initial.hosts, now: now + 1000,
  });
  for (const host of failed.hosts) {
    const row = host.rows[0];
    assert.equal(row.windows[0].capacity, "unknown");
    assert.equal(row.windows[0].remainingPercent, null);
    assert.equal(availabilityOf(row, { hostStatus: host.status, now: now + 1000 }).state, "unknown");
  }
  assert.equal(JSON.stringify(initial), cached);
});
