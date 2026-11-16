const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const helper = path.join(root, 'scripts/refresh.py');
const installer = path.join(root, 'scripts/install-refresh.sh');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hfq-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'state');
  const usage = path.join(state, 'omarchy/agents/usage');
  const control = path.join(state, 'herdr-fleet-quota');
  const omarchy = path.join(home, 'omarchy');
  fs.mkdirSync(path.join(omarchy, 'bin'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    OMARCHY_PATH: omarchy, TMPDIR: home };
  return { home, state, usage, control, omarchy, env };
}
function collector(x, id, body) {
  const file = path.join(x.omarchy, 'bin', `omarchy-agent-usage-${id}`);
  if (id === 'claude') {
    fs.writeFileSync(file, `#!/usr/bin/env python3
import json,os,subprocess,sys
from pathlib import Path
AGENT_ID='claude'
def local_stats(claude_dir,max_age,use_index=True):
    (Path(os.environ['HOME'])/'history-touched').write_text('must not scan')
    raise RuntimeError('history scan must be bypassed')
def emit(record,sort_keys=False):
    print(json.dumps(record,sort_keys=sort_keys))
def main():
    stats=local_stats(Path(os.environ['HOME']),900,use_index=True)
    assert stats == {}
    with (Path(os.environ['HOME'])/'calls').open('a') as calls:
        calls.write('claude '+' '.join(sys.argv[1:])+'\\n')
    result=subprocess.run(['/bin/sh','-c',${JSON.stringify(body)}],stdout=subprocess.PIPE)
    if result.returncode:
        return result.returncode
    try:
        record=json.loads(result.stdout)
    except (ValueError,UnicodeError):
        sys.stdout.buffer.write(result.stdout)
        return 0
    record['hasLocalStats']=True
    emit(record,sort_keys=True)
    return 0
if __name__ == '__main__':
    (Path(os.environ['HOME'])/'cli-fallback').write_text('must not execute CLI')
    raise SystemExit(main())
`, { mode: 0o755 });
    return;
  }
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${id} $*" >> "$HOME/calls"\n${body}\n`, { mode: 0o755 });
}
const record = (id, fields = {}) => ({ id, updatedAt: new Date().toISOString(),
  limitsFetchedAt: Date.now(), limits: [{ label: 'Session', percent: 1,
    resetsAt: new Date(Date.now() - 60000).toISOString() }], ...fields });
const json = (value) => `printf '%s' '${JSON.stringify(value)}'`;
// Fetch timestamps are generated inside the fake collector, not at test setup.
const live = (value, accounts = []) => `python3 - <<'PY'
import json,time
data=json.loads(${JSON.stringify(JSON.stringify(value))})
data['limitsFetchedAt']=time.time_ns()//1000000
for account in data.get('accounts',[]):
    if account.get('id') in ${JSON.stringify(accounts)}:
        account['fetchedAt']=data['limitsFetchedAt']
print(json.dumps(data))
PY`;
const run = (x, args = []) => spawnSync('python3', [helper, ...args], { env: x.env, encoding: 'utf8' });
const calls = (x) => fs.existsSync(path.join(x.home, 'calls')) ? fs.readFileSync(path.join(x.home, 'calls'), 'utf8') : '';
const saved = (x, id) => JSON.parse(fs.readFileSync(path.join(x.usage, `${id}.json`)));
function prior(x, id, value) {
  fs.mkdirSync(x.usage, { recursive: true });
  fs.writeFileSync(path.join(x.usage, `${id}.json`), JSON.stringify(value));
}
function eligible(x, id) {
  const file = path.join(x.control, `${id}.state`);
  const state = JSON.parse(fs.readFileSync(file));
  state.next = 0;
  fs.writeFileSync(file, JSON.stringify(state));
}
function harness(x, code, args = ['claude']) {
  return spawnSync('python3', ['-B', '-c', `import importlib.util,sys\ns=importlib.util.spec_from_file_location('refresh',sys.argv[1])\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\nsys.argv=sys.argv[1:]\n${code}\nsys.exit(m.main())`, helper, ...args], { env: x.env, encoding: 'utf8' });
}

test('clean host refreshes both direct collectors, exporting chosen root, private records', (t) => {
  const x = fixture(t);
  for (const id of ['claude', 'copilot']) collector(x, id,
    `test "$OMARCHY_PATH" = '${x.omarchy}' || exit 9\n${live(record(id))}`);
  assert.equal(run(x).status, 0);
  assert.equal(calls(x), 'claude --limits-only\ncopilot --limits-only\n');
  assert.equal(saved(x, 'claude').limitsStale, false);
  assert.equal(saved(x, 'claude').hasLocalStats, false);
  assert.equal(fs.existsSync(path.join(x.home, 'history-touched')), false);
  assert.equal(fs.existsSync(path.join(x.home, 'cli-fallback')), false);
  assert.equal(fs.existsSync(path.join(x.omarchy, 'bin', '__pycache__')), false);
  assert.equal(fs.statSync(path.join(x.usage, 'claude.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(x.usage).sort(), ['claude.json', 'copilot.json']);
});

test('unsupported Claude private interface fails closed without scanning or CLI fallback', (t) => {
  const mutations = [
    source => source.replace("AGENT_ID='claude'", "AGENT_ID='other'"),
    source => source.replace('def main():', 'def main(required):'),
    source => source.replace('def local_stats(claude_dir,max_age,use_index=True):', 'def local_stats():'),
    source => source.replace('def emit(record,sort_keys=False):', 'def emit(record):'),
    source => source + '\nlocal_stats = None\n',
    source => source + '\nmain = None\n',
    source => source + '\nemit = None\n',
  ];
  for (const mutate of mutations) {
    const x = fixture(t), old = record('claude');
    prior(x, 'claude', old);
    collector(x, 'claude', live(record('claude')));
    collector(x, 'copilot', live(record('copilot')));
    const file = path.join(x.omarchy, 'bin', 'omarchy-agent-usage-claude');
    fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
    const r = run(x);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /adapter unavailable or incompatible; no CLI fallback/);
    assert.doesNotMatch(r.stdout + r.stderr, /Traceback|RuntimeError/);
    assert.equal(calls(x), 'copilot --limits-only\n');
    assert.deepEqual(saved(x, 'claude'), { ...old, limitsStale: true });
    assert.equal(saved(x, 'copilot').limitsStale, false);
    assert.equal(fs.existsSync(path.join(x.home, 'history-touched')), false);
    assert.equal(fs.existsSync(path.join(x.home, 'cli-fallback')), false);
  }
});

test('only exact whitelisted native statuses are logged, without extra probes', (t) => {
  const allowed = ['Limits paused', 'Sign-in expired', 'Waiting for auth', 'Claude limits unavailable'];
  for (const status of [...allowed, 'SECRET-status', 'Limits paused SECRET-suffix',
    'Limits paused\nSECRET-newline', { token: 'SECRET-object' }]) {
    const x = fixture(t);
    collector(x, 'claude', json(record('claude', {
      limitsFetchedAt: 0, limits: [], usageStatusText: status,
      authHelpText: 'SECRET-auth-help',
      accounts: [{ id: 'SECRET-account-id', limits: [], fetchedAt: 0 }],
    })) + '\necho SECRET-stderr >&2');
    const r = run(x, ['claude']);
    assert.equal(r.status, 1);
    const output = r.stdout + r.stderr;
    if (allowed.includes(status)) assert.ok(output.includes(`native status: ${status}\n`));
    else assert.doesNotMatch(output, /native status:/);
    assert.doesNotMatch(output, /SECRET/);
    assert.equal(calls(x), 'claude --limits-only\n');
    const retry = run(x, ['claude']);
    assert.equal(retry.status, 0);
    assert.match(retry.stdout, /retry deferred/);
    assert.doesNotMatch(retry.stdout + retry.stderr, /native status:|SECRET/);
    assert.equal(calls(x), 'claude --limits-only\n');
  }
});

test('Claude help prefixes produce only fixed diagnostics without suffixes or extra probes', (t) => {
  const known = [
    ["Anthropic's usage endpoint is rate limiting checks right now", 'rate limited'],
    ["Couldn't reach Anthropic's usage endpoint.", 'unreachable'],
    ["Anthropic refused Claude Code's sign-in.", 'refused sign-in'],
    ["Anthropic's usage endpoint returned an invalid answer.", 'invalid data'],
    ["Anthropic's usage endpoint returned no limits.", 'missing quota data'],
    ["Anthropic's usage endpoint returned status ", 'rejected request'],
  ];
  for (const [prefix, diagnostic] of known) {
    for (const provider of ['claude', 'copilot']) {
      const x = fixture(t);
      collector(x, provider, live(record(provider, { limits: [],
        authHelpText: `${prefix}599 SECRET-token\nSECRET-body`,
      })));
      const r = run(x, [provider]);
      assert.equal(r.status, 1);
      const output = r.stdout + r.stderr;
      if (provider === 'claude') assert.ok(output.includes(`native quota endpoint ${diagnostic}\n`));
      else assert.doesNotMatch(output, /native quota endpoint/);
      assert.doesNotMatch(output, /SECRET|599|Anthropic|Traceback/);
      assert.equal(calls(x), `${provider} --limits-only\n`);
      const retry = run(x, [provider]);
      assert.equal(retry.status, 0);
      assert.match(retry.stdout, /retry deferred/);
      assert.doesNotMatch(retry.stdout + retry.stderr, /native quota endpoint|SECRET/);
      assert.equal(calls(x), `${provider} --limits-only\n`);
    }
  }
});

test('unknown or non-string help never produces a diagnostic or exposes content', (t) => {
  for (const value of ['SECRET-arbitrary', "SECRET-prefix Anthropic's usage endpoint returned no limits.",
    "anthropic's usage endpoint returned no limits.", null, 599, ['SECRET-array'], { token: 'SECRET-object' }]) {
    const x = fixture(t);
    collector(x, 'claude', live(record('claude', { limits: [], authHelpText: value })));
    const r = run(x, ['claude']);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /native quota endpoint|SECRET|599|Traceback/);
  }
});

test('default OMARCHY_PATH is exported without invoking a real collector', (t) => {
  const x = fixture(t);
  delete x.env.OMARCHY_PATH;
  const r = harness(x, `def fake(executable, environment, provider):\n assert environment['OMARCHY_PATH']=='/usr/share/omarchy'\n assert str(executable)=='/usr/share/omarchy/bin/omarchy-agent-usage-claude'\n return {'id':provider,'limitsFetchedAt':m.time.time_ns()//1000000,'limits':[{'percent':0}]}\nm.collect=fake`);
  assert.equal(r.status, 0, r.stderr);
});

async function assertUnknown(x) {
  const model = await import(pathToFileURL(path.join(root, 'mods/fleet-quota/model.js')));
  const read = spawnSync('bash', ['-c', model.READ_SCRIPT], { env: x.env, encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  const rows = model.parseQuota(read.stdout, Date.now()).rows;
  assert.ok(rows.length);
  for (const row of rows) {
    assert.equal(row.stale, true);
    assert.equal(model.availabilityOf(row, { hostStatus: 'ok', now: Date.now() }).state, 'unknown');
  }
}

test('5s cached 429/reset rewrite preserves exhausted values and remains unknown', async (t) => {
  const x = fixture(t);
  const old = record('claude', { limitsFetchedAt: Date.now() - 5000,
    limits: [{ label: 'Session', percent: 1, resetsAt: new Date(Date.now() - 1000).toISOString() }] });
  prior(x, 'claude', old);
  collector(x, 'claude', json({ ...old, limitsStale: false,
    limits: [{ label: 'Session', percent: 0, resetsAt: '' }] }));
  const r = run(x, ['claude']);
  assert.equal(r.status, 1);
  assert.deepEqual(saved(x, 'claude'), { ...old, limitsStale: true });
  await assertUnknown(x);
});

test('advancing but pre-invocation 30s cache cannot certify availability', async (t) => {
  for (const hasPrior of [false, true]) {
    const x = fixture(t);
    const old = record('claude', { limitsFetchedAt: Date.now() - 60000 });
    if (hasPrior) prior(x, 'claude', old);
    collector(x, 'claude', json(record('claude', { limitsFetchedAt: Date.now() - 30000,
      limits: [{ label: 'Session', percent: 0, resetsAt: '' }] })));
    assert.equal(run(x, ['claude']).status, 1);
    if (hasPrior) assert.deepEqual(saved(x, 'claude'), { ...old, limitsStale: true });
    await assertUnknown(x);
  }
});

test('fresh-stamped empty root and matching account preserve historical quota', async (t) => {
  for (const isAccount of [false, true]) {
    const x = fixture(t);
    const old = record('claude', isAccount ? { accounts: [{ id: 'a', fetchedAt: Date.now() - 5000,
      active: true, limits: [{ label: 'Session', percent: 1 }] }] } : {});
    prior(x, 'claude', old);
    collector(x, 'claude', live(record('claude', { limits: [],
      ...(isAccount ? { accounts: [{ id: 'a', active: true, limits: [] }] } : {}) }), ['a']));
    assert.equal(run(x, ['claude']).status, 1);
    const output = saved(x, 'claude');
    assert.deepEqual(output.limits, old.limits);
    assert.equal(output.limitsFetchedAt, old.limitsFetchedAt);
    if (isAccount) assert.deepEqual(output.accounts[0], { ...old.accounts[0], stale: true });
    await assertUnknown(x);
  }
});

test('probe measured during invocation accepts zero percentage and zero balance', (t) => {
  for (const fields of [{ limits: [{ percent: 0 }] }, { limits: [], balance: { remaining: 0 } }]) {
    const x = fixture(t);
    collector(x, 'claude', live(record('claude', fields)));
    assert.equal(run(x, ['claude']).status, 0);
    const output = saved(x, 'claude');
    assert.equal(output.limitsStale, false);
    assert.deepEqual(output.limits, fields.limits);
    if (fields.balance) assert.deepEqual(output.balance, fields.balance);
  }
});

test('measurement proof is bounded by invocation milliseconds and must advance', (t) => {
  const x = fixture(t);
  const r = harness(x, `for fetched,old,expected in [(1000,0,False),(1001,0,True),(1003,0,True),(1004,0,False),(1001,1001,False)]:\n value={'limitsFetchedAt':fetched,'limits':[{'percent':0}]}\n assert m.fresh(value,{'limitsFetchedAt':old},'limitsFetchedAt','limitsStale',1001,1003) is expected\nsys.exit(0)`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(x), '');
});

test('valid empty or absent quota never destroys previous historical quota', (t) => {
  for (const extra of [{ limits: [], limitsFetchedAt: 0 }, { limits: [] }]) {
    const x = fixture(t), old = record('claude');
    prior(x, 'claude', old);
    collector(x, 'claude', json({ id: 'claude', ...extra }));
    assert.equal(run(x, ['claude']).status, 1);
    assert.deepEqual(saved(x, 'claude'), { ...old, limitsStale: true });
  }
});

test('process failures, wrong id, invalid/oversize JSON preserve quota and mark stale', (t) => {
  for (const body of ['echo SECRET >&2; exit 3', 'echo not-json', json({ id: 'copilot' }),
    'python3 -c "print(\'x\'*262145)"', 'echo \'{"id":"claude","n":NaN}\'']) {
    const x = fixture(t), old = record('claude');
    prior(x, 'claude', old);
    collector(x, 'claude', body);
    const r = run(x, ['claude']);
    assert.equal(r.status, 1);
    assert.deepEqual(saved(x, 'claude'), { ...old, limitsStale: true });
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET|Traceback/);
  }
});

test('missing Claude does not prevent Copilot refreshing', (t) => {
  const x = fixture(t), old = record('claude');
  prior(x, 'claude', old);
  collector(x, 'copilot', live(record('copilot')));
  assert.equal(run(x).status, 1);
  assert.equal(saved(x, 'claude').limitsStale, true);
  assert.equal(saved(x, 'copilot').limitsStale, false);
  assert.equal(calls(x), 'copilot --limits-only\n');
});

test('partial accounts refresh only the independently fresh accounts', (t) => {
  const x = fixture(t);
  const old = record('claude', { accounts: ['a', 'b'].map(id => ({ id,
    active: id === 'a', fetchedAt: Date.now() - 60000, limits: [{ percent: 1 }] })) });
  prior(x, 'claude', old);
  const newer = record('claude', { accounts: [
    { ...old.accounts[0], fetchedAt: Date.now(), limits: [{ percent: 0.1 }] },
    { ...old.accounts[1], stale: false, limits: [{ percent: 0 }] },
  ] });
  collector(x, 'claude', live(newer, ['a']));
  assert.equal(run(x, ['claude']).status, 1);
  const accounts = saved(x, 'claude').accounts;
  assert.equal(accounts[0].stale, false);
  assert.deepEqual(accounts[0].limits, [{ percent: 0.1 }]);
  assert.equal(accounts[1].stale, true);
  assert.deepEqual(accounts[1].limits, old.accounts[1].limits);
  assert.equal(accounts[1].fetchedAt, old.accounts[1].fetchedAt);
});

test('unidentifiable or omitted accounts never borrow freshness from active account', (t) => {
  const x = fixture(t);
  prior(x, 'claude', record('claude', { accounts: [{ id: 'old', fetchedAt: 123, limits: [{ percent: 1 }] }] }));
  collector(x, 'claude', json(record('claude', { accounts: [{ fetchedAt: Date.now(), limits: [{ percent: 0 }] }] })));
  assert.equal(run(x, ['claude']).status, 1);
  assert.ok(saved(x, 'claude').accounts.every(a => a.stale));
  assert.equal(saved(x, 'claude').accounts.find(a => a.id === 'old').limits[0].percent, 1);
});

test('unchanged cache preserves untouched windows as stale even under 15 seconds', async (t) => {
  for (const age of [1000, 20000]) {
    const x = fixture(t), value = record('claude', { limitsFetchedAt: Date.now() - age });
    prior(x, 'claude', value);
    collector(x, 'claude', json(value));
    assert.equal(run(x, ['claude']).status, 1);
    assert.deepEqual(saved(x, 'claude'), { ...value, limitsStale: true });
    await assertUnknown(x);
  }
});

test('unwritable durable control state prevents all calls on repeated invocations', (t) => {
  const x = fixture(t);
  collector(x, 'claude', live(record('claude')));
  const fail = `def fail(*args):\n raise OSError('secret disk error')\nm.os.replace=fail`;
  for (let i = 0; i < 2; i++) {
    const r = harness(x, fail);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no collector called/);
    assert.doesNotMatch(r.stdout + r.stderr, /secret disk error|retry deferred/);
  }
  assert.equal(calls(x), '');
  assert.deepEqual(fs.readdirSync(x.control), ['refresh.lock']);
});

test('post-call write failure leaves reserved backoff, explicit failure, and no retry call', (t) => {
  const x = fixture(t);
  collector(x, 'claude', live(record('claude')));
  const r = harness(x, `original=m.atomic\ndef fail(path,value):\n if path.name=='claude.state' and value['failures']==0: raise OSError('secret')\n original(path,value)\nm.atomic=fail`);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /write failed/);
  assert.doesNotMatch(r.stdout, /fresh quota published|retry deferred/);
  assert.equal(run(x, ['claude']).status, 0);
  assert.equal(calls(x).trim().split('\n').length, 1);
});

test('backoff doubles to 15m independently, and skips collector until eligible', (t) => {
  const x = fixture(t);
  collector(x, 'claude', 'exit 1');
  collector(x, 'copilot', live(record('copilot')));
  assert.equal(run(x).status, 1);
  assert.equal(saved(x, 'claude').limitsStale, true);
  assert.equal(run(x, ['claude']).status, 0);
  assert.equal(calls(x).trim().split('\n').length, 2);
  for (const delay of [120, 240, 480, 900, 900]) {
    eligible(x, 'claude');
    assert.match(run(x, ['claude']).stdout, new RegExp(`deferred ${delay}s`));
  }
  eligible(x, 'claude');
  collector(x, 'claude', live(record('claude')));
  assert.equal(run(x, ['claude']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.control, 'claude.state'))).failures, 0);
});

test('unsupported args make no writes or calls, no account-state/update invocation', (t) => {
  const x = fixture(t);
  for (const id of ['claude', 'copilot', 'update', 'account-state']) collector(x, id, live(record(id)));
  for (const args of [['--force'], ['claude', 'codex'], ['account-state'], ['openrouter']]) {
    assert.equal(run(x, args).status, 2);
    assert.equal(fs.existsSync(x.state), false);
  }
  assert.equal(run(x).status, 0);
  assert.doesNotMatch(calls(x), /update|account-state|force/);
});

test('symlink records, control files and state directory nodes are refused', (t) => {
  for (const which of ['record', 'control', 'directory', 'lock']) {
    const x = fixture(t);
    fs.mkdirSync(x.usage, { recursive: true });
    fs.mkdirSync(x.control, { recursive: true });
    const victim = path.join(x.home, 'victim');
    fs.writeFileSync(victim, 'UNCHANGED');
    let dest = which === 'record' ? path.join(x.usage, 'claude.json') :
      which === 'control' ? path.join(x.control, 'claude.state') :
      which === 'lock' ? path.join(x.control, 'refresh.lock') : x.usage;
    if (which === 'directory') fs.rmdirSync(dest);
    fs.symlinkSync(victim, dest);
    collector(x, 'claude', live(record('claude')));
    assert.notEqual(run(x, ['claude']).status, 0);
    assert.equal(calls(x), '');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'UNCHANGED');
  }
});

test('malformed previous record is not trusted', (t) => {
  const x = fixture(t);
  prior(x, 'claude', { id: 'copilot', limits: [{ percent: 0.9 }] });
  collector(x, 'claude', 'exit 1');
  assert.equal(run(x, ['claude']).status, 1);
  assert.deepEqual(saved(x, 'claude'), { id: 'claude', limits: [], limitsFetchedAt: 0, limitsStale: true });
});

async function waitFor(file) {
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(file));
}
test('lock prevents duplicates; SIGTERM kills collector process group and cleans temps', async (t) => {
  const x = fixture(t);
  collector(x, 'claude', 'sleep 30 &\necho $! > "$HOME/child"\nwait');
  const p = spawn('python3', [helper, 'claude'], { env: x.env });
  const done = new Promise(resolve => p.on('close', resolve));
  await waitFor(path.join(x.home, 'child'));
  assert.match(run(x, ['claude']).stdout, /another refresh/);
  p.kill('SIGTERM');
  assert.equal(await done, 130);
  const pid = fs.readFileSync(path.join(x.home, 'child'), 'utf8').trim();
  const proc = `/proc/${pid}/stat`;
  if (fs.existsSync(proc)) assert.match(fs.readFileSync(proc, 'utf8'), /\) Z /);
  assert.deepEqual(fs.readdirSync(x.usage), []);
  assert.equal(calls(x).trim().split('\n').length, 1);
});

test('timeout preserves old quota as stale and kills owned group', (t) => {
  const x = fixture(t), old = record('claude');
  prior(x, 'claude', old);
  collector(x, 'claude', 'sleep 30 &\necho $! > "$HOME/child"\nwait');
  const r = harness(x, 'assert m.TIMEOUT == 45\nm.TIMEOUT=0.5');
  assert.equal(r.status, 1);
  assert.deepEqual(saved(x, 'claude'), { ...old, limitsStale: true });
  const proc = `/proc/${fs.readFileSync(path.join(x.home, 'child'), 'utf8').trim()}/stat`;
  if (fs.existsSync(proc)) assert.match(fs.readFileSync(proc, 'utf8'), /\) Z /);
});

test('atomic write interruptions clean only owned staging files', (t) => {
  const x = fixture(t);
  fs.mkdirSync(x.usage, { recursive: true });
  fs.writeFileSync(path.join(x.usage, '.unrelated'), 'keep');
  collector(x, 'claude', live(record('claude')));
  const r = harness(x, `original=m.os.replace\ndef interrupt(source,dest):\n if dest.name=='claude.json': raise KeyboardInterrupt\n original(source,dest)\nm.os.replace=interrupt`);
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(x.usage), ['.unrelated']);
});

function installFixture(t, verifyExit = 0) {
  const x = fixture(t);
  const bin = path.join(x.home, 'stubs');
  fs.mkdirSync(bin);
  for (const cmd of ['systemd-analyze', 'systemctl']) fs.writeFileSync(path.join(bin, cmd),
    `#!/bin/sh\necho '${cmd}' >> "$HOME/tools"\nexit ${cmd === 'systemd-analyze' ? verifyExit : 99}\n`, { mode: 0o755 });
  x.env.PATH = `${bin}:${x.env.PATH}`;
  x.install = args => spawnSync('bash', [installer, ...args], { env: x.env, encoding: 'utf8' });
  x.target = path.join(x.home, '.local/bin/herdr-fleet-quota-refresh');
  return x;
}
test('installer checks by default, installs idempotently without activation', (t) => {
  const x = installFixture(t);
  assert.equal(x.install([]).status, 0);
  assert.equal(fs.existsSync(x.target), false);
  assert.equal(x.install(['--check']).status, 0);
  assert.equal(x.install(['--install']).status, 0);
  assert.equal(fs.readFileSync(x.target, 'utf8'), fs.readFileSync(helper, 'utf8'));
  assert.doesNotMatch(x.install(['--install']).stdout, /^installed:/m);
  assert.equal(x.install(['--enable']).status, 2);
  assert.equal(x.install(['--check', '--install']).status, 2);
  assert.doesNotMatch(fs.readFileSync(path.join(x.home, 'tools'), 'utf8'), /systemctl/);
});
test('installer refuses conflicts, symlinks, and failed verification before copying', (t) => {
  for (const type of ['conflict', 'symlink', 'verify']) {
    const x = installFixture(t, type === 'verify' ? 1 : 0);
    fs.mkdirSync(path.dirname(x.target), { recursive: true });
    if (type === 'conflict') fs.writeFileSync(x.target, 'keep');
    if (type === 'symlink') fs.symlinkSync(helper, x.target);
    assert.equal(x.install(['--install']).status, 1);
    if (type === 'verify') assert.equal(fs.existsSync(x.target), false);
    if (type === 'conflict') assert.equal(fs.readFileSync(x.target, 'utf8'), 'keep');
  }
});
test('user units are bounded oneshot with no credentials or global writes', () => {
  const service = fs.readFileSync(path.join(root, 'systemd/herdr-fleet-quota-refresh.service'), 'utf8');
  const timer = fs.readFileSync(path.join(root, 'systemd/herdr-fleet-quota-refresh.timer'), 'utf8');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.match(service, /^TimeoutStartSec=120$/m);
  assert.match(service, /^ExecStart=%h\/\.local\/bin\/herdr-fleet-quota-refresh claude copilot$/m);
  assert.match(timer, /^OnBootSec=30s$/m);
  assert.match(timer, /^OnUnitInactiveSec=60s$/m);
  assert.doesNotMatch(service + timer, /Environment=|TOKEN|sudo|\/home\//);
});
