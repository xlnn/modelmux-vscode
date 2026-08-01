'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const JSON5 = require('json5');
const YAML = require('yaml');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-model-switcher-test-'));
process.env.GROK_HOME = path.join(sandbox, 'grok');
process.env.OPENCLAW_CONFIG_PATH = path.join(sandbox, 'openclaw', 'openclaw.json');

const mockVscode = {
  env: { remoteName: undefined },
  workspace: { getConfiguration() { return { get(_key, fallback) { return fallback; } }; } },
  window: { async showWarningMessage() { return '仍然恢复'; } },
  commands: {},
  Uri: { file(value) { return { fsPath: value }; } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const api = require('../extension.js').__test;

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
const grok = profile({ kind: 'grok', name: 'Grok', selectedModel: 'grok-4', models: ['grok-4'] });
const gemini = profile({ kind: 'gemini', name: 'Gemini', selectedModel: 'gemini-2.5-pro', models: ['gemini-2.5-pro'] });

try {
  const claudeConfig = JSON.parse(api.buildTargetConfig('claude', customAnthropic, 'claude-model', '{"permissions":{"allow":[]}}'));
  assert.strictEqual(claudeConfig.model, 'claude-model');
  assert.strictEqual(claudeConfig.env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
  assert.deepStrictEqual(claudeConfig.permissions, { allow: [] });

  const geminiConfig = JSON.parse(api.buildTargetConfig('gemini', gemini, 'gemini-2.5-pro', '{"theme":"Default"}'));
  assert.strictEqual(geminiConfig.model.name, 'gemini-2.5-pro');
  assert.strictEqual(geminiConfig.theme, 'Default');

  const grokConfig = api.buildTargetConfig('grok', grok, 'grok-4', '# user comment\n[ui]\ncompact = true\n');
  assert(grokConfig.includes('# user comment'));
  assert(grokConfig.includes('[models]\ndefault = "grok-4"'));

  const openCodeText = api.buildTargetConfig('opencode', customChat, 'chat-model', '{\n  // keep me\n  "theme": "system"\n}\n');
  assert(openCodeText.includes('// keep me'));
  const openCode = JSON5.parse(openCodeText);
  assert.strictEqual(openCode.model, 'chat_gateway/chat-model');
  assert.strictEqual(openCode.provider.chat_gateway.options.apiKey, '{env:MODEL_SWITCH_API_KEY}');

  const openClaw = JSON.parse(api.buildTargetConfig('openclaw', customChat, 'chat-model', '{"gateway":{"port":18789}}'));
  assert.strictEqual(openClaw.agents.defaults.model.primary, 'chat_gateway/chat-model');
  assert.strictEqual(openClaw.models.providers.chat_gateway.api, 'openai-completions');
  assert.deepStrictEqual(openClaw.models.providers.chat_gateway.apiKey, { source: 'env', provider: 'default', id: 'MODEL_SWITCH_API_KEY' });

  const hermes = YAML.parse(api.buildTargetConfig('hermes', customAnthropic, 'claude-model', 'terminal:\n  theme: dark\n'));
  assert.strictEqual(hermes.model.provider, 'custom:claude_gateway');
  assert.strictEqual(hermes.providers.claude_gateway.transport, 'anthropic_messages');
  assert.strictEqual(hermes.terminal.theme, 'dark');
  const hermesGemini = YAML.parse(api.buildTargetConfig('hermes', gemini, 'gemini-2.5-pro', '{}\n'));
  assert.strictEqual(hermesGemini.model.provider, 'gemini');

  const secretChat = { ...customChat, authMode: 'secret' };
  assert.strictEqual(api.targetCompatibility('opencode', secretChat).supported, false);
  assert.throws(() => profile({ ...customChat, id: undefined, authMode: 'secret' }), /only supports environment-variable authentication|仅支持环境变量认证或无认证/);
  assert.strictEqual(api.targetCompatibility('codex', customChat).supported, false);
  assert.strictEqual(api.targetCompatibility('claude', customAnthropic).supported, true);

  const values = new Map([['modelProfilesV2', [grok, customChat]]]);
  const context = {
    globalState: {
      get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
      async update(key, value) { if (value === undefined) values.delete(key); else values.set(key, value); }
    }
  };
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
      api.updateActiveTarget(context, 'claude', { profileId: customAnthropic.id, model: 'claude-model' }),
      api.updateActiveTarget(context, 'hermes', { profileId: customChat.id, model: 'chat-model' })
    ]);
    assert(api.getActiveTargets(context).claude && api.getActiveTargets(context).hermes, 'concurrent target state updates must not overwrite each other');
    await api.updateActiveTarget(context, 'claude', undefined);
    await api.updateActiveTarget(context, 'hermes', undefined);

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

    await api.restoreExternalTarget(context, 'grok');
    assert.strictEqual(fs.readFileSync(grokFiles.config, 'utf8'), originalGrok);
    assert(!api.getActiveTargets(context).grok);
    assert(api.getActiveTargets(context).openclaw, 'restoring Grok must not affect OpenClaw');
    assert(fs.readFileSync(openClawFiles.config, 'utf8').includes('chat_gateway/chat-model'));
    console.log('PASS: Claude, Gemini, Grok, OpenCode, OpenClaw and Hermes adapters with isolated restore.');
  })().finally(() => {
    Module._load = originalLoad;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
} catch (error) {
  Module._load = originalLoad;
  fs.rmSync(sandbox, { recursive: true, force: true });
  throw error;
}
