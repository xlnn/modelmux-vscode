'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-activation-'));
const testHome = path.join(sandbox, 'home');
const testTemp = path.join(sandbox, 'tmp');
const originalHomedir = os.homedir;
const originalTmpdir = os.tmpdir;
os.homedir = () => testHome;
os.tmpdir = () => testTemp;
fs.mkdirSync(testHome, { recursive: true });
fs.mkdirSync(testTemp, { recursive: true });
delete process.env.CODEX_HOME;

const registered = [];
const mockVscode = {
  env: { remoteName: undefined },
  workspace: {
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; },
    async openTextDocument(options) { return options; },
    fs: { async writeFile() {}, async readFile() { return Buffer.from('{}'); } }
  },
  window: {
    registerWebviewViewProvider(id) { registered.push(id); return { dispose() {} }; },
    createStatusBarItem() { return { show() {}, dispose() {}, text: '', tooltip: '', command: '' }; },
    async showTextDocument() {}, async showInformationMessage() {}, async showErrorMessage() {}, async showWarningMessage() {}
  },
  commands: {
    registerCommand(id) { registered.push(id); return { dispose() {} }; },
    async executeCommand() {}
  },
  StatusBarAlignment: { Right: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { file(value) { return { fsPath: value }; }, joinPath(base, ...parts) { return { fsPath: [base.fsPath || base, ...parts].join('/') }; } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../extension.js');
const state = new Map();
const context = {
  subscriptions: [],
  extensionUri: { fsPath: sandbox },
  extension: { id: 'cherry-local.codex-config-switcher', packageJSON: { version: '1.4.0' } },
  globalState: {
    get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
    async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); }
  },
  secrets: { async get() {}, async store() {}, async delete() {} }
};

(async () => {
  await extension.activate(context);
  assert(registered.includes('codexConfigSwitcher.dashboard'));
  assert(registered.includes('codexConfigSwitcher.exportProfiles'));
  assert(registered.includes('codexConfigSwitcher.importProfiles'));
  assert(context.subscriptions.length >= 10);
  console.log('PASS: extension activation and command registration.');
})().finally(() => {
  Module._load = originalLoad;
  os.homedir = originalHomedir;
  os.tmpdir = originalTmpdir;
  fs.rmSync(sandbox, { recursive: true, force: true });
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
