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
// A row with an exact used percent, for values the parser's float math cannot hit exactly.
function exactRow(id, remainingPercent, window = {}) {
  const now = Date.now();
  return {
    id, accountLabel: "", accountActive: false, updatedAt: new Date(now).toISOString(),
    freshUntil: now + 3600000, ready: null, used: Math.round(100 - remainingPercent),
    stale: false, incomplete: false,
    windows: [{ label: "Week", used: Math.round(100 - remainingPercent), capacity: "available",
      remainingPercent, estimated: false, reason: "", resetsAt: "", ...window }],
  };
}
function exactHost(...rows) {
  return { name: null, label: "This computer", status: "ok", errors: 0, lastSuccessAt: Date.now(), rows };
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
  assert.ok(visible(mod.panel(COLORS)).includes("Reported quota"));
  mod.refreshedAt = Date.now();
  assert.ok(visible(mod.bar(COLORS)).includes("Unverified"));
  assert.ok(texts(mod.bar(COLORS)).some((text) => text.includes("No provider has confirmed remaining quota")),
    "the empty badge states the real reason");
});

test("bar shows one qualifying provider icon and the honest percentage used", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ label: "Week", percent: 0.4 }] },
    { id: "copilot", limits: [{ percent: 0.996 }] },
    { id: "codex", limits: [{ percent: 1 }] },
    { id: "openrouter", limits: [{ percent: 0.99 }], limitsStale: true },
  ])]);
  assert.deepEqual(barIds(mod), ["copilot"], "only the tightest available provider is in the badge");
  const bar = mod.bar(COLORS);
  assert.equal(byId(bar, "fleet-quota-bar").props.w, 118);
  assert.equal(byId(bar, "fleet-bar-used").text[0], "99.6%", "a window with capacity left is never 100%");
  assert.ok(!visible(bar).some((text) => /!|~|AI/.test(text)));
  assert.match(byId(bar, "fleet-quota-bar").props.tooltip, /Claude.*This computer/);
  const panel = mod.panel(COLORS);
  assert.equal(byId(panel, "fleet-window-pct-0-1-0").text[0], "99.6% used", "rounding to 100 used cannot erase positive capacity");
  assert.equal(byId(panel, "fleet-window-pct-0-0-0").text[0], "100% used", "only a window that is actually spent reads full");
  assert.equal(byId(panel, "fleet-window-pct-0-3-0").text[0], "40% used");
});

test("a provider this build has never heard of renders as its own id with the generic glyph", () => {
  const mod = loaded([host(null, [{ id: "mistral", limits: [{ label: "Week", percent: 0.25 }] }])]);
  assert.deepEqual(barIds(mod), ["mistral"]);
  const chip = byId(mod.bar(COLORS), "fleet-bar-provider-mistral");
  assert.equal(chip.children[0].node.props.path, "mods/fleet-quota/icons/provider.svg", "no mapping keeps the generic outline");
  const text = visible(mod.panel(COLORS));
  assert.ok(text.includes("mistral"), "the raw id stands in for the name");
  assert.ok(text.includes("25% used"));
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
  assert.equal(Math.round(groups[0].used), 60, "the group reports the window that runs out first");
  assert.equal(groups[0].label, "Limit");
  assert.deepEqual(barIds(mod), ["claude"]);
  const label = byId(mod.bar(COLORS), "fleet-quota-bar").props.tooltip;
  assert.match(label, /alpha · Work \(active on host\)/);
  assert.match(label, /beta · Personal \(not active on host\)/);
  const panel = mod.panel(COLORS);
  assert.ok(visible(byId(panel, "fleet-provider-0-0")).includes("20% used"));
  assert.ok(visible(byId(panel, "fleet-provider-1-0")).includes("60% used"));
  assert.ok(visible(byId(panel, "fleet-provider-1-0")).includes("not active on host"));
  assert.equal(nodes(panel).filter((node) => node.id === "fleet-available-claude").length, 1);
});

test("a group keeps the tightest credit among its readings", () => {
  const accounts = (workBalance) => host(null, [{ id: "claude", accounts: [
    { label: "Work", active: true, fetchedAt: Date.now(), limits: [{ label: "Week", percent: 0.8 }],
      balance: workBalance ? { remaining: 5, currency: "USD" } : null },
    { label: "Personal", fetchedAt: Date.now(), limits: [{ label: "Week", percent: 0.2 }], balance: { remaining: 12, currency: "USD" } },
  ] }]);
  const fallback = loaded([accounts(false)]).availableProviders(Date.now())[0];
  assert.equal(Math.round(fallback.used), 80);
  assert.equal(fallback.remaining, 12, "the only reading with credits stands");
  assert.equal(fallback.currency, "USD");
  const own = loaded([accounts(true)]).availableProviders(Date.now())[0];
  assert.equal(own.remaining, 5, "the tightest credit stands, not the first found");
});

test("positive unmetered balances qualify without an allowlist; tiny, zero and estimated values are honest", () => {
  const mod = loaded([host(null, [
    { id: "openrouter", balance: { remaining: 0.004, currency: "USD" } },
    { id: "fireworks", balance: { remaining: 30, funded: 10, currency: "USD" } },
    { id: "zero", balance: { remaining: 0, currency: "USD" } },
    { id: "estimated", balance: { remaining: 2, estimated: true, currency: "USD" } },
  ])]);
  assert.deepEqual(barIds(mod), ["openrouter"], "no percentage: the badge falls back to the tightest credit, not the first provider");
  assert.equal(byId(mod.bar(COLORS), "fleet-bar-credits").text[0], "<0.01 USD", "the balance that runs out first is the one shown");
  const panel = mod.panel(COLORS), text = visible(panel);
  assert.ok(text.includes("<0.01 USD remaining"));
  assert.ok(text.includes("30.00 USD remaining"), "not clamped to funded");
  assert.ok(text.includes("0 USD remaining"));
  assert.ok(text.includes("2.00 USD remaining (estimated)"));
  assert.ok(!text.some((line) => /Balance 0.00|% used/.test(line)));
  assert.ok(texts(panel).includes("0.004 USD remaining"), "tooltip retains raw amount");
  assert.ok(!nodes(panel).some((node) => node.id?.startsWith("fleet-window-fill-")), "balances have no invented percentage track");
});

test("bar keeps one number, counts the other providers, and unknown ids stay safe and accessible", () => {
  for (const count of [3, 4, 105]) {
    const ids = Array.from({ length: count }, (_, i) => `provider-${i}`);
    const mod = loaded(ids.map((id) => host(id, [{ id, limits: [{ percent: 0 }] }])));
    const bar = mod.bar(COLORS);
    assert.equal(barIds(mod).length, 1, "the badge holds one decisive provider");
    assert.equal(byId(bar, "fleet-quota-bar").props.w, 118);
    const extra = byId(bar, "fleet-bar-more");
    assert.equal(extra.props.w, 26);
    assert.deepEqual(extra.text, [count - 1 > 99 ? "+99+" : `+${count - 1}`]);
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

test("used meters preserve zero and unknown, keep colors and do not round away tiny capacity", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ label: "Unused", percent: 0 }, { label: "Tiny", percent: 0.996 },
      { label: "Empty", percent: 1 }, { label: "Unknown", percent: null }] },
  ])]);
  for (const theme of [COLORS, { ...COLORS, canvas: "#fff", ansi3: "#885000" }]) {
    const panel = mod.panel(theme);
    assert.equal(byId(panel, "fleet-window-fill-0-0-0").props.w, "0%", "an unused window is empty");
    assert.equal(byId(panel, "fleet-window-pct-0-0-0").text[0], "0% used");
    const tiny = byId(panel, "fleet-window-fill-0-0-1");
    assert.ok(parseFloat(tiny.props.w) > 99 && parseFloat(tiny.props.w) < 100);
    assert.equal(byId(panel, "fleet-window-pct-0-0-1").text[0], "99.6% used");
    assert.equal(tiny.props.bg, theme.ansi3);
    assert.equal(byId(panel, "fleet-window-fill-0-0-2").props.w, "100%");
    assert.equal(byId(panel, "fleet-window-pct-0-0-2").text[0], "100% used");
    assert.equal(byId(panel, "fleet-window-fill-0-0-3"), undefined);
    assert.ok(visible(panel).includes("Remaining unknown"));
    assert.equal(byId(panel, "fleet-provider-0-0").props.border_color, theme.ansi3);
  }
});

test("bar shows the decisive provider's icon and its percent of quota used", () => {
  const mod = loaded([host(null, [{ id: "claude", limits: [{ label: "Weekly", percent: 0.74 }] }])]);
  const bar = mod.bar(COLORS);
  assert.deepEqual(barIds(mod), ["claude"]);
  assert.equal(byId(bar, "fleet-bar-provider-claude").children[0].node.props.path, "icons/claude.svg");
  assert.equal(byId(bar, "fleet-bar-used").text[0], "74%");
  assert.equal(byId(bar, "fleet-bar-credits"), undefined);
  assert.match(byId(bar, "fleet-quota-bar").props.tooltip, /^Quota used: 74% of Claude · Weekly\. /);
  assert.match(byId(bar, "fleet-quota-bar").props.accessibility_label, /^Quota used: 74% of Claude · Weekly\. /);
});

test("the decisive number is the provider closest to exhaustion, not the first by id", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ label: "Week", percent: 0.26 }] },
    { id: "codex", limits: [{ label: "Month", percent: 0.74 }] },
  ])]);
  const bar = mod.bar(COLORS);
  assert.deepEqual(barIds(mod), ["codex"], "claude sorts first but has more headroom");
  assert.equal(byId(bar, "fleet-bar-used").text[0], "74%");
  assert.equal(byId(bar, "fleet-bar-more").text[0], "+1");
  assert.match(byId(bar, "fleet-quota-bar").props.tooltip, /Quota used: 74% of Codex · Month\./);
  assert.match(byId(bar, "fleet-bar-more").props.tooltip, /Claude: .*26% used/, "the pill explains the providers it counts");
});

test("the badge credits fallback shows the tightest balance, not the first provider", () => {
  const mod = loaded([host(null, [
    { id: "fireworks", balance: { remaining: 30, currency: "USD" } },
    { id: "openrouter", balance: { remaining: 0.004, currency: "USD" } },
  ])]);
  const bar = mod.bar(COLORS);
  assert.deepEqual(barIds(mod), ["openrouter"], "the balance that runs out first leads the badge");
  assert.equal(byId(bar, "fleet-bar-credits").text[0], "<0.01 USD");
  assert.equal(byId(bar, "fleet-bar-used"), undefined, "a credit balance never becomes a percentage");
  assert.match(byId(bar, "fleet-quota-bar").props.tooltip, /^Credits remaining: <0\.01 USD on OpenRouter\./);
  assert.match(byId(bar, "fleet-bar-more").props.tooltip, /Fireworks: .*30\.00 USD remaining/,
    "every provider's own credits stay in the tooltip");
});

test("the badge number can shrink instead of overhanging the badge", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ label: "Week", percent: 0.0001 }] },
    { id: "copilot", limits: [{ label: "Week", percent: 0.26 }] },
  ])]);
  const number = byId(mod.bar(COLORS), "fleet-bar-used");
  assert.equal(number.props.min_w, 0, "the number may shrink to fit the badge");
  assert.equal(number.props.truncate, true, "and clips rather than pushing the layout");
  assert.equal(number.props.flex_shrink, 1);
});

test("every number in the evidence belongs to the reading that reported it", () => {
  const mod = loaded([host(null, [{ id: "claude", accounts: [
    { label: "Work", active: true, fetchedAt: Date.now(), limits: [{ label: "Week", percent: 0.8 }],
      balance: { remaining: 5, currency: "USD" } },
    { label: "Personal", fetchedAt: Date.now(), limits: [{ label: "Week", percent: 0.2 }],
      balance: { remaining: 12, currency: "USD" } },
  ] }])]);
  const evidence = byId(mod.bar(COLORS), "fleet-quota-bar").props.tooltip;
  assert.ok(evidence.includes("Work"), "the account is named");
  assert.ok(/Work[^;]*80% used[^;]*5\.00 USD remaining/.test(evidence),
    `Work's percent and credits travel together: ${evidence}`);
  assert.ok(/Personal[^;]*20% used[^;]*12\.00 USD remaining/.test(evidence),
    `Personal's percent and credits travel together: ${evidence}`);
  assert.ok(!/80% used · 12\.00 USD/.test(evidence), "no account's credit is attached to another account's percent");
});

test("an incomplete or not-ready reading never wears a green current pill", () => {
  const incomplete = loaded([host(null, [{ id: "claude", limits: [{ percent: 0.2 }], limitsTruncated: true }])]);
  const panel = incomplete.panel(COLORS);
  assert.ok(!visible(panel).includes("current"), "an incomplete reading is not current");
  assert.ok(visible(panel).includes("partial"), "it says what is wrong with it");
  const notReady = loaded([host(null, [{ id: "claude", ready: false, limits: [{ percent: 0.2 }] }])]);
  const other = notReady.panel(COLORS);
  assert.ok(!visible(other).includes("current"), "a not-ready reading is not current");
  assert.ok(visible(other).includes("not ready"));
  const fresh = loaded([host(null, [{ id: "claude", limits: [{ percent: 0.2 }] }])]);
  assert.ok(visible(fresh.panel(COLORS)).includes("current"), "a complete, ready reading still says current");
});

test("bar shows remaining credits when no available provider reports a percentage", () => {
  const mod = loaded([host(null, [{ id: "fireworks", balance: { remaining: 30, currency: "USD" } }])]);
  const bar = mod.bar(COLORS);
  assert.deepEqual(barIds(mod), ["fireworks"]);
  assert.equal(byId(bar, "fleet-bar-used"), undefined);
  assert.equal(byId(bar, "fleet-bar-credits").text[0], "30.00 USD");
  assert.match(byId(bar, "fleet-quota-bar").props.tooltip, /^Credits remaining: 30\.00 USD on Fireworks\. /);
});

test("bar keeps its honest empty state when nothing is available", () => {
  const mod = loaded([{ ...host("remote", [{ id: "claude", limits: [{ percent: 0.2 }] }]), status: "offline" }]);
  const bar = mod.bar(COLORS);
  assert.deepEqual(barIds(mod), []);
  assert.ok(visible(bar).includes("Unverified"));
  assert.equal(byId(bar, "fleet-bar-used"), undefined);
  assert.equal(byId(bar, "fleet-bar-credits"), undefined);
  assert.equal(byId(bar, "fleet-bar-more"), undefined);
  assert.ok(byId(bar, "fleet-quota-bar").props.tooltip.includes("No provider has confirmed remaining quota in fresh readings"));
  const untouched = new Mod();
  untouched.init({}, makeCx());
  assert.ok(visible(untouched.bar(COLORS)).includes("Checking…"));
});

test("bar shows no second number beside the other available providers", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ percent: 0.26 }] },
    { id: "codex", limits: [{ percent: 0.5 }] },
    { id: "copilot", limits: [{ percent: 0.9 }] },
  ])]);
  const bar = mod.bar(COLORS);
  assert.deepEqual(barIds(mod), ["copilot"]);
  assert.deepEqual(visible(bar).filter((text) => /\d/.test(text)), ["90%", "+2"],
    "one number, then a count of the other providers");
  assert.equal(nodes(bar).filter((node) => node.id?.startsWith("fleet-bar-provider-")).length, 1);
});

test("a window with capacity left never reads as fully used, and tiny use reads as <1", () => {
  const mod = loaded([exactHost(exactRow("claude", 0.5), exactRow("codex", 99.6))]);
  const panel = mod.panel(COLORS);
  assert.equal(byId(panel, "fleet-window-pct-0-0-0").text[0], "99.5% used");
  assert.equal(byId(panel, "fleet-window-fill-0-0-0").props.w, "99.5%");
  assert.equal(byId(panel, "fleet-window-pct-0-1-0").text[0], "<1% used");
  const tiny = parseFloat(byId(panel, "fleet-window-fill-0-1-0").props.w);
  assert.ok(tiny > 0 && tiny < 1, "the meter keeps the tiny use it reports");
  assert.equal(byId(mod.bar(COLORS), "fleet-bar-used").text[0], "99.5%", "the badge keeps the exact value too");
});

test("the meter fills to the exact used percent and labels it", () => {
  const mod = loaded([exactHost(exactRow("claude", 26))]);
  const panel = mod.panel(COLORS);
  assert.equal(byId(panel, "fleet-window-fill-0-0-0").props.w, "74%");
  assert.equal(byId(panel, "fleet-window-pct-0-0-0").text[0], "74% used");
  assert.equal(byId(panel, "fleet-window-track-0-0-0").props.accessibility_label, "Week: 74% of the quota used");
});

test("overview chips show each provider's own used percentage", () => {
  const mod = loaded([host(null, [
    { id: "claude", limits: [{ label: "Week", percent: 0.74 }] },
    { id: "codex", balance: { remaining: 30, currency: "USD" } },
  ])]);
  const overview = byId(mod.panel(COLORS), "fleet-overview");
  assert.deepEqual(visible(byId(overview, "fleet-available-claude")), ["Claude 74%"]);
  assert.deepEqual(visible(byId(overview, "fleet-available-codex")), ["Codex"], "no percentage, so only the name");
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
  assert.equal(byId(panel, "fleet-window-fill-0-0-0"), undefined, "a stale window has no filled meter");
  assert.ok(!visible(panel).some((text) => text.includes("% used")), "a stale window shows no percentage");
  assert.ok(visible(byId(panel, "fleet-window-0-0-0")).includes("No live reading"));
  assert.ok(visible(byId(panel, "fleet-window-0-0-0")).includes("saved just now"));
  for (const full of [name, row.accountLabel, row.windows[0].label]) {
    assert.ok(nodes(panel).some((node) => node.props.tooltip === full && node.props.accessibility_label === full));
  }
  assert.ok(nodes(panel).some((node) => node.props.tooltip === new Date(now).toLocaleString()));
});

test("a stale window reads as saved history while a fresh window keeps its percentage", () => {
  const now = Date.now();
  const mod = loaded([
    host("old", [{ id: "claude", limitsStale: true, limits: [{ label: "Week", percent: 0 }] }], now),
    host("live", [{ id: "codex", limits: [{ label: "Month", percent: 0.4 }] }], now),
  ]);
  const panel = mod.panel(COLORS);
  const stale = byId(panel, "fleet-window-pct-0-0-0");
  assert.deepEqual(stale.text, ["No live reading"]);
  assert.ok(!stale.text.some((text) => text.includes("% used")));
  assert.equal(stale.props.text_color, COLORS.muted);
  assert.equal(stale.props.tooltip, "last saved: 0% used");
  assert.equal(stale.props.accessibility_label, "last saved: 0% used");
  assert.equal(byId(panel, "fleet-window-fill-0-0-0"), undefined, "an empty track never looks full");
  assert.ok(byId(panel, "fleet-window-track-0-0-0"), "the track itself stays visible");
  assert.ok(visible(byId(panel, "fleet-window-0-0-0")).includes("saved just now"));
  const fresh = byId(panel, "fleet-window-pct-1-0-0");
  assert.deepEqual(fresh.text, ["40% used"]);
  assert.equal(byId(panel, "fleet-window-fill-1-0-0").props.w, "40%");
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
  assert.ok(!visible(panel).some((text) => text.includes("% used")), "a failed read cannot report a live percentage");
  assert.ok(visible(panel).includes("No live reading"));
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
    const panel = mod.panel(COLORS);
    assert.ok(visible(panel).includes("Saved quota reading is stale"));
    assert.ok(!visible(panel).some((text) => text.includes("% used")), "an expired reading is not a live percentage");
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
  assert.ok(visible(panel).includes("99.6% used"));
  assert.ok(visible(panel).includes("Quota reading time unknown"));
  assert.ok(visible(panel).includes("offline"));
});
