// The redesigned fleet-quota bar and dialog, against fake gpui-kit, gpui-base,
// herdr and backend modules. These tests record what the builders were asked
// for: the 118 px bar, provider glyphs, meter widths and unknown readings, the
// pills and timestamps a host or account carries, and the controls that still
// read and close exactly as before. The backend's own readings belong to its
// tests.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const sourceMod = path.join(repo, "mods/fleet-quota");

const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const READ_AT = NOW - 2 * 60 * 1000;
const CLAUDE_UPDATED = iso(-5 * 60 * 1000);
const RESET_LATER = iso(2 * 60 * 60 * 1000);
const RESET_LATER_OTHER = iso(30 * 60 * 60 * 1000);

// Four machines: one reading with known and unknown providers, one offline,
// one that answered with nothing, one that failed and kept what it read
// before. Unknown (null) and zero (0) readings sit next to each other.
const HOSTS = [
  {
    name: null,
    label: "This computer",
    status: "ok",
    errors: 0,
    lastSuccessAt: READ_AT,
    rows: [
      {
        id: "claude",
        accountLabel: "Work",
        accountActive: true,
        updatedAt: CLAUDE_UPDATED,
        used: 42,
        stale: false,
        windows: [
          { label: "5-hour", used: 42, resetsAt: RESET_LATER },
          { label: "tiny", used: 1, resetsAt: "" },
          { label: "week", used: null, resetsAt: null },
          { label: "expired", used: null, resetsAt: "2000-01-01T00:00:00Z" },
        ],
      },
      { id: "claude", accountLabel: "Personal", used: null, stale: true, windows: [] },
      {
        id: "openrouter",
        used: 40,
        stale: false,
        windows: [{ label: "Key limit", used: 40, resetsAt: RESET_LATER_OTHER }],
      },
      {
        id: "fireworks",
        used: null,
        stale: false,
        windows: [{ label: "Balance 25.00 USD", used: null, isBalance: true }],
      },
    ],
  },
  { name: "ax42", label: "ax42", status: "offline", errors: 0, lastSuccessAt: null, rows: [] },
  { name: "vps-tmp", label: "vps-tmp", status: "no-data", errors: 0, lastSuccessAt: READ_AT, rows: [] },
  {
    name: "ops",
    label: "ops",
    status: "error",
    errors: 2,
    truncated: 1,
    truncatedWindows: 1,
    lastSuccessAt: READ_AT,
    rows: [
      {
        id: "codex",
        used: 80,
        stale: true,
        windows: [{ label: "week", used: 80, resetsAt: "not a date" }],
      },
      {
        id: "copilot",
        updatedAt: iso(-10 * 60 * 1000),
        used: 0,
        stale: false,
        windows: [{ label: "Premium credits", used: 0, resetsAt: RESET_LATER }],
      },
      {
        id: "agy",
        used: null,
        stale: false,
        windows: [{ label: "Session", used: null, resetsAt: "not a date" }],
      },
      {
        id: "openrouter",
        used: null,
        stale: true,
        incomplete: true,
        windows: [{ label: "Window", used: 10 }],
      },
      {
        id: "someone",
        used: 10,
        stale: false,
        windows: [{ label: "Window", used: 10 }],
      },
    ],
  },
];

const COLORS = {
  background: "#111",
  canvas: "#0a0a0a",
  chrome: "#141414",
  surface: "#181818",
  popover: "#1c1c1c",
  raised: "#202020",
  hover: "#262626",
  selected: "#2a2a2a",
  border: "#303030",
  input: "#3a3a3a",
  foreground: "#eee",
  muted: "#aaa",
  dim: "#777",
  accent: "#78a9ff",
  blocked: "#ff6b6b",
  done: "#5fbf77",
  unknown: "#888",
  working: "#e0b341",
  idle: "#9a9a9a",
  ansi3: "#e6ad62",
  ansi4: "#6d9eef",
  ansi5: "#b595e9",
  ansi6: "#64cbb6",
  ansi13: "#ea96bc",
};

// Every fluent method the mod uses, recorded with the value it was given, so a
// test can assert on the meter width, the icon path and the bar width without
// asserting the exact look.
const BUILDER_METHODS = [
  "size", "size_full", "h_full", "w", "h", "flex_1", "flex_none", "flex_shrink",
  "min_w", "min_h", "items_center", "justify_between", "justify_end", "justify_center", "gap",
  "p", "px", "py", "pt", "pb", "pl", "rounded", "bg", "border", "border_b",
  "border_color", "text_size", "text_color", "truncate", "font_semibold",
  "font_medium", "overflow_y_scrollbar", "overflow_hidden", "cursor_pointer",
  "max_w", "line_height", "flex_wrap", "border_l", "border_t", "opacity", "text_right",
];

function element(kind) {
  const node = { kind, id: null, text: [], children: [], props: {}, handlers: {} };
  const api = {
    node,
    id(value) {
      node.id = value;
      return api;
    },
    child(child) {
      if (child === null || child === undefined || child === false) return api;
      if (typeof child === "string") node.text.push(child);
      else node.children.push(child);
      return api;
    },
    children(list) {
      for (const child of list ?? []) api.child(child);
      return api;
    },
    when(condition, draw) {
      if (condition) draw(api);
      return api;
    },
    on_click(handler) {
      node.handlers.click = handler;
      return api;
    },
    on_mouse_down(button, handler) {
      node.handlers[`mouse_down_${button}`] = handler;
      return api;
    },
    on_hover() {
      return api;
    },
    hover() {
      return api;
    },
    tooltip(value) {
      node.props.tooltip = value;
      return api;
    },
    role(value) {
      node.props.role = value;
      return api;
    },
    accessibility_label(value) {
      node.props.label = value;
      return api;
    },
  };
  for (const name of BUILDER_METHODS) {
    api[name] = (value) => {
      node.props[name] = value === undefined ? true : value;
      return api;
    };
  }
  return api;
}

function nodes(node, found = []) {
  if (node === null || node === undefined || typeof node === "string") return found;
  node = node.node ?? node;
  found.push(node);
  for (const child of node.children) nodes(child, found);
  return found;
}

function texts(node) {
  return nodes(node).flatMap((value) => {
    const lines = [];
    if (value.props?.label) lines.push(value.props.label);
    if (value.props?.tooltip) lines.push(value.props.tooltip);
    lines.push(...value.text);
    return lines;
  });
}

function byId(node, id) {
  return nodes(node).find((value) => value.id === id) ?? null;
}

function makeCx() {
  const cx = {
    notified: 0,
    tasks: [],
    timers: [],
    focus_handle: () => ({ focus() {} }),
    notify() {
      cx.notified += 1;
    },
    spawn(task) {
      cx.tasks.push(task);
    },
    timer: {
      every(ms, task) {
        cx.timers.push({ ms, task });
      },
    },
  };
  return cx;
}

// The tasks init started, in order, as the app runs them.
async function flush(cx) {
  while (cx.tasks.length) {
    const batch = cx.tasks.splice(0);
    for (const task of batch) await task(cx);
  }
}

function installHerdr(overrides = {}) {
  const calls = { hc: [], exec: [], overlays: [], closed: [] };
  globalThis.__herdr = {
    checking: false,
    props: { part: "bar" },
    theme: COLORS,
    hc: async (args) => {
      calls.hc.push(args);
      return { code: 1, stdout: "", stderr: "no answer was set" };
    },
    exec: async (...args) => {
      calls.exec.push(args);
      return { code: 1, stdout: "", stderr: "no answer was set" };
    },
    openOverlay: (spec) => {
      calls.overlays.push(spec);
      return "fleet-quota-overlay";
    },
    closeOverlay: (id) => calls.closed.push(id),
    ...overrides,
  };
  return calls;
}

function installFleet(read) {
  const calls = { inputs: [] };
  globalThis.__fleet = (input) => {
    calls.inputs.push(input);
    return read(input);
  };
  return calls;
}

let Mod;
let RealMod;

async function stubPackage(name, source) {
  const dir = path.join(globalThis.__harness, "node_modules", name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, type: "module", main: "index.js" }),
  );
  await fsp.writeFile(path.join(dir, "index.js"), source);
}

before(async () => {
  globalThis.__kit = { View: class View {}, element };
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fleet-quota-ui-"));
  globalThis.__harness = root;
  globalThis.__harnessRoot = root;

  const app = path.join(root, "fleet-quota");
  await fsp.mkdir(app, { recursive: true });
  await fsp.writeFile(path.join(app, "package.json"), JSON.stringify({ type: "module" }));
  await fsp.copyFile(path.join(sourceMod, "main.js"), path.join(app, "main.js"));
  // This copy isolates UI behavior from the reader.
  await fsp.writeFile(
    path.join(app, "fleet.js"),
    "export async function collectFleet(input) {\n  return globalThis.__fleet(input);\n}\n",
  );
  await fsp.writeFile(
    path.join(app, "model.js"),
    'export const READ_SCRIPT = "model-quota-read";\n',
  );

  await stubPackage(
    "gpui-kit",
    'const kit = globalThis.__kit;\nexport const View = kit.View;\nexport const div = () => kit.element("div");\n'
      + 'export const svg = (path) => {\n  const node = kit.element("svg");\n  node.node.props.path = path;\n  return node;\n};\n',
  );
  await stubPackage(
    "gpui-base",
    'const kit = globalThis.__kit;\nexport const h_flex = () => kit.element("h_flex");\nexport const v_flex = () => kit.element("v_flex");\n',
  );
  await stubPackage(
    "herdr",
    [
      "const app = () => globalThis.__herdr;",
      "export const checking = () => app().checking;",
      "export const props = () => app().props;",
      "export const theme = () => app().theme;",
      "export const hc = (...args) => app().hc(...args);",
      "export const exec = (...args) => app().exec(...args);",
      "export const openOverlay = (spec) => app().openOverlay(spec);",
      "export const closeOverlay = (id) => app().closeOverlay(id);",
      "",
    ].join("\n"),
  );

  Mod = (await import(path.join(app, "main.js"))).default;

  const actual = path.join(root, "fleet-quota-real");
  await fsp.mkdir(actual, { recursive: true });
  await fsp.writeFile(path.join(actual, "package.json"), JSON.stringify({ type: "module" }));
  for (const file of ["main.js", "fleet.js", "model.js"]) {
    await fsp.copyFile(path.join(sourceMod, file), path.join(actual, file));
  }
  RealMod = (await import(path.join(actual, "main.js"))).default;
});

after(async () => {
  if (globalThis.__harnessRoot) {
    await fsp.rm(globalThis.__harnessRoot, { recursive: true, force: true });
  }
});

test("a check renders both parts and starts no reads, timers or commands", async () => {
  const calls = installHerdr({ checking: true });
  const fleet = installFleet(() => {
    throw new Error("collectFleet must not run during a check");
  });

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "bar" }, cx);

  assert.equal(cx.tasks.length, 0, "no read may start during a check");
  assert.equal(cx.timers.length, 0, "no timer may start during a check");
  assert.equal(fleet.inputs.length, 0);
  assert.equal(calls.hc.length, 0, "a check may not run hc");
  assert.equal(calls.exec.length, 0, "a check may not run exec");

  const bar = texts(mod.render(cx));
  assert.ok(bar.includes("AI —"), "the bar draws before any reading");
  assert.ok(bar.some((line) => line.includes("No percentage available")));

  globalThis.__herdr.props = { part: "panel" };
  const tree = mod.render(cx);
  const panel = texts(tree);
  assert.ok(panel.includes("Fleet quota"));
  assert.ok(panel.includes("No machines read yet"));
  assert.ok(byId(tree, "fleet-refresh"), "the refresh control is drawn");
  assert.ok(byId(tree, "fleet-close"), "the close control is drawn");
  assert.ok(
    !nodes(tree).some((value) => value.kind === "svg" && value.props.path.endsWith("clock.svg")),
    "nothing is stamped as read before the first read",
  );
});

test("the 118 px bar keeps its highest reading and opens the dialog", async () => {
  const calls = installHerdr({ props: { part: "bar" } });
  const fleet = installFleet(async () => ({ hosts: HOSTS, discoveryError: null }));

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "bar" }, cx);

  assert.equal(cx.tasks.length, 1, "init reads once");
  assert.equal(cx.timers.length, 1);
  assert.equal(cx.timers[0].ms, 60000, "and reads again every minute");
  assert.equal(calls.hc.length, 0, "only collectFleet may reach hc");

  await flush(cx);
  assert.equal(fleet.inputs.length, 1);
  const input = fleet.inputs[0];
  assert.deepEqual(input.previous, [], "the first read has nothing before it");
  assert.equal(input.concurrency, 4);
  assert.equal(typeof input.now, "number");
  assert.equal(typeof input.listMachines, "function");
  assert.equal(typeof input.readHost, "function");

  const tree = mod.render(cx);
  const bar = byId(tree, "fleet-quota-bar");
  assert.ok(bar, "the bar has an id to click");
  assert.equal(bar.props.w, 118, "the installed layout still gives the bar 118 px");
  assert.equal(bar.props.role, "button");
  assert.match(bar.props.label, /1 of 4 machines with readings/);
  assert.match(bar.props.label, /Some machines or quota percentages are unavailable/);
  assert.ok(texts(tree).includes("AI 80%~!"), "the highest value is marked old and incomplete");
  assert.equal(
    nodes(tree).filter((value) => value.kind === "svg" && value.props.path.endsWith("chevron-right.svg")).length,
    1,
    "the bar carries its own chevron instead of a font glyph",
  );

  bar.handlers.click(null, { stop_propagation() {} });
  assert.deepEqual(calls.overlays.at(-1), {
    mod: "fleet-quota",
    kind: "dialog",
    width: 620,
    height: 560,
    props: { part: "panel" },
  });
});

test("the dialog lists every host compactly, with names, icons, pills and hints", async () => {
  const calls = installHerdr({ props: { part: "panel", overlay: "quota-dialog" } });
  const fleet = installFleet(async () => ({ hosts: HOSTS, discoveryError: null }));

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "panel" }, cx);
  await flush(cx);

  const tree = mod.render(cx);
  const shown = texts(tree);
  for (const label of ["This computer", "ax42", "vps-tmp", "ops"]) {
    assert.ok(shown.includes(label), `${label} has its own line`);
  }
  // Statuses stay words, now pills rather than loose text.
  for (const word of ["read", "offline", "no data", "error"]) {
    assert.ok(shown.includes(word), `a host is marked ${word}`);
  }
  assert.ok(shown.includes("2 unreadable or omitted"), "a host counts incomplete readings as a pill");
  assert.ok(shown.includes("old reading"), "kept data is marked in the host header");
  assert.ok(shown.includes("Some accounts omitted: limit 16 per provider."));
  assert.ok(shown.includes("Some quota windows omitted: limit 20 per account."));
  assert.ok(shown.includes("incomplete"), "an incomplete account is marked");
  assert.ok(shown.includes("old"), "a stale account is marked");
  assert.ok(shown.includes("active"), "the active account is marked");

  // Provider names read as names, with a glyph beside each.
  for (const name of ["Claude", "Codex", "GitHub Copilot", "OpenRouter", "Antigravity"]) {
    assert.ok(shown.includes(name), `${name} is spelled out`);
  }
  assert.ok(shown.includes("someone"), "an unknown provider keeps its id");
  const paths = nodes(tree).filter((value) => value.kind === "svg").map((value) => value.props.path);
  assert.ok(paths.includes("icons/claude.svg"), "Claude uses Herdr's own glyph");
  assert.ok(paths.includes("icons/codex.svg"));
  assert.ok(paths.includes("icons/copilot.svg"));
  assert.ok(paths.includes("icons/antigravity.svg"));
  assert.ok(paths.includes("mods/fleet-quota/icons/provider.svg"), "unknown and generic providers use the bundled outline");

  // Hosts say where they are and keep their own freshness.
  assert.ok(paths.includes("mods/fleet-quota/icons/desktop.svg"), "the local machine has a desktop mark");
  assert.ok(paths.includes("mods/fleet-quota/icons/server.svg"), "a remote machine has a server mark");
  assert.ok(shown.some((line) => line.startsWith("read ")), "a read time is a short hint");
  assert.ok(
    nodes(tree).some((value) => value.props.tooltip === new Date(CLAUDE_UPDATED).toLocaleString()),
    "the record hint keeps its exact timestamp in the tooltip",
  );
  const offline = byId(tree, "fleet-host-1");
  assert.ok(offline, "the offline host is on screen");
  assert.ok(
    !texts(offline).some((line) => line.startsWith("read ")),
    "a host that never answered gets no made-up read time",
  );

  // Each account keeps its own windows.
  assert.ok(shown.includes("Work"));
  assert.ok(shown.includes("Personal"));
  assert.ok(shown.includes("No quota reported."));
  assert.ok(shown.includes("Balance 25.00 USD"));
  assert.ok(shown.includes("no percentage"));
  assert.ok(shown.includes("5-hour"));
  assert.ok(shown.includes("42% used"));
  assert.ok(shown.includes("1% used"), "an integer one is one percent, not 100");
  assert.ok(shown.includes("80% used"));
  assert.ok(shown.includes("? used"), "an unknown reading is not zero");
  assert.ok(shown.includes("0% used"), "a zero reading is still shown as zero");
  assert.ok(shown.includes("resets ?"), "an unknown reset is not a time");
  assert.ok(shown.includes("reset passed"), "expired cached windows are labelled explicitly");
  assert.ok(shown.some((line) => line.startsWith("record ")), "the source record is a short hint");
  // Readings stay inside the host that reported them.
  const local = texts(byId(tree, "fleet-host-0"));
  assert.ok(local.includes("Claude"));
  assert.ok(!texts(byId(tree, "fleet-host-1")).includes("Claude"), "an offline host inherits no other host's providers");
  assert.ok(
    shown.some((line) => line.includes("nothing here is added up")),
    "the footer says the readings are not summed",
  );

  const refresh = byId(tree, "fleet-refresh");
  assert.equal(refresh.props.role, "button");
  assert.match(refresh.props.label, /Reread/);
  const close = byId(tree, "fleet-close");
  assert.equal(close.props.role, "button");
  assert.match(close.props.label, /Close fleet quota/);

  const before = fleet.inputs.length;
  refresh.handlers.click(null, cx);
  await flush(cx);
  assert.equal(fleet.inputs.length, before + 1, "the refresh control reads again");

  byId(tree, "fleet-close").handlers.click();
  assert.deepEqual(calls.closed, ["quota-dialog"]);
});

test("meters show zero as zero, unknown as unknown, and old apart from current", async () => {
  installHerdr({ props: { part: "panel" } });
  installFleet(async () => ({ hosts: HOSTS, discoveryError: null }));

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "panel" }, cx);
  await flush(cx);

  const tree = mod.render(cx);
  const current = byId(tree, "fleet-window-fill-0-0-0");
  assert.ok(current, "a current window has a fill");
  assert.equal(current.props.w, "42%");
  assert.equal(current.props.h_full, true);

  const tiny = byId(tree, "fleet-window-fill-0-0-1");
  assert.ok(tiny, "one percent is still a fill");
  assert.equal(tiny.props.w, "1%");

  assert.equal(byId(tree, "fleet-window-fill-0-0-2"), null, "an unknown percentage draws no fill");
  assert.equal(byId(tree, "fleet-window-fill-0-3-0"), null, "an unmetered balance draws no fill");

  const zero = byId(tree, "fleet-window-fill-3-1-0");
  assert.ok(zero, "a real zero draws its own fill, not nothing");
  assert.equal(zero.props.w, "0%");

  const stale = byId(tree, "fleet-window-fill-3-0-0");
  assert.ok(stale, "an old reading keeps its meter");
  assert.equal(stale.props.w, "80%");
  assert.ok(stale.props.opacity < current.props.opacity, "old fills are subdued without losing provider color");
  assert.notEqual(stale.props.bg, COLORS.dim, "old readings must not become gray");

  const track = byId(tree, "fleet-window-track-0-0-2");
  assert.equal(track.props.role, "progress_indicator");
  assert.match(track.props.label, /percentage unavailable, not zero/);
  assert.match(byId(tree, "fleet-window-track-0-3-0").props.label, /no percentage available/);
  assert.match(byId(tree, "fleet-window-track-3-1-0").props.label, /0 percent used/);

  const percentCells = nodes(tree).filter((value) => String(value.id).startsWith("fleet-window-pct-"));
  assert.ok(percentCells.length >= 8, "every window has a percentage cell");
  assert.equal(new Set(percentCells.map((value) => value.props.w)).size, 1, "percentage cells share one width");
});

test("provider identity survives old records and switches with the theme", () => {
  installHerdr({ checking: true });
  const mod = new Mod();
  mod.init({}, makeCx());
  const light = {
    ...COLORS, canvas: "#ffffff", surface: "#f8f8f8", raised: "#eeeeee", foreground: "#111111",
    muted: "#555555", ansi3: "#8b5100", ansi4: "#244fab", ansi5: "#7143a0",
    ansi6: "#096e62", ansi13: "#a02c6b", accent: "#125dc1",
  };
  for (const t of [COLORS, light]) {
    for (const [id, token] of [["claude", "ansi3"], ["codex", "ansi6"], ["copilot", "ansi5"],
      ["openrouter", "ansi4"], ["agy", "ansi13"], ["someone", "accent"]]) {
      const row = { id, used: 42, updatedAt: CLAUDE_UPDATED, windows: [{ label: "Quota", used: 42 }] };
      const current = mod.provider(t, row, 0, 0, NOW);
      const old = mod.provider(t, { ...row, stale: true }, 0, 0, NOW);
      assert.equal(byId(old, "fleet-provider-0-0").props.border_color, t[token]);
      assert.equal(byId(current, "fleet-window-fill-0-0-0").props.bg, t[token]);
      assert.equal(byId(old, "fleet-window-fill-0-0-0").props.bg, t[token], "old does not erase identity");
      assert.ok(texts(current).includes("current"));
      assert.ok(!texts(current).includes("old"));
      assert.ok(texts(old).includes("old"));
      assert.ok(!texts(old).includes("current"));
      assert.match(byId(old, "fleet-window-track-0-0-0").props.label, /earlier reading/);
      assert.ok(nodes(old).some((node) => node.props.bg === t[token]
        && nodes(node).some((child) => child.kind === "svg")), "provider icon has a colored tile");
    }
  }
});

test("warning thresholds emphasize reported usage without recoloring provider identity", () => {
  const mod = new Mod();
  for (const [used, expected] of [[0, COLORS.ansi6], [79, COLORS.ansi6], [80, COLORS.working],
    [94, COLORS.working], [95, COLORS.blocked], [100, COLORS.blocked]]) {
    for (const stale of [false, true]) {
      const tree = mod.provider(COLORS, { id: "codex", used, stale, windows: [{ label: "Week", used }] }, 0, 0, NOW);
      assert.equal(byId(tree, "fleet-window-fill-0-0-0").props.bg, expected);
      assert.equal(byId(tree, "fleet-provider-0-0").props.border_color, COLORS.ansi6);
      assert.ok(texts(tree).includes(stale ? "old" : "current"));
    }
  }
});

test("a known maximum does not hide an unknown window in the same row", () => {
  installHerdr({ checking: true });
  const mod = new Mod();
  mod.init({}, makeCx());
  const row = { id: "openrouter", used: 40, stale: false, windows: [] };
  mod.hosts = [{ name: null, label: "This computer", status: "ok", errors: 0, rows: [row] }];
  for (const unknown of [
    { label: "Balance 25.00 USD", used: null, isBalance: true },
    { label: "Expired window", used: null, resetsAt: "2000-01-01T00:00:00Z" },
  ]) {
    row.windows = [{ label: "Key limit", used: 40 }, unknown];
    assert.equal(mod.summary().incomplete, true);
    assert.ok(texts(mod.bar(COLORS)).includes("AI 40%!"));
    const panel = mod.panel(COLORS);
    assert.ok(texts(byId(panel, "fleet-highest")).includes("40%"));
    assert.ok(texts(byId(panel, "fleet-coverage")).includes("! incomplete"));
    assert.ok(!texts(byId(panel, "fleet-host-0")).includes("error"));
    assert.equal(byId(panel, "fleet-window-fill-0-0-1"), null);
  }
  row.windows = [{ label: "Key limit", used: 40 }, { label: "Unused window", used: 0 }];
  assert.equal(mod.summary().incomplete, false, "known zero is complete coverage");
  assert.ok(texts(mod.bar(COLORS)).includes("AI 40%"));
  row.used = 0;
  row.windows = [{ label: "Unused window", used: 0 }];
  assert.equal(mod.summary().incomplete, false);
  assert.ok(texts(mod.bar(COLORS)).includes("AI 0%"));
});

test("summary reports a maximum and coverage separately, never a combined quota", () => {
  installHerdr({ checking: true });
  const mod = new Mod();
  mod.init({}, makeCx());
  const first = { name: "a", label: "a", status: "ok", errors: 0,
    rows: [{ id: "claude", accountLabel: "Work", used: 60, windows: [{ used: 60 }] }] };
  const second = { name: "b", label: "b", status: "ok", errors: 0,
    rows: [{ id: "codex", used: 20, stale: true, windows: [{ used: 20 }] }] };
  mod.hosts = [first, second];
  let tree = mod.panel(COLORS);
  assert.ok(texts(byId(tree, "fleet-highest")).includes("60%"));
  assert.ok(!texts(byId(tree, "fleet-highest")).includes("80%"));
  assert.ok(texts(byId(tree, "fleet-highest")).includes("Claude · a · Work"));
  assert.ok(texts(byId(tree, "fleet-highest")).includes("current"));
  assert.ok(texts(byId(tree, "fleet-coverage")).includes("2 / 2"));
  assert.ok(texts(mod.bar(COLORS)).includes("AI 60%"), "an old lower row does not mark the maximum old");

  first.rows[0].stale = true;
  first.rows.push({ id: "openrouter", used: null, windows: [{ label: "Balance", isBalance: true, used: null }] });
  tree = mod.panel(COLORS);
  assert.ok(texts(byId(tree, "fleet-highest")).includes("old"));
  assert.ok(texts(byId(tree, "fleet-coverage")).includes("! incomplete"));
  assert.ok(texts(mod.bar(COLORS)).includes("AI 60%~!"));
  assert.ok(!texts(byId(tree, "fleet-coverage")).includes("error"), "an unmetered balance is not a provider error");

  mod.hosts = [{ ...first, rows: [{ id: "openrouter", used: null, windows: [{ isBalance: true, used: null }] }] }];
  tree = mod.panel(COLORS);
  assert.ok(texts(byId(tree, "fleet-highest")).includes("—"));
  assert.ok(!texts(byId(tree, "fleet-highest")).includes("0%"));
  assert.equal(byId(tree, "fleet-window-fill-0-0-0"), null);
});

test("unknown prototype-like provider ids and long labels preserve their actual identity", () => {
  const mod = new Mod();
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const accountLabel = "Long account ".repeat(20);
    const label = "A quota window with a very long label ".repeat(10);
    const hostLabel = "host-".repeat(30);
    const tree = mod.host(COLORS, { name: hostLabel, label: hostLabel, status: "offline",
      rows: [{ id, accountLabel, used: 25, windows: [{ label, used: 25 }] }] }, 0, NOW);
    assert.ok(texts(tree).includes(id));
    assert.ok(nodes(tree).some((node) => node.props.path === "mods/fleet-quota/icons/provider.svg"));
    for (const fullLabel of [id, accountLabel, label, hostLabel]) {
      assert.ok(nodes(tree).some((node) => node.props.tooltip === fullLabel && node.props.label === fullLabel));
    }
    assert.ok(texts(tree).includes("offline"));
    assert.ok(texts(tree).includes("old"), "a carried row is old even if the row flag is absent");
    assert.ok(!texts(tree).includes("current"));
    assert.ok(texts(tree).includes("25% used"));
  }
});

test("reset hints stay short without Intl and timestamps never invent freshness", () => {
  const mod = new Mod();
  const now = new Date(2026, 10, 16, 10, 0).getTime();
  const future = new Date(2026, 10, 18, 14, 5);
  const row = { id: "claude", used: 42, windows: [{ label: "Week", used: 42, resetsAt: future.toISOString() }] };
  const originalDate = Date.prototype.toLocaleDateString;
  const originalTime = Date.prototype.toLocaleTimeString;
  try {
    Date.prototype.toLocaleDateString = () => "UNSUPPORTED DATE OPTIONS";
    Date.prototype.toLocaleTimeString = () => "UNSUPPORTED TIME OPTIONS";
    const tree = mod.provider(COLORS, { ...row, updatedAt: new Date(2026, 10, 1).toISOString(), stale: true }, 0, 0, now);
    assert.ok(texts(tree).includes("resets Nov 18 · 14:05"));
    assert.ok(texts(tree).includes("record Nov 1"));
    assert.ok(nodes(tree).some((node) => node.props.tooltip === future.toLocaleString()));
    assert.ok(!texts(tree).some((text) => text.includes("UNSUPPORTED")));
  } finally {
    Date.prototype.toLocaleDateString = originalDate;
    Date.prototype.toLocaleTimeString = originalTime;
  }
  for (const resetsAt of [null, "", "not-a-date"]) {
    assert.ok(texts(mod.window(COLORS, { used: null, resetsAt }, row, 0, 0, 0, now)).includes("resets ?"));
  }
  assert.ok(texts(mod.window(COLORS, { used: null, resetsAt: now - 1 }, row, 0, 0, 0, now)).includes("reset passed"));
  const futureRecord = mod.provider(COLORS, { ...row, stale: true, updatedAt: future.toISOString() }, 0, 0, now);
  assert.ok(texts(futureRecord).includes("record future timestamp"));
  assert.ok(!texts(futureRecord).includes("record just now"));
  const missing = mod.provider(COLORS, { ...row, stale: true, updatedAt: "" }, 0, 0, now);
  assert.ok(texts(missing).includes("Record time unknown"));
});

test("a failed reading keeps the hosts on screen and says so", async () => {
  installHerdr({ props: { part: "panel" } });
  let answer = { hosts: HOSTS, discoveryError: null };
  installFleet(async () => answer);

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "panel" }, cx);
  await flush(cx);

  answer = { hosts: HOSTS, discoveryError: "hc machine ls: exit 1" };
  mod.refresh(cx);
  await flush(cx);

  const shown = texts(mod.render(cx));
  assert.ok(shown.includes("This computer"), "the earlier reading stays");
  assert.ok(shown.includes("Couldn't list every machine; showing what was read before."));

  installFleet(async () => {
    throw new Error("Couldn't read the fleet.");
  });
  mod.refresh(cx);
  await flush(cx);
  const after = texts(mod.render(cx));
  assert.ok(after.includes("This computer"));
  assert.ok(after.includes("Couldn't read the fleet."));
});

test("a read in flight keeps the next one from starting", async () => {
  installHerdr({ props: { part: "bar" } });
  const fleet = installFleet(() => new Promise(() => {}));

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "bar" }, cx);
  mod.refresh(cx);
  mod.refresh(cx);

  assert.equal(cx.tasks.length, 1, "one read at a time, however often it's asked");
  cx.tasks[0](cx);
  assert.equal(fleet.inputs.length, 1);
});

test("machines come from hc and readings from the one fixed script", async () => {
  const calls = installHerdr({ props: { part: "bar" } });
  const fleet = installFleet(async () => ({ hosts: [], discoveryError: null }));

  const mod = new Mod();
  const cx = makeCx();
  mod.init({ part: "bar" }, cx);
  await flush(cx);
  const { listMachines, readHost } = fleet.inputs[0];

  const machines = [
    { name: "ax42", state: "connected", target: "ax42.lan" },
    { name: "sandbox-7", state: "connected", target: "10.0.0.7", temporary: true },
  ];
  globalThis.__herdr.hc = async (args) => {
    calls.hc.push(args);
    return { code: 0, stdout: JSON.stringify({ machines }), stderr: "" };
  };
  assert.deepEqual(await listMachines(), machines, "remote and temporary connections alike");
  assert.deepEqual(calls.hc.at(-1), ["machine", "ls", "--json"]);

  globalThis.__herdr.hc = async () => ({ code: 1, stdout: "", stderr: "token=abc123" });
  await assert.rejects(listMachines(), (error) => {
    assert.ok(!String(error.message).includes("abc123"), "stderr stays inside");
    return true;
  });

  globalThis.__herdr.hc = async () => ({ code: 0, stdout: JSON.stringify({ machines: "nope" }) });
  await assert.rejects(listMachines(), /machine list/);

  const reading = '{"quotaMeta":{"refreshIntervalSec":300}}\n{"id":"claude"}\n';
  globalThis.__herdr.exec = async (...args) => {
    calls.exec.push(args);
    return { code: 0, stdout: reading, stderr: "" };
  };
  assert.deepEqual(await readHost("ax42; rm -rf ~"), { code: 0, stdout: reading, stderr: "" });
  const [command, argv, options] = calls.exec.at(-1);
  assert.equal(command, "sh");
  assert.deepEqual(argv, ["-c", "model-quota-read"], "the host never goes into the script");
  assert.deepEqual(options, { on: "ax42; rm -rf ~", timeout: 8000 });

  globalThis.__herdr.exec = async () => ({
    code: 2,
    stdout: "",
    stderr: "/home/me/.config/token: abc123",
  });
  assert.equal((await readHost("ax42")).code, 2, "the backend classifies the exit code");
});

test("every bundled icon is a 24-unit outline the mod can reference", async () => {
  for (const name of ["gauge", "desktop", "server", "refresh", "close", "chevron-right", "provider", "clock"]) {
    const file = path.join(sourceMod, "icons", `${name}.svg`);
    const svg = await fsp.readFile(file, "utf8");
    assert.match(svg, /viewBox="0 0 24 24"/, `${name}.svg keeps a 24-unit viewBox`);
    assert.match(svg, /currentColor/, `${name}.svg follows the surrounding text color`);
  }
});

test("the redesigned panel consumes the real backend's readings", async () => {
  const reads = [];
  installHerdr({
    props: { part: "bar" },
    hc: async () => ({ code: 0, stdout: JSON.stringify({ machines: [
      { name: "online", state: "connected" },
      { name: "offline", state: "disconnected" },
      { name: "missing-jq", state: "connected" },
    ] }) }),
    exec: async (_command, _args, options) => {
      reads.push(options.on);
      if (options.on === null) return { code: 4, stdout: "" };
      if (options.on === "missing-jq") return { code: 5, stdout: "", stderr: "secret must not be shown" };
      return { code: 0, stdout: [
        JSON.stringify({ quotaMeta: { refreshIntervalSec: 300 } }),
        JSON.stringify({ id: "copilot", updatedAt: new Date().toISOString(), limits: [{ percent: 0.9 }], accounts: [
          { label: "Work", active: true, limits: [{ label: "Credits", percent: 0.01 }] },
          { label: "Personal", limits: [] },
        ] }),
      ].join("\n") };
    },
  });
  const mod = new RealMod();
  const cx = makeCx();
  mod.init({ part: "bar" }, cx);
  await flush(cx);
  assert.deepEqual(reads, [null, "missing-jq", "online"]);
  assert.ok(texts(mod.render(cx)).includes("AI 1%!"));
  globalThis.__herdr.props = { part: "panel", overlay: "quota-dialog" };
  const detail = texts(mod.render(cx));
  assert.ok(detail.includes("online"));
  assert.ok(detail.includes("offline"));
  assert.ok(detail.includes("jq is not installed."));
  assert.ok(!detail.some((line) => line.includes("secret must not be shown")));
  assert.ok(detail.includes("1% used"));
  assert.ok(detail.includes("GitHub Copilot"));
  assert.ok(detail.includes("Work"));
  assert.ok(detail.includes("Personal"));
  assert.ok(detail.includes("No quota reported."));
  assert.ok(!detail.includes("100% used"));
});
