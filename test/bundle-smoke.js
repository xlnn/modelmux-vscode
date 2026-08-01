'use strict';

const assert = require('assert');
const Module = require('module');

const mockVscode = {
  env: { remoteName: undefined },
  workspace: { getConfiguration() { return { get(_key, fallback) { return fallback; } }; } },
  window: {},
  commands: {},
  Uri: { file(value) { return { fsPath: value }; } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require('../dist/extension.js');
  assert.strictEqual(typeof extension.activate, 'function');
  assert.strictEqual(typeof extension.__test.buildTargetConfig, 'function');
  console.log('PASS: bundled extension entry point loads successfully.');
} finally {
  Module._load = originalLoad;
}
