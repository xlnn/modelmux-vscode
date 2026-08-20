'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const dashboardSource = fs.readFileSync(path.join(root, 'media', 'dashboard.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

assert.strictEqual(manifest.publisher, 'cherry-local');
assert.strictEqual(manifest.name, 'codex-config-switcher', 'the existing extension ID must remain stable for upgrades');
assert.strictEqual(manifest.displayName, 'ModelMux: AI CLI Model Manager');
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'extension version must be valid SemVer');
assert.strictEqual(lockfile.version, manifest.version, 'package-lock version must match package.json');
assert.strictEqual(lockfile.packages[''].version, manifest.version, 'root lockfile package version must match package.json');
assert(readme.includes(`ModelMux: AI CLI Model Manager ${manifest.version}`), 'README title must match the manifest version');
assert(readme.includes(`modelmux-${manifest.version}.vsix`), 'README package examples must match the manifest version');
assert(changelog.includes(`## ${manifest.version}`), 'CHANGELOG must include the manifest version');
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

console.log(`PASS: ModelMux ${manifest.version} identity, application settings, workspace restrictions and assets.`);
