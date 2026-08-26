'use strict';

const assert = require('assert');
const Module = require('module');

const mockVscode = {
  env: { remoteName: undefined },
  workspace: {
    workspaceFolders: [],
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const api = require('../extension.js').__test;
const state = new Map();
const secrets = new Map();
function createContext() {
  return {
    globalState: {
      get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
      async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); }
    },
    secrets: {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); }
    },
    globalStorageUri: { scheme: 'file', authority: '', fsPath: '/extension-global-storage' }
  };
}

function profile(id, name) {
  return {
    id,
    name,
    kind: 'customResponses',
    providerId: id.replace(/-/g, '_'),
    providerName: name,
    baseUrl: `https://${id}.example/v1`,
    authMode: 'secret',
    selectedModel: 'model-a',
    models: ['model-a']
  };
}

(async () => {
  const localContext = createContext();
  const localProfile = profile('local-provider', 'Local Windows Provider');
  state.set('modelProfilesV2', [localProfile]);
  state.set('activeCliTargetsV1', { codex: { profileId: localProfile.id, model: 'model-a' } });
  secrets.set(`modelProfileApiKey:${localProfile.id}`, 'local-secret');

  await api.migrateEnvironmentStorage(localContext);
  const localProfilesKey = api.environmentStateKey(localContext, 'modelProfilesV2');
  const localSecretKey = api.profileSecretKey(localContext, localProfile.id);
  assert.deepStrictEqual(api.getProfiles(localContext), [localProfile], 'local host must retain pre-1.3.2 providers');
  assert.strictEqual(await localContext.secrets.get(localSecretKey), 'local-secret', 'local legacy credential must migrate into the local scope');
  assert(api.getActiveTargets(localContext).codex, 'local active state must migrate into the local scope');

  mockVscode.env.remoteName = 'ssh-remote';
  mockVscode.workspace.workspaceFolders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+server-a' } }];
  const serverAContext = createContext();
  await api.migrateEnvironmentStorage(serverAContext);
  const serverAProfilesKey = api.environmentStateKey(serverAContext, 'modelProfilesV2');
  assert.notStrictEqual(serverAProfilesKey, localProfilesKey, 'Remote-SSH must use a different state namespace');
  assert.deepStrictEqual(api.getProfiles(serverAContext), [], 'a remote host must not import unscoped providers from the local host');
  assert.deepStrictEqual(api.getActiveTargets(serverAContext), {}, 'a remote host must not import local active records');
  assert.strictEqual(await serverAContext.secrets.get(api.profileSecretKey(serverAContext, localProfile.id)), undefined, 'a remote host must not read the local API key');

  const serverAProfile = profile('server-a-provider', 'Server A Provider');
  await api.saveProfiles(serverAContext, [serverAProfile]);
  await serverAContext.secrets.store(api.profileSecretKey(serverAContext, serverAProfile.id), 'server-a-secret');
  assert.deepStrictEqual(api.getProfiles(serverAContext), [serverAProfile]);

  mockVscode.workspace.workspaceFolders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+server-b' } }];
  const serverBContext = createContext();
  await api.migrateEnvironmentStorage(serverBContext);
  assert.deepStrictEqual(api.getProfiles(serverBContext), [], 'different Remote-SSH hosts must have independent provider stores');
  assert.strictEqual(await serverBContext.secrets.get(api.profileSecretKey(serverBContext, serverAProfile.id)), undefined, 'different Remote-SSH hosts must have independent secrets');

  mockVscode.env.remoteName = undefined;
  mockVscode.workspace.workspaceFolders = [];
  assert.deepStrictEqual(api.getProfiles(localContext), [localProfile], 'returning local must restore only the local provider store');
  assert.strictEqual(await localContext.secrets.get(api.profileSecretKey(localContext, localProfile.id)), 'local-secret');

  mockVscode.env.remoteName = 'ssh-remote';
  mockVscode.workspace.workspaceFolders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+server-a' } }];
  assert.deepStrictEqual(api.getProfiles(serverAContext), [serverAProfile], 'returning to a remote host must restore that host\'s provider store');
  assert.strictEqual(await serverAContext.secrets.get(api.profileSecretKey(serverAContext, serverAProfile.id)), 'server-a-secret');

  console.log('PASS: local, Remote-SSH host state and SecretStorage are independently scoped.');
})().finally(() => {
  Module._load = originalLoad;
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
