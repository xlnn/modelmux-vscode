'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Module = require('module');

if (process.platform !== 'linux') {
  console.log('SKIP: Linux smoke test only.');
  process.exit(0);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-linux-test-'));
const home = path.join(sandbox, 'home');
const tmp = path.join(sandbox, 'tmp');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.TMPDIR = tmp;
delete process.env.CODEX_HOME;

const values = new Map();
const secrets = new Map();
const mockVscode = {
  env: { remoteName: 'ssh-remote' },
  workspace: {
    getConfiguration() {
      return { get(_key, fallback) { return fallback; } };
    },
    async openTextDocument(options) { return options; },
    fs: {
      async writeFile() {},
      async readFile() { return Buffer.from('{}'); }
    }
  },
  window: {
    async showTextDocument() {},
    async showErrorMessage() {},
    async showInformationMessage() {},
    async showWarningMessage() {},
    async showInputBox() {},
    async showQuickPick() {},
    createStatusBarItem() { return { show() {}, dispose() {} }; }
  },
  commands: { async executeCommand() {}, registerCommand() { return { dispose() {} }; } },
  StatusBarAlignment: { Right: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { file(value) { return { fsPath: value }; }, joinPath(...parts) { return parts.join('/'); } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../extension.js');
const api = extension.__test;

(async () => {
  assert(api, 'test API is exported');
  const files = api.pathsForCurrentUser();
  assert.strictEqual(files.config, path.join(home, '.codex', 'config.toml'));
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const preferredRuntimeToken = path.join(`/run/user/${uid}`, `codex-model-profile-token-${uid}`);
  assert(
    files.token === preferredRuntimeToken || files.token.startsWith(tmp + path.sep),
    `runtime token should use /run/user/<uid> when private, otherwise stay under TMPDIR: ${files.token}`
  );

  const cat = api.resolveUnixCatCommand();
  assert(['/bin/cat', '/usr/bin/cat', 'cat'].includes(cat));

  const profile = api.normalizeProfileFromGui({
    kind: 'customResponses',
    name: 'Linux Test',
    providerId: 'linux_test',
    baseUrl: 'https://example.invalid/v1',
    authMode: 'secret',
    selectedModel: 'test-model',
    models: ['test-model'],
    reasoningPolicy: 'none',
    requestMaxRetries: 0,
    streamMaxRetries: 2,
    streamIdleTimeoutMs: 300000
  });

  const key = 'test-secret-not-a-real-key';
  await api.writeRuntimeToken(files.token, key);
  const tokenStat = fs.statSync(files.token);
  assert.strictEqual(tokenStat.mode & 0o777, 0o600, 'token mode must be 600');
  assert.strictEqual(tokenStat.uid, process.getuid(), 'token owner must be current user');

  const helper = api.authCommandForToken(files.token);
  const output = childProcess.execFileSync(helper.command, helper.args, { encoding: 'utf8' });
  assert.strictEqual(output, key, 'token helper must return exact key without extra bytes');

  const config = api.buildManagedConfig(profile, 'test-model', files.token);
  assert(config.includes('wire_api = "responses"'));
  assert(config.includes('request_max_retries = 0'));
  assert(config.includes('stream_max_retries = 2'));
  assert(config.includes(`command = "${helper.command}"`));
  assert(config.includes(files.token));

  fs.mkdirSync(path.dirname(files.config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(files.config, '# original user configuration\nmodel = "original"\n', { mode: 0o600 });
  await api.ensureOriginalBackup(files);
  assert(fs.existsSync(files.backup), 'original config backup must be created');
  assert(fs.existsSync(files.originalState), 'original state record must be created');
  await api.writeAtomic(files.config, config);
  assert.strictEqual(fs.statSync(files.config).mode & 0o777, 0o600, 'config mode must be 600');

  // Symbolic links must not be followed when writing a runtime token.
  await api.removeRuntimeToken(files.token);
  const victim = path.join(sandbox, 'victim');
  fs.writeFileSync(victim, 'unchanged', { mode: 0o600 });
  fs.symlinkSync(victim, files.token);
  let symlinkRejected = false;
  try {
    await api.writeRuntimeToken(files.token, 'overwrite-attempt');
  } catch {
    symlinkRejected = true;
  }
  assert(symlinkRejected, 'symlink token path must be rejected');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'unchanged');
  fs.unlinkSync(files.token);
  await api.writeRuntimeToken(files.token, key);

  values.set('modelProfilesV2', [profile]);
  values.set('activeProfileIdV2', profile.id);
  secrets.set(`modelProfileApiKey:${profile.id}`, key);
  const context = {
    globalState: {
      get(name, fallback) { return values.has(name) ? values.get(name) : fallback; },
      async update(name, value) { values.set(name, value); }
    },
    secrets: {
      async get(name) { return secrets.get(name); },
      async store(name, value) { secrets.set(name, value); },
      async delete(name) { secrets.delete(name); }
    },
    extension: { packageJSON: { version: '1.1.0' }, id: 'lichao-local.codex-config-switcher' }
  };

  const diagnostics = await api.collectDiagnostics(context);
  assert.strictEqual(diagnostics.failed, 0, JSON.stringify(diagnostics.checks, null, 2));

  console.log('PASS: Linux config, token helper, permissions, symlink safety and diagnostics.');
})().finally(() => {
  Module._load = originalLoad;
  fs.rmSync(sandbox, { recursive: true, force: true });
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
