'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmux-security-test-'));
const previousOpenCodeDir = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, 'missing-opencode-home');

const mockVscode = {
  env: { remoteName: undefined },
  workspace: {
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
  },
  window: {},
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
    'canAutomaticallyRefreshManagedConfig'
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
  const diagnostics = await api.collectTargetDiagnostics(context, 'opencode');
  assert(diagnostics && Array.isArray(diagnostics.checks));
  assert(!fs.existsSync(missingDirectory), 'read-only diagnostics must not create a missing CLI configuration directory');

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
  fs.writeFileSync(managedFiles.config, managedContent);
  fs.writeFileSync(managedFiles.originalState, JSON.stringify({
    existed: false,
    lastAppliedHash: api.contentHash(managedContent),
    profileId: 'shared-profile',
    model: 'gpt-5'
  }));
  values.set('activeCliTargetsV1', {
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
  assert.strictEqual(drifted.canApply, false, 'Codex hash collisions must block automatic replacement');
  assert.strictEqual(api.canAutomaticallyRefreshManagedConfig(drifted), false);

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
