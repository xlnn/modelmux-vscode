'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const http = require('http');
const TOML = require('@iarna/toml');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmux-security-test-'));
const previousOpenCodeDir = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, 'missing-opencode-home');
const warningMessages = [];
let acceptWarning = true;

const mockVscode = {
  env: { remoteName: undefined },
  workspace: {
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
  },
  window: {
    async showWarningMessage(...args) {
      warningMessages.push(args);
      return acceptWarning ? args.at(-1) : undefined;
    }
  },
  commands: {},
  Uri: { file(value) { return { fsPath: value }; } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const api = require('../extension.js').__test;

function requireTestApis(names) {
  const missing = names.filter(name => typeof api[name] !== 'function');
  assert.deepStrictEqual(missing, [], `extension.__test is missing: ${missing.join(', ')}`);
}

function profile(overrides = {}) {
  return {
    id: 'shared-profile',
    kind: 'customResponses',
    name: 'Gateway',
    providerId: 'gateway',
    providerName: 'Gateway',
    baseUrl: 'https://gateway.example/v1',
    authMode: 'env',
    envKey: 'MODEL_SWITCH_API_KEY',
    selectedModel: 'model-a',
    models: ['model-a'],
    reasoningPolicy: 'none',
    ...overrides
  };
}

function plannedProfiles(plan) {
  if (Array.isArray(plan)) return plan;
  assert(plan && Array.isArray(plan.profiles), 'import plan must expose the resulting profiles');
  return plan.profiles;
}

(async () => {
  requireTestApis([
    'exportableProfile',
    'validateWebviewMessage',
    'collectTargetDiagnostics',
    'createImportPlan',
    'applyImportPlan',
    'getTargetManagementState',
    'assertTargetCanApply',
    'assertTargetSnapshotUnchanged',
    'canAutomaticallyRefreshManagedConfig',
    'parseManagedCodexMetadata',
    'reconcileManagedCodexState',
    'canRecreateRuntimeTokenFromManagedConfig',
    'recreateRuntimeTokenIfNeeded',
    'mergeManagedCodexConfig',
    'requestJson',
    'commitProfileAndSecret',
    'originalContentForTarget',
    'writeAtomic',
    'buildRestoredCodexConfig',
    'removeFileAtomicallyIfUnchanged',
    'activateProfile',
    'updateActiveTarget',
    'getActiveTargets',
    'restoreOriginal'
  ]);

  const secretValues = [
    'Bearer export-secret',
    'header-api-key-secret',
    'cookie-session-secret',
    'query-token-secret',
    'query-signature-secret'
  ];
  const exported = api.exportableProfile(profile({
    httpHeaders: {
      Authorization: secretValues[0],
      'X-API-Key': secretValues[1],
      Cookie: secretValues[2],
      'X-Client': 'modelmux-smoke'
    },
    queryParams: {
      access_token: secretValues[3],
      signature: secretValues[4],
      'api-version': '2026-08-01'
    },
    hasSecret: true,
    requiresSecret: true,
    active: true,
    envReady: true
  }));
  const exportedText = JSON.stringify(exported);
  const leakedSecretValues = secretValues.filter(value => exportedText.includes(value));
  assert(exportedText.includes('modelmux-smoke'), 'ordinary static headers must remain portable');
  assert(exportedText.includes('2026-08-01'), 'ordinary query parameters must remain portable');
  for (const runtimeOnly of ['hasSecret', 'requiresSecret', 'active', 'envReady']) {
    assert(!Object.prototype.hasOwnProperty.call(exported, runtimeOnly), `${runtimeOnly} is runtime-only state`);
  }
  const genericSecrets = api.exportableProfile(profile({
    baseUrl: 'https://url-user:url-password@gateway.example/v1?api_key=url-query-secret&api-version=2026-08-01',
    modelDiscoveryPath: '/models?token=discovery-secret&api-version=2026-08-01',
    httpHeaders: { token: 'generic-token-secret', 'X-Token': 'x-token-secret', 'X-Client': 'safe' },
    queryParams: { key: 'generic-key-secret', 'api-version': '2026-08-01' }
  }));
  const genericExport = JSON.stringify(genericSecrets);
  for (const value of ['url-user', 'url-password', 'url-query-secret', 'discovery-secret', 'generic-token-secret', 'x-token-secret', 'generic-key-secret']) {
    assert(!genericExport.includes(value), `export leaked ${value}`);
  }
  assert(genericExport.includes('api-version'));
  assert.strictEqual(genericSecrets.baseUrl, 'https://gateway.example/v1?api-version=2026-08-01');
  assert.strictEqual(genericSecrets.modelDiscoveryPath, '/models?api-version=2026-08-01');
  assert.deepStrictEqual(genericSecrets.httpHeaders, { 'X-Client': 'safe' });
  assert.deepStrictEqual(genericSecrets.queryParams, { 'api-version': '2026-08-01' });
  assert.throws(() => api.normalizeProfileFromGui({
    ...profile(), name: 'bad\nname', selectedModel: 'model-a'
  }), /control characters|控制字符/);
  assert.throws(() => api.normalizeProfileFromGui({
    ...profile(), baseUrl: 'https://user:password@gateway.example/v1'
  }), /username or password|用户名或密码/);
  assert.throws(() => api.normalizeProfileFromGui({
    ...profile(), baseUrl: 'https://gateway.example/v1?access_token=secret'
  }), /credential-like query|疑似凭据/);
  assert.throws(() => api.buildManagedConfig(profile({
    baseUrl: 'https://legacy-user:legacy-password@gateway.example/v1'
  }), 'model-a', path.join(sandbox, 'legacy-token')), /username or password|用户名或密码/,
  'previously saved profiles must not bypass Base URL validation');
  assert.throws(() => api.buildManagedConfig(profile({
    baseUrl: 'https://gateway.example/v1?api_key=legacy-secret'
  }), 'model-a', path.join(sandbox, 'legacy-token')), /credential-like query|疑似凭据/,
  'previously saved profiles must not write query-string credentials');

  const oversizedServer = http.createServer((request, response) => {
    response.on('error', () => {});
    if (request.url === '/declared-models') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(4 * 1024 * 1024 + 1)
      });
      response.end('{}');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    });
    const chunk = 'x'.repeat(64 * 1024);
    for (let index = 0; index < 65; index += 1) response.write(chunk);
    response.end();
  });
  await new Promise((resolve, reject) => {
    oversizedServer.once('error', reject);
    oversizedServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = oversizedServer.address();
    await assert.rejects(
      api.requestJson(`http://127.0.0.1:${address.port}/declared-models`, {}, 2000),
      /exceeded 4 MB|超过 4 MB/,
      'model discovery must reject an oversized response before buffering it'
    );
    await assert.rejects(
      api.requestJson(`http://127.0.0.1:${address.port}/chunked-models`, {}, 2000),
      /exceeded 4 MB|超过 4 MB/,
      'model discovery must enforce the limit when Content-Length is absent'
    );
  } finally {
    await new Promise(resolve => oversizedServer.close(resolve));
  }

  assert.doesNotThrow(() => api.validateWebviewMessage({ command: 'ready' }));
  assert.doesNotThrow(() => api.validateWebviewMessage({
    command: 'activateProfile',
    requestId: 'request-1',
    targetId: 'opencode',
    profileId: 'profile-1',
    model: 'claude-3-7-sonnet'
  }));
  const invalidMessages = [
    null,
    {},
    { command: 'unknownOperation', requestId: 'request-2' },
    { command: 'selectTarget', targetId: '../codex' },
    { command: 'activateProfile', profileId: { value: 'profile-1' }, model: 'gpt-5' },
    { command: 'updateUiSettings', fontSize: '13' },
    { command: 'saveProfile', profile: [], apiKey: 'not-relevant' }
  ];
  const acceptedInvalidMessages = invalidMessages.filter(message => {
    try {
      api.validateWebviewMessage(message);
      return true;
    } catch {
      return false;
    }
  });

  const missingDirectory = process.env.OPENCODE_CONFIG_DIR;
  assert(!fs.existsSync(missingDirectory));
  const values = new Map();
  const context = {
    globalState: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) { values.set(key, value); }
    },
    secrets: { async get() { return undefined; } }
  };
  const stateKey = key => api.environmentStateKey(context, key);
  const diagnostics = await api.collectTargetDiagnostics(context, 'opencode');
  assert(diagnostics && Array.isArray(diagnostics.checks));
  assert(!fs.existsSync(missingDirectory), 'read-only diagnostics must not create a missing CLI configuration directory');

  const rollbackPrevious = [profile({ authMode: 'secret', name: 'Before rollback' })];
  const rollbackNext = [profile({ authMode: 'secret', name: 'After rollback' })];
  const rollbackValues = new Map();
  const rollbackSecrets = new Map();
  let rollbackStoreCalls = 0;
  const rollbackContext = {
    globalState: {
      get(key, fallback) { return rollbackValues.has(key) ? rollbackValues.get(key) : fallback; },
      async update(key, value) { if (value === undefined) rollbackValues.delete(key); else rollbackValues.set(key, value); }
    },
    secrets: {
      async get(key) { return rollbackSecrets.get(key); },
      async store(key, value) {
        rollbackStoreCalls += 1;
        if (rollbackStoreCalls === 1) throw new Error('simulated SecretStorage failure');
        rollbackSecrets.set(key, value);
      },
      async delete(key) { rollbackSecrets.delete(key); }
    }
  };
  const rollbackProfilesKey = api.environmentStateKey(rollbackContext, 'modelProfilesV2');
  const rollbackSecretKey = api.profileSecretKey(rollbackContext, 'shared-profile');
  rollbackValues.set(rollbackProfilesKey, rollbackPrevious);
  rollbackSecrets.set(rollbackSecretKey, 'old-secret');
  await assert.rejects(
    api.commitProfileAndSecret(rollbackContext, rollbackPrevious, rollbackNext, rollbackNext[0], 'new-secret'),
    /simulated SecretStorage failure/
  );
  assert.deepStrictEqual(rollbackValues.get(rollbackProfilesKey), rollbackPrevious,
    'a SecretStorage failure must roll back the provider list');
  assert.strictEqual(rollbackSecrets.get(rollbackSecretKey), 'old-secret',
    'a SecretStorage failure must restore the previous credential');

  const stateFailureValues = new Map();
  let stateFailureSecretWrites = 0;
  const stateFailureContext = {
    globalState: {
      get(key, fallback) { return stateFailureValues.has(key) ? stateFailureValues.get(key) : fallback; },
      async update() { throw new Error('simulated GlobalState failure'); }
    },
    secrets: {
      async get() { return 'old-secret'; },
      async store() { stateFailureSecretWrites += 1; },
      async delete() { stateFailureSecretWrites += 1; }
    }
  };
  const stateFailureProfilesKey = api.environmentStateKey(stateFailureContext, 'modelProfilesV2');
  stateFailureValues.set(stateFailureProfilesKey, rollbackPrevious);
  await assert.rejects(
    api.commitProfileAndSecret(stateFailureContext, rollbackPrevious, rollbackNext, rollbackNext[0], 'new-secret'),
    /simulated GlobalState failure/
  );
  assert.deepStrictEqual(stateFailureValues.get(stateFailureProfilesKey), rollbackPrevious);
  assert.strictEqual(stateFailureSecretWrites, 0,
    'a GlobalState failure must not partially update SecretStorage');

  const managedDir = path.join(sandbox, 'codex-management');
  fs.mkdirSync(managedDir, { recursive: true });
  const managedFiles = {
    targetId: 'codex',
    configDir: managedDir,
    config: path.join(managedDir, 'config.toml'),
    backup: path.join(managedDir, 'config.toml.backup'),
    originalState: path.join(managedDir, 'config.toml.state.json')
  };
  const managedContent = '# Managed by Codex Model Profile Manager\nmodel = "gpt-5"\n';
  const originalManagedContent = 'model = "original"\n';
  fs.writeFileSync(managedFiles.backup, originalManagedContent);
  fs.writeFileSync(managedFiles.config, managedContent);
  fs.writeFileSync(managedFiles.originalState, JSON.stringify({
    existed: true,
    originalHash: api.contentHash(originalManagedContent),
    lastAppliedHash: api.contentHash(managedContent),
    profileId: 'shared-profile',
    model: 'gpt-5'
  }));
  values.set(stateKey('activeCliTargetsV1'), {
    codex: { profileId: 'shared-profile', model: 'gpt-5' }
  });
  const clean = await api.getTargetManagementState(context, 'codex', managedFiles);
  assert.strictEqual(clean.status, 'managed-clean');
  assert.strictEqual(clean.canApply, true);
  assert.strictEqual(api.canAutomaticallyRefreshManagedConfig(clean), true);
  assert.strictEqual(api.canAutomaticallyRefreshManagedConfig({
    ...clean,
    originalState: { ...clean.originalState, automaticRefreshDisabled: true }
  }), false, 'adopted legacy Codex configs must not be rebuilt automatically');

  fs.writeFileSync(managedFiles.config, `${managedContent}# external edit\n`);
  const drifted = await api.getTargetManagementState(context, 'codex', managedFiles);
  assert.strictEqual(drifted.status, 'managed-drifted');
  assert.strictEqual(drifted.canApply, true, 'a drifted config must allow an explicit reapply flow');
  assert.strictEqual(drifted.requiresApplyConfirmation, true);
  assert.strictEqual(api.canAutomaticallyRefreshManagedConfig(drifted), false);
  acceptWarning = false;
  assert.strictEqual(
    await api.assertTargetCanApply(context, 'codex', managedFiles, true),
    undefined,
    'cancelling the drift warning must leave the configuration untouched'
  );
  acceptWarning = true;
  const confirmedDrift = await api.assertTargetCanApply(context, 'codex', managedFiles, true);
  assert.strictEqual(confirmedDrift.status, 'managed-drifted');
  assert(
    warningMessages.some(args => String(args[0]).includes('重新应用') || String(args[0]).includes('Reapplying')),
    'reapply must explain that the current file will be replaced'
  );
  await api.assertTargetSnapshotUnchanged(confirmedDrift, managedFiles);
  fs.appendFileSync(managedFiles.config, '# changed again after confirmation\n');
  await assert.rejects(
    api.assertTargetSnapshotUnchanged(confirmedDrift, managedFiles),
    /发生了变化|changed/,
    'a second external edit after confirmation must abort the write'
  );
  fs.rmSync(managedFiles.backup);
  const missingBackup = await api.getTargetManagementState(context, 'codex', managedFiles);
  assert.strictEqual(missingBackup.status, 'backup-missing', 'a missing original backup must outrank managed drift');
  assert.strictEqual(missingBackup.canApply, false);
  await assert.rejects(
    api.assertTargetCanApply(context, 'codex', managedFiles, true),
    /备份缺失|Backup.*missing/i,
    'reapply must be blocked when the recorded original backup is gone'
  );

  const atomicDir = path.join(sandbox, 'atomic-rollback');
  fs.mkdirSync(atomicDir, { recursive: true });
  const atomicFile = path.join(atomicDir, 'config.toml');
  fs.writeFileSync(atomicFile, 'old-content\n');
  await assert.rejects(
    api.writeAtomic(atomicFile, 'new-content\n', undefined, {
      async afterInstall() { throw new Error('simulated post-install failure'); }
    }),
    /simulated post-install failure/
  );
  assert.strictEqual(fs.readFileSync(atomicFile, 'utf8'), 'old-content\n',
    'a failure after installing the replacement must restore the old file');
  fs.writeFileSync(atomicFile, 'old-content\n');
  await assert.rejects(
    api.writeAtomic(atomicFile, 'new-content\n', undefined, {
      async afterDisplace() { fs.writeFileSync(atomicFile, 'external-content\n'); }
    }),
    /发生了变化|changed|恢复副本/i
  );
  assert.strictEqual(fs.readFileSync(atomicFile, 'utf8'), 'external-content\n',
    'an external edit before the final replace check must never be overwritten');
  const newlyCreatedFile = path.join(atomicDir, 'new-config.toml');
  await assert.rejects(
    api.writeAtomic(newlyCreatedFile, 'new-content\n', undefined, {
      async afterInstall() { throw new Error('simulated new-file permission failure'); }
    }),
    /simulated new-file permission failure/
  );
  assert.strictEqual(fs.existsSync(newlyCreatedFile), false,
    'a failed first write must not leave an uncommitted replacement behind');
  const linkedFile = path.join(atomicDir, 'linked-config.toml');
  await assert.rejects(
    api.writeAtomic(linkedFile, 'new-content\n', undefined, {
      async afterLinkInstall() { throw new Error('simulated temporary-link cleanup failure'); }
    }),
    /simulated temporary-link cleanup failure/
  );
  assert.strictEqual(fs.existsSync(linkedFile), false,
    'a failure after the exclusive hard-link install must roll back the new target');
  const backupRaceDir = path.join(atomicDir, 'backup-race');
  fs.mkdirSync(backupRaceDir);
  const backupRaceFiles = {
    targetId: 'codex',
    config: path.join(backupRaceDir, 'config.toml'),
    backup: path.join(backupRaceDir, 'config.toml.backup'),
    originalState: path.join(backupRaceDir, 'config.toml.state.json')
  };
  fs.writeFileSync(backupRaceFiles.config, 'original-content\n');
  const originalCopyFile = fs.promises.copyFile;
  fs.promises.copyFile = async (...args) => {
    await originalCopyFile.apply(fs.promises, args);
    if (args[0] === backupRaceFiles.config) fs.writeFileSync(backupRaceFiles.config, 'external-content\n');
  };
  try {
    await assert.rejects(api.ensureOriginalBackup(backupRaceFiles), /创建原始备份期间发生了变化/);
  } finally {
    fs.promises.copyFile = originalCopyFile;
  }
  assert.strictEqual(fs.existsSync(backupRaceFiles.backup), false,
    'a raced original backup must be removed');
  assert.strictEqual(fs.existsSync(backupRaceFiles.originalState), false,
    'a raced original backup must not create an ownership record');
  const invalidStateFiles = {
    originalState: path.join(atomicDir, 'state-is-directory')
  };
  fs.mkdirSync(invalidStateFiles.originalState);
  await assert.rejects(api.readOriginalState(invalidStateFiles), /不是普通文件|not.*regular/i,
    'state I/O errors must not be silently treated as a missing state record');
  const directoryTarget = path.join(atomicDir, 'directory-target');
  fs.mkdirSync(directoryTarget);
  await assert.rejects(api.writeAtomic(directoryTarget, 'unsafe\n'), /不是普通文件|not.*regular/i);
  const deleteRaceFile = path.join(atomicDir, 'delete-race.toml');
  fs.writeFileSync(deleteRaceFile, 'managed-content\n');
  await assert.rejects(
    api.removeFileAtomicallyIfUnchanged(deleteRaceFile, undefined, {
      async afterMove() { fs.writeFileSync(deleteRaceFile, 'external-content\n'); }
    }),
    /重新创建|recreated|原内容保留/i,
    'an external file created during restore must not be deleted or treated as a successful restore'
  );
  assert.strictEqual(fs.readFileSync(deleteRaceFile, 'utf8'), 'external-content\n');

  const activeFailureValues = new Map();
  const activeTargetsKey = api.environmentStateKey(context, 'activeCliTargetsV1');
  const legacyActiveKey = api.environmentStateKey(context, 'activeProfileIdV2');
  activeFailureValues.set(activeTargetsKey, { codex: { profileId: 'old-profile', model: 'old-model' } });
  activeFailureValues.set(legacyActiveKey, 'old-profile');
  let failLegacyUpdate = true;
  const activeFailureContext = {
    globalState: {
      get(key, fallback) { return activeFailureValues.has(key) ? activeFailureValues.get(key) : fallback; },
      async update(key, value) {
        if (value === undefined) activeFailureValues.delete(key); else activeFailureValues.set(key, value);
        if (key === legacyActiveKey && value === 'new-profile' && failLegacyUpdate) {
          failLegacyUpdate = false;
          throw new Error('simulated legacy active-state failure');
        }
      }
    }
  };
  await assert.rejects(
    api.updateActiveTarget(activeFailureContext, 'codex', { profileId: 'new-profile', model: 'new-model' }),
    /simulated legacy active-state failure/
  );
  assert.deepStrictEqual(activeFailureValues.get(activeTargetsKey), {
    codex: { profileId: 'old-profile', model: 'old-model' }
  }, 'a failure updating the legacy active key must roll back the canonical active-target map');
  assert.strictEqual(activeFailureValues.get(legacyActiveKey), 'old-profile');
  activeFailureValues.set(activeTargetsKey, {});
  activeFailureValues.set(legacyActiveKey, 'stale-profile');
  assert.strictEqual(api.getActiveTargets(activeFailureContext).codex, undefined,
    'a stale legacy key must not resurrect Codex after the canonical target map exists');

  const transactionDir = path.join(sandbox, 'codex-activation-transaction');
  fs.mkdirSync(transactionDir, { recursive: true });
  const transactionFiles = {
    targetId: 'codex',
    configDir: transactionDir,
    codexDir: transactionDir,
    config: path.join(transactionDir, 'config.toml'),
    backup: path.join(transactionDir, 'config.toml.original-backup'),
    originalState: path.join(transactionDir, 'config.toml.state.json'),
    token: path.join(transactionDir, 'runtime-token')
  };
  fs.writeFileSync(transactionFiles.config, 'model = "original-model"\n');
  const transactionProfile = profile({
    id: 'transaction-profile',
    selectedModel: 'old-model',
    models: ['old-model', 'new-model']
  });
  const transactionValues = new Map();
  const transactionProfilesKey = api.environmentStateKey(context, 'modelProfilesV2');
  const transactionTargetsKey = api.environmentStateKey(context, 'activeCliTargetsV1');
  transactionValues.set(transactionProfilesKey, [transactionProfile]);
  let failCanonicalActiveUpdate = true;
  const transactionContext = {
    globalState: {
      get(key, fallback) { return transactionValues.has(key) ? transactionValues.get(key) : fallback; },
      async update(key, value) {
        if (value === undefined) transactionValues.delete(key); else transactionValues.set(key, value);
        if (key === transactionTargetsKey && value && value.codex && failCanonicalActiveUpdate) {
          failCanonicalActiveUpdate = false;
          throw new Error('simulated activation state commit failure');
        }
      }
    },
    secrets: { async get() { return undefined; } }
  };
  await assert.rejects(
    api.activateProfile(transactionContext, transactionProfile.id, {}, 'new-model', {
      files: transactionFiles,
      offerReload: false,
      showError: false,
      throwOnError: true
    }),
    /simulated activation state commit failure/
  );
  assert.strictEqual(fs.readFileSync(transactionFiles.config, 'utf8'), 'model = "original-model"\n',
    'an active-state commit failure must roll back the Codex config');
  assert.strictEqual(fs.existsSync(transactionFiles.backup), false,
    'a failed first activation must roll back the newly created backup');
  assert.strictEqual(fs.existsSync(transactionFiles.originalState), false,
    'a failed first activation must roll back the newly created state record');
  assert.deepStrictEqual(transactionValues.get(transactionProfilesKey), [transactionProfile],
    'a failed activation must roll back the selected model in profile state');
  assert.strictEqual(api.getActiveTargets(transactionContext).codex, undefined);

  const tokenPath = '/run/user/1000/codex-model-profile-token-1000';
  const tokenAuth = api.authCommandForToken(tokenPath, 'linux');
  const tokenContent = [
    '# Managed by Codex Model Profile Manager',
    '# profile_id = shared-profile',
    'model = "remote-model"',
    'model_provider = "gateway"',
    '',
    '[model_providers.gateway]',
    'base_url = "https://gateway.example/v1"',
    'wire_api = "responses"',
    '',
    '[model_providers.gateway.auth]',
    `command = "${tokenAuth.command}"`,
    `args = ["${tokenPath}"]`,
    'timeout_ms = 5000',
    '# harmless external comment',
    ''
  ].join('\n');
  const tokenManagement = {
    status: 'managed-drifted',
    active: undefined,
    originalState: { profileId: 'shared-profile', model: 'remote-model', lastAppliedHash: 'previous-hash' }
  };
  const tokenProfile = profile({ authMode: 'secret' });
  assert.strictEqual(
    api.canRecreateRuntimeTokenFromManagedConfig(tokenContent, tokenProfile, tokenPath, tokenManagement, 'linux'),
    true,
    'a harmless config drift may recreate the private token without rewriting config'
  );
  assert.strictEqual(
    api.canRecreateRuntimeTokenFromManagedConfig(
      tokenContent.replace('https://gateway.example/v1', 'https://attacker.invalid/v1'),
      tokenProfile,
      tokenPath,
      tokenManagement,
      'linux'
    ),
    false,
    'token recreation must stop if the credential destination changed'
  );
  assert.strictEqual(
    api.canRecreateRuntimeTokenFromManagedConfig(
      tokenContent.replace(tokenPath, '/tmp/untrusted-token'),
      tokenProfile,
      tokenPath,
      tokenManagement,
      'linux'
    ),
    false,
    'token recreation must stop if the helper path changed'
  );

  const codexExtensionDir = path.join(sandbox, 'codex-extension-settings');
  const codexExtensionFiles = {
    targetId: 'codex',
    configDir: codexExtensionDir,
    codexDir: codexExtensionDir,
    config: path.join(codexExtensionDir, 'config.toml'),
    backup: path.join(codexExtensionDir, 'config.toml.backup'),
    originalState: path.join(codexExtensionDir, 'config.toml.state.json'),
    token: path.join(codexExtensionDir, 'runtime-token')
  };
  fs.mkdirSync(codexExtensionDir, { recursive: true });
  const codexExtensionProfile = profile({
    id: 'codex-extension-profile',
    authMode: 'env',
    selectedModel: 'extension-model',
    models: ['extension-model']
  });
  const codexManagedContent = api.buildManagedConfig(
    codexExtensionProfile,
    'extension-model',
    codexExtensionFiles.token
  );
  // Root settings must appear before the first TOML table.
  const firstProviderOffset = codexManagedContent.indexOf('[model_providers.');
  assert(firstProviderOffset > 0, 'the managed Codex fixture must contain a provider table');
  const codexRootContent = codexManagedContent.slice(0, firstProviderOffset).trimEnd();
  const codexProviderContent = codexManagedContent.slice(firstProviderOffset).trim();
  const codexExtendedContent = [
    codexRootContent,
    'notify = [',
    '  "turn-ended",',
    '  "approval-requested",',
    ']',
    'developer_instructions = """',
    'Preserve this multiline',
    '# Managed by Codex Model Profile Manager',
    '[model_providers.not_a_real_table]',
    'root-level value.',
    '"""',
    '',
    '[features]',
    'web_search_request = true',
    '',
    codexProviderContent,
    '',
    '[model_providers.other_gateway]',
    'name = "Other gateway"',
    'base_url = "https://other.example/v1"',
    'wire_api = "responses"',
    '',
    '[desktop]',
    'followUpQueueMode = "queue"',
    '',
    '[mcp_servers.node_repl]',
    'command = "node"',
    'args = [ "--experimental-repl-await" ]',
    '',
    "[projects.'d:/workspace']",
    'trust_level = "trusted"',
    ''
  ].join('\n');
  const codexExtendedParsed = TOML.parse(codexExtendedContent);
  assert.deepStrictEqual(Array.from(codexExtendedParsed.notify), ['turn-ended', 'approval-requested']);
  assert.strictEqual(codexExtendedParsed.developer_instructions, 'Preserve this multiline\n# Managed by Codex Model Profile Manager\n[model_providers.not_a_real_table]\nroot-level value.\n');
  assert.strictEqual(codexExtendedParsed.features.web_search_request, true);
  assert.strictEqual(codexExtendedParsed.model_providers.gateway.notify, undefined, 'notify must remain a root setting');
  assert.strictEqual(codexExtendedParsed.model_providers.other_gateway.base_url, 'https://other.example/v1');
  assert.strictEqual(codexExtendedParsed.desktop.followUpQueueMode, 'queue');
  assert.strictEqual(codexExtendedParsed.mcp_servers.node_repl.command, 'node');
  assert.strictEqual(codexExtendedParsed.projects['d:/workspace'].trust_level, 'trusted');

  const replacementManagedContent = api.buildManagedConfig(
    { ...codexExtensionProfile, selectedModel: 'replacement-model', models: ['replacement-model'] },
    'replacement-model',
    codexExtensionFiles.token
  );
  const mergedExtendedContent = api.mergeManagedCodexConfig(replacementManagedContent, codexExtendedContent);
  const mergedExtendedParsed = TOML.parse(mergedExtendedContent);
  assert.strictEqual(mergedExtendedParsed.model, 'replacement-model');
  assert.strictEqual(mergedExtendedParsed.model_provider, 'gateway');
  assert.deepStrictEqual(Array.from(mergedExtendedParsed.notify), ['turn-ended', 'approval-requested']);
  assert.strictEqual(mergedExtendedParsed.developer_instructions, 'Preserve this multiline\n# Managed by Codex Model Profile Manager\n[model_providers.not_a_real_table]\nroot-level value.\n');
  assert.strictEqual(mergedExtendedParsed.features.web_search_request, true);
  assert.strictEqual(mergedExtendedParsed.model_providers.other_gateway.base_url, 'https://other.example/v1');
  assert.strictEqual(mergedExtendedParsed.desktop.followUpQueueMode, 'queue');
  assert.strictEqual(mergedExtendedParsed.mcp_servers.node_repl.command, 'node');
  assert.strictEqual(mergedExtendedParsed.projects['d:/workspace'].trust_level, 'trusted');
  assert.strictEqual(mergedExtendedParsed.model_providers.gateway.notify, undefined, 'merge must not move root settings into a provider');
  assert.strictEqual(api.parseManagedCodexMetadata([
    'developer_instructions = """',
    '# Managed by Codex Model Profile Manager',
    '# profile_id = fake-profile',
    '"""'
  ].join('\n')), undefined, 'a managed marker inside a multiline string must not claim the file');
  const restoredCodexContent = api.buildRestoredCodexConfig(
    'notify = [ "original" ]\n\n[model_providers.gateway]\nname = "Original gateway"\nbase_url = "https://original.example/v1"\n',
    codexExtendedContent,
    'gateway'
  );
  const restoredCodexParsed = TOML.parse(restoredCodexContent);
  assert.deepStrictEqual(Array.from(restoredCodexParsed.notify), ['turn-ended', 'approval-requested'],
    'Codex restore must preserve current unmanaged root settings');
  assert.strictEqual(restoredCodexParsed.desktop.followUpQueueMode, 'queue',
    'Codex restore must preserve current desktop settings');
  assert.strictEqual(restoredCodexParsed.model_providers.other_gateway.base_url, 'https://other.example/v1',
    'Codex restore must preserve other provider sections');
  assert.strictEqual(restoredCodexParsed.model_providers.gateway.base_url, 'https://original.example/v1',
    'Codex restore must restore an original provider that reused the managed provider ID');
  const restoredWithoutOriginal = TOML.parse(api.buildRestoredCodexConfig('', codexExtendedContent, 'gateway'));
  assert.strictEqual(restoredWithoutOriginal.model, undefined);
  assert.strictEqual(restoredWithoutOriginal.model_provider, undefined);
  assert.strictEqual(restoredWithoutOriginal.model_providers.gateway, undefined,
    'when config.toml was originally absent, restore must remove the managed provider only');
  assert.strictEqual(restoredWithoutOriginal.mcp_servers.node_repl.command, 'node',
    'when config.toml was originally absent, Codex-created unmanaged settings must keep the file alive');
  const restoreMergeDir = path.join(sandbox, 'codex-restore-merge');
  fs.mkdirSync(restoreMergeDir, { recursive: true });
  const restoreMergeFiles = {
    targetId: 'codex',
    configDir: restoreMergeDir,
    codexDir: restoreMergeDir,
    config: path.join(restoreMergeDir, 'config.toml'),
    backup: path.join(restoreMergeDir, 'config.toml.original-backup'),
    originalState: path.join(restoreMergeDir, 'config.toml.state.json'),
    token: path.join(restoreMergeDir, 'runtime-token')
  };
  fs.writeFileSync(restoreMergeFiles.config, codexExtendedContent);
  fs.writeFileSync(restoreMergeFiles.originalState, JSON.stringify({
    existed: false,
    lastAppliedHash: api.contentHash(codexManagedContent),
    managedConfigHash: api.managedCodexConfigHash(codexManagedContent, { maskSecrets: false }),
    managedConfigHashVersion: 2,
    profileId: codexExtensionProfile.id,
    model: 'extension-model'
  }));
  const restoreMergeValues = new Map([
    [api.environmentStateKey(context, 'modelProfilesV2'), [codexExtensionProfile]],
    [api.environmentStateKey(context, 'activeCliTargetsV1'), {
      codex: { profileId: codexExtensionProfile.id, model: 'extension-model' }
    }]
  ]);
  const restoreMergeContext = {
    globalState: {
      get(key, fallback) { return restoreMergeValues.has(key) ? restoreMergeValues.get(key) : fallback; },
      async update(key, value) { if (value === undefined) restoreMergeValues.delete(key); else restoreMergeValues.set(key, value); }
    },
    secrets: { async get() { return undefined; } }
  };
  await api.restoreOriginal(restoreMergeContext, { show() {} }, {
    files: restoreMergeFiles,
    offerReload: false,
    showError: false,
    throwOnError: true
  });
  const restoredMergeParsed = TOML.parse(fs.readFileSync(restoreMergeFiles.config, 'utf8'));
  assert.strictEqual(restoredMergeParsed.model_provider, undefined);
  assert.strictEqual(restoredMergeParsed.model_providers.gateway, undefined);
  assert.strictEqual(restoredMergeParsed.desktop.followUpQueueMode, 'queue');
  assert.strictEqual(restoredMergeParsed.mcp_servers.node_repl.command, 'node');
  assert.strictEqual(api.getActiveTargets(restoreMergeContext).codex, undefined);
  fs.writeFileSync(codexExtensionFiles.config, codexExtendedContent);
  fs.writeFileSync(codexExtensionFiles.originalState, JSON.stringify({
    existed: false,
    lastAppliedHash: api.contentHash(codexManagedContent),
    managedConfigHash: api.managedCodexConfigHash(codexManagedContent, {
      maskSecrets: false,
      includeRuntimeSelection: true
    }),
    profileId: codexExtensionProfile.id,
    model: 'extension-model'
  }));
  const codexExtensionValues = new Map([
    [api.environmentStateKey(context, 'modelProfilesV2'), [codexExtensionProfile]],
    [api.environmentStateKey(context, 'activeCliTargetsV1'), {
      codex: { profileId: codexExtensionProfile.id, model: 'extension-model' }
    }]
  ]);
  const codexExtensionContext = {
    globalState: {
      get(key, fallback) { return codexExtensionValues.has(key) ? codexExtensionValues.get(key) : fallback; },
      async update(key, value) { if (value === undefined) codexExtensionValues.delete(key); else codexExtensionValues.set(key, value); }
    },
    secrets: { async get() { return undefined; } }
  };
  const extensionClean = await api.getTargetManagementState(codexExtensionContext, 'codex', codexExtensionFiles);
  assert.strictEqual(extensionClean.status, 'managed-clean', 'Codex-owned sections must not cause a drift warning');
  assert.strictEqual(extensionClean.managedMatch, true);
  assert.strictEqual(extensionClean.hasUnmanagedChanges, true);
  fs.writeFileSync(
    codexExtensionFiles.config,
    codexExtendedContent.replace('model = "extension-model"', 'model = "tampered-model"')
  );
  const modelChanged = await api.getTargetManagementState(codexExtensionContext, 'codex', codexExtensionFiles);
  assert.strictEqual(modelChanged.status, 'managed-clean', 'Codex model picker changes must not cause a drift warning');
  assert.strictEqual(modelChanged.currentModel, 'tampered-model');
  const migratedModelChange = await api.reconcileManagedCodexState(codexExtensionContext, codexExtensionFiles);
  assert(migratedModelChange, 'a Codex model change must migrate a version 1.5.1 managed hash');
  const migratedModelState = JSON.parse(fs.readFileSync(codexExtensionFiles.originalState, 'utf8'));
  assert.strictEqual(migratedModelState.managedConfigHashVersion, 2);
  assert.strictEqual(migratedModelState.model, 'tampered-model');
  assert.strictEqual(api.getActiveTargets(codexExtensionContext).codex.model, 'tampered-model');
  fs.writeFileSync(
    codexExtensionFiles.config,
    codexExtendedContent.replace('model_provider = "gateway"', 'model_provider = "gateway"\nmodel_reasoning_effort = "low"')
  );
  const reasoningChanged = await api.getTargetManagementState(codexExtensionContext, 'codex', codexExtensionFiles);
  assert.strictEqual(reasoningChanged.status, 'managed-clean', 'Codex reasoning picker changes must not cause a drift warning');
  fs.writeFileSync(
    codexExtensionFiles.config,
    codexExtendedContent.replace('base_url = "https://gateway.example/v1"', 'base_url = "https://other.example/v1"')
  );
  const extensionDrifted = await api.getTargetManagementState(codexExtensionContext, 'codex', codexExtensionFiles);
  assert.strictEqual(extensionDrifted.status, 'managed-drifted', 'managed provider fields must still detect drift');
  const unknownManagedField = codexExtendedContent.replace(
    '[model_providers.gateway]',
    '[model_providers.gateway]\nprovider_extension = "externally-changed"'
  );
  fs.writeFileSync(codexExtensionFiles.config, unknownManagedField);
  const unknownFieldDrifted = await api.getTargetManagementState(codexExtensionContext, 'codex', codexExtensionFiles);
  assert.strictEqual(unknownFieldDrifted.status, 'managed-drifted', 'unknown fields in the managed provider subtree must still detect drift');
  fs.writeFileSync(codexExtensionFiles.config, `${codexExtendedContent}\ninvalid_toml = [`);
  const invalidTomlDrifted = await api.getTargetManagementState(codexExtensionContext, 'codex', codexExtensionFiles);
  assert.strictEqual(invalidTomlDrifted.status, 'managed-drifted', 'invalid TOML must never be treated as a clean managed config');
  assert.throws(
    () => api.mergeManagedCodexConfig(replacementManagedContent, `${codexExtendedContent}\ninvalid_toml = [`),
    /invalid TOML|不是有效 TOML/,
    'an invalid existing config must not be merged'
  );

  const raceDir = path.join(sandbox, 'startup-delete-race');
  const raceFiles = {
    targetId: 'codex',
    configDir: raceDir,
    codexDir: raceDir,
    config: path.join(raceDir, 'config.toml'),
    backup: path.join(raceDir, 'config.toml.backup'),
    originalState: path.join(raceDir, 'config.toml.state.json'),
    token: path.join(raceDir, 'runtime-token')
  };
  fs.mkdirSync(raceDir, { recursive: true });
  const raceProfile = profile({
    id: 'startup-race-profile',
    authMode: 'secret',
    selectedModel: 'race-model',
    models: ['race-model']
  });
  const raceContent = api.buildManagedConfig(raceProfile, 'race-model', raceFiles.token, 'race-secret');
  fs.writeFileSync(raceFiles.config, raceContent);
  fs.writeFileSync(raceFiles.originalState, JSON.stringify({
    existed: false,
    lastAppliedHash: api.contentHash(raceContent),
    profileId: raceProfile.id,
    model: 'race-model'
  }));
  const raceValues = new Map();
  let releaseSecret;
  let markSecretRead;
  const secretRead = new Promise(resolve => { markSecretRead = resolve; });
  const secretGate = new Promise(resolve => { releaseSecret = resolve; });
  const raceContext = {
    globalState: {
      get(key, fallback) { return raceValues.has(key) ? raceValues.get(key) : fallback; },
      async update(key, value) { if (value === undefined) raceValues.delete(key); else raceValues.set(key, value); }
    },
    secrets: {
      async get() {
        markSecretRead();
        await secretGate;
        return 'race-secret';
      }
    }
  };
  raceValues.set(api.environmentStateKey(raceContext, 'modelProfilesV2'), [raceProfile]);
  raceValues.set(api.environmentStateKey(raceContext, 'activeCliTargetsV1'), {
    codex: { profileId: raceProfile.id, model: 'race-model' }
  });
  const raceStatusBar = { show() {}, text: '', tooltip: '' };
  const startupRefresh = api.recreateRuntimeTokenIfNeeded(raceContext, raceStatusBar, raceFiles);
  await secretRead;
  const externallyEditedRaceContent = `${raceContent}# edit while SecretStorage is pending\n`;
  fs.writeFileSync(raceFiles.config, externallyEditedRaceContent);
  let competingMutationStarted = false;
  const competingMutation = api.withProfileMutation(raceProfile.id, () => api.withTargetMutation('codex', async () => {
    competingMutationStarted = true;
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(competingMutationStarted, false, 'startup refresh must hold the profile and Codex mutation locks');
  releaseSecret();
  await startupRefresh;
  await competingMutation;
  assert.strictEqual(competingMutationStarted, true);
  assert.strictEqual(
    fs.readFileSync(raceFiles.config, 'utf8'),
    externallyEditedRaceContent,
    'startup refresh must not overwrite an external edit made after its initial hash check'
  );

  const orphanDir = path.join(sandbox, 'orphaned-remote-management');
  const orphanFiles = {
    targetId: 'codex',
    configDir: orphanDir,
    codexDir: orphanDir,
    config: path.join(orphanDir, 'config.toml'),
    backup: path.join(orphanDir, 'config.toml.backup'),
    originalState: path.join(orphanDir, 'config.toml.state.json'),
    token: path.join(orphanDir, 'runtime-token')
  };
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphanContent = [
    '# Managed by Codex Model Profile Manager',
    '# profile_id = provider-from-another-host',
    'model = "remote-model"',
    'model_provider = "gateway"',
    ''
  ].join('\n');
  fs.writeFileSync(orphanFiles.config, orphanContent);
  fs.writeFileSync(orphanFiles.originalState, JSON.stringify({
    existed: false,
    lastAppliedHash: api.contentHash(orphanContent),
    profileId: 'provider-from-another-host',
    model: 'remote-model'
  }));
  fs.writeFileSync(orphanFiles.token, 'credential-from-another-host');
  const orphanValues = new Map();
  const orphanContext = {
    globalState: {
      get(key, fallback) { return orphanValues.has(key) ? orphanValues.get(key) : fallback; },
      async update(key, value) { if (value === undefined) orphanValues.delete(key); else orphanValues.set(key, value); }
    },
    secrets: { async get() { return undefined; } }
  };
  await api.recreateRuntimeTokenIfNeeded(orphanContext, raceStatusBar, orphanFiles);
  assert(!fs.existsSync(orphanFiles.token), 'an orphaned provider must not retain a runtime credential from another host scope');
  assert.strictEqual(fs.readFileSync(orphanFiles.config, 'utf8'), orphanContent, 'orphan cleanup must not overwrite the managed config');

  const legacyDir = path.join(sandbox, 'legacy-codex-management');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyFiles = {
    targetId: 'codex',
    configDir: legacyDir,
    config: path.join(legacyDir, 'config.toml'),
    backup: path.join(legacyDir, 'config.toml.backup'),
    originalState: path.join(legacyDir, 'config.toml.state.json')
  };
  const legacyContent = [
    '# Managed by Codex Model Profile Manager',
    '# profile_id = shared-profile',
    '# profile_name = Gateway',
    'model = "remote-model"',
    'model_provider = "gateway"',
    ''
  ].join('\n');
  fs.writeFileSync(legacyFiles.config, legacyContent);
  fs.writeFileSync(legacyFiles.originalState, JSON.stringify({ existed: false }));
  values.set(stateKey('modelProfilesV2'), [profile()]);
  values.set(stateKey('activeCliTargetsV1'), { codex: { profileId: 'shared-profile' } });
  values.delete(stateKey('activeProfileIdV2'));

  assert.deepStrictEqual(api.parseManagedCodexMetadata(legacyContent), {
    profileId: 'shared-profile',
    model: 'remote-model'
  });
  const reconciled = await api.reconcileManagedCodexState(context, legacyFiles);
  assert(reconciled && reconciled.migrated, 'legacy managed state should be reconciled');
  assert.deepStrictEqual(api.getActiveTargets(context).codex, {
    profileId: 'shared-profile',
    model: 'remote-model'
  });
  const reconciledState = JSON.parse(fs.readFileSync(legacyFiles.originalState, 'utf8'));
  assert.strictEqual(reconciledState.lastAppliedHash, api.contentHash(legacyContent));
  assert.strictEqual(reconciledState.automaticRefreshDisabled, true, 'legacy config must be adopted without automatic rewriting');
  assert.strictEqual((await api.getTargetManagementState(context, 'codex', legacyFiles)).status, 'managed-clean');

  values.set(stateKey('activeCliTargetsV1'), {});
  values.delete(stateKey('activeProfileIdV2'));
  const recoveredMissingRecord = await api.reconcileManagedCodexState(context, legacyFiles);
  assert(recoveredMissingRecord, 'a verified state file should recover a missing remote active record');
  assert.strictEqual(api.getActiveTargets(context).codex.model, 'remote-model');

  values.set(stateKey('activeCliTargetsV1'), {});
  values.delete(stateKey('activeProfileIdV2'));
  // A provider edit must block automatic recovery. Runtime model selection and
  // Codex-owned sections are intentionally tolerated by the projection.
  fs.writeFileSync(legacyFiles.config, legacyContent.replace('model_provider = "gateway"', 'model_provider = "tampered"'));
  assert.strictEqual(await api.reconcileManagedCodexState(context, legacyFiles), undefined, 'hash mismatch must block automatic state recovery');
  assert.strictEqual(api.getActiveTargets(context).codex, undefined, 'hash mismatch must not recreate an active record');

  const current = [profile({ selectedModel: 'current-model', models: ['current-model'] })];
  const incoming = [
    profile({ selectedModel: 'imported-model', models: ['imported-model'] }),
    profile({ id: 'new-profile', providerId: 'new_gateway', name: 'New Gateway' })
  ];

  const skipped = plannedProfiles(api.applyImportPlan(current, api.createImportPlan(current, incoming), 'skip'));
  assert.strictEqual(skipped.length, 2);
  assert.strictEqual(skipped.find(item => item.id === 'shared-profile').selectedModel, 'current-model');
  assert(skipped.some(item => item.id === 'new-profile'));

  const replaced = plannedProfiles(api.applyImportPlan(current, api.createImportPlan(current, incoming), 'replace'));
  assert.strictEqual(replaced.length, 2);
  assert.strictEqual(replaced.find(item => item.id === 'shared-profile').selectedModel, 'imported-model');
  assert(replaced.some(item => item.id === 'new-profile'));

  assert.throws(() => api.applyImportPlan(current, api.createImportPlan(current, incoming), 'overwrite-everything'));
  assert.deepStrictEqual(
    acceptedInvalidMessages,
    [],
    `invalid webview messages were accepted: ${JSON.stringify(acceptedInvalidMessages)}`
  );
  assert.deepStrictEqual(leakedSecretValues, [], `export leaked sensitive values: ${leakedSecretValues.join(', ')}`);
  console.log('PASS: export redaction, message validation, read-only diagnostics and import conflict plans.');
})().finally(() => {
  Module._load = originalLoad;
  if (previousOpenCodeDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
