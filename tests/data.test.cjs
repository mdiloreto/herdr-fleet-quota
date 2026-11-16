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

test("rejects unusable records, drops invalid windows and clamps overage", async () => {
  const { parseQuota } = await modelPromise;
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
    ["claude", 100, false], ["codex", 100, false],
  ]);
  assert.equal(result.rows[0].windows[0].used, 100);
  assert.equal(result.rows[0].updatedAt, recent);
  assert.equal(result.errors, 4);
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

test("expired windows stay unknown, never zero, and a fully expired record has no percentage", async () => {
  const { parseQuota } = await modelPromise;
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
  assert.deepEqual([mixed.used, mixed.stale], [60, true]);
  assert.deepEqual(result.rows.map((row) => [row.id, row.used, row.stale]), [
    ["mixed", 60, true], ["a-expired", null, true], ["z-expired", null, true],
  ]);
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
    ["Personal", 60, false, true], ["Work", 20, true, false], ["Pending", null, false, false],
  ]);
  assert.equal(result.rows[1].updatedAt, new Date(now - 60000).toISOString());
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
});
