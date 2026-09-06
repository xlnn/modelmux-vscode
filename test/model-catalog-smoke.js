'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const TOML = require('@iarna/toml');

function tomlString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

const mockVscode = {
  env: { remoteName: undefined },
  workspace: {
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const api = require('../extension.js').__test;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmux-catalog-test-'));

function profile(id, providerId, models) {
  return {
    id,
    kind: 'customResponses',
    name: `${providerId} provider`,
    providerName: `${providerId} provider`,
    providerId,
    baseUrl: `https://${providerId}.example/v1`,
    authMode: 'none',
    models,
    selectedModel: models[0],
    reasoningPolicy: 'none'
  };
}

try {
  const first = profile('profile-one', 'shared_gateway', ['model-one', 'model-two']);
  const second = profile('profile-two', 'shared_gateway', ['model-three']);
  const firstPath = api.modelCatalogPathForProfile(first, sandbox);
  const secondPath = api.modelCatalogPathForProfile(second, sandbox);
  assert.notStrictEqual(firstPath, secondPath, 'provider catalogs must be unique per profile');
  assert(firstPath.startsWith(path.join(sandbox, '.modelmux', 'model-catalogs')));

  const firstCatalog = api.buildModelCatalog(first, 'model-new');
  const secondCatalog = api.buildModelCatalog(second, 'model-three');
  assert.deepStrictEqual(firstCatalog.models.map(item => item.slug), ['model-one', 'model-two', 'model-new']);
  assert.deepStrictEqual(secondCatalog.models.map(item => item.slug), ['model-three']);
  assert.strictEqual(firstCatalog.models[0].support_verbosity, true);
  assert.strictEqual(firstCatalog.models[0].include_apps_usage_instructions, false);
  assert.strictEqual(firstCatalog.models[0].include_plugin_usage_instructions, false);
  assert.strictEqual(firstCatalog.models[0].supports_parallel_tool_calls, true);
  assert.strictEqual(firstCatalog.models[0].base_instructions, 'You are Codex.');
  assert.strictEqual(firstCatalog.models[0].model_messages, null);

  const firstFiles = {
    targetId: 'codex',
    codexDir: sandbox,
    config: path.join(sandbox, 'config.toml'),
    backup: path.join(sandbox, 'config.toml.backup'),
    originalState: path.join(sandbox, 'config.toml.state.json'),
    token: path.join(sandbox, 'runtime-token')
  };
  const context = {
    globalState: { get(_key, fallback) { return fallback; }, async update() {} },
    secrets: { async get() { return undefined; } }
  };
  const writtenFirst = api.writeModelCatalogForProfile;
  assert.strictEqual(typeof writtenFirst, 'function');

  (async () => {
    await writtenFirst(context, first, 'model-new', firstFiles);
    const firstBefore = fs.readFileSync(firstPath, 'utf8');
    await writtenFirst(context, second, 'model-three', firstFiles);
    assert.strictEqual(fs.readFileSync(firstPath, 'utf8'), firstBefore, 'updating one provider must not alter another catalog');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(secondPath, 'utf8')).models.map(item => item.slug), ['model-three']);

    const desired = api.buildManagedConfig(first, 'model-new', firstFiles.token, undefined, { catalogPath: firstPath, codexDir: sandbox });
    const current = [
      desired,
      '[model_providers.other_gateway]',
      'name = "Other"',
      'base_url = "https://other.example/v1"',
      'wire_api = "responses"',
      ''
    ].join('\n');
    const merged = TOML.parse(api.mergeManagedCodexConfig(desired, current));
    assert.strictEqual(merged.model_catalog_json, firstPath);
    assert.strictEqual(merged.model_providers.other_gateway.base_url, 'https://other.example/v1');

    const restored = TOML.parse(api.buildRestoredCodexConfig(
      `model_catalog_json = "${tomlString(firstPath)}"\n\n[model_providers.original]\nbase_url = "https://original.example/v1"\n`,
      api.mergeManagedCodexConfig(desired, current),
      first.providerId
    ));
    assert.strictEqual(restored.model_catalog_json, firstPath, 'restore must retain the original Codex catalog setting');
    assert.strictEqual(restored.model_providers.other_gateway.base_url, 'https://other.example/v1');
    assert.strictEqual(restored.model_providers.shared_gateway, undefined);
    console.log('PASS: Codex model catalogs are provider-isolated and merge/restore safely.');
  })().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
} finally {
  Module._load = originalLoad;
}
