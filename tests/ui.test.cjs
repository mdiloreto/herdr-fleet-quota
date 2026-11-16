const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const sourceMod = path.resolve(__dirname, "../mods/fleet-quota");
const COLORS = {
  canvas: "#111", chrome: "#141414", surface: "#181818", raised: "#222", hover: "#333",
  border: "#444", foreground: "#eee", muted: "#aaa", dim: "#777", accent: "#78a9ff",
  blocked: "#ff6b6b", done: "#5fbf77", working: "#e0b341", ansi3: "#e6ad62",
  ansi4: "#6d9eef", ansi5: "#b595e9", ansi6: "#64cbb6", ansi13: "#ea96bc",
};
const BUILDERS = [
  "size", "size_full", "h_full", "w", "h", "flex_1", "flex_none", "flex_shrink", "min_w", "min_h",
  "items_center", "justify_between", "justify_end", "justify_center", "gap", "p", "px", "py", "pt",
  "pb", "pl", "rounded", "bg", "border", "border_b", "border_color", "text_size", "text_color",
  "truncate", "font_semibold", "font_medium", "overflow_y_scrollbar", "overflow_hidden", "cursor_pointer",
  "max_w", "line_height", "flex_wrap", "border_l", "border_t", "opacity", "text_right", "role",
  "accessibility_label", "tooltip",
];

function element(kind) {
  const node = { kind, id: null, text: [], children: [], props: {}, handlers: {} };
  const api = {
    node,
    id(value) { node.id = value; return api; },
    child(child) {
      if (typeof child === "string") node.text.push(child);
      else if (child != null && child !== false) node.children.push(child);
      return api;
    },
    children(children) { for (const child of children) api.child(child); return api; },
    when(condition, draw) { if (condition) draw(api); return api; },
    on_click(handler) { node.handlers.click = handler; return api; },
    on_mouse_down(button, handler) { node.handlers[button] = handler; return api; },
    hover() { return api; },
  };
  for (const method of BUILDERS) api[method] = (value) => { node.props[method] = value ?? true; return api; };
  return api;
}
function nodes(tree) {
  if (!tree || typeof tree === "string") return [];
  const node = tree.node ?? tree;
  return [node, ...node.children.flatMap(nodes)];
}
function byId(tree, id) { return nodes(tree).find((node) => node.id === id); }
function visible(tree) { return nodes(tree).flatMap((node) => node.text); }
function texts(tree) {
  return nodes(tree).flatMap((node) => [...node.text, node.props.tooltip, node.props.accessibility_label].filter(Boolean));
}
function makeCx() {
  const cx = {
    tasks: [], timers: [], notified: 0,
    spawn(task) { cx.tasks.push(task); },
    notify() { cx.notified++; },
    timer: { every(ms, task) { cx.timers.push({ ms, task }); } },
  };
  return cx;
}
async function flush(cx) { while (cx.tasks.length) await cx.tasks.shift()(cx); }
function install(overrides = {}) {
  const calls = { hc: [], exec: [], overlays: [], closed: [], fleet: [] };
  globalThis.__herdr = {
    checking: false, props: { part: "panel", overlay: "quota-dialog" }, theme: COLORS,
    hc: async (args) => { calls.hc.push(args); return { code: 1, stdout: "", stderr: "secret" }; },
    exec: async (...args) => { calls.exec.push(args); return { code: 4, stdout: "" }; },
    openOverlay(spec) { calls.overlays.push(spec); },
    closeOverlay(id) { calls.closed.push(id); },
    ...overrides,
  };
  globalThis.__fleet = async (input) => { calls.fleet.push(input); return { hosts: [], discoveryError: false }; };
  return calls;
}

let Mod, RealMod, parseQuota, root;
before(async () => {
  ({ parseQuota } = await import(pathToFileURL(path.join(sourceMod, "model.js"))));
  globalThis.__kit = { View: class {}, element };
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-quota-ui-"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const packages = {
    "gpui-kit": 'export const View = globalThis.__kit.View; export const div = () => globalThis.__kit.element("div"); export const svg = (path) => { const el = globalThis.__kit.element("svg"); el.node.props.path = path; return el; };',
    "gpui-base": 'export const h_flex = () => globalThis.__kit.element("h_flex"); export const v_flex = () => globalThis.__kit.element("v_flex");',
    herdr: ["checking", "props", "theme", "hc", "exec", "openOverlay", "closeOverlay"].map((name) =>
      `export const ${name} = (...args) => typeof globalThis.__herdr.${name} === "function" ? globalThis.__herdr.${name}(...args) : globalThis.__herdr.${name};`).join("\n"),
  };
  for (const [name, content] of Object.entries(packages)) {
    const dir = path.join(root, "node_modules", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await fs.writeFile(path.join(dir, "index.js"), content);
  }
  for (const dir of ["stub", "real"]) {
    const target = path.join(root, dir);
    await fs.mkdir(target);
    for (const file of ["main.js", "model.js", "fleet.js"]) await fs.copyFile(path.join(sourceMod, file), path.join(target, file));
  }
  // Both variants use the real availability function; only collection is stubbed.
  await fs.writeFile(path.join(root, "stub", "fleet.js"), "export const collectFleet = (input) => globalThis.__fleet(input);");
  Mod = (await import(pathToFileURL(path.join(root, "stub", "main.js")))).default;
  RealMod = (await import(pathToFileURL(path.join(root, "real", "main.js")))).default;
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

function rows(records, now = Date.now()) {
  return parseQuota(records.map((record) => JSON.stringify({ updatedAt: new Date(now).toISOString(), ...record })).join("\n"), now).rows;
}
function host(name, records, now = Date.now()) {
  return { name, label: name ?? "This computer", status: "ok", errors: 0, lastSuccessAt: now, rows: rows(records, now) };
}
function loaded(hosts) {
  install({ checking: true });
  const mod = new Mod();
  mod.init({}, makeCx());
  mod.hosts = hosts;
  mod.refreshedAt = Date.now();
  return mod;
}
function barIds(mod) {
  return nodes(mod.bar(COLORS)).filter((node) => node.id?.startsWith("fleet-bar-provider-")).map((node) => node.id.slice(19));
}

test("checking guard renders honest empty states without reads or timers", () => {
  const calls = install({ checking: true });
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  assert.equal(cx.tasks.length, 0);
  assert.equal(cx.timers.length, 0);
  assert.deepEqual(calls.hc, []);
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.fleet, []);
  assert.ok(visible(mod.bar(COLORS)).includes("Checking…"));
  assert.ok(visible(mod.panel(COLORS)).includes("Reported quota remaining"));
  mod.refreshedAt = Date.now();
  assert.ok(visible(mod.bar(COLORS)).includes("Unverified"));
  assert.ok(!texts(mod.bar(COLORS)).some((text) => text.includes("no providers available")));
});

test("bar contains only qualifying provider icons, not highest consumption or warnings", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ percent: 0.4 }] },
    { id: "copilot", limits: [{ percent: 0.996 }] },
    { id: "codex", limits: [{ percent: 1 }] },
    { id: "openrouter", limits: [{ percent: 0.99 }], limitsStale: true },
  ])]);
  assert.deepEqual(barIds(mod), ["claude", "copilot"]);
  const bar = mod.bar(COLORS);
  assert.equal(byId(bar, "fleet-quota-bar").props.w, 118);
  assert.ok(!visible(bar).some((text) => /%|!|~|AI/.test(text)));
  assert.match(byId(bar, "fleet-quota-bar").props.tooltip, /Claude.*This computer/);
  assert.ok(!visible(mod.panel(COLORS)).some((text) => /used|HIGHEST|MACHINES WITH READINGS/.test(text)));
  assert.ok(visible(mod.panel(COLORS)).includes("<1% remaining"), "rounding to 100 used cannot erase positive capacity");
});

test("authoritative availability excludes stale, offline, failed, incomplete and mixed exhausted rows", () => {
  const now = Date.now();
  const hosts = [
    host("old", [{ id: "claude", limitsStale: true, limits: [{ percent: 0 }] }]),
    { ...host("offline", [{ id: "copilot", limits: [{ percent: 0 }] }]), status: "offline" },
    { ...host("failed", [{ id: "gemini", limits: [{ percent: 0 }] }]), status: "error" },
    host("truncated", [{ id: "agy", limitsTruncated: true, limits: [{ percent: 0 }] }]),
    host("mixed", [{ id: "openrouter", limits: [{ percent: 1 }], balance: { remaining: 10, currency: "USD" } }]),
    host("not-ready", [{ id: "fireworks", ready: false, balance: { remaining: 10 } }]),
    host("no-time", [{ id: "other", accounts: [{ label: "Work", limits: [{ percent: 0 }] }] }]),
    host("expired", [{ id: "another", limits: [{ percent: 0.4, resetsAt: new Date(now - 1).toISOString() }] }]),
  ];
  const mod = loaded(hosts);
  assert.deepEqual(barIds(mod), []);
  const text = visible(mod.panel(COLORS));
  for (const reason of ["Saved quota reading is stale", "Machine is offline", "Quota read failed",
    "Some quota windows were omitted", "A reported quota is exhausted", "Provider is not ready",
    "Quota reading time unknown", "Awaiting reading after reset"]) assert.ok(text.includes(reason), reason);
});

test("same provider shares one chip but retains independent host/account evidence", () => {
  const now = Date.now();
  const mod = loaded([
    host("alpha", [{ id: "claude", accounts: [{ label: "Work", active: true, fetchedAt: now, limits: [{ percent: 0.2 }] }] }]),
    host("beta", [{ id: "claude", accounts: [{ label: "Personal", active: false, fetchedAt: now, limits: [{ percent: 0.6 }] }] }]),
  ]);
  const groups = mod.availableProviders(now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].readings.length, 2);
  assert.deepEqual(barIds(mod), ["claude"]);
  const label = byId(mod.bar(COLORS), "fleet-quota-bar").props.tooltip;
  assert.match(label, /alpha · Work \(active on host\)/);
  assert.match(label, /beta · Personal \(not active on host\)/);
  const panel = mod.panel(COLORS);
  assert.ok(visible(byId(panel, "fleet-provider-0-0")).includes("80% remaining"));
  assert.ok(visible(byId(panel, "fleet-provider-1-0")).includes("40% remaining"));
  assert.ok(visible(byId(panel, "fleet-provider-1-0")).includes("not active on host"));
  assert.equal(nodes(panel).filter((node) => node.id === "fleet-available-claude").length, 1);
});

test("positive unmetered balances qualify without an allowlist; tiny, zero and estimated values are honest", () => {
  const mod = loaded([host(null, [
    { id: "openrouter", balance: { remaining: 0.004, currency: "USD" } },
    { id: "fireworks", balance: { remaining: 30, funded: 10, currency: "USD" } },
    { id: "zero", balance: { remaining: 0, currency: "USD" } },
    { id: "estimated", balance: { remaining: 2, estimated: true, currency: "USD" } },
  ])]);
  assert.deepEqual(barIds(mod), ["fireworks", "openrouter"]);
  const panel = mod.panel(COLORS), text = visible(panel);
  assert.ok(text.includes("<0.01 USD remaining"));
  assert.ok(text.includes("30.00 USD remaining"), "not clamped to funded");
  assert.ok(text.includes("0 USD remaining"));
  assert.ok(text.includes("2.00 USD remaining (estimated)"));
  assert.ok(!text.some((line) => /Balance 0.00|% used/.test(line)));
  assert.ok(texts(panel).includes("0.004 USD remaining"), "tooltip retains raw amount");
  assert.ok(!nodes(panel).some((node) => node.id?.startsWith("fleet-window-fill-")), "balances have no invented percentage track");
});

test("bar overflow is bounded, unknown provider ids are safe and all evidence remains accessible", () => {
  for (const count of [3, 4, 105]) {
    const ids = Array.from({ length: count }, (_, i) => `provider-${i}`);
    const mod = loaded(ids.map((id) => host(id, [{ id, limits: [{ percent: 0 }] }])));
    const bar = mod.bar(COLORS);
    assert.equal(barIds(mod).length, count === 3 ? 3 : 2);
    assert.equal(byId(bar, "fleet-quota-bar").props.w, 118);
    if (count > 3) {
      const extra = byId(bar, "fleet-bar-more");
      assert.equal(extra.props.w, 26);
      assert.deepEqual(extra.text, [count > 101 ? "+99+" : `+${count - 2}`]);
    }
    for (const id of ids) assert.ok(byId(bar, "fleet-quota-bar").props.tooltip.includes(id));
    const overview = byId(mod.panel(COLORS), "fleet-overview");
    assert.ok(nodes(overview).filter((node) => node.id?.startsWith("fleet-available-")).length <= 6);
    for (const id of ids) assert.ok(texts(overview).some((text) => text.includes(id)), "overflow evidence stays accessible");
  }
  const mod = loaded([host(null, [{ id: "constructor", limits: [{ percent: 0 }] }])]);
  assert.deepEqual(barIds(mod), ["constructor"]);
  assert.ok(nodes(mod.bar(COLORS)).some((node) => node.props.path === "mods/fleet-quota/icons/provider.svg"));
  assert.match(byId(mod.bar(COLORS), "fleet-quota-bar").props.tooltip, /constructor/);
});

test("remaining meters preserve zero and unknown, keep colors and do not round away tiny capacity", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ label: "Unused", percent: 0 }, { label: "Tiny", percent: 0.996 },
      { label: "Empty", percent: 1 }, { label: "Unknown", percent: null }] },
  ])]);
  for (const theme of [COLORS, { ...COLORS, canvas: "#fff", ansi3: "#885000" }]) {
    const panel = mod.panel(theme);
    assert.equal(byId(panel, "fleet-window-fill-0-0-0").props.w, "100%");
    const tiny = byId(panel, "fleet-window-fill-0-0-1");
    assert.ok(parseFloat(tiny.props.w) > 0 && parseFloat(tiny.props.w) < 1);
    assert.equal(tiny.props.bg, theme.ansi3);
    assert.equal(byId(panel, "fleet-window-fill-0-0-2").props.w, "0%");
    assert.equal(byId(panel, "fleet-window-fill-0-0-3"), undefined);
    assert.ok(visible(panel).includes("Remaining unknown"));
    assert.equal(byId(panel, "fleet-provider-0-0").props.border_color, theme.ansi3);
  }
});

test("local no-data is compact information, while host omissions and failures remain visible locally", () => {
  const mod = loaded([
    { name: null, label: "This computer", status: "no-data", rows: [] },
    { ...host("remote", [{ id: "claude", limits: [{ percent: 0 }] }]), errors: 2, truncated: 1, truncatedWindows: 1 },
  ]);
  const panel = mod.panel(COLORS);
  assert.equal(byId(panel, "fleet-notice"), undefined);
  assert.equal(byId(panel, "fleet-coverage"), undefined);
  assert.equal(byId(panel, "fleet-highest"), undefined);
  assert.ok(visible(byId(panel, "fleet-host-0")).includes("no data"));
  assert.ok(visible(byId(panel, "fleet-host-1")).includes("2 unreadable or omitted"));
  assert.ok(visible(byId(panel, "fleet-host-1")).includes("Some accounts omitted: limit 16 per provider."));
  assert.deepEqual(barIds(mod), ["claude"]);
});

test("old records retain provider identity and long source labels remain accessible", () => {
  const now = Date.now();
  const name = "remote-".repeat(15), account = "Account ".repeat(10), window = "Window ".repeat(10);
  const mod = loaded([host(name, [{ id: "claude", accounts: [{ label: account, active: false, fetchedAt: now,
    stale: true, limits: [{ title: window, percent: 0.4 }] }] }], now)]);
  const row = mod.hosts[0].rows[0];
  const panel = mod.panel(COLORS);
  assert.deepEqual(barIds(mod), []);
  assert.ok(visible(panel).includes("old"));
  assert.ok(visible(panel).includes("not active on host"));
  assert.equal(byId(panel, "fleet-provider-0-0").props.border_color, COLORS.ansi3);
  assert.equal(byId(panel, "fleet-window-fill-0-0-0").props.bg, COLORS.ansi3);
  assert.ok(byId(panel, "fleet-window-fill-0-0-0").props.opacity < 1);
  for (const full of [name, row.accountLabel, row.windows[0].label]) {
    assert.ok(nodes(panel).some((node) => node.props.tooltip === full && node.props.accessibility_label === full));
  }
  assert.ok(nodes(panel).some((node) => node.props.tooltip === new Date(now).toLocaleString()));
});

test("refresh failure retains detail but invalidates positive availability", async () => {
  install();
  const hosts = [host("remote", [{ id: "claude", limits: [{ percent: 0.4 }] }])];
  globalThis.__fleet = async () => ({ hosts, discoveryError: false });
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  await flush(cx);
  assert.deepEqual(barIds(mod), ["claude"]);
  globalThis.__fleet = async () => { throw new Error("failed"); };
  mod.refresh(cx);
  await flush(cx);
  assert.deepEqual(barIds(mod), []);
  const panel = mod.panel(COLORS);
  assert.ok(visible(panel).includes("Couldn't read the fleet."));
  assert.ok(visible(panel).includes("Quota read failed"));
  assert.ok(visible(panel).includes("60% remaining"));
  globalThis.__fleet = async () => ({ hosts, discoveryError: true });
  mod.refresh(cx);
  await flush(cx);
  assert.ok(visible(mod.panel(COLORS)).includes("Couldn't list every machine; showing what was read before."));
});

test("minute timer invalidates expired data even while a read hangs without stacking reads", async () => {
  install();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const hosts = [host(null, [{ id: "claude", limits: [{ percent: 0.4 }] }], now)];
    globalThis.__fleet = async () => ({ hosts, discoveryError: false });
    const mod = new Mod(), cx = makeCx();
    mod.init({}, cx);
    await flush(cx);
    assert.equal(cx.timers.length, 1);
    assert.equal(cx.timers[0].ms, 60000);
    assert.deepEqual(barIds(mod), ["claude"]);
    let reads = 0;
    globalThis.__fleet = () => { reads++; return new Promise(() => {}); };
    mod.refresh(cx);
    void cx.tasks.shift()(cx);
    now = hosts[0].rows[0].freshUntil + 1;
    const notifications = cx.notified;
    cx.timers[0].task(cx);
    assert.equal(cx.notified, notifications + 1);
    assert.equal(reads, 1);
    assert.equal(cx.tasks.length, 0);
    assert.deepEqual(barIds(mod), []);
    assert.ok(visible(mod.panel(COLORS)).includes("Saved quota reading is stale"));
  } finally { Date.now = originalNow; }
});

test("reset expiry is checked at render time and short dates do not rely on Intl options", () => {
  const now = Date.now();
  const reset = new Date(now + 60000);
  const mod = loaded([host(null, [{ id: "claude", limits: [{ label: "Week", percent: 0.2, resetsAt: reset.toISOString() }] }], now)]);
  assert.equal(mod.availableProviders(now).length, 1);
  assert.equal(mod.availableProviders(reset.getTime()).length, 0);
  const tree = mod.host(COLORS, mod.hosts[0], 0, reset.getTime());
  assert.ok(visible(tree).includes("Awaiting reading after reset"));
  assert.ok(visible(tree).includes("Remaining unknown"));
  assert.equal(byId(tree, "fleet-window-fill-0-0-0"), undefined);
  assert.ok(nodes(tree).some((node) => node.props.tooltip === reset.toLocaleString()));
  const saved = Date.prototype.toLocaleTimeString;
  try {
    Date.prototype.toLocaleTimeString = () => "UNSUPPORTED";
    assert.ok(!visible(mod.host(COLORS, mod.hosts[0], 0, now)).some((text) => text.includes("UNSUPPORTED")));
  } finally { Date.prototype.toLocaleTimeString = saved; }
});

test("controls, read cadence and fixed command transport remain unchanged", async () => {
  const calls = install();
  const mod = new Mod(), cx = makeCx();
  mod.init({}, cx);
  await flush(cx);
  const input = calls.fleet[0];
  assert.equal(input.concurrency, 4);
  assert.deepEqual(input.previous, []);
  assert.equal(cx.timers[0].ms, 60000);
  globalThis.__herdr.hc = async (args) => {
    calls.hc.push(args);
    return { code: 0, stdout: JSON.stringify({ machines: [{ name: "remote", state: "connected", temporary: true }] }) };
  };
  assert.equal((await input.listMachines())[0].name, "remote");
  assert.deepEqual(calls.hc[0], ["machine", "ls", "--json"]);
  globalThis.__herdr.hc = async () => ({ code: 1, stderr: "secret" });
  await assert.rejects(input.listMachines(), (error) => !error.message.includes("secret"));
  globalThis.__herdr.hc = async () => ({ code: 0, stdout: '{"machines":42}' });
  await assert.rejects(input.listMachines(), /machine list/);
  await input.readHost("remote; untrusted");
  const { READ_SCRIPT } = await import(pathToFileURL(path.join(sourceMod, "model.js")));
  assert.deepEqual(calls.exec[0], ["sh", ["-c", READ_SCRIPT], { on: "remote; untrusted", timeout: 8000 }]);
  const bar = byId(mod.bar(COLORS), "fleet-quota-bar");
  let stops = 0;
  bar.handlers.left(null, { stop_propagation() { stops++; } });
  bar.handlers.click(null, { stop_propagation() { stops++; } });
  assert.equal(stops, 2);
  assert.deepEqual(calls.overlays[0], { mod: "fleet-quota", kind: "dialog", width: 620, height: 560, props: { part: "panel" } });
  const panel = mod.panel(COLORS);
  byId(panel, "fleet-refresh").handlers.click(null, cx);
  await flush(cx);
  assert.equal(calls.fleet.length, 2);
  byId(panel, "fleet-close").handlers.click();
  assert.deepEqual(calls.closed, ["quota-dialog"]);
});

test("real UI/backend integration keeps account freshness and remaining units", async () => {
  const reads = [], now = Date.now();
  install({
    hc: async () => ({ code: 0, stdout: JSON.stringify({ machines: [{ name: "online", state: "connected" }, { name: "offline", state: "disconnected" }] }) }),
    exec: async (_command, _args, options) => {
      reads.push(options.on);
      if (options.on === null) return { code: 4, stdout: "" };
      return { code: 0, stdout: JSON.stringify({ id: "copilot", updatedAt: new Date(now).toISOString(), accounts: [
        { label: "Work", active: true, fetchedAt: now, limits: [{ percent: 0.996 }] },
        { label: "Personal", limits: [{ percent: 0 }] },
      ] }) };
    },
  });
  const mod = new RealMod(), cx = makeCx();
  mod.init({}, cx);
  await flush(cx);
  assert.deepEqual(reads, [null, "online"]);
  assert.deepEqual(barIds(mod), ["copilot"]);
  const groups = mod.availableProviders(Date.now());
  assert.equal(groups[0].readings.length, 1);
  assert.equal(groups[0].readings[0].row.accountLabel, "Work");
  const panel = mod.panel(COLORS);
  assert.ok(visible(panel).includes("<1% remaining"));
  assert.ok(visible(panel).includes("Quota reading time unknown"));
  assert.ok(visible(panel).includes("offline"));
});
