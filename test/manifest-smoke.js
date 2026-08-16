'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dashboardSource = fs.readFileSync(path.join(root, 'media', 'dashboard.js'), 'utf8');

assert.strictEqual(manifest.publisher, 'cherry-local');
assert.strictEqual(manifest.name, 'codex-config-switcher', 'the existing extension ID must remain stable for upgrades');
assert.strictEqual(manifest.displayName, 'ModelMux: AI CLI Model Manager');
assert.strictEqual(manifest.version, '1.2.0');
assert(manifest.repository.url.endsWith('/modelmux-vscode.git'));
assert.strictEqual(manifest.icon, 'media/modelmux.png');
assert(manifest.keywords.length <= 30, 'Marketplace supports at most 30 keywords');

const configuration = manifest.contributes.configuration.properties;
assert.strictEqual(configuration['codexConfigSwitcher.uiLanguage'].default, 'en');
assert.strictEqual(configuration['codexConfigSwitcher.uiFontFamily'].default, 'default');
assert.strictEqual(configuration['codexConfigSwitcher.uiFontSize'].default, 13);
assert.strictEqual(configuration['codexConfigSwitcher.approvalPolicy'].scope, 'machine');
assert.strictEqual(configuration['codexConfigSwitcher.sandboxMode'].scope, 'machine');
for (const key of [
  'codexConfigSwitcher.uiFontSize',
  'codexConfigSwitcher.uiFontFamily',
  'codexConfigSwitcher.uiLanguage'
]) {
  assert.strictEqual(configuration[key].scope, 'application', `${key} must be application-scoped`);
}

const restricted = manifest.capabilities
  && manifest.capabilities.untrustedWorkspaces
  && manifest.capabilities.untrustedWorkspaces.restrictedConfigurations;
assert(Array.isArray(restricted), 'untrusted workspaces must declare restricted configuration keys');
for (const key of [
  'codexConfigSwitcher.approvalPolicy',
  'codexConfigSwitcher.sandboxMode'
]) {
  assert(restricted.includes(key), `${key} must be restricted in untrusted workspaces`);
}

assert(fs.existsSync(path.join(root, 'media', 'modelmux.png')));
assert(fs.existsSync(path.join(root, 'media', 'modelmux.svg')));
assert(dashboardSource.includes("'zh-CN'"));
assert(dashboardSource.includes("let locale = 'en'"));

console.log('PASS: ModelMux 1.2.0 identity, application settings, workspace restrictions and assets.');
