const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");
const installer = path.join(repo, "scripts/install.sh");
const modSrc = path.join(repo, "mods/fleet-quota");

const MOD_FILES = ["main.js", "model.js", "fleet.js", "mod.json",
  ...["chevron-right", "clock", "close", "desktop", "gauge", "provider", "refresh", "server"].map((n) => `icons/${n}.svg`)];

// Only the tools the installer and the stubs need, so the host's real herdr-app can never be found.
function toolDir(root) {
  const bin = path.join(root, "tools");
  fs.mkdirSync(bin);
  for (const name of ["dirname", "mktemp", "cmp", "cp", "mkdir", "rm", "sleep", "touch"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, `${name} is needed to run these tests`);
    fs.symlinkSync(found, path.join(bin, name));
  }
  return bin;
}

const STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1" in
check)
  [ -f "$2/main.js" ] && [ -f "$2/icons/gauge.svg" ] && echo has-files >> "$STUB_LOG"
  if [ -n "\${STUB_MARKER:-}" ]; then : > "$STUB_MARKER"; fi
  if [ -n "\${STUB_SLEEP:-}" ]; then sleep "$STUB_SLEEP"; fi
  : > "$2/jsconfig.json"
  : > "$2/herdr.d.ts"
  exit "\${STUB_EXIT:-0}"
  ;;
esac
exit 0
`;

function sandbox(t, { spaces = false, withStub = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), spaces ? "fleet install " : "fleet-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = toolDir(root);
  const stubDir = path.join(root, "stub");
  fs.mkdirSync(stubDir);
  if (withStub) {
    fs.writeFileSync(path.join(stubDir, "herdr-app"), STUB, { mode: 0o755 });
  }
  const home = path.join(root, spaces ? "my home" : "home");
  const appHome = path.join(home, spaces ? "app home" : "app");
  fs.mkdirSync(path.join(appHome, "layouts"), { recursive: true });
  fs.mkdirSync(path.join(appHome, "mods", "other"), { recursive: true });
  fs.writeFileSync(path.join(appHome, "layouts", "main.json"), '{"layout":"mine"}\n');
  fs.writeFileSync(path.join(appHome, "keys.json"), '{"global":{}}\n');
  fs.writeFileSync(path.join(appHome, "settings.json"), '{"zoom":1}\n');
  fs.writeFileSync(path.join(appHome, "mods", "other", "main.js"), "// someone else's mod\n");
  const tmpdir = path.join(root, spaces ? "tmp dir" : "tmp");
  fs.mkdirSync(tmpdir);
  const log = path.join(root, "stub.log");
  fs.writeFileSync(log, "");
  const env = {
    PATH: `${stubDir}:${bin}`,
    HOME: home,
    HERDR_APP_HOME: appHome,
    TMPDIR: tmpdir,
    STUB_LOG: log,
  };
  return { root, appHome, home, tmpdir, log, env, bin, stubDir, target: path.join(appHome, "mods", "fleet-quota") };
}

const run = (sb, args = [], extra = {}, script = installer) =>
  spawnSync("/bin/sh", [script, ...args], { env: { ...sb.env, ...extra }, encoding: "utf8" });

function tree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isSymbolicLink()) out.push(`l ${rel} -> ${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) { out.push(`d ${rel}`); walk(full); }
      else out.push(`f ${rel} ${fs.readFileSync(full).toString("base64")}`);
    }
  };
  walk(dir);
  return out;
}

const logLines = (sb) => fs.readFileSync(sb.log, "utf8").split("\n").filter(Boolean);
const checkCalls = (sb) => logLines(sb).filter((line) => line.startsWith("check "));
const installedFiles = (sb) => tree(sb.target).filter((line) => line.startsWith("f ")).map((line) => line.split(" ")[1]).sort();

test("the default run, --check and --dry-run only report and change nothing", (t) => {
  const sb = sandbox(t);
  const before = tree(sb.root);
  for (const args of [[], ["--check"], ["--dry-run"]]) {
    const result = run(sb, args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /--install/);
    assert.match(result.stdout, new RegExp(sb.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, /not installed yet/);
    assert.match(result.stdout, /Nothing was changed/);
  }
  assert.deepEqual(tree(sb.root), before);
  assert.deepEqual(logLines(sb), [], "a dry run must not even call herdr-app");
  assert.equal(fs.existsSync(sb.target), false);
});

test("a fresh install copies exactly the allowlisted files and nothing else", (t) => {
  const sb = sandbox(t);
  const repoBefore = tree(modSrc);
  const protectedBefore = {
    layouts: tree(path.join(sb.appHome, "layouts")),
    other: tree(path.join(sb.appHome, "mods", "other")),
    files: ["keys.json", "settings.json"].map((name) => fs.readFileSync(path.join(sb.appHome, name), "utf8")),
  };

  const result = run(sb, ["--install"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  assert.deepEqual(installedFiles(sb), [...MOD_FILES].sort());
  for (const rel of MOD_FILES) {
    assert.ok(fs.readFileSync(path.join(sb.target, rel)).equals(fs.readFileSync(path.join(modSrc, rel))), `${rel} matches the repo`);
  }
  // The native check ran once, on a temporary folder, never on the repo or the live target.
  const calls = checkCalls(sb);
  assert.equal(calls.length, 1);
  const checked = calls[0].slice("check ".length);
  assert.ok(checked.startsWith(sb.tmpdir + path.sep), "checked a staged copy");
  assert.ok(!checked.startsWith(repo) && checked !== sb.target);
  assert.ok(logLines(sb).includes("has-files"), "the staged folder was complete when checked");
  // Files the native check generated stay out of the repo and out of the install.
  assert.deepEqual(tree(modSrc), repoBefore);
  assert.equal(fs.existsSync(path.join(sb.target, "jsconfig.json")), false);
  assert.equal(fs.existsSync(path.join(sb.target, "herdr.d.ts")), false);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), [], "staging folder removed");
  // The installer never opens the app or edits user configuration.
  assert.equal(logLines(sb).some((line) => line.startsWith("do ")), false);
  assert.deepEqual(tree(path.join(sb.appHome, "layouts")), protectedBefore.layouts);
  assert.deepEqual(tree(path.join(sb.appHome, "mods", "other")), protectedBefore.other);
  assert.deepEqual(["keys.json", "settings.json"].map((name) => fs.readFileSync(path.join(sb.appHome, name), "utf8")), protectedBefore.files);
  assert.deepEqual(fs.readdirSync(sb.appHome).sort(), ["keys.json", "layouts", "mods", "settings.json"]);
  // What the user is told next.
  assert.match(result.stdout, /herdr-app do mod\.open --name fleet-quota/);
  assert.match(result.stdout, /examples\/bar-block\.json/);
  // A missing local jq or collector is information, not a failure.
  assert.match(result.stdout, /jq not found locally/);
});

test("a missing Herdr mods folder is created, and the default app home is used without HERDR_APP_HOME", (t) => {
  const sb = sandbox(t);
  const defaultHome = path.join(sb.home, ".config", "herdr-app");
  fs.mkdirSync(defaultHome, { recursive: true });
  const env = { ...sb.env };
  delete env.HERDR_APP_HOME;
  const result = spawnSync("/bin/sh", [installer, "--install"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(tree(defaultHome).filter((line) => line.startsWith("f ")).map((line) => line.split(" ")[1]).sort(),
    MOD_FILES.map((rel) => path.join("mods", "fleet-quota", rel)).sort());
  assert.doesNotMatch(result.stdout, /HERDR_APP_HOME=/);
});

test("a failing native check leaves every existing path unchanged and removes the staging folder", (t) => {
  const sb = sandbox(t);
  const before = tree(sb.root).filter((line) => !line.includes("stub.log"));
  const result = run(sb, ["--install"], { STUB_EXIT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Nothing was installed/);
  assert.equal(checkCalls(sb).length, 1);
  assert.equal(fs.existsSync(sb.target), false);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
  assert.deepEqual(tree(sb.root).filter((line) => !line.includes("stub.log")), before);
});

test("an identical existing install is a no-op that keeps unknown files and calls nothing", (t) => {
  const sb = sandbox(t);
  assert.equal(run(sb, ["--install"]).status, 0);
  const generated = path.join(sb.target, "jsconfig.json");
  fs.writeFileSync(generated, "{}\n");
  const stamps = MOD_FILES.map((rel) => fs.statSync(path.join(sb.target, rel)).mtimeMs);
  const before = tree(sb.target);
  fs.writeFileSync(sb.log, "");

  for (const args of [["--install"], []]) {
    const result = run(sb, args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /already installed and identical/);
  }
  assert.deepEqual(tree(sb.target), before);
  assert.deepEqual(MOD_FILES.map((rel) => fs.statSync(path.join(sb.target, rel)).mtimeMs), stamps);
  assert.deepEqual(logLines(sb), []);
  assert.equal(fs.existsSync(generated), true);
});

test("a different, missing or extra-content install is refused and never overwritten", (t) => {
  const cases = [
    ["edited file", (sb) => fs.appendFileSync(path.join(sb.target, "model.js"), "// my edit\n")],
    ["missing file", (sb) => fs.rmSync(path.join(sb.target, "icons/gauge.svg"))],
    ["missing mod.json", (sb) => fs.rmSync(path.join(sb.target, "mod.json"))],
  ];
  for (const [label, damage] of cases) {
    const sb = sandbox(t);
    assert.equal(run(sb, ["--install"]).status, 0);
    damage(sb);
    fs.writeFileSync(path.join(sb.target, "notes.txt"), "mine\n");
    const before = tree(sb.target);
    fs.writeFileSync(sb.log, "");
    for (const args of [["--install"], ["--check"]]) {
      const result = run(sb, args);
      assert.notEqual(result.status, 0, `${label} ${args}`);
      assert.match(result.stdout + result.stderr, /No changes were made|Nothing is overwritten/);
    }
    assert.deepEqual(tree(sb.target), before, label);
    assert.deepEqual(logLines(sb), [], label);
  }
});

test("symbolic links at the destination are refused without following them", (t) => {
  const makers = {
    "target is a link": (sb, outside) => fs.symlinkSync(outside, sb.target),
    "icons is a link": (sb, outside) => {
      fs.cpSync(modSrc, sb.target, { recursive: true });
      fs.rmSync(path.join(sb.target, "icons"), { recursive: true });
      fs.cpSync(path.join(modSrc, "icons"), outside, { recursive: true });
      fs.symlinkSync(outside, path.join(sb.target, "icons"));
    },
    "a file is a link": (sb, outside) => {
      fs.cpSync(modSrc, sb.target, { recursive: true });
      fs.writeFileSync(outside, fs.readFileSync(path.join(modSrc, "main.js")));
      fs.rmSync(path.join(sb.target, "main.js"));
      fs.symlinkSync(outside, path.join(sb.target, "main.js"));
    },
    "dangling target link": (sb, outside) => fs.symlinkSync(path.join(outside, "nowhere"), sb.target),
  };
  for (const [label, make] of Object.entries(makers)) {
    const sb = sandbox(t);
    const outside = path.join(sb.root, "outside");
    if (label !== "a file is a link" && label !== "icons is a link") fs.mkdirSync(outside);
    fs.writeFileSync(sb.log, "");
    make(sb, outside);
    const beforeAll = tree(sb.root);
    const result = run(sb, ["--install"]);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stdout, /symbolic link/, label);
    assert.deepEqual(tree(sb.root), beforeAll, label);
    assert.deepEqual(logLines(sb), [], label);
  }
});

test("a final copy failure removes only the folder this run created", (t) => {
  const sb = sandbox(t);
  const real = spawnSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).stdout.trim();
  fs.rmSync(path.join(sb.bin, "cp"));
  fs.writeFileSync(path.join(sb.bin, "cp"), `#!/bin/sh
for last; do :; done
case "$last" in */mods/fleet-quota/fleet.js) exit 1 ;; esac
exec "${real}" "$@"
`, { mode: 0o755 });
  const before = tree(sb.appHome);
  const result = run(sb, ["--install"]);
  assert.notEqual(result.status, 0);
  assert.equal(checkCalls(sb).length, 1);
  assert.equal(fs.existsSync(sb.target), false, "the half-written folder is gone");
  assert.deepEqual(tree(sb.appHome), before, "everything else is unchanged");
  assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
});

test("a folder created by someone else while installing is not touched", (t) => {
  const sb = sandbox(t);
  // The check stub plays the other party: it creates the destination mid-install.
  fs.writeFileSync(path.join(sb.stubDir, "herdr-app"), STUB.replace(
    '  : > "$2/jsconfig.json"',
    `  mkdir "${sb.target}" && echo precious > "${sb.target}/theirs.txt"\n  : > "$2/jsconfig.json"`));
  const result = run(sb, ["--install"]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(tree(sb.target), [`f theirs.txt ${Buffer.from("precious\n").toString("base64")}`]);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
});

test("an interrupted install cleans its staging folder and creates nothing", async (t) => {
  const sb = sandbox(t);
  const marker = path.join(sb.root, "marker");
  const child = spawn("/bin/sh", [installer, "--install"], {
    env: { ...sb.env, STUB_MARKER: marker, STUB_SLEEP: "1" }, stdio: "ignore",
  });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(marker), "the native check started");
  child.kill("SIGTERM");
  const { code, signal } = await closed;
  assert.ok(code !== 0 || signal, "interrupted install does not report success");
  assert.equal(fs.existsSync(sb.target), false);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
  assert.deepEqual(fs.readdirSync(path.join(sb.appHome, "mods")), ["other"]);
});

test("spaces in the repository, Herdr home, HOME and TMPDIR are handled", (t) => {
  const sb = sandbox(t, { spaces: true });
  const copy = path.join(sb.root, "re po");
  fs.mkdirSync(path.join(copy, "scripts"), { recursive: true });
  fs.copyFileSync(installer, path.join(copy, "scripts", "install.sh"));
  fs.cpSync(modSrc, path.join(copy, "mods", "fleet-quota"), { recursive: true });
  const script = path.join(copy, "scripts", "install.sh");

  const dry = run(sb, [], {}, script);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(fs.existsSync(sb.target), false);
  const result = run(sb, ["--install"], {}, script);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(installedFiles(sb), [...MOD_FILES].sort());
  assert.match(result.stdout, /HERDR_APP_HOME='.* .*' herdr-app do mod\.open --name fleet-quota/);
  assert.equal(run(sb, ["--install"], {}, script).status, 0);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
});

test("a repository missing an allowlisted file refuses to install", (t) => {
  const sb = sandbox(t);
  const copy = path.join(sb.root, "repo-copy");
  fs.mkdirSync(path.join(copy, "scripts"), { recursive: true });
  fs.copyFileSync(installer, path.join(copy, "scripts", "install.sh"));
  fs.cpSync(modSrc, path.join(copy, "mods", "fleet-quota"), { recursive: true });
  fs.rmSync(path.join(copy, "mods", "fleet-quota", "icons", "server.svg"));
  const result = run(sb, ["--install"], {}, path.join(copy, "scripts", "install.sh"));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /icons\/server\.svg/);
  assert.equal(fs.existsSync(sb.target), false);
  assert.deepEqual(logLines(sb), []);
});

test("without the native Herdr CLI nothing can be installed, and the CLI is also found in ~/.local/bin", (t) => {
  const sb = sandbox(t, { withStub: false });
  const before = tree(sb.root);
  const check = run(sb, []);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /herdr-app not found/);
  const install = run(sb, ["--install"]);
  assert.notEqual(install.status, 0);
  assert.deepEqual(tree(sb.root), before);

  const localBin = path.join(sb.home, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(path.join(localBin, "herdr-app"), STUB, { mode: 0o755 });
  const found = run(sb, ["--install"]);
  assert.equal(found.status, 0, found.stderr + found.stdout);
  assert.equal(checkCalls(sb).length, 1);
  assert.deepEqual(installedFiles(sb), [...MOD_FILES].sort());
});

test("a missing Herdr app home is reported, not created", (t) => {
  const sb = sandbox(t);
  const missing = path.join(sb.root, "never-started");
  const result = run(sb, ["--install"], { HERDR_APP_HOME: missing });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Herdr app home not found/);
  assert.equal(fs.existsSync(missing), false);
});

test("unknown or combined arguments are rejected with usage", (t) => {
  const sb = sandbox(t);
  for (const args of [["--nope"], ["--install", "--check"], ["install"]]) {
    const result = run(sb, args);
    assert.equal(result.status, 2, String(args));
    assert.match(result.stderr, /usage:/);
  }
  assert.equal(fs.existsSync(sb.target), false);
});
