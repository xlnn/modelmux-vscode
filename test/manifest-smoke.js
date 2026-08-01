'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(root, 'media', 'dashboard.js'), 'utf8');

assert.strictEqual(manifest.name, 'codex-config-switcher', 'the existing extension ID must remain stable for upgrades');
assert.strictEqual(manifest.displayName, 'ModelMux：AI CLI 模型管理器');
assert.strictEqual(manifest.version, '1.1.0');
assert(manifest.repository.url.endsWith('/modelmux-vscode.git'));
assert.strictEqual(manifest.icon, 'media/modelmux.png');
assert(manifest.keywords.length <= 30, 'Marketplace supports at most 30 keywords');
assert.strictEqual(manifest.contributes.configuration.properties['codexConfigSwitcher.uiLanguage'].default, 'en');
assert.strictEqual(manifest.contributes.configuration.properties['codexConfigSwitcher.uiFontFamily'].default, 'default');
assert.strictEqual(manifest.contributes.configuration.properties['codexConfigSwitcher.uiFontSize'].default, 13);
assert(fs.existsSync(path.join(root, 'media', 'modelmux.png')));
assert(fs.existsSync(path.join(root, 'media', 'modelmux.svg')));
assert(extensionSource.includes('id="settingsDialog"'));
assert(!extensionSource.includes('id="fontReset"'), 'font controls must not remain in the dashboard header');
assert(dashboardSource.includes("'zh-CN'"));
assert(dashboardSource.includes("let locale = 'en'"));

console.log('PASS: ModelMux branding, settings, localization, repository and icon metadata.');
