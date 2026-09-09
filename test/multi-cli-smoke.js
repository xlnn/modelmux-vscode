'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const JSON5 = require('json5');
const YAML = require('yaml');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-model-switcher-test-'));
const originalHomedir = os.homedir;
os.homedir = () => sandbox;
process.env.GROK_HOME = path.join(sandbox, 'grok');
process.env.OPENCLAW_CONFIG_PATH = path.join(sandbox, 'openclaw', 'openclaw.json');

const mockVscode = {
  env: { remoteName: undefined },
  workspace: { getConfiguration() { return { get(_key, fallback) { return fallback; } }; } },
  window: { async showWarningMessage(...args) { return args.at(-1); } },
  commands: {},
  Uri: { file(value) { return { fsPath: value }; } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const api = require('../extension.js').__test;
const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function profile(input) {
  return api.normalizeProfileFromGui(input);
}

const customChat = profile({
  kind: 'customChat', name: 'Chat Gateway', providerId: 'chat_gateway',
  baseUrl: 'https://gateway.example/v1', authMode: 'env', envKey: 'MODEL_SWITCH_API_KEY',
  selectedModel: 'chat-model', models: ['chat-model'], reasoningPolicy: 'none'
});
const customAnthropic = profile({
  kind: 'customAnthropic', name: 'Claude Gateway', providerId: 'claude_gateway',
  baseUrl: 'https://claude.example/v1', authMode: 'env', envKey: 'ANTHROPIC_API_KEY',
  selectedModel: 'claude-model', models: ['claude-model'], reasoningPolicy: 'none'
});
const directAnthropic = profile({
  kind: 'customAnthropic', name: 'Direct Claude Gateway', providerId: 'direct_claude_gateway',
  baseUrl: 'https://direct-claude.example/v1', authMode: 'secret', envKey: 'IGNORED_FOR_DIRECT_MODE',
  selectedModel: 'claude-direct-model', models: ['claude-direct-model'], reasoningPolicy: 'none'
});
const directAnthropicKey = 'direct-anthropic-key';
const driftChat = {
  ...customChat,
  id: 'drift-chat-profile',
  name: 'Drift Chat Gateway',
  providerId: 'drift_chat_gateway',
  providerName: 'Drift Chat Gateway'
};
const missingConfigChat = {
  ...customChat,
  id: 'missing-config-chat-profile',
  name: 'Missing Config Chat Gateway',
  providerId: 'missing_config_chat_gateway',
  providerName: 'Missing Config Chat Gateway'
};
const grok = profile({ kind: 'grok', name: 'Grok', selectedModel: 'grok-4', models: ['grok-4'] });
const gemini = profile({ kind: 'gemini', name: 'Gemini', selectedModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'] });

try {
  const claudeConfig = JSON.parse(api.buildTargetConfig('claude', customAnthropic, 'claude-model', '{"permissions":{"allow":[]}}'));
  assert.strictEqual(claudeConfig.model, 'claude-model');
  assert.strictEqual(claudeConfig.env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
  assert.deepStrictEqual(claudeConfig.permissions, { allow: [] });

  const directClaudeConfig = JSON.parse(api.buildTargetConfig(
    'claude', directAnthropic, 'claude-direct-model', '{"permissions":{"allow":[]}}', directAnthropicKey
  ));
  assert.strictEqual(directClaudeConfig.env.ANTHROPIC_BASE_URL, 'https://direct-claude.example/v1');
  assert.strictEqual(directClaudeConfig.env.ANTHROPIC_API_KEY, directAnthropicKey);

  const geminiConfig = JSON.parse(api.buildTargetConfig('gemini', gemini, 'gemini-2.5-pro', '{"theme":"Default"}'));
  assert.strictEqual(geminiConfig.model.name, 'gemini-2.5-pro');
  assert.strictEqual(geminiConfig.theme, 'Default');

  const grokConfig = api.buildTargetConfig('grok', grok, 'grok-4', '# user comment\n[ui]\ncompact = true\n');
  assert(grokConfig.includes('# user comment'));
  assert(grokConfig.includes('[models]\ndefault = "grok-4"'));
  const grokMultiline = api.buildTargetConfig('grok', grok, 'grok-4', [
    'description = """',
    '[models]',
    'default = "text-only"',
    '# Managed by CLI Model Switcher',
    '"""',
    '',
    '[ui]',
    'compact = true',
    ''
  ].join('\n'));
  const parsedGrokMultiline = require('@iarna/toml').parse(grokMultiline);
  assert.strictEqual(parsedGrokMultiline.description,
    '[models]\ndefault = "text-only"\n# Managed by CLI Model Switcher\n');
  assert.strictEqual(parsedGrokMultiline.models.default, 'grok-4',
    'Grok must ignore table headers and management markers inside multiline strings');
  assert.strictEqual((grokMultiline.match(/# Managed by CLI Model Switcher/g) || []).length, 2,
    'a marker inside a string must not suppress the real top-level management marker');

  const openCodeText = api.buildTargetConfig('opencode', customChat, 'chat-model', '{\n  // keep me\n  "theme": "system"\n}\n');
  assert(openCodeText.includes('// keep me'));
  const openCode = JSON5.parse(openCodeText);
  assert.strictEqual(openCode.model, 'chat_gateway/chat-model');
  assert.strictEqual(openCode.provider.chat_gateway.options.apiKey, '{env:MODEL_SWITCH_API_KEY}');

  const anthropicOpenCodeText = api.buildTargetConfig(
    'opencode',
    customAnthropic,
    'claude-model',
    '{\n  // preserve anthropic settings\n  "theme": "system"\n}\n'
  );
  assert(anthropicOpenCodeText.includes('// preserve anthropic settings'));
  const anthropicOpenCode = JSON5.parse(anthropicOpenCodeText);
  assert.strictEqual(api.targetCompatibility('opencode', customAnthropic).supported, true);
  assert.strictEqual(anthropicOpenCode.model, 'claude_gateway/claude-model');
  assert.strictEqual(anthropicOpenCode.provider.claude_gateway.npm, '@ai-sdk/anthropic');
  assert.strictEqual(anthropicOpenCode.provider.claude_gateway.options.apiKey, '{env:ANTHROPIC_API_KEY}');

  const directAnthropicOpenCode = JSON5.parse(api.buildTargetConfig(
    'opencode', directAnthropic, 'claude-direct-model', '{}\n', directAnthropicKey
  ));
  assert.strictEqual(directAnthropicOpenCode.provider.direct_claude_gateway.npm, '@ai-sdk/anthropic');
  assert.strictEqual(directAnthropicOpenCode.provider.direct_claude_gateway.options.apiKey, directAnthropicKey);

  const openClaw = JSON.parse(api.buildTargetConfig('openclaw', customChat, 'chat-model', '{"gateway":{"port":18789}}'));
  assert.strictEqual(openClaw.agents.defaults.model.primary, 'chat_gateway/chat-model');
  assert.strictEqual(openClaw.models.providers.chat_gateway.api, 'openai-completions');
  assert.deepStrictEqual(openClaw.models.providers.chat_gateway.apiKey, { source: 'env', provider: 'default', id: 'MODEL_SWITCH_API_KEY' });
  const repairedOpenClaw = JSON.parse(api.buildTargetConfig(
    'openclaw', customChat, 'chat-model', '{"agents":[],"models":{"providers":[]}}'
  ));
  assert.strictEqual(repairedOpenClaw.agents.defaults.model.primary, 'chat_gateway/chat-model');
  assert.strictEqual(repairedOpenClaw.models.providers.chat_gateway.api, 'openai-completions');

  const directAnthropicOpenClaw = JSON.parse(api.buildTargetConfig(
    'openclaw', directAnthropic, 'claude-direct-model', '{}\n', directAnthropicKey
  ));
  assert.strictEqual(directAnthropicOpenClaw.models.providers.direct_claude_gateway.api, 'anthropic-messages');
  assert.strictEqual(directAnthropicOpenClaw.models.providers.direct_claude_gateway.apiKey, directAnthropicKey);

  const hermes = YAML.parse(api.buildTargetConfig('hermes', customAnthropic, 'claude-model', 'terminal:\n  theme: dark\n'));
  assert.strictEqual(hermes.model.provider, 'custom:claude_gateway');
  assert.strictEqual(hermes.providers.claude_gateway.transport, 'anthropic_messages');
  assert.strictEqual(hermes.terminal.theme, 'dark');
  const directAnthropicHermes = YAML.parse(api.buildTargetConfig(
    'hermes', directAnthropic, 'claude-direct-model', '{}\n', directAnthropicKey
  ));
  assert.strictEqual(directAnthropicHermes.providers.direct_claude_gateway.transport, 'anthropic_messages');
  assert.strictEqual(directAnthropicHermes.providers.direct_claude_gateway.key, directAnthropicKey);
  const hermesGemini = YAML.parse(api.buildTargetConfig('hermes', gemini, 'gemini-2.5-pro', '{}\n'));
  assert.strictEqual(hermesGemini.model.provider, 'gemini');

  const secretChat = { ...customChat, authMode: 'secret' };
  assert.strictEqual(api.targetCompatibility('opencode', secretChat).supported, false);
  assert.throws(
    () => profile({ ...customChat, id: undefined, authMode: 'secret' }),
    /only supports environment-variable authentication|仅支持环境变量认证或无认证|does not support the selected authentication mode|不支持所选认证方式/
  );
  assert.throws(
    () => api.buildTargetConfig('opencode', directAnthropic, 'claude-direct-model', '{}\n'),
    /missing.*API Key|缺少 API Key/i
  );
  assert.strictEqual(api.targetCompatibility('codex', customChat).supported, false);
  assert.strictEqual(api.targetCompatibility('claude', customAnthropic).supported, true);
  assert.strictEqual(api.targetCompatibility('claude', directAnthropic).supported, true,
    'Claude environment-variable name restrictions must not apply to direct credentials');
  for (const targetId of ['claude', 'opencode', 'openclaw', 'hermes']) {
    assert.strictEqual(api.targetCompatibility(targetId, directAnthropic).supported, true,
      `${targetId} must accept direct Anthropic credentials`);
  }
  assert(extensionSource.includes("if (profile.kind !== 'customResponses') authChoices = authChoices.filter(item => item.value !== 'envHeaders')"),
    'the command-palette editor must not offer unsupported header authentication for Anthropic gateways');
  assert(extensionSource.includes("profile.kind === 'customAnthropic' ? '$(symbol-variable) API Key 环境变量'"),
    'the command-palette editor must describe Anthropic environment authentication as an API key');

  const values = new Map();
  const storedSecrets = new Map();
  let failActiveStateUpdates = false;
  const context = {
    globalState: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) {
        if (value === undefined) values.delete(key); else values.set(key, value);
        if (failActiveStateUpdates && key.includes('activeCliTargetsV1')) {
          throw new Error('simulated persistent active-state failure');
        }
      }
    },
    secrets: {
      async get(key) { return storedSecrets.get(key); },
      async store(key, value) { storedSecrets.set(key, value); },
      async delete(key) { storedSecrets.delete(key); }
    }
  };
  storedSecrets.set(api.profileSecretKey(context, directAnthropic.id), directAnthropicKey);
  const profilesStateKey = api.environmentStateKey(context, 'modelProfilesV2');
  values.set(profilesStateKey, [grok, customChat, driftChat, missingConfigChat]);
  const statusBar = { show() {}, text: '', tooltip: '' };
  const grokFiles = api.pathsForTarget('grok');
  const openClawFiles = api.pathsForTarget('openclaw');
  fs.mkdirSync(path.dirname(grokFiles.config), { recursive: true });
  fs.mkdirSync(path.dirname(openClawFiles.config), { recursive: true });
  const originalGrok = '[ui]\ncompact = true\n';
  const originalOpenClaw = '{"gateway":{"port":18789}}\n';
  fs.writeFileSync(grokFiles.config, originalGrok);
  fs.writeFileSync(openClawFiles.config, originalOpenClaw);

  (async () => {
    await Promise.all([
      api.updateActiveTarget(context, 'codex', { profileId: customAnthropic.id, model: 'codex-model' }),
      api.updateActiveTarget(context, 'opencode', { profileId: customAnthropic.id, model: 'opencode-model' }),
      api.updateActiveTarget(context, 'claude', { profileId: customAnthropic.id, model: 'claude-model' }),
      api.updateActiveTarget(context, 'hermes', { profileId: customChat.id, model: 'chat-model' })
    ]);
    const activeTargets = api.getActiveTargets(context);
    assert(activeTargets.claude && activeTargets.hermes, 'concurrent target state updates must not overwrite each other');
    assert.strictEqual(activeTargets.codex.model, 'codex-model');
    assert.strictEqual(activeTargets.opencode.model, 'opencode-model');
    await api.updateActiveTarget(context, 'codex', { profileId: customAnthropic.id, model: 'codex-model-2' });
    assert.strictEqual(api.getActiveTargets(context).codex.model, 'codex-model-2');
    assert.strictEqual(api.getActiveTargets(context).opencode.model, 'opencode-model', 'each target must own its active model');
    await api.updateActiveTarget(context, 'codex', undefined);
    await api.updateActiveTarget(context, 'opencode', undefined);
    await api.updateActiveTarget(context, 'claude', undefined);
    await api.updateActiveTarget(context, 'hermes', undefined);

    for (const targetId of ['claude', 'opencode', 'openclaw', 'hermes']) {
      const preview = await api.proposedTargetContent(
        context, targetId, directAnthropic, 'claude-direct-model'
      );
      assert(preview.includes('<stored in protected configuration>'),
        `${targetId} preview must use a credential placeholder`);
      assert(!preview.includes(directAnthropicKey),
        `${targetId} preview must not read or reveal the SecretStorage credential`);
    }

    const codexHash = api.contentHash('model = "gpt-5"\nmodel_provider = "openai"\n');
    const gatewayHash = api.contentHash('model = "gpt-5"\nmodel_provider = "gateway"\n');
    assert.match(codexHash, /^[a-f0-9]{64}$/);
    assert.notStrictEqual(codexHash, gatewayHash, 'different Codex configurations must not share an applied-content hash');
    assert.strictEqual(codexHash, api.contentHash('model = "gpt-5"\nmodel_provider = "openai"\n'));

    const order = [];
    await Promise.all([
      api.withTargetMutation('grok', async () => {
        order.push('first:start');
        await new Promise(resolve => setTimeout(resolve, 15));
        order.push('first:end');
      }),
      api.withTargetMutation('grok', async () => { order.push('second'); })
    ]);
    assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);

    await api.activateExternalTarget(context, 'grok', grok, 'grok-4');
    await api.activateExternalTarget(context, 'openclaw', customChat, 'chat-model');
    assert(api.getActiveTargets(context).grok);
    assert(api.getActiveTargets(context).openclaw);
    assert(fs.readFileSync(openClawFiles.config, 'utf8').includes('chat_gateway/chat-model'));

    const claudeFiles = api.pathsForTarget('claude');
    await api.activateExternalTarget(context, 'claude', directAnthropic, 'claude-direct-model');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(claudeFiles.config, 'utf8')).env.ANTHROPIC_API_KEY,
      directAnthropicKey,
      'activation must resolve the direct Anthropic key from SecretStorage'
    );
    await api.restoreExternalTarget(context, 'claude');
    assert(!fs.existsSync(claudeFiles.config),
      'restoring a target that originally had no configuration must remove the managed direct credential');

    await api.restoreExternalTarget(context, 'grok');
    assert.strictEqual(fs.readFileSync(grokFiles.config, 'utf8'), originalGrok);
    assert(!api.getActiveTargets(context).grok);
    assert(api.getActiveTargets(context).openclaw, 'restoring Grok must not affect OpenClaw');
    assert(fs.readFileSync(openClawFiles.config, 'utf8').includes('chat_gateway/chat-model'));

    await api.activateExternalTarget(context, 'grok', grok, 'grok-4');
    const managedGrokState = fs.readFileSync(grokFiles.originalState, 'utf8');
    failActiveStateUpdates = true;
    await assert.rejects(
      api.restoreExternalTarget(context, 'grok'),
      /simulated persistent active-state failure/
    );
    failActiveStateUpdates = false;
    assert.strictEqual(fs.readFileSync(grokFiles.originalState, 'utf8'), managedGrokState,
      'state-file rollback must still run when active-state rollback also fails');
    assert(fs.readFileSync(grokFiles.config, 'utf8').includes('# Managed by CLI Model Switcher'),
      'a failed restore must put the managed config back');
    await api.restoreExternalTarget(context, 'grok');

    const deletion = await api.deleteStoredProfile(context, customChat, statusBar);
    assert.strictEqual(deletion.cancelled, false);
    assert.deepStrictEqual(deletion.restoredTargets, ['openclaw']);
    assert.strictEqual(fs.readFileSync(openClawFiles.config, 'utf8'), originalOpenClaw, 'deleting an active provider must restore the target first');
    assert(!api.getActiveTargets(context).openclaw);
    assert(!values.get(profilesStateKey).some(item => item.id === customChat.id), 'provider must be deleted after restore');

    await api.activateExternalTarget(context, 'openclaw', driftChat, 'chat-model');
    fs.appendFileSync(openClawFiles.config, '// first external edit\n');
    const reapplied = await api.activateExternalTarget(context, 'openclaw', driftChat, 'chat-model');
    assert(reapplied, 'confirmed drift reapply must complete');
    assert.strictEqual(
      (await api.getTargetManagementState(context, 'openclaw', openClawFiles)).status,
      'managed-clean',
      'confirmed reapply must replace the drift and record the new content hash'
    );
    assert(!fs.readFileSync(openClawFiles.config, 'utf8').includes('first external edit'));
    await api.updateActiveTarget(context, 'openclaw', undefined);
    fs.appendFileSync(openClawFiles.config, '// external edit\n');
    const driftDeletion = await api.deleteStoredProfile(context, driftChat, statusBar);
    assert.strictEqual(driftDeletion.cancelled, false);
    assert.deepStrictEqual(driftDeletion.restoredTargets, ['openclaw']);
    assert.strictEqual(
      fs.readFileSync(openClawFiles.config, 'utf8'),
      originalOpenClaw,
      'disk state must identify a provider when its active record is missing and config drifted'
    );
    assert(!values.get(profilesStateKey).some(item => item.id === driftChat.id));

    await api.activateExternalTarget(context, 'openclaw', missingConfigChat, 'chat-model');
    fs.rmSync(openClawFiles.config);
    const missingConfigDeletion = await api.deleteStoredProfile(context, missingConfigChat, statusBar);
    assert.strictEqual(missingConfigDeletion.cancelled, false);
    assert.deepStrictEqual(missingConfigDeletion.restoredTargets, ['openclaw']);
    assert.strictEqual(
      fs.readFileSync(openClawFiles.config, 'utf8'),
      originalOpenClaw,
      'a missing managed config must be restored from backup before deleting its provider'
    );
    assert(!values.get(profilesStateKey).some(item => item.id === missingConfigChat.id));
    console.log('PASS: Claude, Gemini, Grok, OpenCode, OpenClaw and Hermes adapters with isolated restore.');
  })().finally(() => {
    Module._load = originalLoad;
    os.homedir = originalHomedir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
} catch (error) {
  Module._load = originalLoad;
  os.homedir = originalHomedir;
  fs.rmSync(sandbox, { recursive: true, force: true });
  throw error;
}
