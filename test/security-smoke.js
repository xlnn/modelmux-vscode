'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

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
    'recreateRuntimeTokenIfNeeded'
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
  const raceValues = new Map([
    ['modelProfilesV2', [raceProfile]],
    ['activeCliTargetsV1', { codex: { profileId: raceProfile.id, model: 'race-model' } }]
  ]);
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
  values.set('modelProfilesV2', [profile()]);
  values.set('activeCliTargetsV1', { codex: { profileId: 'shared-profile' } });
  values.delete('activeProfileIdV2');

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

  values.set('activeCliTargetsV1', {});
  values.delete('activeProfileIdV2');
  const recoveredMissingRecord = await api.reconcileManagedCodexState(context, legacyFiles);
  assert(recoveredMissingRecord, 'a verified state file should recover a missing remote active record');
  assert.strictEqual(api.getActiveTargets(context).codex.model, 'remote-model');

  values.set('activeCliTargetsV1', {});
  values.delete('activeProfileIdV2');
  fs.appendFileSync(legacyFiles.config, '# external edit\n');
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
