'use strict';

const assert = require('assert');
const Module = require('module');
const configValues = {};

const mockVscode = {
  env: { remoteName: undefined },
  workspace: {
    getConfiguration() { return { get(key, fallback) { return Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback; } }; }
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

try {
  assert.deepStrictEqual(api.readGlobalSettings().uiLanguage, 'en');
  assert.deepStrictEqual(api.readGlobalSettings().uiFontFamily, 'default');
  configValues.uiLanguage = 'zh-CN';
  configValues.uiFontFamily = 'monospace';
  configValues.uiFontSize = 18;
  assert.deepStrictEqual(api.readGlobalSettings().uiLanguage, 'zh-CN');
  assert.deepStrictEqual(api.readGlobalSettings().uiFontFamily, 'monospace');
  assert.deepStrictEqual(api.readGlobalSettings().uiFontSize, 18);

  const envProfile = api.normalizeProfileFromGui({
    kind: 'customResponses',
    name: 'Azure-compatible gateway',
    providerId: 'azure_gateway',
    baseUrl: 'https://example.openai.azure.com/openai/v1',
    authMode: 'env',
    envKey: 'AZURE_OPENAI_API_KEY',
    envKeyInstructions: 'Set AZURE_OPENAI_API_KEY before starting VS Code',
    selectedModel: 'deployment-name',
    models: ['deployment-name'],
    reasoningPolicy: 'none',
    queryParams: '{"api-version":"2025-04-01-preview"}',
    envHttpHeaders: '{"api-key":"AZURE_OPENAI_API_KEY"}',
    httpHeaders: '{"X-Client":"codex-switcher"}',
    requestMaxRetries: 1,
    streamMaxRetries: 3,
    streamIdleTimeoutMs: 120000,
    supportsWebsockets: true
  });
  const envConfig = api.buildManagedConfig(envProfile, envProfile.selectedModel, '/tmp/not-used');
  assert(envConfig.includes('env_key = "AZURE_OPENAI_API_KEY"'));
  assert(envConfig.includes('env_http_headers = { "api-key" = "AZURE_OPENAI_API_KEY" }'));
  assert(envConfig.includes('query_params = { "api-version" = "2025-04-01-preview" }'));
  assert(envConfig.includes('http_headers = { "X-Client" = "codex-switcher" }'));
  assert(envConfig.includes('request_max_retries = 1'));
  assert(envConfig.includes('stream_max_retries = 3'));
  assert(envConfig.includes('stream_idle_timeout_ms = 120000'));
  assert(envConfig.includes('supports_websockets = true'));
  assert(!envConfig.includes('[model_providers.azure_gateway.auth]'));

  const discovery = api.modelDiscoveryUrl(envProfile);
  assert(discovery.includes('/models?'));
  assert(discovery.includes('api-version=2025-04-01-preview'));
  assert.throws(() => api.validatedModelDiscoveryUrl({
    ...envProfile,
    baseUrl: 'http://remote.example/v1',
    allowInsecureHttp: false
  }, true), /远程 HTTP/);
  assert.throws(() => api.validatedModelDiscoveryUrl({
    ...envProfile,
    modelDiscoveryPath: 'https://other.example/models'
  }, true), /不同源/);

  const headerAuth = api.normalizeProfileFromGui({
    kind: 'customResponses',
    name: 'Header auth gateway',
    providerId: 'header_auth',
    baseUrl: 'https://example.invalid/v1',
    authMode: 'envHeaders',
    envHttpHeaders: '{"api-key":"HEADER_API_KEY"}',
    selectedModel: 'model',
    models: ['model'],
    reasoningPolicy: 'none'
  });
  const headerConfig = api.buildManagedConfig(headerAuth, 'model', '/tmp/not-used');
  assert(headerConfig.includes('env_http_headers = { "api-key" = "HEADER_API_KEY" }'));
  assert(!headerConfig.includes('env_key ='));
  assert(!headerConfig.includes('[model_providers.header_auth.auth]'));

  for (const [kind, provider] of [['ollama', 'ollama'], ['lmstudio', 'lmstudio'], ['openai', 'openai']]) {
    const profile = api.normalizeProfileFromGui({
      kind,
      name: kind,
      selectedModel: 'local-model',
      models: ['local-model'],
      reasoningPolicy: 'none'
    });
    const config = api.buildManagedConfig(profile, 'local-model', '/tmp/not-used');
    assert(config.includes(`model_provider = "${provider}"`));
    assert(!config.includes('[model_providers.'));
  }

  const bedrock = api.normalizeProfileFromGui({
    kind: 'bedrock',
    name: 'Bedrock',
    selectedModel: 'anthropic.claude-model',
    models: ['anthropic.claude-model'],
    awsRegion: 'us-east-1',
    awsProfile: 'default',
    reasoningPolicy: 'none'
  });
  const bedrockConfig = api.buildManagedConfig(bedrock, bedrock.selectedModel, '/tmp/not-used');
  assert(bedrockConfig.includes('model_provider = "amazon-bedrock"'));
  assert(bedrockConfig.includes('[model_providers.amazon-bedrock.aws]'));
  assert(bedrockConfig.includes('profile = "default"'));
  assert(bedrockConfig.includes('region = "us-east-1"'));

  const winPath = 'C:\\Users\\Tester\\AppData\\Local\\Temp\\codex-token';
  const windowsHelper = api.authCommandForToken(winPath, 'win32');
  assert(windowsHelper.args.includes('-EncodedCommand'));
  const encodedIndex = windowsHelper.args.indexOf('-EncodedCommand') + 1;
  const decoded = Buffer.from(windowsHelper.args[encodedIndex], 'base64').toString('utf16le');
  assert(decoded.includes(winPath));
  assert(decoded.includes('ReadAllText'));
  assert(!decoded.includes('$args[0]'));

  assert.throws(() => api.normalizeProfileFromGui({
    kind: 'customResponses', name: 'Unsafe', providerId: 'unsafe', baseUrl: 'http://example.com/v1',
    authMode: 'none', selectedModel: 'm', models: ['m']
  }), /远程 HTTP/);
  const allowed = api.normalizeProfileFromGui({
    kind: 'customResponses', name: 'Allowed', providerId: 'allowed', baseUrl: 'http://example.com/v1',
    authMode: 'none', selectedModel: 'm', models: ['m'], allowInsecureHttp: true
  });
  assert.strictEqual(allowed.allowInsecureHttp, true);

  console.log('PASS: cross-platform config generation, env auth, local providers and Windows helper.');
} finally {
  Module._load = originalLoad;
}
