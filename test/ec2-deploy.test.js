const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve('deploy/ec2/update.sh');
const commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const previous = `walleto:${'b'.repeat(40)}`;
function harness({ failBuild = false, failStart = false, failProbe = false, failConcurrency, alreadyDeployed = false, background = false, concurrency, perNetwork, deployedSettings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-deploy-'));
  const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const repo = path.join(dir, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(state); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(state, 'current-image'), `${alreadyDeployed ? `walleto:${commit}` : previous}\n`);
  if (background) fs.writeFileSync(path.join(state, 'background-enabled'), '');
  // The production deploy service runs as root; tests need not change ownership.
  fs.writeFileSync(path.join(bin, 'chown'), '#!/bin/bash\nexit 0\n');
  fs.chmodSync(path.join(bin, 'chown'), 0o755);
  if (alreadyDeployed) {
    fs.writeFileSync(path.join(state, 'deployed.sha'), commit + '\n');
    fs.writeFileSync(path.join(state, 'deployed-worker-settings'), `${deployedSettings ?? (background ? 'enabled:12:3' : 'disabled')}\n`);
  }
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\necho "git $*" >> "$LOG"\nif [[ "$1" == rev-parse ]]; then echo "$COMMIT"; fi\n`);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
 echo "docker $*" >> "$LOG"
 if [[ "$1" == build && "$FAIL_BUILD" == 1 ]]; then exit 1; fi
 if [[ "$1" == exec && "$2" == walleto-app-candidate && "$FAIL_PROBE" == 1 ]]; then exit 1; fi
 if [[ "$1" == run && "$FAIL_START" == 1 && "$*" == *"$COMMIT"* && "$*" != *"candidate"* ]]; then exit 1; fi
 if [[ "$1" == run && -n "$FAIL_CONCURRENCY" && "$*" == *"WALLETO_SCAN_CONCURRENCY=$FAIL_CONCURRENCY"* ]]; then exit 1; fi
 if [[ "$1 $2" == "image ls" ]]; then printf '%s\\n' "walleto:$COMMIT" "$PREVIOUS" "walleto:obsolete"; fi
 exit 0
`);
  for (const name of ['git', 'docker']) fs.chmodSync(path.join(bin, name), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO_DIR: repo, STATE_DIR: state, LOG: path.join(dir, 'log'), COMMIT: commit, PREVIOUS: previous, FAIL_BUILD: failBuild ? '1' : '0', FAIL_START: failStart ? '1' : '0', FAIL_PROBE: failProbe ? '1' : '0', FAIL_CONCURRENCY: failConcurrency || '', PROBE_ATTEMPTS: '1' };
  delete env.WALLETO_SCAN_CONCURRENCY; delete env.WALLETO_SCAN_PER_NETWORK;
  if (concurrency !== undefined) env.WALLETO_SCAN_CONCURRENCY = concurrency;
  if (perNetwork !== undefined) env.WALLETO_SCAN_PER_NETWORK = perNetwork;
  const result = spawnSync('bash', [script], { env, encoding: 'utf8' });
  const log = fs.existsSync(env.LOG) ? fs.readFileSync(env.LOG, 'utf8') : '';
  return { dir, state, result, log };
}

test('successful deploy probes the new image before replacing the current app', () => {
  const h = harness();
  try {
    assert.equal(h.result.status, 0, h.result.stderr);
    assert.match(h.log, /docker build -t walleto:a{40} \./);
    assert.ok(h.log.indexOf('docker exec walleto-app-candidate') < h.log.indexOf('docker rm -f walleto-app\n'));
    assert.equal(fs.readFileSync(path.join(h.state, 'deployed.sha'), 'utf8').trim(), commit);
    assert.match(h.log, /docker image rm walleto:obsolete/);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('build failure leaves the existing container and deployed commit untouched', () => {
  const h = harness({ failBuild: true });
  try {
    assert.notEqual(h.result.status, 0);
    assert.doesNotMatch(h.log, /docker rm -f walleto-app\n/);
    assert.equal(fs.existsSync(path.join(h.state, 'deployed.sha')), false);
    assert.equal(fs.readFileSync(path.join(h.state, 'current-image'), 'utf8').trim(), previous);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('failed new app restores the previous image and does not mark the new commit deployed', () => {
  const h = harness({ failStart: true });
  try {
    assert.notEqual(h.result.status, 0);
    assert.ok(h.log.includes(`docker run -d --name walleto-app --restart unless-stopped -p 127.0.0.1:3000:3000 ${previous}`));
    assert.equal(fs.existsSync(path.join(h.state, 'deployed.sha')), false);
    assert.equal(fs.readFileSync(path.join(h.state, 'current-image'), 'utf8').trim(), previous);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('already healthy deployment skips building and replacing the container', () => {
  const h = harness({ alreadyDeployed: true });
  try {
    assert.equal(h.result.status, 0, h.result.stderr);
    assert.doesNotMatch(h.log, /docker build/);
    assert.doesNotMatch(h.log, /docker rm -f walleto-app\n/);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});


test('failed candidate health check leaves the running app untouched', () => {
  const h = harness({ failProbe: true });
  try {
    assert.notEqual(h.result.status, 0);
    assert.doesNotMatch(h.log, /docker rm -f walleto-app\n/);
    assert.equal(fs.existsSync(path.join(h.state, 'deployed.sha')), false);
    assert.equal(fs.readFileSync(path.join(h.state, 'current-image'), 'utf8').trim(), previous);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('background volume is private, persistent and opt-in', () => {
  const normal = harness();
  const enabled = harness({ background: true });
  try {
    assert.equal(normal.result.status, 0, normal.result.stderr);
    assert.doesNotMatch(normal.log, /WALLETO_BACKGROUND_DIR/);
    assert.equal(enabled.result.status, 0, enabled.result.stderr);
    assert.match(enabled.log, /-p 127\.0\.0\.1:3000:3000 -e WALLETO_BACKGROUND_DIR=\/var\/lib\/walleto-jobs -v .*\/background-jobs:\/var\/lib\/walleto-jobs/);
    assert.equal(fs.statSync(path.join(enabled.state, 'background-jobs')).mode & 0o777, 0o700);
  } finally { fs.rmSync(normal.dir, { recursive: true, force: true }); fs.rmSync(enabled.dir, { recursive: true, force: true }); }
});

test('private worker settings are passed to the single app container and recorded', () => {
  const h = harness({ background: true, concurrency: '20', perNetwork: '4' });
  try {
    assert.equal(h.result.status, 0, h.result.stderr);
    assert.match(h.log, /-e WALLETO_SCAN_CONCURRENCY=20 -e WALLETO_SCAN_PER_NETWORK=4/);
    assert.equal(fs.readFileSync(path.join(h.state, 'deployed-worker-settings'), 'utf8').trim(), 'enabled:20:4');
    assert.equal((h.log.match(/docker run -d --name walleto-app --restart/g) || []).length, 1, 'does not launch additional app processes');
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('changing worker settings redeploys the same commit; unchanged settings do not', () => {
  const changed = harness({ alreadyDeployed: true, background: true, concurrency: '20', perNetwork: '4', deployedSettings: 'enabled:12:3' });
  const same = harness({ alreadyDeployed: true, background: true, concurrency: '20', perNetwork: '4', deployedSettings: 'enabled:20:4' });
  try {
    assert.equal(changed.result.status, 0, changed.result.stderr);
    assert.doesNotMatch(changed.log, /docker build/, 'configuration-only changes reuse the rollback image');
    assert.match(changed.log, /docker image inspect walleto:a{40}/);
    assert.match(changed.log, /WALLETO_SCAN_CONCURRENCY=20/);
    assert.equal(fs.readFileSync(path.join(changed.state, 'deployed-worker-settings'), 'utf8').trim(), 'enabled:20:4');
    assert.equal(same.result.status, 0, same.result.stderr);
    assert.doesNotMatch(same.log, /docker build/);
    assert.doesNotMatch(same.log, /docker rm -f walleto-app\n/);
  } finally { fs.rmSync(changed.dir, { recursive: true, force: true }); fs.rmSync(same.dir, { recursive: true, force: true }); }
});

test('invalid worker settings are rejected before replacing the running EC2 app', () => {
  for (const options of [
    { concurrency: '0' }, { concurrency: '41' }, { concurrency: '' }, { concurrency: '04' },
    { perNetwork: '0' }, { perNetwork: '9' }, { perNetwork: '3.5' },
  ]) {
    const h = harness({ background: true, ...options });
    try {
      assert.notEqual(h.result.status, 0);
      assert.match(h.result.stderr, /WALLETO_SCAN_/);
      assert.doesNotMatch(h.log, /docker build/);
      assert.doesNotMatch(h.log, /docker rm -f walleto-app\n/);
      assert.equal(fs.readFileSync(path.join(h.state, 'current-image'), 'utf8').trim(), previous);
    } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test('enabling the private worker redeploys even when the commit is unchanged', () => {
  const h = harness({ alreadyDeployed: true, background: true, deployedSettings: 'disabled' });
  try {
    assert.equal(h.result.status, 0, h.result.stderr);
    assert.match(h.log, /WALLETO_BACKGROUND_DIR=/);
    assert.equal(fs.readFileSync(path.join(h.state, 'deployed-worker-settings'), 'utf8').trim(), 'enabled:12:3');
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('a failed settings change restores the previous image and previous worker limits', () => {
  const h = harness({ alreadyDeployed: true, background: true, concurrency: '20', perNetwork: '4', deployedSettings: 'enabled:12:3', failConcurrency: '20' });
  try {
    assert.notEqual(h.result.status, 0);
    assert.match(h.log, /WALLETO_SCAN_CONCURRENCY=20 -e WALLETO_SCAN_PER_NETWORK=4/);
    assert.match(h.log, /WALLETO_SCAN_CONCURRENCY=12 -e WALLETO_SCAN_PER_NETWORK=3/);
    assert.match(h.result.stderr, /previous worker settings/);
    assert.equal(fs.readFileSync(path.join(h.state, 'deployed-worker-settings'), 'utf8').trim(), 'enabled:12:3');
    assert.equal(fs.readFileSync(path.join(h.state, 'deployed.sha'), 'utf8').trim(), commit);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('rollback does not re-enable a private worker whose opt-in flag was removed', () => {
  const h = harness({ alreadyDeployed: true, background: false, deployedSettings: 'enabled:12:3', failStart: true });
  try {
    assert.notEqual(h.result.status, 0);
    const starts = h.log.split('\n').filter(line => line.startsWith('docker run -d --name walleto-app --restart'));
    assert.equal(starts.length, 2);
    assert.ok(starts.every(line => !line.includes('WALLETO_BACKGROUND_DIR')));
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});
