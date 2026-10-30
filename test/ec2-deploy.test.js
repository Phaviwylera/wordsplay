const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve('deploy/ec2/update.sh');
const commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const previous = `walleto:${'b'.repeat(40)}`;
function harness({ failBuild = false, failStart = false, failProbe = false, alreadyDeployed = false, background = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-deploy-'));
  const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const repo = path.join(dir, 'repo');
  fs.mkdirSync(bin); fs.mkdirSync(state); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(state, 'current-image'), previous + '\n');
  if (background) fs.writeFileSync(path.join(state, 'background-enabled'), '');
  // The production deploy service runs as root; tests need not change ownership.
  fs.writeFileSync(path.join(bin, 'chown'), '#!/bin/bash\nexit 0\n');
  fs.chmodSync(path.join(bin, 'chown'), 0o755);
  if (alreadyDeployed) fs.writeFileSync(path.join(state, 'deployed.sha'), commit + '\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\necho "git $*" >> "$LOG"\nif [[ "$1" == rev-parse ]]; then echo "$COMMIT"; fi\n`);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
 echo "docker $*" >> "$LOG"
 if [[ "$1" == build && "$FAIL_BUILD" == 1 ]]; then exit 1; fi
 if [[ "$1" == exec && "$2" == walleto-app-candidate && "$FAIL_PROBE" == 1 ]]; then exit 1; fi
 if [[ "$1" == run && "$FAIL_START" == 1 && "$*" == *"$COMMIT"* && "$*" != *"candidate"* ]]; then exit 1; fi
 if [[ "$1 $2" == "image ls" ]]; then printf '%s\\n' "walleto:$COMMIT" "$PREVIOUS" "walleto:obsolete"; fi
 exit 0
`);
  for (const name of ['git', 'docker']) fs.chmodSync(path.join(bin, name), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO_DIR: repo, STATE_DIR: state, LOG: path.join(dir, 'log'), COMMIT: commit, PREVIOUS: previous, FAIL_BUILD: failBuild ? '1' : '0', FAIL_START: failStart ? '1' : '0', FAIL_PROBE: failProbe ? '1' : '0', PROBE_ATTEMPTS: '1' };
  const result = spawnSync('bash', [script], { env, encoding: 'utf8' });
  const log = fs.readFileSync(env.LOG, 'utf8');
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
