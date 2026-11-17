const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");
const installer = path.join(repo, "scripts/install-refresh.sh");
const helperRepo = path.join(repo, "scripts/refresh.py");
const serviceRepo = path.join(repo, "systemd/herdr-fleet-quota-refresh.service");
const timerRepo = path.join(repo, "systemd/herdr-fleet-quota-refresh.timer");
const SERVICE = "herdr-fleet-quota-refresh.service";
const TIMER = "herdr-fleet-quota-refresh.timer";
const EXEC = "ExecStart=%h/.local/bin/herdr-fleet-quota-refresh";

const bash = (() => {
  const found = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  assert.ok(found, "bash is needed to run these tests");
  return found;
})();

// Only the tools the installer needs, so the host's real systemd tools can never be found.
function toolDir(root) {
  const bin = path.join(root, "tools");
  fs.mkdirSync(bin);
  for (const name of ["dirname", "mktemp", "cmp", "cp", "install", "sed", "grep", "mkdir", "rm"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, `${name} is needed to run these tests`);
    fs.symlinkSync(found, path.join(bin, name));
  }
  return bin;
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hfq-install-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = toolDir(root);
  const stubs = path.join(root, "stubs");
  fs.mkdirSync(stubs);
  for (const name of ["systemd-analyze", "systemctl"]) {
    fs.writeFileSync(path.join(stubs, name),
      `#!/bin/sh\necho '${name}' "$@" >> "$STUB_LOG"\nexit 0\n`, { mode: 0o755 });
  }
  const home = path.join(root, "home");
  const tmpdir = path.join(root, "tmp");
  const omarchy = path.join(root, "omarchy");
  const calls = path.join(root, "calls");
  fs.mkdirSync(home);
  fs.mkdirSync(tmpdir);
  fs.mkdirSync(path.join(omarchy, "bin"), { recursive: true });
  const env = { PATH: `${stubs}:${bin}`, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    TMPDIR: tmpdir, OMARCHY_PATH: omarchy, STUB_LOG: calls };
  return { root, home, bin, stubs, tmpdir, omarchy, env,
    units: path.join(home, ".config/systemd/user"),
    target: path.join(home, ".local/bin/herdr-fleet-quota-refresh"),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "") };
}

const run = (sb, args = []) => spawnSync(bash, [installer, ...args], { env: sb.env, encoding: "utf8" });
const readUnit = (sb, name) => fs.readFileSync(path.join(sb.units, name), "utf8");
const collector = (sb, id, body) =>
  fs.writeFileSync(path.join(sb.omarchy, "bin", `omarchy-agent-usage-${id}`), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

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

// What the installer could write: HOME plus anything left in TMPDIR.
const state = (sb) => ({ home: tree(sb.home), tmp: fs.readdirSync(sb.tmpdir).sort() });

test("the default run reports the repo unit, writes nothing, and --install copies it verbatim", (t) => {
  const sb = sandbox(t);
  const before = state(sb);
  const preview = run(sb);
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  assert.match(preview.stdout, /would install: .*herdr-fleet-quota-refresh\.service/);
  assert.match(preview.stdout, /^providers \(repo unit\): claude copilot codex$/m);
  assert.match(preview.stdout, /dry run; pass --install to install/);
  assert.deepEqual(state(sb), before, "the default run changes nothing");
  

  const installed = run(sb, ["--install"]);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert.equal(fs.readFileSync(sb.target, "utf8"), fs.readFileSync(helperRepo, "utf8"));
  assert.equal(readUnit(sb, SERVICE), fs.readFileSync(serviceRepo, "utf8"));
  assert.equal(readUnit(sb, TIMER), fs.readFileSync(timerRepo, "utf8"));
});

test("--install --providers replaces only the ExecStart provider list", (t) => {
  const sb = sandbox(t);
  const repoUnit = fs.readFileSync(serviceRepo, "utf8");
  const result = run(sb, ["--install", "--providers", "claude gemini"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const installed = readUnit(sb, SERVICE);
  const timeout = Number(fs.readFileSync(helperRepo, "utf8").match(/^TIMEOUT = (\d+)$/m)[1]);
  const expected = repoUnit
    .replace(/^ExecStart=.*$/m, `${EXEC} claude gemini`)
    .replace(/^TimeoutStartSec=.*$/m, `TimeoutStartSec=${60 + timeout * 2}`);
  assert.equal(installed, expected, "every other byte of the unit is unchanged");
  assert.match(installed, /^ExecStart=%h\/\.local\/bin\/herdr-fleet-quota-refresh claude gemini$/m);
  const repoLines = repoUnit.split("\n");
  const gotLines = installed.split("\n");
  assert.equal(gotLines.length, repoLines.length);
  for (const [i, line] of repoLines.entries()) {
    if (line.startsWith("ExecStart=")) assert.equal(gotLines[i], `${EXEC} claude gemini`, "ExecStart line");
    else if (line.startsWith("TimeoutStartSec=")) assert.equal(gotLines[i], `TimeoutStartSec=${60 + timeout * 2}`);
    else assert.equal(gotLines[i], line, `line ${i + 1}`);
  }
  assert.equal(readUnit(sb, TIMER), fs.readFileSync(timerRepo, "utf8"));
  assert.equal(fs.readFileSync(sb.target, "utf8"), fs.readFileSync(helperRepo, "utf8"));
  assert.equal(fs.readFileSync(serviceRepo, "utf8"), repoUnit, "the repo unit is never edited");
});

test("the service timeout covers every selected provider", (t) => {
  const timeout = Number(fs.readFileSync(helperRepo, "utf8").match(/^TIMEOUT = (\d+)$/m)[1]);
  for (const [ids, count] of [["claude", 1], ["claude gemini", 2], ["claude gemini cursor", 3]]) {
    const sb = sandbox(t);
    const result = run(sb, ["--install", "--providers", ids]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const installed = readUnit(sb, SERVICE);
    assert.equal(installed.match(/^TimeoutStartSec=(\d+)$/m)[1], String(60 + timeout * count),
      `service timeout for ${ids}`);
    assert.ok(60 + timeout * count >= timeout * count, "the service outlasts every collector it runs");
  }
});

test("a second identical --providers install is a no-op", (t) => {
  const sb = sandbox(t);
  const first = run(sb, ["--install", "--providers", "claude gemini"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /^installed: .*herdr-fleet-quota-refresh\.service$/m);

  const again = run(sb, ["--install", "--providers", "claude gemini"]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /^installed:/m);
  assert.match(again.stdout, /^ok \(identical\): .*herdr-fleet-quota-refresh\.service$/m);
  assert.match(readUnit(sb, SERVICE), /^ExecStart=.* claude gemini$/m);
});

test("invalid --providers values are refused before anything is written", (t) => {
  for (const value of ["Claude", "claude ../x", "", "a".repeat(33)]) {
    const sb = sandbox(t);
    const before = state(sb);
    const result = run(sb, ["--install", "--providers", value]);
    assert.equal(result.status, 2, `${JSON.stringify(value)} -> ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^refuse: /m);
    assert.match(result.stderr, /\^\[a-z\]\[a-z0-9\]\*\$/, "the refusal names the id rule");
    if (value) assert.equal(result.stderr.includes(value), false, "the refusal does not echo the input");
    assert.equal(fs.existsSync(sb.units), false);
    assert.equal(fs.existsSync(sb.target), false);
    assert.deepEqual(state(sb), before, `${JSON.stringify(value)} changes nothing`);
    assert.equal(sb.calls(), "", "nothing is verified or enabled");
  }
  const sb = sandbox(t);
  const missing = run(sb, ["--install", "--providers"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^refuse: /m);
  assert.equal(fs.existsSync(sb.units), false);
});

test("--providers is rejected with --check only when combined with --install or --enable", (t) => {
  const sb = sandbox(t);
  const before = state(sb);
  const combined = run(sb, ["--check", "--install", "--providers", "claude"]);
  assert.equal(combined.status, 2);
  assert.match(combined.stderr, /--check cannot be combined/);
  const enableAlone = run(sb, ["--enable", "--providers", "claude"]);
  assert.equal(enableAlone.status, 2);
  assert.match(enableAlone.stderr, /--enable requires --install/);
  assert.deepEqual(state(sb), before);
});

test("--check --providers only reports and writes nothing", (t) => {
  const sb = sandbox(t);
  collector(sb, "claude", "exit 0");
  collector(sb, "gemini", "exit 0");
  const before = state(sb);
  const result = run(sb, ["--check", "--providers", "claude gemini"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^providers: claude gemini$/m);
  assert.deepEqual(state(sb), before, "a check writes nothing");
  assert.equal(fs.existsSync(sb.units), false);
  assert.equal(fs.existsSync(sb.target), false);
  assert.doesNotMatch(sb.calls(), /systemctl/);
});

test("duplicate provider ids are dropped and the given order is kept", (t) => {
  const sb = sandbox(t);
  const result = run(sb, ["--install", "--providers", "claude claude gemini"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const installed = readUnit(sb, SERVICE);
  const timeout = Number(fs.readFileSync(helperRepo, "utf8").match(/^TIMEOUT = (\d+)$/m)[1]);
  assert.equal(installed,
    fs.readFileSync(serviceRepo, "utf8")
      .replace(/^ExecStart=.*$/m, `${EXEC} claude gemini`)
      .replace(/^TimeoutStartSec=.*$/m, `TimeoutStartSec=${60 + timeout * 2}`));
  const reordered = sandbox(t);
  const reversed = run(reordered, ["--check", "--providers", "gemini claude gemini"]);
  assert.match(reversed.stdout, /^providers: gemini claude$/m);
});

test("the reserved id 'update' is refused as Omarchy's batch updater", (t) => {
  for (const value of ["claude update", "update"]) {
    const sb = sandbox(t);
    collector(sb, "update", ': > "$HOME/updater-ran"');
    collector(sb, "claude", ': > "$HOME/collector-ran"');
    const before = state(sb);
    const result = run(sb, ["--install", "--providers", value]);
    assert.equal(result.status, 2, `${JSON.stringify(value)} -> ${result.stdout}${result.stderr}`);
    assert.match(result.stderr,
      /^refusing 'update': that is Omarchy's batch updater, not a provider$/m);
    assert.doesNotMatch(result.stderr, /\^\[a-z\]\[a-z0-9\]\*\$/, "not the invalid-name message");
    assert.equal(fs.existsSync(sb.units), false, "no unit is written");
    assert.equal(fs.existsSync(sb.target), false, "no helper is written");
    assert.deepEqual(state(sb), before, `${JSON.stringify(value)} changes nothing`);
    assert.equal(sb.calls(), "", "nothing is verified or enabled");
  }

  // No general allowlist: only `update` is reserved, ordinary ids still pass.
  const ok = sandbox(t);
  const accepted = run(ok, ["--check", "--providers", "local ollama opencode deepseek gemini cursor"]);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.match(accepted.stdout, /^providers: local ollama opencode deepseek gemini cursor$/m);
});

test("--check lists the collectors that exist without executing them", (t) => {
  const sb = sandbox(t);
  collector(sb, "claude", ': > "$HOME/collector-ran"');
  collector(sb, "gemini", ': > "$HOME/collector-ran"');
  fs.writeFileSync(path.join(sb.omarchy, "bin", "unrelated"), "not a collector\n");
  const result = run(sb, ["--check", "--providers", "claude gemini"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /^collectors: claude gemini$/m);
  assert.equal(fs.existsSync(path.join(sb.home, "collector-ran")), false, "no collector was run");

  const empty = sandbox(t);
  const none = run(empty, ["--check", "--providers", "claude"]);
  assert.match(none.stdout, /^collectors: none of omarchy-agent-usage-\* in .*\/omarchy\/bin$/m);
});

test("installed modes are 0755 for the helper and 0644 for the units", (t) => {
  const sb = sandbox(t);
  assert.equal(run(sb, ["--install", "--providers", "claude"]).status, 0);
  assert.equal(fs.statSync(sb.target).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(sb.units, SERVICE)).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(sb.units, TIMER)).mode & 0o777, 0o644);
});

test("systemctl runs only with --enable, then daemon-reload + enable --now", (t) => {
  const plain = sandbox(t);
  assert.equal(run(plain, ["--install", "--providers", "claude"]).status, 0);
  assert.doesNotMatch(plain.calls(), /systemctl/);
  assert.match(plain.calls(), /systemd-analyze --user verify/);

  const enabled = sandbox(t);
  const result = run(enabled, ["--install", "--enable", "--providers", "claude"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(enabled.calls(), /^systemctl --user daemon-reload$/m);
  assert.match(enabled.calls(), /^systemctl --user enable --now herdr-fleet-quota-refresh\.timer$/m);
  assert.match(readUnit(enabled, SERVICE), /^ExecStart=.* claude$/m);
});
