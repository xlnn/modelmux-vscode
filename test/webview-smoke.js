'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const dashboardSource = fs.readFileSync(path.join(root, 'media', 'dashboard.js'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(root, 'media', 'dashboard.css'), 'utf8');

const mockVscode = {
  env: { remoteName: undefined },
  workspace: { getConfiguration() { return { get(_key, fallback) { return fallback; } }; } },
  window: {},
  commands: {},
  Uri: {
    file(value) { return { fsPath: value }; },
    joinPath(base, ...parts) { return { fsPath: path.join(base.fsPath || String(base), ...parts) }; }
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const api = require('../extension.js').__test;
  assert.strictEqual(typeof api.getDashboardHtml, 'function', 'extension.__test is missing: getDashboardHtml');

  const webview = {
    cspSource: 'vscode-webview://modelmux-test',
    asWebviewUri(uri) { return `vscode-webview://modelmux-test/${path.basename(uri.fsPath)}`; }
  };
  const html = api.getDashboardHtml(webview, { fsPath: root });

  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<html\s+lang="en">/i);
  assert.match(html, /<meta\s+name="viewport"[^>]*>/i);
  assert.match(html, /<title>ModelMux<\/title>/);
  assert(html.includes("default-src 'none'"));
  assert(html.includes("base-uri 'none'"));
  assert(html.includes("form-action 'none'"));
  assert(html.includes('vscode-webview://modelmux-test/dashboard.css'));
  assert(html.includes('vscode-webview://modelmux-test/dashboard.js'));

  const script = html.match(/<script\s+nonce="([^"]+)"\s+src="([^"]+)"\s*><\/script>/i);
  assert(script && script[1].length >= 16, 'dashboard script must use a fresh CSP nonce');
  assert.strictEqual((html.match(/<script\b/gi) || []).length, 1, 'dashboard must load one nonce-protected script');
  assert(!/\son[a-z]+\s*=/i.test(html), 'inline event handlers bypass the dashboard event boundary');

  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), match => match[1]);
  assert(ids.length > 20, 'dashboard HTML extraction returned an incomplete document');
  assert.strictEqual(new Set(ids).size, ids.length, 'dashboard element IDs must be unique');

  for (const dialogId of ['settingsDialog', 'profileDialog']) {
    const opening = html.match(new RegExp(`<dialog[^>]*id="${dialogId}"[^>]*>`, 'i'));
    assert(opening, `${dialogId} is missing`);
    const labelledBy = opening[0].match(/aria-labelledby="([^"]+)"/i);
    const describedBy = opening[0].match(/aria-describedby="([^"]+)"/i);
    assert(labelledBy && ids.includes(labelledBy[1]), `${dialogId} must reference an existing title`);
    assert(describedBy && ids.includes(describedBy[1]), `${dialogId} must reference existing descriptive text`);
  }

  const controls = Array.from(html.matchAll(/<(input|select|textarea)\b[^>]*>/gi));
  for (const match of controls) {
    const opening = match[0];
    if (/type="hidden"/i.test(opening)) continue;
    const position = match.index;
    const wrappedByLabel = html.lastIndexOf('<label', position) > html.lastIndexOf('</label>', position);
    const named = /aria-label(?:ledby)?="[^"]+"/i.test(opening)
      || /\sid="([^"]+)"/i.test(opening) && new RegExp(`<label[^>]*for="${opening.match(/\sid="([^"]+)"/i)[1]}"`, 'i').test(html);
    assert(wrappedByLabel || named, `form control has no accessible label: ${opening}`);
  }

  const buttons = Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi));
  assert(buttons.length > 10, 'dashboard actions are missing');
  for (const [, attributes, body] of buttons) {
    const visibleText = body.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
    assert(/aria-label="[^"]+"/i.test(attributes) || visibleText, `button has no accessible name: <button${attributes}>`);
  }

  assert(/aria-live="polite"/i.test(html));
  assert(/role="status"/i.test(html));
  assert(ids.includes('previewRestore'), 'restore diff preview action is missing');
  assert(ids.includes('diagnosticsDialog'), 'structured diagnostics dialog is missing');
  assert(ids.includes('importStrategy'), 'import conflict strategy control is missing');
  assert(dashboardSource.includes('managementStatus'), 'dashboard must render explicit target management states');
  for (const capability of ['canRestore', 'canApply', 'canEdit', 'canDelete', 'canClearSecret']) {
    assert(dashboardSource.includes(capability), `dashboard does not consume ${capability}`);
  }
  assert(dashboardSource.includes("request('previewRestore'"), 'restore preview must use the validated message boundary');
  assert(dashboardSource.includes("request('commitImport', { importId: importSession.importId, strategy })"), 'import commit must use the server-held preview and explicit conflict strategy');
  assert(dashboardSource.includes("menu.scrollIntoView({ block: 'nearest', inline: 'nearest' })"), 'expanded provider menus must scroll fully into view');
  assert(/\.provider-row \.menu\s*\{[\s\S]*position:\s*static/.test(dashboardCss), 'provider menus must expand their row instead of being clipped overlays');
  assert(/\.provider-row \.menu\s*\{[\s\S]*overflow-y:\s*auto/.test(dashboardCss), 'provider menus must remain scrollable in short Webviews');
  assert(/:focus-visible/.test(dashboardCss), 'keyboard focus must remain visible');
  assert(dashboardCss.includes('vscode-high-contrast-light'), 'high contrast light theme must receive explicit borders and focus styles');
  assert(dashboardCss.includes('prefers-reduced-motion'), 'dashboard must respect reduced-motion preferences');
  assert(!/\.innerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(/.test(dashboardSource), 'dashboard must build untrusted content with DOM/text APIs');
  assert(dashboardSource.includes("window.addEventListener('message'"));
  assert(dashboardSource.includes('textContent'));

  console.log('PASS: extracted Webview document CSP, DOM safety and accessibility structure.');
} finally {
  Module._load = originalLoad;
}
