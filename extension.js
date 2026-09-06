'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const childProcess = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');
const { URL } = require('url');
const JSON5 = require('json5');
const jsonc = require('jsonc-parser');
const YAML = require('yaml');
const TOML = require('@iarna/toml');
const PACKAGE_MANIFEST = require('./package.json');

const execFileAsync = promisify(childProcess.execFile);

const PROFILES_KEY = 'modelProfilesV2';
const ACTIVE_PROFILE_KEY = 'activeProfileIdV2';
const ACTIVE_TARGETS_KEY = 'activeCliTargetsV1';
const SELECTED_TARGET_KEY = 'selectedCliTargetV1';
const ENVIRONMENT_STORAGE_MIGRATION_KEY = 'environmentStorageMigrationV1';
const LEGACY_SECRET_KEY = 'customProxyApiKey';
const SECRET_PREFIX = 'modelProfileApiKey:';
const ENVIRONMENT_STATE_KEYS = [PROFILES_KEY, ACTIVE_PROFILE_KEY, ACTIVE_TARGETS_KEY, SELECTED_TARGET_KEY];
const MANAGED_MARKER = '# Managed by Codex Model Profile Manager';
const OLD_MANAGED_MARKER = '# Managed by Codex Config Switcher';
const UNIVERSAL_MANAGED_MARKER = '# Managed by CLI Model Switcher';
const ORIGINAL_STATE_FILE = 'config.toml.original-state.json';
const PROFILE_EXPORT_FORMAT = 'cli-model-profile-export';
const LEGACY_PROFILE_EXPORT_FORMAT = 'codex-model-profile-export';
const RESERVED_PROVIDER_IDS = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EXTENSION_VERSION = PACKAGE_MANIFEST.version;
const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024;
const PENDING_PROFILE_SECRET = Symbol('pendingProfileSecret');
const MODEL_CATALOG_DIRECTORY = path.join('.modelmux', 'model-catalogs');
const CUSTOM_KINDS = new Set(['customResponses', 'customChat', 'customAnthropic']);
const TARGET_IDS = ['codex', 'claude', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes'];
const TARGET_LABELS = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  grok: 'Grok Build',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes'
};
const TARGET_EXECUTABLES = {
  codex: 'codex', claude: 'claude', gemini: 'gemini', grok: 'grok',
  opencode: 'opencode', openclaw: 'openclaw', hermes: 'hermes'
};
const targetMutationQueues = new Map();
const environmentScopeIds = new WeakMap();
let activeStateMutationQueue = Promise.resolve();
let profileStateMutationQueue = Promise.resolve();
let dashboardProvider;

function expandEnvironmentVariables(value) {
  return String(value || '')
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => process.env[name] ?? match);
}

function expandUserPath(value) {
  let text = expandEnvironmentVariables(value).trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    text = path.join(os.homedir(), text.slice(2));
  }
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(os.homedir(), text);
}

function codexHomeDirectory() {
  const configured = expandUserPath(process.env.CODEX_HOME);
  return configured || path.join(os.homedir(), '.codex');
}

function safeModelCatalogSegment(value, fallback) {
  const segment = String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 64);
  return segment || fallback;
}

/**
 * Return a stable, provider-specific catalog path under the active CODEX_HOME.
 * The optional scope id lets callers keep otherwise-identical profiles from
 * different extension hosts separate when they intentionally share a home.
 */
function modelCatalogPathForProfile(profile, codexDir = codexHomeDirectory(), scopeId = '') {
  if (!profile || profile.kind !== 'customResponses') return undefined;
  const root = path.resolve(String(codexDir || codexHomeDirectory()));
  const providerId = String(profile.providerId || 'provider');
  const profileId = String(profile.id || 'profile');
  const identity = `${scopeId || ''}\u0000${profileId}\u0000${providerId}`;
  const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 20);
  const label = `${safeModelCatalogSegment(providerId, 'provider')}-${safeModelCatalogSegment(profileId, 'profile')}`.slice(0, 120);
  return path.join(root, MODEL_CATALOG_DIRECTORY, `${label}-${digest}.json`);
}

function codexDirectoryForFiles(files) {
  if (files && files.codexDir) return files.codexDir;
  if (files && files.config) return path.dirname(files.config);
  return codexHomeDirectory();
}

function modelCatalogPathForFiles(context, profile, files) {
  return modelCatalogPathForProfile(
    profile,
    codexDirectoryForFiles(files)
  );
}

function modelCatalogModels(profile, selectedModel, explicitModels) {
  const source = explicitModels === undefined
    ? [...(profile && Array.isArray(profile.models) ? profile.models : []), selectedModel]
    : [...(Array.isArray(explicitModels) ? explicitModels : []), selectedModel];
  const models = [];
  const seen = new Set();
  for (const value of source) {
    const model = String(value || '').trim();
    if (!model || model.length > 512 || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  if (!models.length) throw new Error('至少需要一个模型 ID 才能生成 Codex 模型目录。');
  return models;
}

const FALLBACK_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' }
];

function fallbackModelDisplayName(slug) {
  return String(slug || '')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-(astra|sol|terra|luna|codex|max|mini)(?=-|$)/gi, (_match, name) => (
      `-${name.charAt(0).toUpperCase()}${name.slice(1).toLowerCase()}`
    ));
}

function referenceCatalogModel(referenceCatalog, slug) {
  const models = referenceCatalog && Array.isArray(referenceCatalog.models)
    ? referenceCatalog.models : [];
  const match = models.find(item => item && item.slug === slug);
  if (!match || typeof match !== 'object' || Array.isArray(match)) return undefined;
  try { return JSON.parse(JSON.stringify(match)); }
  catch { return undefined; }
}

function fallbackReasoningLevels(slug) {
  if (!isLikelyOpenAIReasoningModel(slug)) return [FALLBACK_REASONING_LEVELS[0]];
  const id = String(slug || '').toLowerCase();
  const count = /^gpt-6-astra(?:-|$)|^gpt-5\.6-(?:sol|terra)(?:-|$)/.test(id)
    ? 6
    : /^(?:gpt-reserve|gpt-5\.6-luna|codex-auto-review)(?:-|$)/.test(id) ? 5 : 4;
  return FALLBACK_REASONING_LEVELS.slice(0, count).map(level => ({ ...level }));
}

function fallbackCatalogModel(profile, slug) {
  const providerName = String(profile && (profile.providerName || profile.name) || 'Custom provider').trim();
  return {
    include_skills_usage_instructions: false,
    use_responses_lite: true,
    description: `${providerName} model`,
    shell_type: 'unified_exec',
    default_reasoning_level: 'low',
    default_verbosity: 'low',
    supported_in_api: true,
    supported_reasoning_levels: fallbackReasoningLevels(slug),
    web_search_tool_type: 'text_and_image',
    additional_speed_tiers: [],
    include_apps_usage_instructions: false,
    multi_agent_version: 'v1',
    tool_mode: 'code_mode_only',
    include_plugin_usage_instructions: false,
    context_window: 272000,
    node_repl_disabled: false,
    display_name: fallbackModelDisplayName(slug),
    support_verbosity: true,
    apply_patch_tool_type: 'freeform',
    supports_search_tool: true,
    availability_nux: null,
    comp_hash: 'modelmux',
    upgrade: null,
    input_modalities: ['text', 'image'],
    node_repl_auto_review_required: false,
    service_tiers: [],
    model_messages: null,
    visibility: 'list',
    supports_image_detail_original: true,
    supports_parallel_tool_calls: true,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    effective_context_window_percent: 95,
    max_context_window: 872000,
    default_reasoning_summary: 'none',
    experimental_supported_tools: [],
    base_instructions: 'You are Codex.'
  };
}

function buildModelCatalog(profile, selectedModel, options = {}) {
  const models = modelCatalogModels(profile, selectedModel, options.models);
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const clientVersion = options.clientVersion || `modelmux-${EXTENSION_VERSION}`;
  return {
    fetched_at: fetchedAt,
    etag: options.etag === undefined ? null : options.etag,
    client_version: clientVersion,
    models: models.map((slug, index) => ({
      ...(referenceCatalogModel(options.referenceCatalog, slug) || fallbackCatalogModel(profile, slug)),
      slug,
      priority: index + 1,
      visibility: 'list'
    }))
  };
}

async function readCodexModelCache(codexDir) {
  const cachePath = path.join(path.resolve(String(codexDir || codexHomeDirectory())), 'models_cache.json');
  try {
    const snapshot = await readRegularFileSnapshot(cachePath);
    if (!snapshot.exists || Buffer.byteLength(snapshot.content, 'utf8') > MAX_MODEL_RESPONSE_BYTES) return undefined;
    const parsed = JSON.parse(snapshot.content);
    return parsed && Array.isArray(parsed.models) ? parsed : undefined;
  } catch (error) {
    console.warn(`Could not reuse Codex model metadata from ${cachePath}:`, error);
    return undefined;
  }
}

async function writeModelCatalogForProfile(context, profile, selectedModel, files, expectedSnapshot, options = {}) {
  if (!profile || profile.kind !== 'customResponses') return undefined;
  const catalogPath = options.path || modelCatalogPathForFiles(context, profile, files);
  const referenceCatalog = options.referenceCatalog
    || await readCodexModelCache(codexDirectoryForFiles(files));
  const content = JSON.stringify(buildModelCatalog(profile, selectedModel, { ...options, referenceCatalog }), null, 2) + '\n';
  const snapshot = expectedSnapshot || await readRegularFileSnapshot(catalogPath);
  await writeAtomic(catalogPath, content, snapshot);
  return { path: catalogPath, content, snapshot };
}

function isWslEnvironment() {
  return process.platform === 'linux' && (
    Boolean(process.env.WSL_DISTRO_NAME) ||
    /microsoft/i.test(os.release()) ||
    vscode.env.remoteName === 'wsl'
  );
}

function runtimeEnvironmentInfo() {
  const remoteName = vscode.env.remoteName || '';
  const wsl = isWslEnvironment();
  const codespaces = Boolean(process.env.CODESPACES) || remoteName === 'codespaces';
  const devContainer = remoteName === 'dev-container' || Boolean(process.env.REMOTE_CONTAINERS);
  let base;
  if (process.platform === 'win32') base = 'Windows';
  else if (process.platform === 'darwin') base = 'macOS';
  else if (wsl) base = `WSL${process.env.WSL_DISTRO_NAME ? ` (${process.env.WSL_DISTRO_NAME})` : ''}`;
  else if (codespaces) base = 'GitHub Codespaces';
  else if (devContainer) base = 'Dev Container';
  else if (process.platform === 'linux') base = 'Linux';
  else base = process.platform;

  const remoteSuffix = remoteName && !['wsl', 'codespaces', 'dev-container'].includes(remoteName)
    ? ` · ${remoteName === 'ssh-remote' ? 'Remote-SSH' : remoteName}`
    : '';
  return {
    platform: process.platform,
    platformLabel: `${base}${remoteSuffix} (${process.arch})`,
    arch: process.arch,
    remoteName,
    isRemote: Boolean(remoteName),
    wsl,
    codespaces,
    devContainer
  };
}

function platformName() {
  return runtimeEnvironmentInfo().platformLabel;
}

function currentRemoteAuthority() {
  const folders = vscode.workspace && Array.isArray(vscode.workspace.workspaceFolders)
    ? vscode.workspace.workspaceFolders
    : [];
  const remoteFolder = folders.find(folder => folder && folder.uri && folder.uri.authority);
  return remoteFolder && String(remoteFolder.uri.authority || '').trim().toLowerCase() || '';
}

function environmentScopeId(context) {
  if (context && environmentScopeIds.has(context)) return environmentScopeIds.get(context);
  const runtime = runtimeEnvironmentInfo();
  const storageUri = context && context.globalStorageUri;
  const descriptor = {
    remoteName: runtime.remoteName || 'local',
    remoteAuthority: runtime.isRemote ? currentRemoteAuthority() : '',
    platform: process.platform,
    arch: process.arch,
    hostname: String(os.hostname() || '').trim().toLowerCase(),
    home: path.normalize(os.homedir()),
    storageScheme: storageUri && storageUri.scheme || '',
    storageAuthority: storageUri && storageUri.authority || ''
  };
  const scopeId = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 24);
  if (context) environmentScopeIds.set(context, scopeId);
  return scopeId;
}

function environmentStateKey(context, key) {
  return `${key}:environment:${environmentScopeId(context)}`;
}

function getEnvironmentState(context, key, fallback) {
  return context.globalState.get(environmentStateKey(context, key), fallback);
}

async function updateEnvironmentState(context, key, value) {
  await context.globalState.update(environmentStateKey(context, key), value);
}

function pathsForCurrentUser() {
  const home = os.homedir();
  const codexDir = codexHomeDirectory();
  return {
    home,
    codexDir,
    config: path.join(codexDir, 'config.toml'),
    backup: path.join(codexDir, 'config.toml.original-backup'),
    originalState: path.join(codexDir, ORIGINAL_STATE_FILE),
    token: runtimeTokenPath()
  };
}

function existingOpenCodeConfig(configDir) {
  const override = expandUserPath(process.env.OPENCODE_CONFIG);
  if (override) return override;
  for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) {
    const candidate = path.join(configDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(configDir, 'opencode.json');
}

function pathsForTarget(targetId) {
  if (targetId === 'codex') return { ...pathsForCurrentUser(), targetId: 'codex' };
  const home = os.homedir();
  let config;
  if (targetId === 'claude') {
    const dir = expandUserPath(process.env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude');
    config = path.join(dir, 'settings.json');
  } else if (targetId === 'gemini') {
    config = path.join(home, '.gemini', 'settings.json');
  } else if (targetId === 'grok') {
    config = path.join(expandUserPath(process.env.GROK_HOME) || path.join(home, '.grok'), 'config.toml');
  } else if (targetId === 'opencode') {
    const configDir = expandUserPath(process.env.OPENCODE_CONFIG_DIR)
      || path.join(expandUserPath(process.env.XDG_CONFIG_HOME) || path.join(home, '.config'), 'opencode');
    config = existingOpenCodeConfig(configDir);
  } else if (targetId === 'openclaw') {
    config = expandUserPath(process.env.OPENCLAW_CONFIG_PATH)
      || path.join(expandUserPath(process.env.OPENCLAW_STATE_DIR) || expandUserPath(process.env.OPENCLAW_HOME) || path.join(home, '.openclaw'), 'openclaw.json');
  } else if (targetId === 'hermes') {
    const defaultRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'hermes')
      : path.join(home, '.hermes');
    config = path.join(expandUserPath(process.env.HERMES_HOME) || defaultRoot, 'config.yaml');
  } else {
    throw new Error(`不支持的 CLI 目标：${targetId}`);
  }
  return {
    targetId,
    home,
    configDir: path.dirname(config),
    config,
    backup: `${config}.cli-model-switcher-backup`,
    originalState: `${config}.cli-model-switcher-state.json`
  };
}

function targetLabel(targetId) {
  return TARGET_LABELS[targetId] || targetId;
}

function normalizeTargetId(value) {
  return TARGET_IDS.includes(value) ? value : 'codex';
}

function getSelectedTargetId(context) {
  return normalizeTargetId(getEnvironmentState(context, SELECTED_TARGET_KEY, 'codex'));
}

async function setSelectedTargetId(context, targetId) {
  const normalized = normalizeTargetId(targetId);
  await updateEnvironmentState(context, SELECTED_TARGET_KEY, normalized);
  return normalized;
}

function getActiveTargets(context) {
  const stored = getEnvironmentState(context, ACTIVE_TARGETS_KEY, undefined);
  const result = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
  if (stored === undefined) {
    const legacyCodexId = getEnvironmentState(context, ACTIVE_PROFILE_KEY);
    if (legacyCodexId) result.codex = { profileId: legacyCodexId };
  }
  return result;
}

async function updateActiveTarget(context, targetId, value) {
  const operation = activeStateMutationQueue.catch(() => {}).then(async () => {
    const previousTargets = getEnvironmentState(context, ACTIVE_TARGETS_KEY, undefined);
    const previousLegacy = targetId === 'codex'
      ? getEnvironmentState(context, ACTIVE_PROFILE_KEY, undefined) : undefined;
    const targets = getActiveTargets(context);
    if (value) targets[targetId] = value;
    else delete targets[targetId];
    let targetsUpdateStarted = false;
    let legacyUpdateStarted = false;
    try {
      targetsUpdateStarted = true;
      await updateEnvironmentState(context, ACTIVE_TARGETS_KEY, targets);
      if (targetId === 'codex') {
        legacyUpdateStarted = true;
        await updateEnvironmentState(context, ACTIVE_PROFILE_KEY, value && value.profileId);
      }
    } catch (error) {
      const rollbackErrors = [];
      if (legacyUpdateStarted) {
        try { await updateEnvironmentState(context, ACTIVE_PROFILE_KEY, previousLegacy); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (targetsUpdateStarted) {
        try { await updateEnvironmentState(context, ACTIVE_TARGETS_KEY, previousTargets); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) {
        throw new Error(`${error.message || error}；活动 Provider 状态回滚未完成：${rollbackErrors.map(item => item.message || item).join('；')}`, { cause: error });
      }
      throw error;
    }
  });
  activeStateMutationQueue = operation;
  return operation;
}

async function activeManagedTargetForProfile(context, profileId) {
  return (await managedTargetsForProfile(context, profileId))[0];
}

async function managedTargetMap(context) {
  const activeTargets = getActiveTargets(context);
  const result = new Map();
  const add = (profileId, targetId) => {
    if (!profileId) return;
    const targets = result.get(profileId) || [];
    if (!targets.includes(targetId)) targets.push(targetId);
    result.set(profileId, targets);
  };
  await Promise.all(TARGET_IDS.map(async targetId => {
    const files = pathsForTarget(targetId);
    const active = activeTargets[targetId];
    const originalState = await readOriginalState(files);
    const metadata = targetId === 'codex'
      ? parseManagedCodexMetadata(await readConfigText(files.config))
      : undefined;
    add(originalState && originalState.profileId, targetId);
    add(metadata && metadata.profileId, targetId);
    const evidenceConflicts = Boolean(
      active && ((originalState && originalState.profileId && originalState.profileId !== active.profileId)
      || (metadata && metadata.profileId && metadata.profileId !== active.profileId))
    );
    const activeHasManagedEvidence = active && !evidenceConflicts && Boolean(
      metadata
      || originalState && (
        originalState.lastAppliedHash
        || originalState.profileId
        || !originalState.restoredAt
      )
    );
    if (activeHasManagedEvidence) add(active.profileId, targetId);
  }));
  return result;
}

async function managedTargetsForProfile(context, profileId) {
  return (await managedTargetMap(context)).get(profileId) || [];
}

async function withTargetMutation(targetId, task) {
  const normalizedTarget = normalizeTargetId(targetId);
  const previous = targetMutationQueues.get(normalizedTarget) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  targetMutationQueues.set(normalizedTarget, current);
  await previous.catch(() => {});
  try { return await task(); }
  finally {
    release();
    if (targetMutationQueues.get(normalizedTarget) === current) targetMutationQueues.delete(normalizedTarget);
  }
}

async function withProfileMutation(profileId, task) {
  void profileId;
  const operation = profileStateMutationQueue.catch(() => {}).then(task);
  profileStateMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function isCustomProfile(profile) {
  return Boolean(profile && CUSTOM_KINDS.has(profile.kind));
}

function profileProtocol(profile) {
  if (!profile) return '';
  if (profile.kind === 'customResponses') return 'openai-responses';
  if (profile.kind === 'customChat') return 'openai-chat';
  if (profile.kind === 'customAnthropic') return 'anthropic-messages';
  return 'native';
}

function targetCompatibility(targetId, profile) {
  const kind = profile && profile.kind;
  const custom = isCustomProfile(profile);
  if (custom) {
    try {
      validateProviderId(profile.providerId);
      validateProviderBaseUrl(profile.baseUrl);
      assertNoSensitiveStaticValues(profile.queryParams, uiText('Query parameters', '查询参数'));
      assertNoSensitiveStaticValues(profile.httpHeaders, uiText('Static headers', '静态请求头'));
    }
    catch (error) { return { supported: false, code: 'profile', reason: error.message || String(error) }; }
  }
  if (custom && targetId !== 'codex' && !['env', 'none'].includes(profile.authMode)) {
    return { supported: false, code: 'auth', reason: '该 CLI 仅支持环境变量认证或无认证；编辑 Provider 后再启用。' };
  }
  const supportedKinds = {
    codex: ['customResponses', 'openai', 'bedrock', 'ollama', 'lmstudio'],
    claude: ['customAnthropic', 'anthropic'],
    gemini: ['gemini'],
    grok: ['grok'],
    opencode: ['customChat', 'customAnthropic', 'openai', 'anthropic', 'gemini', 'grok', 'ollama'],
    openclaw: ['customResponses', 'customChat', 'customAnthropic', 'openai', 'anthropic', 'gemini', 'grok', 'ollama'],
    hermes: ['customResponses', 'customChat', 'customAnthropic', 'openai', 'anthropic', 'gemini', 'grok', 'lmstudio']
  };
  if (!(supportedKinds[targetId] || []).includes(kind)) {
    return { supported: false, code: 'kind', reason: `${targetLabel(targetId)} 不支持 ${kindLabel(kind)} 配置。` };
  }
  if (targetId === 'claude' && custom && !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(profile.envKey)) {
    return { supported: false, code: 'claudeEnv', reason: 'Claude Code 自定义网关的环境变量名必须是 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。' };
  }
  return { supported: true, reason: '' };
}

function safeUserSegment() {
  let value = 'user';
  try { value = os.userInfo().username || value; } catch {}
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'user';
}

function isPrivateRuntimeDirectory(dir) {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      if (stat.uid !== process.getuid()) return false;
      if ((stat.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function runtimeTokenPath() {
  if (process.platform === 'linux') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    const preferred = `/run/user/${uid}`;
    if (isPrivateRuntimeDirectory(preferred)) {
      return path.join(preferred, `codex-model-profile-token-${uid}`);
    }
  }

  // macOS 的 os.tmpdir() 通常指向当前用户专属的 /var/folders/.../T 目录；
  // Windows 则通常指向 %TEMP%。Linux 在 /run/user/<uid> 不可用时也退回这里。
  const fallbackDir = path.join(os.tmpdir(), 'codex-model-profile-manager', safeUserSegment());
  return path.join(fallbackDir, 'token');
}

function resolveUnixCatCommand() {
  for (const candidate of ['/bin/cat', '/usr/bin/cat']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return 'cat';
}

function resolveWindowsPowerShellCommand() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const candidates = [
    systemRoot && path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
      continue;
    }
    try {
      childProcess.execFileSync('where.exe', [candidate], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
      return candidate;
    } catch {}
  }
  return 'powershell.exe';
}

function authCommandForToken(tokenPath, platform = process.platform) {
  if (platform === 'win32') {
    const escapedPath = String(tokenPath).replace(/'/g, "''");
    const script = `[Console]::Out.Write([System.IO.File]::ReadAllText('${escapedPath}'))`;
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    return {
      command: resolveWindowsPowerShellCommand(),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand]
    };
  }
  return { command: resolveUnixCatCommand(), args: [tokenPath] };
}

function tomlArray(values) {
  return `[${values.map(value => `"${tomlString(value)}"`).join(', ')}]`;
}

function tomlString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001F\u007F]/g, character => {
      const escapes = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
      return escapes[character] || `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
}

function tomlCommentText(value) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, 512);
}

function tomlInlineMap(value) {
  const entries = Object.entries(normalizeStringMap(value));
  return `{ ${entries.map(([key, item]) => `"${tomlString(key)}" = "${tomlString(item)}"`).join(', ')} }`;
}

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || item === undefined || item === null) continue;
    result[normalizedKey] = String(item);
  }
  return result;
}

function parseJsonMap(value, fieldName) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return normalizeStringMap(value);
  const text = String(value).trim();
  if (!text) return {};
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error(`${fieldName}超过 64 KB 限制。`);
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error(uiText(`${fieldName} must be a valid JSON object: ${error.message || error}`, `${fieldName}必须是有效的 JSON 对象：${error.message || error}`));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(uiText(`${fieldName} must be a JSON object.`, `${fieldName}必须是 JSON 对象。`));
  }
  return normalizeStringMap(parsed);
}

function isSensitiveName(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|proxyauthorization|auth|apikey|accesskey|accesskeyid|accesskeysecret|accesstoken|bearertoken|authtoken|secrettoken|clientsecret|password|passwd|credential|signature|cookie|setcookie|sessionid|privatekey|token|secret|key)$/.test(normalized);
}

function assertNoSensitiveStaticValues(map, fieldName) {
  const sensitive = Object.keys(normalizeStringMap(map)).filter(isSensitiveName);
  if (sensitive.length) {
    throw new Error(uiText(
      `${fieldName} contains credential-like keys (${sensitive.join(', ')}). Use SecretStorage or environment-variable headers instead.`,
      `${fieldName}包含疑似凭据字段（${sensitive.join(', ')}）。请改用 SecretStorage 或环境变量请求头。`
    ));
  }
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function modelDiscoveryUrl(profile) {
  const custom = String(profile.modelDiscoveryPath || '/models').trim() || '/models';
  const validatedBase = validateProviderBaseUrl(profile.baseUrl);
  let url;
  if (/^https?:\/\//i.test(custom)) {
    url = new URL(custom);
  } else {
    url = new URL(validatedBase.normalized);
    const relative = new URL(custom.startsWith('/') ? custom : `/${custom}`, 'https://modelmux.invalid');
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${relative.pathname.replace(/^\/+/, '')}`;
    for (const [key, value] of relative.searchParams) url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(normalizeStringMap(profile.queryParams))) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
}

function validatedModelDiscoveryUrl(profile, carriesCredentials) {
  const discovery = new URL(modelDiscoveryUrl(profile));
  if (!['http:', 'https:'].includes(discovery.protocol)) throw new Error(uiText('Model discovery only supports HTTP or HTTPS.', '模型发现地址仅支持 http 或 https。'));
  if (discovery.username || discovery.password) {
    throw new Error(uiText('The model discovery URL must not contain a username or password.', '模型发现地址不能包含用户名或密码。'));
  }
  const sensitiveQuery = Array.from(discovery.searchParams.keys()).filter(isSensitiveName);
  if (sensitiveQuery.length) {
    throw new Error(uiText(
      `The model discovery URL contains credential-like query parameters (${sensitiveQuery.join(', ')}).`,
      `模型发现地址包含疑似凭据查询参数（${sensitiveQuery.join(', ')}）。`
    ));
  }
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(discovery.hostname);
  if (discovery.protocol === 'http:' && !localHost && !profile.allowInsecureHttp) {
    throw new Error(uiText('Remote HTTP transmits model requests or credentials in clear text. Use HTTPS or explicitly allow unsafe remote HTTP.', '远程 HTTP 会明文传输模型请求或凭据。请改用 HTTPS，或明确勾选“允许远程 HTTP（危险）”。'));
  }
  if (carriesCredentials) {
    const base = new URL(normalizeBaseUrl(profile.baseUrl));
    if (discovery.origin !== base.origin) {
      throw new Error(uiText('The model discovery URL has a different origin from the Base URL. Credential forwarding was blocked; use a same-origin path.', '模型发现地址与 Base URL 不同源，已阻止向其它主机发送凭据。请使用同源路径。'));
    }
  }
  return discovery.toString();
}

function normalizeBaseUrl(value) {
  const source = String(value || '').trim();
  const suffixOffset = source.search(/[?#]/);
  let pathname = suffixOffset < 0 ? source : source.slice(0, suffixOffset);
  const suffix = suffixOffset < 0 ? '' : source.slice(suffixOffset);
  pathname = pathname.replace(/\/+$/, '').replace(/\/(responses|chat\/completions)$/i, '');
  return `${pathname}${suffix}`;
}

function validateProviderBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  let url;
  try { url = new URL(normalized); } catch {
    throw new Error(uiText('Base URL must be a valid HTTP or HTTPS URL.', 'Base URL 必须是有效的 http 或 https 地址。'));
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(uiText('Base URL only supports HTTP or HTTPS.', 'Base URL 仅支持 http 或 https。'));
  }
  if (url.username || url.password) {
    throw new Error(uiText('Base URL must not contain a username or password. Use the authentication controls instead.', 'Base URL 不能包含用户名或密码，请使用认证设置。'));
  }
  if (url.hash) {
    throw new Error(uiText('Base URL must not contain a URL fragment.', 'Base URL 不能包含 URL 片段。'));
  }
  const sensitiveQuery = Array.from(url.searchParams.keys()).filter(isSensitiveName);
  if (sensitiveQuery.length) {
    throw new Error(uiText(
      `Base URL contains credential-like query parameters (${sensitiveQuery.join(', ')}). Use SecretStorage or environment variables instead.`,
      `Base URL 包含疑似凭据查询参数（${sensitiveQuery.join(', ')}），请改用 SecretStorage 或环境变量。`
    ));
  }
  return { normalized, url };
}

function providerIdFromName(name) {
  let value = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!value) value = 'custom_proxy';
  if (/^[0-9]/.test(value)) value = `provider_${value}`;
  if (RESERVED_PROVIDER_IDS.has(value)) value = `${value}_custom`;
  return value;
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function legacySecretKey(profileId) {
  return `${SECRET_PREFIX}${profileId}`;
}

function profileSecretKey(context, profileId) {
  return `${SECRET_PREFIX}environment:${environmentScopeId(context)}:${profileId}`;
}

async function migrateEnvironmentStorage(context) {
  const markerKey = environmentStateKey(context, ENVIRONMENT_STORAGE_MIGRATION_KEY);
  if (context.globalState.get(markerKey, false)) return;

  // State written by versions <= 1.3.1 has no owner metadata. Only the local
  // extension host may claim it; a remote host must start with independent
  // storage instead of importing records that most likely came from the UI host.
  if (!runtimeEnvironmentInfo().isRemote) {
    for (const key of ENVIRONMENT_STATE_KEYS) {
      const scopedKey = environmentStateKey(context, key);
      if (context.globalState.get(scopedKey) !== undefined) continue;
      const legacyValue = context.globalState.get(key);
      if (legacyValue !== undefined) await context.globalState.update(scopedKey, legacyValue);
    }

    const legacyProfiles = context.globalState.get(PROFILES_KEY, []);
    if (Array.isArray(legacyProfiles)) {
      for (const profile of legacyProfiles) {
        if (!profile || typeof profile.id !== 'string') continue;
        const scopedKey = profileSecretKey(context, profile.id);
        if (await context.secrets.get(scopedKey)) continue;
        const legacySecret = await context.secrets.get(legacySecretKey(profile.id));
        if (legacySecret) await context.secrets.store(scopedKey, legacySecret);
      }
    }
  }

  await context.globalState.update(markerKey, {
    version: 1,
    migratedAt: new Date().toISOString(),
    importedUnscopedState: !runtimeEnvironmentInfo().isRemote
  });
}

function readGlobalSettings() {
  const config = vscode.workspace.getConfiguration('codexConfigSwitcher');
  const uiLanguage = config.get('uiLanguage', 'en');
  const uiFontFamily = config.get('uiFontFamily', 'default');
  return {
    approvalPolicy: config.get('approvalPolicy', 'on-request'),
    sandboxMode: config.get('sandboxMode', 'workspace-write'),
    modelRequestTimeoutMs: Number(config.get('modelRequestTimeoutMs', 15000)) || 15000,
    uiFontSize: clampInteger(config.get('uiFontSize', 13), 13, 10, 20),
    uiLanguage: ['en', 'zh-CN'].includes(uiLanguage) ? uiLanguage : 'en',
    uiFontFamily: ['default', 'system', 'monospace'].includes(uiFontFamily) ? uiFontFamily : 'default'
  };
}

function uiText(english, chinese) {
  return readGlobalSettings().uiLanguage === 'zh-CN' ? chinese : english;
}

function getProfiles(context) {
  const profiles = getEnvironmentState(context, PROFILES_KEY, []);
  return Array.isArray(profiles) ? profiles : [];
}

async function saveProfiles(context, profiles) {
  await updateEnvironmentState(context, PROFILES_KEY, profiles);
}

async function commitProfileAndSecret(context, previousProfiles, nextProfiles, profile, apiKey) {
  const secretKey = profileSecretKey(context, profile.id);
  const oldSecret = await context.secrets.get(secretKey);
  const wantsSecret = isCustomProfile(profile) && profile.authMode === 'secret';
  const nextSecret = wantsSecret ? String(apiKey || '').trim() || oldSecret : undefined;
  if (wantsSecret && !nextSecret) {
    throw new Error(uiText('SecretStorage authentication requires an API key.', 'SecretStorage 认证需要填写 API Key。'));
  }

  await saveProfiles(context, nextProfiles);
  try {
    if (wantsSecret) {
      if (nextSecret !== oldSecret) await context.secrets.store(secretKey, nextSecret);
    } else if (oldSecret !== undefined) {
      await context.secrets.delete(secretKey);
    }
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (oldSecret !== undefined) await context.secrets.store(secretKey, oldSecret);
      else await context.secrets.delete(secretKey);
    } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { await saveProfiles(context, previousProfiles); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) {
      throw new Error(`${error.message || error}；回滚 Provider/SecretStorage 时也失败：${rollbackErrors.map(item => item.message || item).join('；')}`, { cause: error });
    }
    throw error;
  }
}

async function migrateLegacyProfile(context) {
  if (runtimeEnvironmentInfo().isRemote) return;
  const existing = getProfiles(context);
  if (existing.length > 0) return;

  const legacy = vscode.workspace.getConfiguration('codexConfigSwitcher');
  const model = legacy.get('model');
  const baseUrl = legacy.get('baseUrl');
  if (!model && !baseUrl) return;

  const profile = {
    id: createId(),
    name: 'Custom Proxy（旧配置迁移）',
    kind: 'customResponses',
    providerId: 'custom_proxy',
    providerName: 'Custom Proxy',
    baseUrl: normalizeBaseUrl(baseUrl || ''),
    authMode: 'secret',
    models: [model || 'gpt-5.6-sol'],
    selectedModel: model || 'gpt-5.6-sol',
    reasoningPolicy: legacy.get('reasoningEffort', 'xhigh') || 'auto',
    allowInsecureModelDiscovery: false
  };

  await saveProfiles(context, [profile]);
  const legacySecret = await context.secrets.get(LEGACY_SECRET_KEY);
  if (legacySecret) {
    await context.secrets.store(profileSecretKey(context, profile.id), legacySecret);
  }
}

function isLikelyOpenAIReasoningModel(model) {
  const id = String(model || '').toLowerCase();
  if (/claude|gemini|qwen|glm|deepseek|mistral|llama|grok|kimi|minimax/.test(id)) return false;
  return /(^|[-_.])(gpt|codex|o[1-9])|openai/.test(id);
}

function reasoningLine(profile, model) {
  const policy = profile.reasoningPolicy || 'auto';
  if (policy === 'none') return '';
  if (policy === 'auto') {
    return isLikelyOpenAIReasoningModel(model)
      ? 'model_reasoning_effort = "high"\n'
      : '';
  }
  return `model_reasoning_effort = "${tomlString(policy)}"\n`;
}

function buildManagedConfig(profile, model, tokenPath, resolvedSecret = undefined, options = {}) {
  const settings = readGlobalSettings();
  const inferredCodexDir = options.codexDir || (tokenPath ? path.dirname(tokenPath) : codexHomeDirectory());
  const catalogPath = profile && profile.kind === 'customResponses'
    ? options.catalogPath || modelCatalogPathForProfile(profile, inferredCodexDir)
    : undefined;
  const common = `${MANAGED_MARKER}\n# profile_id = ${tomlCommentText(profile.id)}\n# profile_name = ${tomlCommentText(profile.name)}\nmodel = "${tomlString(model)}"\nmodel_provider = "${tomlString(providerIdForProfile(profile))}"\n\napproval_policy = "${tomlString(settings.approvalPolicy)}"\nsandbox_mode = "${tomlString(settings.sandboxMode)}"\n${reasoningLine(profile, model)}`;

  if (['openai', 'ollama', 'lmstudio'].includes(profile.kind)) return `${common}\n`;

  if (profile.kind === 'bedrock') {
    const awsProfile = String(profile.awsProfile || '').trim();
    const awsRegion = String(profile.awsRegion || '').trim();
    let bedrock = `${common}\n[model_providers.amazon-bedrock.aws]\n`;
    if (awsProfile) bedrock += `profile = "${tomlString(awsProfile)}"\n`;
    if (awsRegion) bedrock += `region = "${tomlString(awsRegion)}"\n`;
    return bedrock;
  }

  const validatedBase = validateProviderBaseUrl(profile.baseUrl);
  assertNoSensitiveStaticValues(profile.queryParams, uiText('Query parameters', '查询参数'));
  assertNoSensitiveStaticValues(profile.httpHeaders, uiText('Static headers', '静态请求头'));
  const requestRetries = clampInteger(profile.requestMaxRetries, 0, 0, 20);
  const streamRetries = clampInteger(profile.streamMaxRetries, 2, 0, 20);
  const streamTimeout = clampInteger(profile.streamIdleTimeoutMs, 300000, 1000, 3600000);
  let result = `${common}${catalogPath ? `model_catalog_json = "${tomlString(catalogPath)}"\n` : ''}\n[model_providers.${profile.providerId}]\nname = "${tomlString(profile.providerName || profile.name)}"\nbase_url = "${tomlString(validatedBase.normalized)}"\nwire_api = "responses"\nrequest_max_retries = ${requestRetries}\nstream_max_retries = ${streamRetries}\nstream_idle_timeout_ms = ${streamTimeout}\n`;

  if (profile.supportsWebsockets) result += 'supports_websockets = true\n';
  if (Object.keys(normalizeStringMap(profile.queryParams)).length) result += `query_params = ${tomlInlineMap(profile.queryParams)}\n`;
  if (Object.keys(normalizeStringMap(profile.httpHeaders)).length) result += `http_headers = ${tomlInlineMap(profile.httpHeaders)}\n`;
  if (Object.keys(normalizeStringMap(profile.envHttpHeaders)).length) result += `env_http_headers = ${tomlInlineMap(profile.envHttpHeaders)}\n`;

  const authMode = profile.authMode === 'bearer' ? 'secret' : (profile.authMode || 'secret');
  if (authMode === 'secret') {
    // Some Windows Codex builds do not execute command-backed provider auth
    // consistently from the VS Code extension host. In that case they send an
    // empty/invalid bearer token and rapidly trigger authentication-rate limits.
    // Use the schema-supported direct bearer field on Windows for compatibility.
    // The managed config is ACL-restricted and is removed/restored when disabled.
    if (process.platform === 'win32') {
      const token = String(resolvedSecret || '').trim();
      if (!token) throw new Error('Windows 兼容认证缺少 API Key，请重新保存并启用 Provider。');
      result += `experimental_bearer_token = "${tomlString(token)}"\n`;
    } else {
      const auth = authCommandForToken(tokenPath);
      result += `\n[model_providers.${profile.providerId}.auth]\ncommand = "${tomlString(auth.command)}"\nargs = ${tomlArray(auth.args)}\ntimeout_ms = 5000\nrefresh_interval_ms = 0\n`;
    }
  } else if (authMode === 'env') {
    result += `env_key = "${tomlString(profile.envKey)}"\n`;
    if (profile.envKeyInstructions) result += `env_key_instructions = "${tomlString(profile.envKeyInstructions)}"\n`;
  } else if (authMode === 'envHeaders' && !Object.keys(normalizeStringMap(profile.envHttpHeaders)).length) {
    throw new Error('环境变量请求头认证需要至少一个 env_http_headers 映射。');
  }
  return result;
}

function providerIdForProfile(profile) {
  if (profile.kind === 'openai') return 'openai';
  if (profile.kind === 'ollama') return 'ollama';
  if (profile.kind === 'lmstudio') return 'lmstudio';
  if (profile.kind === 'bedrock') return 'amazon-bedrock';
  return validateProviderId(profile.providerId);
}

async function ensureSupportedPlatform() {
  if (!['linux', 'win32', 'darwin'].includes(process.platform)) {
    await vscode.window.showErrorMessage(`当前系统暂不受支持：${process.platform}。`);
    return false;
  }
  return true;
}

function windowsAccountName() {
  let username = '';
  try { username = String(os.userInfo().username || '').trim(); } catch {}
  if (!username) username = String(process.env.USERNAME || '').trim();
  const domain = String(process.env.USERDOMAIN || '').trim();
  if (username.includes('\\') || username.includes('@')) return username;
  if (username && domain) return `${domain}\\${username}`;
  if (username) return username;
  return '';
}

async function verifyWindowsPrivateAcl(target) {
  const account = windowsAccountName();
  if (!account) throw new Error(`无法确定当前 Windows 账户，不能验证私有 ACL：${target}`);
  const { stdout } = await execFileAsync('icacls.exe', [target], { windowsHide: true, timeout: 10000 });
  const acl = String(stdout || '');
  if (!acl.toLowerCase().includes(`${account.toLowerCase()}:`)) {
    throw new Error(`Windows ACL 未包含当前账户：${target}`);
  }
  const broadWrite = /(?:^|[\\\s])(?:Everyone|Authenticated Users|BUILTIN\\Users|\*S-1-1-0|\*S-1-5-11|\*S-1-5-32-545):[^\r\n]*\((?:F|M|W|WD|AD|DC)\)/im;
  if (broadWrite.test(acl)) throw new Error(`Windows ACL 仍允许宽泛账户写入：${target}`);
  return acl;
}

async function applyPrivatePermissions(target, isDirectory = false) {
  if (process.platform !== 'win32') {
    await fs.promises.chmod(target, isDirectory ? 0o700 : 0o600);
    return;
  }

  const account = windowsAccountName();
  if (!account) throw new Error(`无法确定当前 Windows 账户，不能保护文件：${target}`);
  const permission = isDirectory ? '(OI)(CI)F' : 'F';
  await execFileAsync('icacls.exe', [
    target,
    '/inheritance:r',
    '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545',
    '/grant:r', `${account}:${permission}`,
    '/grant:r', '*S-1-5-18:F'
  ], { windowsHide: true, timeout: 10000 });
  await verifyWindowsPrivateAcl(target);
}

async function ensureDirectory(dir, privateOnWindows = false) {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' || privateOnWindows) {
    await applyPrivatePermissions(dir, true);
  }
}

async function ensurePrivateRuntimeDirectory(tokenPath) {
  const directory = path.resolve(path.dirname(tokenPath));
  if (process.platform === 'win32') {
    await ensureDirectory(directory, true);
    return;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const validate = async target => {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`拒绝使用符号链接或非目录作为运行时密钥目录：${target}`);
    }
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`运行时密钥目录所有者不匹配：${target}`);
    }
    await fs.promises.chmod(target, 0o700);
    const hardened = await fs.promises.lstat(target);
    if ((hardened.mode & 0o077) !== 0) {
      throw new Error(`运行时密钥目录权限不安全：${target}`);
    }
  };

  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, directory);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    let current = tempRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        await validate(current);
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
        try { await fs.promises.mkdir(current, { mode: 0o700 }); }
        catch (mkdirError) { if (!mkdirError || mkdirError.code !== 'EEXIST') throw mkdirError; }
        await validate(current);
      }
    }
    return;
  }

  await validate(directory);
}

async function writePrivateFile(file, content, privateParentOnWindows = false) {
  await ensureDirectory(path.dirname(file), privateParentOnWindows);

  if (process.platform === 'win32') {
    try {
      const existing = await fs.promises.lstat(file);
      if (existing.isSymbolicLink()) throw new Error(`拒绝写入符号链接或重解析链接：${file}`);
      if (!existing.isFile()) throw new Error(`目标不是普通文件：${file}`);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.promises.writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
      await applyPrivatePermissions(file, false);
    } catch (error) {
      await fs.promises.rm(file, { force: true }).catch(() => {});
      throw error;
    }
    return;
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
  let handle;
  try {
    handle = await fs.promises.open(file, flags, 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  await applyPrivatePermissions(file, false);
}

async function readRegularFileSnapshot(file) {
  let stat;
  try { stat = await fs.promises.lstat(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, configExists: false, currentHash: undefined, content: '' };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`拒绝读取符号链接或重解析链接：${file}`);
  if (!stat.isFile()) throw new Error(`目标不是普通文件：${file}`);
  const content = await fs.promises.readFile(file, 'utf8');
  const after = await fs.promises.lstat(file);
  if (after.isSymbolicLink() || !after.isFile()
    || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
    throw new Error(`${file} 在读取期间发生了变化。为避免覆盖外部改动，本次操作已停止。`);
  }
  return { exists: true, configExists: true, currentHash: contentHash(content), content };
}

function assertSnapshotMatches(file, actual, expected) {
  if (!expected) return;
  const expectedExists = expected.configExists !== undefined ? expected.configExists : expected.exists;
  if (actual.exists !== Boolean(expectedExists)
    || actual.exists && expected.currentHash && actual.currentHash !== expected.currentHash) {
    throw new Error(`${file} 在确认应用后又发生了变化。为避免覆盖新的外部改动，本次应用已停止，请重试。`);
  }
}

async function writeAtomic(file, content, expectedSnapshot, hooks = {}) {
  const dir = path.dirname(file);
  await ensureDirectory(dir, false);
  const baseName = path.basename(file).replace(/[^A-Za-z0-9_.-]+/g, '_');
  const operationId = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const temp = path.join(dir, `.${baseName}.tmp-${operationId}`);
  const displaced = path.join(dir, `.${baseName}.previous-${operationId}`);
  let displacedExisting = false;
  let installedReplacement = false;
  let preserveDisplaced = false;
  const replacementHash = contentHash(content);
  try {
    await writePrivateFile(temp, content);
    const sourceSnapshot = await readRegularFileSnapshot(file);
    assertSnapshotMatches(file, sourceSnapshot, expectedSnapshot);
    if (hooks.beforeDisplace) await hooks.beforeDisplace({ file, sourceSnapshot });
    if (sourceSnapshot.exists) {
      await fs.promises.copyFile(file, displaced, fs.constants.COPYFILE_EXCL);
      displacedExisting = true;
      await applyPrivatePermissions(displaced, false);
      const displacedSnapshot = await readRegularFileSnapshot(displaced);
      if (displacedSnapshot.currentHash !== sourceSnapshot.currentHash) {
        throw new Error(`${file} 的原文件恢复副本校验失败，本次写入已停止。`);
      }
      if (hooks.afterDisplace) await hooks.afterDisplace({ file, displaced, sourceSnapshot });
      const latestSource = await readRegularFileSnapshot(file);
      if (!latestSource.exists || latestSource.currentHash !== sourceSnapshot.currentHash) {
        throw new Error(`${file} 在准备原子替换期间发生了变化，本次写入已停止。`);
      }
    }
    if (!sourceSnapshot.exists) {
      // A hard-link install is exclusive: a concurrent creator gets EEXIST
      // instead of being silently overwritten by rename(temp, file).
      await fs.promises.link(temp, file);
      installedReplacement = true;
      if (hooks.afterLinkInstall) await hooks.afterLinkInstall({ file, temp, sourceSnapshot });
      // Mark the replacement before removing the temporary directory entry.
      // If cleanup fails, the formal target is still installed and must be
      // removed by the rollback path rather than being left behind.
      await fs.promises.rm(temp);
    } else {
      let renameError;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.promises.rename(temp, file);
          installedReplacement = true;
          renameError = undefined;
          break;
        } catch (error) {
          renameError = error;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
        }
      }
      if (renameError) throw renameError;
    }
    if (hooks.afterInstall) await hooks.afterInstall({ file, displaced, sourceSnapshot });
    await applyPrivatePermissions(file, false);
    if (displacedExisting) {
      await fs.promises.rm(displaced);
      displacedExisting = false;
    }
  } catch (error) {
    try {
      if (installedReplacement) {
        const installed = await readRegularFileSnapshot(file);
        if (!installed.exists || installed.currentHash !== replacementHash) {
          throw new Error('目标文件在替换后又发生了变化，不能自动覆盖该外部改动');
        }
        await fs.promises.rm(file);
        installedReplacement = false;
      }
      if (displacedExisting && !(await readRegularFileSnapshot(file)).exists) {
        await fs.promises.rename(displaced, file);
        displacedExisting = false;
      } else if (displacedExisting) {
        const current = await readRegularFileSnapshot(file);
        const previous = await readRegularFileSnapshot(displaced);
        if (!current.exists || current.currentHash !== previous.currentHash) {
          throw new Error('原目标已发生变化，不能自动丢弃恢复副本');
        }
        await fs.promises.rm(displaced);
        displacedExisting = false;
      }
    } catch (restoreError) {
      preserveDisplaced = displacedExisting;
      const location = preserveDisplaced ? `，恢复副本已保留在 ${displaced}` : '';
      throw new Error(`${error.message || error}；原文件回滚失败${location}：${restoreError.message || restoreError}`, { cause: error });
    }
    throw error;
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    if (!preserveDisplaced && displacedExisting) await fs.promises.rm(displaced, { force: true }).catch(() => {});
  }
}

async function removeFileAtomicallyIfUnchanged(file, expectedSnapshot, hooks = {}) {
  const current = await readRegularFileSnapshot(file);
  assertSnapshotMatches(file, current, expectedSnapshot);
  if (!current.exists) return false;
  const baseName = path.basename(file).replace(/[^A-Za-z0-9_.-]+/g, '_');
  const operationId = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tombstone = path.join(path.dirname(file), `.${baseName}.removed-${operationId}`);
  let moved = false;
  let preserveTombstone = false;
  try {
    await fs.promises.rename(file, tombstone);
    moved = true;
    if (hooks.afterMove) await hooks.afterMove({ file, tombstone, current });
    const displaced = await readRegularFileSnapshot(tombstone);
    if (!displaced.exists || displaced.currentHash !== current.currentHash) {
      throw new Error(`${file} 在准备删除期间发生了变化，本次删除已停止。`);
    }
    if ((await readRegularFileSnapshot(file)).exists) {
      throw new Error(`${file} 在删除期间被其它程序重新创建，本次删除已停止。`);
    }
    await fs.promises.rm(tombstone);
    moved = false;
    return true;
  } catch (error) {
    if (moved) {
      try {
        const replacement = await readRegularFileSnapshot(file);
        if (replacement.exists) {
          preserveTombstone = true;
          throw new Error(`目标路径已被其它程序重新创建，原内容保留在 ${tombstone}`);
        }
        await fs.promises.rename(tombstone, file);
        moved = false;
      } catch (restoreError) {
        preserveTombstone = true;
        throw new Error(`${error.message || error}；删除回滚失败，原内容保留在 ${tombstone}：${restoreError.message || restoreError}`, { cause: error });
      }
    }
    throw error;
  } finally {
    if (!preserveTombstone && moved) await fs.promises.rm(tombstone, { force: true }).catch(() => {});
  }
}

async function restoreFileSnapshot(file, snapshot, expectedCurrent) {
  if (snapshot.exists) {
    await writeAtomic(file, snapshot.content, expectedCurrent);
    return;
  }
  const current = await readRegularFileSnapshot(file);
  assertSnapshotMatches(file, current, expectedCurrent);
  if (current.exists) await removeFileAtomicallyIfUnchanged(file, current);
}

async function fileExists(file) {
  try {
    await fs.promises.access(file, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readConfigText(file) {
  const snapshot = await readRegularFileSnapshot(file);
  return snapshot.exists ? snapshot.content : '';
}

async function isManagedConfig(configPath) {
  const text = await readConfigText(configPath);
  if (hasTomlControlLine(text, UNIVERSAL_MANAGED_MARKER)) return true;
  return Boolean(parseManagedCodexMetadata(text));
}

async function readOriginalState(files) {
  let snapshot;
  try {
    snapshot = await readRegularFileSnapshot(files.originalState);
  } catch (error) {
    throw new Error(`无法安全读取原始状态记录 ${files.originalState}：${error.message || error}`, { cause: error });
  }
  if (!snapshot.exists) return undefined;
  try {
    const parsed = JSON.parse(snapshot.content);
    return parsed && typeof parsed.existed === 'boolean' ? parsed : undefined;
  } catch { return undefined; }
}

async function writeOriginalState(files, existed, extra = {}) {
  const current = await readOriginalState(files) || {};
  await writeAtomic(files.originalState, JSON.stringify({
    ...current,
    version: files.targetId && files.targetId !== 'codex' ? 2 : 1,
    targetId: files.targetId || current.targetId,
    existed,
    createdAt: current.createdAt || new Date().toISOString(),
    ...extra
  }, null, 2));
}

async function removeOriginalBackupState(files) {
  // Delete the backup first. If that fails, retain the state that explains who
  // owns it instead of creating a new state record that points at stale data.
  await fs.promises.rm(files.backup, { force: true });
  await fs.promises.rm(files.originalState, { force: true });
}

async function ensureOriginalBackup(files, expectedSnapshot) {
  const existingState = await readOriginalState(files);
  if (existingState && existingState.lastAppliedHash) return false;

  // A restored or interrupted takeover no longer owns the target. Capture the
  // current original again so a later restore cannot resurrect a stale backup
  // or delete a configuration created after the previous restore/cancellation.
  if (existingState) {
    await removeOriginalBackupState(files);
  } else if (await fileExists(files.backup)) {
    throw new Error(`发现没有状态记录的旧备份：${files.backup}。为避免恢复错误配置，请先手动核对或移走该文件。`);
  }

  const sourceSnapshot = await readRegularFileSnapshot(files.config);
  assertSnapshotMatches(files.config, sourceSnapshot, expectedSnapshot);
  if (!sourceSnapshot.exists) {
    await writeOriginalState(files, false);
    return true;
  }

  const alreadyManaged = files.targetId === 'grok'
    ? hasTomlControlLine(sourceSnapshot.content, UNIVERSAL_MANAGED_MARKER)
    : (!files.targetId || files.targetId === 'codex') && parseManagedCodexMetadata(sourceSnapshot.content);
  if (alreadyManaged) {
    throw new Error('当前 config.toml 已由切换器管理，但原始状态记录不存在。请先手动恢复原配置，避免覆盖。');
  }
  let backupCreated = false;
  try {
    await fs.promises.copyFile(files.config, files.backup, fs.constants.COPYFILE_EXCL);
    backupCreated = true;
    await applyPrivatePermissions(files.backup, false);
    const backupSnapshot = await readRegularFileSnapshot(files.backup);
    const latestSource = await readRegularFileSnapshot(files.config);
    if (backupSnapshot.currentHash !== sourceSnapshot.currentHash
      || !latestSource.exists || latestSource.currentHash !== sourceSnapshot.currentHash) {
      throw new Error(`${files.config} 在创建原始备份期间发生了变化，本次操作已停止。`);
    }
    const originalHash = backupSnapshot.currentHash;
    await writeOriginalState(files, true, { originalHash });
  } catch (error) {
    if (backupCreated) await fs.promises.rm(files.backup, { force: true }).catch(() => {});
    await fs.promises.rm(files.originalState, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

// Codex may append its own settings (desktop integration, MCP servers,
// project trust, etc.) to the same file after ModelMux writes the provider.
// Those settings are outside ModelMux's ownership boundary and must not turn
// an otherwise valid provider into a drift warning. Keep this projection
// deliberately small: every field ModelMux writes is still checked, while
// unknown Codex fields and sections are ignored.
const MANAGED_CODEX_ROOT_KEYS = new Set([
  'model', 'model_provider', 'model_catalog_json', 'approval_policy', 'sandbox_mode', 'model_reasoning_effort'
]);

function managedCodexConfigProjection(content, options = {}) {
  const maskSecrets = options.maskSecrets !== false;
  const source = String(content || '').replace(/^\uFEFF/, '');
  let parsed;
  try { parsed = TOML.parse(source); }
  catch { return undefined; }
  const providerId = typeof parsed.model_provider === 'string' ? parsed.model_provider : '';
  const document = splitTomlDocument(source);
  const rootLines = document.rootControlIndexes.map(index => document.root[index].trim());
  const metadata = rootLines.filter(line => line === MANAGED_MARKER || line === OLD_MANAGED_MARKER
    || /^#\s*profile_(?:id|name)\s*=/.test(line));
  const root = {};
  for (const key of MANAGED_CODEX_ROOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) root[key] = parsed[key];
  }
  const provider = providerId && parsed.model_providers && parsed.model_providers[providerId];

  const canonicalize = (value, key = '') => {
    if (maskSecrets && key === 'experimental_bearer_token') return '<secret>';
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(item => canonicalize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonicalize(value[name], name)]));
    }
    return value;
  };
  return JSON.stringify(canonicalize({ metadata, root, provider: provider || null }));
}

function managedCodexConfigHash(content, options = {}) {
  const projection = managedCodexConfigProjection(content, options);
  return projection === undefined ? undefined : contentHash(projection);
}

async function expectedManagedCodexProjection(context, files, originalState, active) {
  if (!originalState || !originalState.profileId) return undefined;
  const profile = getProfiles(context).find(item => item.id === originalState.profileId);
  if (!profile) return undefined;
  const model = active && active.model || originalState.model || profile.selectedModel;
  if (!model) return undefined;
  try {
    let secret;
    let maskSecrets = true;
    if (process.platform === 'win32' && profile.kind === 'customResponses'
      && ['secret', 'bearer'].includes(profile.authMode)) {
      secret = context && context.secrets && await context.secrets.get(profileSecretKey(context, profile.id));
      if (!secret) return undefined;
      maskSecrets = false;
    }
    return {
      value: managedCodexConfigProjection(buildManagedConfig(profile, model, files.token, secret, {
        codexDir: files.codexDir
      }), { maskSecrets }),
      maskSecrets
    };
  } catch {
    return undefined;
  }
}

function splitTomlDocument(content) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const indexes = [];
  const controlIndexes = [];
  let quote = '';
  let bracketDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!quote && bracketDepth === 0) controlIndexes.push(index);
    if (!quote && bracketDepth === 0
      && /^\s*\[{1,2}[^\r\n]+\]{1,2}\s*(?:#.*)?$/.test(line)) {
      indexes.push(index);
      continue;
    }

    for (let offset = 0; offset < line.length; offset += 1) {
      const character = line[offset];
      const triple = line.slice(offset, offset + 3);
      if (quote === '"""' || quote === "'''") {
        if (triple === quote) {
          let backslashes = 0;
          for (let cursor = offset - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1;
          if (quote === "'''" || backslashes % 2 === 0) { quote = ''; offset += 2; }
        }
        continue;
      }
      if (quote === '"') {
        if (character === '\\') offset += 1;
        else if (character === '"') quote = '';
        continue;
      }
      if (quote === "'") {
        if (character === "'") quote = '';
        continue;
      }
      if (character === '#') break;
      if (triple === '"""' || triple === "'''") { quote = triple; offset += 2; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '[' || character === '{') bracketDepth += 1;
      else if (character === ']' || character === '}') bracketDepth = Math.max(0, bracketDepth - 1);
    }
  }
  const rootEnd = indexes.length ? indexes[0] : lines.length;
  const sections = indexes.map((start, index) => ({
    start,
    header: lines[start].trim(),
    lines: lines.slice(start, indexes[index + 1] === undefined ? lines.length : indexes[index + 1])
  }));
  return {
    root: lines.slice(0, rootEnd),
    rootControlIndexes: controlIndexes.filter(index => index < rootEnd),
    controlIndexes,
    sections
  };
}

function hasTomlControlLine(content, expected) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  return splitTomlDocument(content).controlIndexes.some(index => lines[index].trim() === expected);
}

function simpleModelProviderSectionId(header) {
  const match = String(header || '').match(/^\[\s*model_providers\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.|\s*\])/);
  return match && match[1];
}

function unmanagedCodexRootLines(lines) {
  const retained = [];
  const controlIndexes = new Set(splitTomlDocument(lines.join('\n')).rootControlIndexes);
  let skippingManagedValue = false;
  let bracketDepth = 0;
  let quote = '';
  const updateState = text => {
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const triple = text.slice(index, index + 3);
      if (quote === '"""' || quote === "'''") {
        if (triple === quote) { quote = ''; index += 2; }
        continue;
      }
      if (quote === '"') {
        if (character === '\\') { index += 1; continue; }
        if (character === '"') quote = '';
        continue;
      }
      if (quote === "'") {
        if (character === "'") quote = '';
        continue;
      }
      if (triple === '"""' || triple === "'''") { quote = triple; index += 2; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '#' && bracketDepth === 0) break;
      if (character === '[' || character === '{') bracketDepth += 1;
      else if (character === ']' || character === '}') bracketDepth = Math.max(0, bracketDepth - 1);
    }
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.trim();
    const isControlLine = controlIndexes.has(lineIndex);
    if (!skippingManagedValue && isControlLine && (line === MANAGED_MARKER || line === OLD_MANAGED_MARKER
      || /^#\s*profile_(?:id|name)\s*=/.test(line))) continue;
    if (!skippingManagedValue && isControlLine) {
      const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (keyMatch && MANAGED_CODEX_ROOT_KEYS.has(keyMatch[1])) {
        bracketDepth = 0; quote = '';
        updateState(line.slice(keyMatch[0].length));
        skippingManagedValue = bracketDepth > 0 || Boolean(quote);
        continue;
      }
      retained.push(rawLine);
      continue;
    }
    if (!skippingManagedValue) {
      retained.push(rawLine);
      continue;
    }
    updateState(line);
    if (bracketDepth === 0 && !quote) skippingManagedValue = false;
  }
  return retained;
}

function mergeManagedCodexConfig(desired, current) {
  const desiredSource = String(desired || '');
  const currentSource = String(current || '');
  let desiredParsed;
  let currentParsed;
  try { desiredParsed = TOML.parse(desiredSource); }
  catch (error) { throw new Error(`ModelMux 生成了无效 TOML：${error.message || error}`); }
  if (!currentSource.trim()) return desiredSource;
  try { currentParsed = TOML.parse(currentSource); }
  catch (error) {
    throw new Error(uiText(
      `The existing Codex config.toml is invalid TOML and cannot be merged safely: ${error.message || error}`,
      `现有 Codex config.toml 不是有效 TOML，无法安全合并：${error.message || error}`
    ));
  }

  const desiredDocument = splitTomlDocument(desiredSource);
  const currentDocument = splitTomlDocument(currentSource);
  const managedProviderIds = new Set();
  if (typeof desiredParsed.model_provider === 'string') managedProviderIds.add(desiredParsed.model_provider);
  const currentHasMarker = currentDocument.rootControlIndexes.some(index => {
    const line = currentDocument.root[index].trim();
    return line === MANAGED_MARKER || line === OLD_MANAGED_MARKER;
  });
  if (currentHasMarker && typeof currentParsed.model_provider === 'string') {
    managedProviderIds.add(currentParsed.model_provider);
  }

  const retainedRoot = unmanagedCodexRootLines(currentDocument.root).join('\n').trim();
  const retainedSections = currentDocument.sections
    .filter(section => {
      const providerId = simpleModelProviderSectionId(section.header);
      return !providerId || !managedProviderIds.has(providerId);
    })
    .map(section => section.lines.join('\n').trimEnd())
    .filter(Boolean)
    .join('\n\n');
  const parts = [desiredDocument.root.join('\n').trimEnd(), retainedRoot,
    desiredDocument.sections.map(section => section.lines.join('\n').trimEnd()).filter(Boolean).join('\n\n'),
    retainedSections].filter(Boolean);
  const merged = `${parts.join('\n\n')}\n`;
  try { TOML.parse(merged); }
  catch (error) { throw new Error(`合并后的 Codex config.toml 不是有效 TOML：${error.message || error}`); }
  return merged;
}

function buildRestoredCodexConfig(original, current, managedProviderId) {
  const parse = (source, label) => {
    if (!String(source || '').trim()) return {};
    try { return TOML.parse(String(source)); }
    catch (error) { throw new Error(`${label}不是有效 TOML，无法安全恢复：${error.message || error}`); }
  };
  const clone = value => {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    }
    return value;
  };
  const originalParsed = parse(original, 'Codex 原始备份');
  const currentParsed = parse(current, '当前 Codex 配置');
  const restored = clone(originalParsed);
  const providerToRemove = String(managedProviderId || currentParsed.model_provider || '');

  for (const [key, value] of Object.entries(currentParsed)) {
    if (MANAGED_CODEX_ROOT_KEYS.has(key)) continue;
    if (key !== 'model_providers') {
      restored[key] = clone(value);
      continue;
    }
    const providers = restored.model_providers && typeof restored.model_providers === 'object'
      ? clone(restored.model_providers) : {};
    for (const [providerId, provider] of Object.entries(value || {})) {
      if (providerId !== providerToRemove) providers[providerId] = clone(provider);
    }
    if (Object.keys(providers).length) restored.model_providers = providers;
    else delete restored.model_providers;
  }

  if (!Object.keys(restored).length) return '';
  const result = TOML.stringify(restored);
  try { TOML.parse(result); }
  catch (error) { throw new Error(`恢复后的 Codex config.toml 不是有效 TOML：${error.message || error}`); }
  return result.endsWith('\n') ? result : `${result}\n`;
}

async function managedCodexConfigMatches(context, files, content, originalState, active) {
  const currentHash = managedCodexConfigHash(content, { maskSecrets: false });
  if (!currentHash) return false;
  if (originalState && typeof originalState.managedConfigHash === 'string') {
    return currentHash === originalState.managedConfigHash;
  }
  const expected = await expectedManagedCodexProjection(context, files, originalState, active);
  return Boolean(expected && managedCodexConfigProjection(content, { maskSecrets: expected.maskSecrets }) === expected.value);
}

function parseManagedCodexMetadata(content) {
  const text = String(content || '');
  const document = splitTomlDocument(text);
  const rootLines = document.rootControlIndexes.map(index => document.root[index].trim());
  if (!rootLines.includes(MANAGED_MARKER) && !rootLines.includes(OLD_MANAGED_MARKER)) return undefined;

  const profileMatch = rootLines.join('\n').match(/^#\s*profile_id\s*=\s*([^\r\n]+?)\s*$/m);
  const rawProfileId = profileMatch && profileMatch[1].trim();
  const profileId = rawProfileId && /^[A-Za-z0-9_.-]{1,128}$/.test(rawProfileId)
    ? rawProfileId
    : undefined;
  let model;
  try {
    const parsed = TOML.parse(text);
    if (typeof parsed.model === 'string' && parsed.model.trim() && parsed.model.length <= 512) model = parsed.model;
  } catch {}
  return { profileId, model };
}

function resolveManagedCodexProfile(context, content, originalState, active = getActiveTargets(context).codex) {
  const metadata = parseManagedCodexMetadata(content);
  if (!metadata || !originalState) return undefined;
  const profiles = getProfiles(context);
  const candidateIds = [metadata.profileId, originalState.profileId, active && active.profileId].filter(Boolean);
  const profile = candidateIds.map(id => profiles.find(item => item.id === id)).find(Boolean);
  if (!profile) return undefined;

  // The generated profile_id is the strongest link to the current file. If it
  // no longer exists, do not guess between similar providers in extension state.
  if (metadata.profileId && metadata.profileId !== profile.id) return undefined;
  if (originalState.profileId && originalState.profileId !== profile.id) return undefined;
  const model = metadata.model || originalState.model || active && active.model || profile.selectedModel;
  return model ? { metadata, profile, model } : undefined;
}

function tomlSectionLines(content, sectionName) {
  const header = `[${sectionName}]`;
  const matches = splitTomlDocument(content).sections.filter(section => section.header === header);
  if (matches.length !== 1) return undefined;
  return matches[0].lines.slice(1).map(line => line.trim()).filter(Boolean);
}

function hasSingleTomlLine(lines, expected, key) {
  if (!lines) return false;
  const prefix = `${key} =`;
  const matches = lines.filter(line => line.startsWith(prefix));
  return matches.length === 1 && matches[0] === expected;
}

function canRecreateRuntimeTokenFromManagedConfig(
  content,
  profile,
  tokenPath,
  management,
  platform = process.platform
) {
  if (platform === 'win32' || !profile || profile.kind !== 'customResponses') return false;
  const authMode = profile.authMode === 'bearer' ? 'secret' : profile.authMode;
  if (authMode !== 'secret' || !management || !management.originalState) return false;

  const metadata = parseManagedCodexMetadata(content);
  if (!metadata) return false;
  const stateProfileId = management.originalState.profileId;
  const activeProfileId = management.active && management.active.profileId;
  const linkedProfile = Boolean(metadata && metadata.profileId === profile.id)
    || (management.status === 'managed-clean'
      && stateProfileId === profile.id
      && activeProfileId === profile.id);
  if (!linkedProfile) return false;
  if (metadata && metadata.profileId && metadata.profileId !== profile.id) return false;
  if (stateProfileId && stateProfileId !== profile.id) return false;

  const rootLines = splitTomlDocument(content).root
    .map(line => line.trim()).filter(Boolean);
  const providerId = profile.providerId;
  const providerLines = tomlSectionLines(content, `model_providers.${providerId}`);
  const authLines = tomlSectionLines(content, `model_providers.${providerId}.auth`);
  const auth = authCommandForToken(tokenPath, platform);
  let baseUrl;
  try {
    baseUrl = validateProviderBaseUrl(profile.baseUrl).normalized;
    assertNoSensitiveStaticValues(profile.queryParams, 'Query parameters');
    assertNoSensitiveStaticValues(profile.httpHeaders, 'Static headers');
  } catch { return false; }
  return hasSingleTomlLine(rootLines, `model_provider = "${tomlString(providerId)}"`, 'model_provider')
    && hasSingleTomlLine(providerLines, `base_url = "${tomlString(baseUrl)}"`, 'base_url')
    && hasSingleTomlLine(providerLines, 'wire_api = "responses"', 'wire_api')
    && hasSingleTomlLine(authLines, `command = "${tomlString(auth.command)}"`, 'command')
    && hasSingleTomlLine(authLines, `args = ${tomlArray(auth.args)}`, 'args');
}

async function reconcileManagedCodexState(context, files = pathsForCurrentUser()) {
  const content = await readConfigText(files.config);
  const metadata = parseManagedCodexMetadata(content);
  if (!metadata) return undefined;

  const originalState = await readOriginalState(files);
  if (!originalState) return undefined;
  const currentHash = contentHash(content);
  const active = getActiveTargets(context).codex;
  const managedMatch = await managedCodexConfigMatches(context, files, content, originalState, active);
  if (originalState.lastAppliedHash
    && originalState.lastAppliedHash !== currentHash
    && !managedMatch) return undefined;
  const resolved = resolveManagedCodexProfile(context, content, originalState, active);
  if (!resolved) return undefined;
  const { profile, model } = resolved;

  const legacyState = !originalState.lastAppliedHash;
  const projectedHash = managedCodexConfigHash(content, { maskSecrets: false });
  if (legacyState
    || !originalState.managedConfigHash
    || originalState.profileId !== profile.id
    || originalState.model !== model) {
    await writeOriginalState(files, originalState.existed, {
      // Keep the old full-file hash when Codex has appended its own settings.
      // Automatic refresh must not mistake an additive external change for a
      // clean snapshot and then erase those settings.
      lastAppliedHash: originalState.lastAppliedHash || currentHash,
      managedConfigHash: projectedHash,
      profileId: profile.id,
      model,
      automaticRefreshDisabled: legacyState ? true : originalState.automaticRefreshDisabled,
      migratedAt: legacyState ? new Date().toISOString() : originalState.migratedAt
    });
  }
  if (!active || active.profileId !== profile.id || active.model !== model) {
    await updateActiveTarget(context, 'codex', { profileId: profile.id, model });
  }
  return { profile, model, migrated: legacyState };
}

async function getTargetManagementState(context, targetId, files = pathsForTarget(targetId)) {
  const normalizedTarget = normalizeTargetId(targetId);
  const active = getActiveTargets(context)[normalizedTarget];
  const originalState = await readOriginalState(files);
  const configSnapshot = await readRegularFileSnapshot(files.config);
  const backupSnapshot = await readRegularFileSnapshot(files.backup);
  const configExists = configSnapshot.exists;
  const backupExists = backupSnapshot.exists;
  const markerManaged = normalizedTarget === 'codex' && configExists
    ? Boolean(parseManagedCodexMetadata(configSnapshot.content))
    : false;
  const hasManagedRecord = Boolean(originalState && originalState.lastAppliedHash);

  let status = 'original';
  let currentHash;
  let currentContent = '';
  if (configExists) {
    currentContent = configSnapshot.content;
    currentHash = configSnapshot.currentHash;
  }
  let managedMatch = false;
  const currentManagedConfigHash = normalizedTarget === 'codex' && configExists
    ? managedCodexConfigHash(currentContent, { maskSecrets: false })
    : undefined;
  if (normalizedTarget === 'codex' && configExists && originalState && hasManagedRecord) {
    managedMatch = await managedCodexConfigMatches(context, files, currentContent, originalState, active);
  }
  if (hasManagedRecord && originalState.existed && !backupExists) {
    status = 'backup-missing';
  } else if ((active || markerManaged || hasManagedRecord) && (!active || !originalState || !hasManagedRecord || !configExists)) {
    status = 'managed-orphaned';
  } else if (normalizedTarget === 'codex' && (markerManaged || hasManagedRecord) && !currentManagedConfigHash) {
    status = 'managed-drifted';
  } else if (hasManagedRecord && currentHash !== originalState.lastAppliedHash && !managedMatch) {
    status = 'managed-drifted';
  } else if (active && hasManagedRecord) {
    status = 'managed-clean';
  }

  const hasUnmanagedChanges = Boolean(normalizedTarget === 'codex' && hasManagedRecord
    && currentHash !== originalState.lastAppliedHash && managedMatch);
  return {
    status,
    active,
    originalState,
    configExists,
    backupExists,
    currentHash,
    managedMatch,
    managedConfigHash: currentManagedConfigHash,
    hasUnmanagedChanges,
    managed: status !== 'original',
    canRestore: Boolean(status !== 'original' && originalState && (!originalState.existed || backupExists)),
    // A drifted file may be deliberately replaced, but only after the
    // activation path obtains explicit confirmation. Automatic refresh stays
    // disabled because it uses the stricter managed-clean status.
    canApply: status === 'original' || status === 'managed-clean' || status === 'managed-drifted',
    requiresApplyConfirmation: status === 'managed-drifted'
  };
}

async function assertManagedContentUnchanged(context, targetId, files, allowConfirmation = false) {
  const management = await getTargetManagementState(context, targetId, files);
  const uncertain = management.status === 'managed-drifted'
    || (management.status === 'managed-orphaned' && management.configExists)
    || management.hasUnmanagedChanges;
  if (!uncertain) return management;
  if (!allowConfirmation) {
    throw new Error(`${targetLabel(targetId)} 配置在 ModelMux 写入后已被其它程序修改，或缺少可验证的托管记录。请先预览或恢复，避免覆盖外部改动。`);
  }
  const continueLabel = uiText('Restore anyway', '仍然恢复');
  const answer = await vscode.window.showWarningMessage(
    uiText(
      `${targetLabel(targetId)} configuration changed outside ModelMux or its integrity record is incomplete. Restoring will overwrite the current file.`,
      `${targetLabel(targetId)} 配置已被其它程序修改，或完整性记录不完整。继续恢复会覆盖当前文件。`
    ),
    { modal: true }, continueLabel
  );
  if (answer !== continueLabel) return undefined;
  return management;
}

async function assertTargetCanApply(context, targetId, files, allowDriftConfirmation = false) {
  const management = await getTargetManagementState(context, targetId, files);
  if (management.originalState && management.originalState.existed && !management.backupExists) {
    throw new Error(`${targetLabel(targetId)} 的原始备份缺失。为避免不可逆覆盖，ModelMux 已停止写入。`);
  }
  if (management.status === 'managed-drifted') {
    if (!allowDriftConfirmation) {
      throw new Error(`${targetLabel(targetId)} 配置在 ModelMux 写入后已被其它程序修改。重新应用前需要明确确认，以免覆盖外部改动。`);
    }
    const reapplyLabel = uiText('Reapply provider', '重新应用 Provider');
    const answer = await vscode.window.showWarningMessage(
      uiText(
        `${targetLabel(targetId)} configuration changed after ModelMux last wrote it. Reapplying will replace the current file; the recorded original backup will be kept.`,
        `${targetLabel(targetId)} 配置在 ModelMux 上次写入后发生了变化。重新应用会替换当前文件，但已记录的原始备份会保留。`
      ),
      { modal: true }, reapplyLabel
    );
    if (answer !== reapplyLabel) return undefined;
  }
  if (management.status === 'managed-orphaned') {
    throw new Error(`${targetLabel(targetId)} 的托管配置或活动记录不完整。请先运行诊断并恢复原配置。`);
  }
  if (management.status === 'backup-missing') {
    throw new Error(`${targetLabel(targetId)} 的原始备份缺失。为避免不可逆覆盖，ModelMux 已停止写入。`);
  }
  return management;
}

async function assertTargetSnapshotUnchanged(management, files) {
  return assertFileSnapshotUnchanged(files.config, management);
}

async function assertFileSnapshotUnchanged(file, snapshot) {
  const current = await readRegularFileSnapshot(file);
  assertSnapshotMatches(file, current, snapshot);
}

async function originalContentForTarget(files) {
  const state = await readOriginalState(files);
  if (!state || state.existed === false) return '';
  const backupSnapshot = await readRegularFileSnapshot(files.backup);
  if (!backupSnapshot.exists) throw new Error(`找不到 ${targetLabel(files.targetId)} 原始备份：${files.backup}`);
  if (state.originalHash && backupSnapshot.currentHash !== state.originalHash) {
    throw new Error(`${targetLabel(files.targetId)} 原始备份完整性校验失败：${files.backup}`);
  }
  return backupSnapshot.content;
}

function parseJsonObject(content, label, allowJson5 = false) {
  if (!String(content || '').trim()) return {};
  try {
    const value = allowJson5 ? JSON5.parse(content) : JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根节点必须是对象');
    return value;
  } catch (error) {
    throw new Error(`${label}不是有效配置：${error.message || error}`);
  }
}

function setJsoncValue(content, pathSegments, value) {
  const source = String(content || '').trim() ? String(content) : '{}\n';
  const errors = [];
  jsonc.parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`OpenCode 配置包含无法解析的 JSONC（错误代码 ${errors[0].error}）。`);
  const edits = jsonc.modify(source, pathSegments, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' }
  });
  return jsonc.applyEdits(source, edits);
}

function nativeProviderId(targetId, kind) {
  const maps = {
    opencode: { openai: 'openai', anthropic: 'anthropic', gemini: 'google', grok: 'xai', ollama: 'ollama' },
    openclaw: { openai: 'openai', anthropic: 'anthropic', gemini: 'google', grok: 'xai', ollama: 'ollama' },
    hermes: { openai: 'openai-api', anthropic: 'anthropic', gemini: 'gemini', grok: 'xai', lmstudio: 'lmstudio' }
  };
  return maps[targetId] && maps[targetId][kind];
}

function environmentApiKey(profile) {
  if (!profile || profile.authMode === 'none') return undefined;
  if (profile.authMode !== 'env') throw new Error('该 CLI 的自定义 Provider 仅支持环境变量认证或无认证。');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envKey || '')) throw new Error('请为 Provider 配置有效的 API Key 环境变量名。');
  return profile.envKey;
}

function buildClaudeConfig(profile, model, original) {
  const config = parseJsonObject(original, 'Claude Code settings.json');
  config.model = model;
  if (profile.kind === 'customAnthropic') {
    config.env = config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {};
    config.env.ANTHROPIC_BASE_URL = normalizeBaseUrl(profile.baseUrl);
    config.env.ANTHROPIC_MODEL = model;
    environmentApiKey(profile);
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildGeminiConfig(model, original) {
  const config = parseJsonObject(original, 'Gemini CLI settings.json');
  config.model = config.model && typeof config.model === 'object' && !Array.isArray(config.model) ? config.model : {};
  config.model.name = model;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildGrokConfig(model, original) {
  const source = String(original || '').replace(/^\uFEFF/, '');
  if (source.trim()) {
    try { TOML.parse(source); }
    catch (error) { throw new Error(`Grok config.toml 不是有效 TOML：${error.message || error}`); }
  }
  const lines = source.split(/\r?\n/);
  const document = splitTomlDocument(source);
  const modelsSection = document.sections.find(section => /^\[\s*models\s*\]\s*(?:#.*)?$/.test(section.header));
  let sectionStart = modelsSection ? modelsSection.start : -1;
  if (sectionStart < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push('[models]', `default = "${tomlString(model)}"`);
  } else {
    const sectionIndex = document.sections.indexOf(modelsSection);
    const nextSection = document.sections[sectionIndex + 1];
    const sectionEnd = nextSection ? nextSection.start : lines.length;
    const defaultIndex = document.controlIndexes.find(index => index > sectionStart && index < sectionEnd
      && /^\s*default\s*=/.test(lines[index]));
    if (defaultIndex !== undefined) lines[defaultIndex] = `default = "${tomlString(model)}"`;
    else lines.splice(sectionStart + 1, 0, `default = "${tomlString(model)}"`);
  }
  if (!hasTomlControlLine(source, UNIVERSAL_MANAGED_MARKER)) lines.unshift(UNIVERSAL_MANAGED_MARKER);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function buildOpenCodeConfig(profile, model, original) {
  let content = String(original || '').trim() ? String(original) : '{}\n';
  if (isCustomProfile(profile)) {
    const envKey = environmentApiKey(profile);
    const npmPackage = profile.kind === 'customAnthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
    const options = { baseURL: normalizeBaseUrl(profile.baseUrl) };
    if (envKey) options.apiKey = `{env:${envKey}}`;
    if (Object.keys(normalizeStringMap(profile.httpHeaders)).length) options.headers = normalizeStringMap(profile.httpHeaders);
    const provider = {
      npm: npmPackage,
      name: profile.providerName || profile.name,
      options,
      models: Object.fromEntries((profile.models || [model]).map(id => [id, { name: id }]))
    };
    content = setJsoncValue(content, ['provider', profile.providerId], provider);
    content = setJsoncValue(content, ['model'], `${profile.providerId}/${model}`);
  } else {
    const providerId = nativeProviderId('opencode', profile.kind);
    content = setJsoncValue(content, ['model'], `${providerId}/${model}`);
  }
  return content.endsWith('\n') ? content : `${content}\n`;
}

function buildOpenClawConfig(profile, model, original) {
  const config = parseJsonObject(original, 'OpenClaw openclaw.json', true);
  config.agents = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents) ? config.agents : {};
  config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === 'object' && !Array.isArray(config.agents.defaults) ? config.agents.defaults : {};
  config.agents.defaults.model = config.agents.defaults.model && typeof config.agents.defaults.model === 'object'
    && !Array.isArray(config.agents.defaults.model)
    ? config.agents.defaults.model : {};
  let providerId = nativeProviderId('openclaw', profile.kind);
  if (isCustomProfile(profile)) {
    providerId = profile.providerId;
    const envKey = environmentApiKey(profile);
    config.models = config.models && typeof config.models === 'object' && !Array.isArray(config.models) ? config.models : {};
    config.models.mode = 'merge';
    config.models.providers = config.models.providers && typeof config.models.providers === 'object'
      && !Array.isArray(config.models.providers) ? config.models.providers : {};
    const provider = {
      baseUrl: normalizeBaseUrl(profile.baseUrl),
      api: profile.kind === 'customResponses' ? 'openai-responses'
        : profile.kind === 'customAnthropic' ? 'anthropic-messages' : 'openai-completions',
      models: (profile.models || [model]).map(id => ({ id, name: id }))
    };
    if (envKey) provider.apiKey = { source: 'env', provider: 'default', id: envKey };
    config.models.providers[providerId] = provider;
  }
  config.agents.defaults.model.primary = `${providerId}/${model}`;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildHermesConfig(profile, model, original) {
  let document;
  try { document = YAML.parseDocument(String(original || '').trim() ? String(original) : '{}\n'); }
  catch (error) { throw new Error(`Hermes config.yaml 不是有效 YAML：${error.message || error}`); }
  if (document.errors && document.errors.length) throw new Error(`Hermes config.yaml 不是有效 YAML：${document.errors[0].message}`);
  let providerId = nativeProviderId('hermes', profile.kind);
  if (isCustomProfile(profile)) {
    providerId = profile.providerId;
    const envKey = environmentApiKey(profile);
    const provider = {
      api: normalizeBaseUrl(profile.baseUrl),
      transport: profile.kind === 'customResponses' ? 'codex_responses'
        : profile.kind === 'customAnthropic' ? 'anthropic_messages' : 'chat_completions',
      models: Object.fromEntries((profile.models || [model]).map(id => [id, {}]))
    };
    if (envKey) provider.key_env = envKey;
    document.setIn(['providers', providerId], provider);
    providerId = `custom:${providerId}`;
  }
  document.setIn(['model', 'default'], model);
  document.setIn(['model', 'provider'], providerId);
  return document.toString({ lineWidth: 0 });
}

function buildTargetConfig(targetId, profile, model, original) {
  if (targetId === 'claude') return buildClaudeConfig(profile, model, original);
  if (targetId === 'gemini') return buildGeminiConfig(model, original);
  if (targetId === 'grok') return buildGrokConfig(model, original);
  if (targetId === 'opencode') return buildOpenCodeConfig(profile, model, original);
  if (targetId === 'openclaw') return buildOpenClawConfig(profile, model, original);
  if (targetId === 'hermes') return buildHermesConfig(profile, model, original);
  throw new Error(`没有 ${targetLabel(targetId)} 配置生成器。`);
}

async function activateExternalTarget(context, targetId, profile, model) {
  const compatibility = targetCompatibility(targetId, profile);
  if (!compatibility.supported) throw new Error(compatibility.reason);
  const files = pathsForTarget(targetId);
  const management = await assertTargetCanApply(context, targetId, files, true);
  if (!management) return false;
  const configSnapshot = await readRegularFileSnapshot(files.config);
  assertSnapshotMatches(files.config, configSnapshot, management);
  const backupSnapshot = await readRegularFileSnapshot(files.backup);
  const stateSnapshot = await readRegularFileSnapshot(files.originalState);
  const previousActive = getActiveTargets(context)[targetId];
  let createdBackup = false;
  let configWritten = false;
  let takeoverStarted = false;
  let activeUpdateStarted = false;
  let writtenContent;
  try {
    takeoverStarted = true;
    createdBackup = await ensureOriginalBackup(files, configSnapshot);
    await assertTargetSnapshotUnchanged(management, files);
    const original = await originalContentForTarget(files);
    const content = buildTargetConfig(targetId, profile, model, original);
    writtenContent = content;
    await writeAtomic(files.config, content, management);
    configWritten = true;
    const state = await readOriginalState(files);
    await writeOriginalState(files, state ? state.existed : false, {
      lastAppliedHash: contentHash(content),
      profileId: profile.id,
      model,
      updatedAt: new Date().toISOString()
    });
    activeUpdateStarted = true;
    await updateActiveTarget(context, targetId, { profileId: profile.id, model });
    return { profile, model, files, backupText: state && state.existed ? `原配置已备份到 ${files.backup}。` : '原先没有配置文件，已记录空白原始状态。' };
  } catch (error) {
    const rollbackErrors = [];
    let configRollbackComplete = !configWritten;
    if (configWritten) {
      try {
        await restoreFileSnapshot(files.config, configSnapshot, {
          configExists: true,
          currentHash: contentHash(writtenContent)
        });
        configRollbackComplete = true;
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (activeUpdateStarted) {
      try { await updateActiveTarget(context, targetId, previousActive); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (takeoverStarted && configRollbackComplete) {
      try { await restoreFileSnapshot(files.originalState, stateSnapshot); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try { await restoreFileSnapshot(files.backup, backupSnapshot); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message || error}；回滚未完成：${rollbackErrors.map(item => item.message || item).join('；')}`, { cause: error });
    }
    throw error;
  }
}

async function restoreExternalTarget(context, targetId) {
  const files = pathsForTarget(targetId);
  const management = await assertManagedContentUnchanged(context, targetId, files, true);
  if (!management) return false;
  if (management.status === 'original') throw new Error(`${targetLabel(targetId)} 当前未由 ModelMux 管理，不能再次恢复旧备份。`);
  const state = management.originalState;
  if (!state) throw new Error(`尚未记录 ${targetLabel(targetId)} 的原始配置。`);
  const configSnapshot = await readRegularFileSnapshot(files.config);
  assertSnapshotMatches(files.config, configSnapshot, management);
  const stateSnapshot = await readRegularFileSnapshot(files.originalState);
  const previousActive = getActiveTargets(context)[targetId];
  let restoredContent = '';
  let configRestored = false;
  let activeUpdateStarted = false;
  try {
  await assertTargetSnapshotUnchanged(management, files);
  if (state.existed === false) {
    await removeFileAtomicallyIfUnchanged(files.config, management);
  }
  else {
    const original = await originalContentForTarget(files);
    restoredContent = original;
    await writeAtomic(files.config, original, management);
  }
  configRestored = true;
  await writeOriginalState(files, state.existed, { lastAppliedHash: undefined, profileId: undefined, model: undefined, restoredAt: new Date().toISOString() });
  activeUpdateStarted = true;
  await updateActiveTarget(context, targetId, undefined);
  return { files, originallyExisted: state.existed };
  } catch (error) {
    const rollbackErrors = [];
    let configRollbackComplete = !configRestored;
    if (configRestored) {
      try {
        await restoreFileSnapshot(files.config, configSnapshot, state.existed
          ? { configExists: true, currentHash: contentHash(restoredContent) }
          : { configExists: false });
        configRollbackComplete = true;
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (activeUpdateStarted) {
      try { await updateActiveTarget(context, targetId, previousActive); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (configRollbackComplete) {
      try { await restoreFileSnapshot(files.originalState, stateSnapshot); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message || error}；恢复回滚未完成：${rollbackErrors.map(item => item.message || item).join('；')}`, { cause: error });
    }
    throw error;
  }
}

async function writeRuntimeToken(tokenPath, apiKey) {
  await ensurePrivateRuntimeDirectory(tokenPath);
  await writePrivateFile(tokenPath, apiKey.trim(), true);
}

async function removeRuntimeToken(tokenPath) {
  await fs.promises.rm(tokenPath, { force: true });
  try {
    await fs.promises.lstat(tokenPath);
    throw new Error(`运行时临时密钥仍然存在，删除失败：${tokenPath}`);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
}

async function removeRuntimeTokenBestEffort(tokenPath) {
  try { return await removeRuntimeToken(tokenPath); }
  catch (error) {
    console.error(`Failed to remove runtime token ${tokenPath}:`, error);
    return false;
  }
}

async function offerReload(message) {
  const reloadLabel = uiText('Reload window', '重新加载窗口');
  const action = await vscode.window.showInformationMessage(message, reloadLabel);
  if (action === reloadLabel) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function isTlsNameError(error) {
  const code = String(error && error.code || '');
  const message = String(error && error.message || '');
  return code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    || /hostname\/ip does not match certificate|cert does not contain a dns name|certificate.*name/i.test(message);
}

function tlsNameError(urlString, error) {
  let host = '';
  try { host = new URL(urlString).hostname; } catch { host = urlString; }
  const detail = String(error && error.message || error || uiText('Unknown certificate error', '未知证书错误'));
  return new Error(uiText(
    `The TLS certificate does not match ${host}. Prefer a Base URL whose DNS name is covered by the certificate, or enter model IDs manually. The advanced exception only affects model discovery and does not disable TLS validation for CLI inference. Original error: ${detail}`,
    `TLS 证书与访问地址不匹配（${host}）。请优先把 Base URL 改为证书中包含的 DNS 域名，或者手动填写模型 ID 并跳过 /models 自动发现。高级选项仅对模型列表获取临时忽略证书验证，不会关闭 CLI 推理请求的证书校验。原始错误：${detail}`
  ));
}

function requestJson(urlString, headers, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      fail(new Error(uiText(`Invalid URL: ${urlString}`, `无效 URL：${urlString}`)));
      return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;
    const requestOptions = {
      method: 'GET',
      headers,
      timeout: timeoutMs
    };
    if (parsed.protocol === 'https:') {
      requestOptions.rejectUnauthorized = options.rejectUnauthorized !== false;
    }

    const request = transport.request(parsed, requestOptions, response => {
      let body = '';
      let bodyBytes = 0;
      const declaredBytes = Number(response.headers['content-length']);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MODEL_RESPONSE_BYTES) {
        fail(new Error(uiText(
          `The model discovery response exceeded ${MAX_MODEL_RESPONSE_BYTES / 1024 / 1024} MB.`,
          `模型列表响应超过 ${MAX_MODEL_RESPONSE_BYTES / 1024 / 1024} MB 限制。`
        )));
        response.destroy();
        return;
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (settled) return;
        bodyBytes += Buffer.byteLength(chunk, 'utf8');
        if (bodyBytes > MAX_MODEL_RESPONSE_BYTES) {
          fail(new Error(uiText(
            `The model discovery response exceeded ${MAX_MODEL_RESPONSE_BYTES / 1024 / 1024} MB.`,
            `模型列表响应超过 ${MAX_MODEL_RESPONSE_BYTES / 1024 / 1024} MB 限制。`
          )));
          response.destroy();
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          fail(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try {
          succeed(JSON.parse(body));
        } catch {
          fail(new Error(uiText(`The service did not return valid JSON: ${body.slice(0, 300)}`, `服务返回的不是有效 JSON：${body.slice(0, 300)}`)));
        }
      });
      response.on('error', fail);
    });

    request.on('timeout', () => request.destroy(new Error(uiText(`Request timed out (${timeoutMs} ms).`, `请求超时（${timeoutMs} ms）`))));
    request.on('error', error => {
      fail(isTlsNameError(error) ? tlsNameError(urlString, error) : error);
    });
    request.end();
  });
}

async function fetchModelsForProfile(context, profile, apiKeyOverride) {
  if (!isCustomProfile(profile)) throw new Error(uiText('Only custom providers support automatic model discovery.', '仅自定义 Provider 支持自动获取模型。'));

  const authMode = profile.authMode === 'bearer' ? 'secret' : (profile.authMode || 'secret');
  let apiKey = String(apiKeyOverride || '').trim();
  if (authMode === 'secret' && !apiKey) {
    apiKey = await context.secrets.get(profileSecretKey(context, profile.id));
    if (!apiKey) {
      apiKey = await promptForApiKey(context, profile, false);
      if (!apiKey) throw new Error(uiText('No API key is available.', '没有可用的 API Key。'));
    }
  } else if (authMode === 'env' && !apiKey) {
    apiKey = process.env[profile.envKey];
    if (!apiKey) throw new Error(uiText(`Environment variable ${profile.envKey} is not set. Set it before starting or reloading VS Code.`, `环境变量 ${profile.envKey} 未设置。请在启动 VS Code/Codex 前设置它。`));
  }

  const headers = { Accept: 'application/json', ...normalizeStringMap(profile.httpHeaders) };
  const environmentHeaderMap = normalizeStringMap(profile.envHttpHeaders);
  let environmentHeaderCount = 0;
  for (const [header, envName] of Object.entries(environmentHeaderMap)) {
    if (process.env[envName]) {
      headers[header] = process.env[envName];
      environmentHeaderCount += 1;
    }
  }
  if (authMode === 'envHeaders' && Object.keys(environmentHeaderMap).length === 0) {
    throw new Error(uiText('Environment-variable header authentication requires at least one env_http_headers mapping.', '“环境变量请求头”认证至少需要配置一个 env_http_headers 映射。'));
  }
  if (authMode === 'envHeaders' && environmentHeaderCount === 0) {
    throw new Error(uiText('None of the configured header environment variables are visible to VS Code. Set them and restart or reload VS Code.', '环境变量请求头均未在当前 VS Code 进程中找到。请设置变量并重新启动或重新加载 VS Code。'));
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const settings = readGlobalSettings();
  const allowInsecure = Boolean(profile.allowInsecureModelDiscovery);
  if (allowInsecure) {
    const continueLabel = uiText('Continue once', '仅此次继续');
    const answer = await vscode.window.showWarningMessage(
      uiText(
        `Provider “${profile.name || 'Unnamed'}” will skip TLS certificate validation only for model discovery. This permits man-in-the-middle attacks.`,
        `Provider“${profile.name || '未命名'}”将仅在获取模型列表时跳过 TLS 证书验证。此操作存在中间人风险。`
      ),
      { modal: true }, continueLabel
    );
    if (answer !== continueLabel) throw new Error(uiText('The unsafe model discovery request was cancelled.', '已取消不安全的模型列表请求。'));
  }

  const carriesCredentials = Boolean(apiKey)
    || Object.keys(normalizeStringMap(profile.httpHeaders)).length > 0
    || Object.keys(environmentHeaderMap).length > 0;
  const discoveryUrl = validatedModelDiscoveryUrl(profile, carriesCredentials);
  const data = await requestJson(discoveryUrl, headers, settings.modelRequestTimeoutMs, { rejectUnauthorized: !allowInsecure });
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data && data.data) ? data.data
      : Array.isArray(data && data.models) ? data.models
        : Array.isArray(data && data.items) ? data.items
          : [];
  const models = raw
    .map(item => typeof item === 'string' ? item : item && (item.id || item.name || item.model || item.model_id))
    .filter(Boolean).map(String)
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) throw new Error(uiText('The request succeeded, but no model list was recognized. Supported shapes: array, data[], models[], or items[].', '接口返回成功，但未识别到模型列表。支持数组、data[]、models[] 或 items[]。'));
  return models;
}

function profileRevisionFingerprint(profile) {
  return contentHash(JSON.stringify(profile || {}));
}

async function profileCredentialFingerprint(context, profile) {
  const authMode = profile && profile.authMode === 'bearer' ? 'secret' : profile && profile.authMode;
  const material = {};
  if (authMode === 'secret') {
    material.secret = await context.secrets.get(profileSecretKey(context, profile.id)) || '';
  } else if (authMode === 'env') {
    material[profile.envKey || ''] = process.env[profile.envKey] || '';
  } else if (authMode === 'envHeaders') {
    for (const envName of Object.values(normalizeStringMap(profile.envHttpHeaders)).sort()) {
      material[envName] = process.env[envName] || '';
    }
  }
  return {
    hash: contentHash(JSON.stringify(material)),
    available: Object.values(material).some(Boolean)
  };
}

async function promptRequired(options) {
  const customValidator = options.validateInput;
  return vscode.window.showInputBox({
    ...options,
    ignoreFocusOut: true,
    validateInput: value => {
      if (!value.trim()) return options.emptyMessage || '该字段不能为空';
      return customValidator ? customValidator(value) : undefined;
    }
  });
}

async function chooseReasoningPolicy(current = 'auto') {
  const options = [
    { label: '$(wand) 自动（推荐）', description: 'GPT/Codex 默认 high；Claude、Gemini、Qwen 等不写入 reasoning_effort', value: 'auto' },
    { label: '$(circle-slash) 不写入', description: '兼容非 OpenAI 模型或不接受 reasoning_effort 的网关', value: 'none' },
    { label: 'minimal', value: 'minimal' },
    { label: 'low', value: 'low' },
    { label: 'medium', value: 'medium' },
    { label: 'high', value: 'high' },
    { label: 'xhigh', description: '仅部分模型支持', value: 'xhigh' }
  ];
  const picked = await vscode.window.showQuickPick(options, {
    title: '选择推理强度兼容策略',
    placeHolder: `当前：${current}`,
    ignoreFocusOut: true
  });
  return picked ? picked.value : undefined;
}

async function promptForApiKey(context, profile, allowKeepExisting = true, options = {}) {
  const existing = await context.secrets.get(profileSecretKey(context, profile.id));
  const value = await vscode.window.showInputBox({
    title: `${profile.name}：API Key`,
    prompt: existing && allowKeepExisting
      ? '已保存密钥。留空并确认可保留原密钥；输入新值可替换。'
      : '请输入 Bearer API Key。密钥保存在 VS Code SecretStorage，不写入 config.toml。',
    password: true,
    ignoreFocusOut: true
  });

  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed && existing && allowKeepExisting) return existing;
  if (!trimmed) {
    await vscode.window.showErrorMessage('API Key 不能为空。');
    return undefined;
  }
  if (options.store !== false) await context.secrets.store(profileSecretKey(context, profile.id), trimmed);
  return trimmed;
}

async function chooseInitialModel(context, profile, currentModel, apiKeyOverride) {
  const choice = await vscode.window.showQuickPick([
    { label: '$(cloud-download) 从 /models 自动获取', value: 'fetch' },
    { label: '$(edit) 手动输入模型 ID', value: 'manual' }
  ], {
    title: '配置可用模型',
    ignoreFocusOut: true
  });
  if (!choice) return undefined;

  if (choice.value === 'fetch') {
    try {
      const models = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在获取模型列表…',
        cancellable: false
      }, () => fetchModelsForProfile(context, profile, apiKeyOverride));
      const selected = await vscode.window.showQuickPick(models.map(id => ({ label: id })), {
        title: `选择模型（共 ${models.length} 个）`,
        ignoreFocusOut: true,
        matchOnDescription: true
      });
      if (!selected) return undefined;
      return { models, selectedModel: selected.label };
    } catch (error) {
      const action = await vscode.window.showWarningMessage(
        `获取模型失败：${error.message || error}`,
        '手动输入'
      );
      if (action !== '手动输入') return undefined;
    }
  }

  const model = await promptRequired({
    title: '模型 ID',
    prompt: '请输入接口实际接受的模型 ID，例如 gpt-5.6-sol、claude-sonnet-*。',
    value: currentModel || ''
  });
  if (!model) return undefined;
  return { models: [model.trim()], selectedModel: model.trim() };
}

async function createCustomProfile(context, existing, requestedKind = 'customResponses') {
  const profile = existing ? { ...existing } : {
    id: createId(), kind: requestedKind, authMode: requestedKind === 'customResponses' ? 'secret' : 'env', reasoningPolicy: 'auto',
    models: [], requestMaxRetries: 0, streamMaxRetries: 2, streamIdleTimeoutMs: 300000,
    modelDiscoveryPath: '/models'
  };
  const name = await promptRequired({ title: existing ? '编辑自定义 Provider' : `添加${kindLabel(profile.kind)} Provider`, prompt: '配置名称。', value: profile.name || kindLabel(profile.kind) });
  if (!name) return undefined;
  profile.name = name.trim();
  if (/[\u0000-\u001F\u007F]/.test(profile.name)) throw new Error('配置名称不能包含控制字符或换行。');
  const providerId = await promptRequired({
    title: 'Provider ID', prompt: '仅允许字母、数字、下划线和连字符；不能使用保留 ID。',
    value: profile.providerId || providerIdFromName(profile.name),
    validateInput: value => { try { validateProviderId(value); return undefined; } catch (error) { return error.message; } }
  });
  if (!providerId) return undefined;
  profile.providerId = providerId.trim();
  profile.providerName = profile.name;
  const baseUrl = await promptRequired({ title: `${kindLabel(profile.kind)} Base URL`, prompt: '填写服务根地址，通常到 /v1，不包含具体请求路径。', value: profile.baseUrl || '' });
  if (!baseUrl) return undefined;
  const validatedBase = validateProviderBaseUrl(baseUrl);
  profile.baseUrl = validatedBase.normalized;
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(validatedBase.url.hostname);
  if (validatedBase.url.protocol === 'http:' && !localHost && !profile.allowInsecureHttp) {
    throw new Error('远程 HTTP 会明文传输凭据；请改用 HTTPS 或图形化编辑器中的显式危险选项。');
  }

  let authChoices = [
    { label: '$(symbol-variable) Bearer 环境变量', description: 'Codex 通过 env_key 读取，适合服务器、CI 与多平台', value: 'env' },
    { label: '$(list-filter) 环境变量请求头', description: '通过 env_http_headers 适配 api-key 等非 Bearer 认证', value: 'envHeaders' },
    { label: '$(unlock) 无认证', description: '仅适用于可信本地或内网服务', value: 'none' }
  ];
  if (profile.kind === 'customResponses') {
    authChoices.unshift({ label: '$(key) SecretStorage / Windows 兼容认证', description: 'Linux/macOS 使用 token helper；Windows 写入受 ACL 保护的托管配置', value: 'secret' });
  } else authChoices = authChoices.filter(item => item.value !== 'envHeaders');
  const authChoice = await vscode.window.showQuickPick(authChoices, { title: '认证方式', ignoreFocusOut: true });
  if (!authChoice) return undefined;
  profile.authMode = authChoice.value;
  let pendingSecret;
  if (profile.authMode === 'secret') {
    pendingSecret = await promptForApiKey(context, profile, Boolean(existing), { store: false });
    if (!pendingSecret) return undefined;
  } else if (profile.authMode === 'env') {
    const defaultEnvKey = profile.kind === 'customAnthropic' ? 'ANTHROPIC_API_KEY' : 'MODEL_SWITCH_API_KEY';
    const envKey = await promptRequired({ title: 'API Key 环境变量名', value: profile.envKey || defaultEnvKey, validateInput: value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()) ? undefined : '环境变量名格式无效。' });
    if (!envKey) return undefined;
    profile.envKey = envKey.trim();
  } else if (profile.authMode === 'envHeaders') {
    const mapping = await promptRequired({
      title: '环境变量请求头映射',
      prompt: '填写 JSON，例如 {"api-key":"AZURE_OPENAI_API_KEY"}。',
      value: JSON.stringify(profile.envHttpHeaders || { 'api-key': 'CUSTOM_CODEX_API_KEY' }),
      validateInput: value => { try { return Object.keys(parseJsonMap(value, '环境变量请求头映射')).length ? undefined : '至少配置一个请求头。'; } catch (error) { return error.message; } }
    });
    if (!mapping) return undefined;
    profile.envHttpHeaders = parseJsonMap(mapping, '环境变量请求头映射');
  }

  const modelResult = await chooseInitialModel(context, profile, profile.selectedModel, pendingSecret);
  if (!modelResult) return undefined;
  profile.models = modelResult.models;
  profile.selectedModel = modelResult.selectedModel;
  const reasoningPolicy = await chooseReasoningPolicy(profile.reasoningPolicy || 'auto');
  if (!reasoningPolicy) return undefined;
  profile.reasoningPolicy = reasoningPolicy;
  Object.defineProperty(profile, PENDING_PROFILE_SECRET, { value: pendingSecret, configurable: true });
  return profile;
}

async function createOpenAIProfile(existing) {
  const profile = existing ? { ...existing } : {
    id: createId(),
    kind: 'openai',
    reasoningPolicy: 'auto',
    models: []
  };

  const name = await promptRequired({
    title: 'OpenAI 官方配置',
    prompt: '配置名称。该配置使用 Codex 已有的官方登录状态。',
    value: profile.name || 'OpenAI 官方'
  });
  if (!name) return undefined;
  profile.name = name.trim();

  const model = await promptRequired({
    title: '模型 ID',
    prompt: '请输入官方模型 ID。',
    value: profile.selectedModel || ''
  });
  if (!model) return undefined;
  profile.selectedModel = model.trim();
  profile.models = Array.from(new Set([...(profile.models || []), profile.selectedModel]));

  const reasoningPolicy = await chooseReasoningPolicy(profile.reasoningPolicy || 'auto');
  if (!reasoningPolicy) return undefined;
  profile.reasoningPolicy = reasoningPolicy;
  return profile;
}

async function createNativeProfile(kind, existing) {
  const names = { anthropic: 'Anthropic 官方', gemini: 'Google Gemini 官方', grok: 'xAI Grok 官方' };
  const profile = existing ? { ...existing } : { id: createId(), kind, reasoningPolicy: 'none', models: [] };
  const name = await promptRequired({
    title: `${names[kind]}配置`,
    prompt: '配置名称。该配置使用对应 CLI 已有的登录或环境变量凭据。',
    value: profile.name || names[kind]
  });
  if (!name) return undefined;
  profile.name = name.trim();
  const model = await promptRequired({ title: '模型 ID', prompt: '请输入 CLI 接受的模型 ID。', value: profile.selectedModel || '' });
  if (!model) return undefined;
  profile.selectedModel = model.trim();
  profile.models = Array.from(new Set([...(profile.models || []), profile.selectedModel]));
  profile.reasoningPolicy = 'none';
  return profile;
}

async function createBedrockProfile(existing) {
  const profile = existing ? { ...existing } : {
    id: createId(),
    kind: 'bedrock',
    reasoningPolicy: 'none',
    models: []
  };

  const name = await promptRequired({
    title: 'Amazon Bedrock 配置',
    prompt: '配置名称，例如“Bedrock Claude”。',
    value: profile.name || 'Bedrock Claude'
  });
  if (!name) return undefined;
  profile.name = name.trim();

  const model = await promptRequired({
    title: 'Bedrock 模型 ID',
    prompt: '输入 AWS Bedrock 接受的完整模型 ID 或推理配置 ID。',
    value: profile.selectedModel || ''
  });
  if (!model) return undefined;
  profile.selectedModel = model.trim();
  profile.models = Array.from(new Set([...(profile.models || []), profile.selectedModel]));

  const region = await promptRequired({
    title: 'AWS Region',
    prompt: '例如 us-east-1、eu-central-1。',
    value: profile.awsRegion || 'us-east-1'
  });
  if (!region) return undefined;
  profile.awsRegion = region.trim();

  const awsProfile = await vscode.window.showInputBox({
    title: 'AWS Profile（可选）',
    prompt: '留空使用标准 AWS 凭据链；也可以填写 default 或其他 profile 名称。',
    value: profile.awsProfile || '',
    ignoreFocusOut: true
  });
  if (awsProfile === undefined) return undefined;
  profile.awsProfile = awsProfile.trim();

  const reasoningPolicy = await chooseReasoningPolicy(profile.reasoningPolicy || 'none');
  if (!reasoningPolicy) return undefined;
  profile.reasoningPolicy = reasoningPolicy;
  return profile;
}

async function createLocalProfile(kind, existing) {
  const defaults = kind === 'ollama'
    ? { name: 'Ollama 本地', model: 'qwen2.5-coder:latest' }
    : { name: 'LM Studio 本地', model: '' };
  const profile = existing ? { ...existing } : { id: createId(), kind, reasoningPolicy: 'none', models: [] };
  const name = await promptRequired({ title: `配置 ${kindLabel(kind)}`, value: profile.name || defaults.name });
  if (!name) return undefined;
  profile.name = name.trim();
  const model = await promptRequired({ title: '模型 ID', prompt: '填写本地服务中已加载或可用的模型 ID。', value: profile.selectedModel || defaults.model });
  if (!model) return undefined;
  profile.selectedModel = model.trim();
  profile.models = Array.from(new Set([...(profile.models || []), profile.selectedModel]));
  const reasoningPolicy = await chooseReasoningPolicy(profile.reasoningPolicy || 'none');
  if (!reasoningPolicy) return undefined;
  profile.reasoningPolicy = reasoningPolicy;
  return profile;
}

async function addProfile(context, statusBar) {
  if (!(await ensureSupportedPlatform())) return;
  const type = await vscode.window.showQuickPick([
    { label: '$(server) 自定义 OpenAI Responses Provider', description: '适用于 Codex、OpenClaw 与 Hermes', value: 'customResponses' },
    { label: '$(server) 自定义 OpenAI Chat Provider', description: '适用于 OpenCode、OpenClaw 与 Hermes', value: 'customChat' },
    { label: '$(server) 自定义 Anthropic Messages Provider', description: '适用于 Claude Code、OpenClaw 与 Hermes', value: 'customAnthropic' },
    { label: '$(account) OpenAI 官方', description: '使用 Codex 当前官方登录状态', value: 'openai' },
    { label: '$(account) Anthropic 官方', description: '使用 Claude Code 或其它 CLI 的现有凭据', value: 'anthropic' },
    { label: '$(account) Google Gemini 官方', description: '使用 Gemini CLI 或其它 CLI 的现有凭据', value: 'gemini' },
    { label: '$(account) xAI Grok 官方', description: '使用 Grok Build 或其它 CLI 的现有凭据', value: 'grok' },
    { label: '$(cloud) Amazon Bedrock', description: '使用 AWS 凭据链和 Bedrock 模型', value: 'bedrock' },
    { label: '$(device-desktop) Ollama 本地', description: '使用 Codex 内置 ollama Provider', value: 'ollama' },
    { label: '$(server-environment) LM Studio 本地', description: '使用 Codex 内置 lmstudio Provider', value: 'lmstudio' }
  ], { title: '添加模型 Provider', placeHolder: '自定义网关必须兼容 Responses API。', ignoreFocusOut: true });
  if (!type) return;
  let profile;
  if (CUSTOM_KINDS.has(type.value)) profile = await createCustomProfile(context, undefined, type.value);
  else if (type.value === 'bedrock') profile = await createBedrockProfile();
  else if (type.value === 'openai') profile = await createOpenAIProfile();
  else if (['anthropic', 'gemini', 'grok'].includes(type.value)) profile = await createNativeProfile(type.value);
  else profile = await createLocalProfile(type.value);
  if (!profile) return;
  await withProfileMutation(profile.id, async () => {
    const previous = getProfiles(context);
    const next = [...previous, profile];
    if (isCustomProfile(profile)) await commitProfileAndSecret(context, previous, next, profile, profile[PENDING_PROFILE_SECRET]);
    else await saveProfiles(context, next);
  });
  const activateNow = await vscode.window.showInformationMessage(`已保存配置“${profile.name}”。`, '立即启用', '稍后');
  if (activateNow === '立即启用') await activateProfileForTarget(context, getSelectedTargetId(context), profile.id, statusBar);
}

async function chooseProfile(context, title, predicate = () => true) {
  const profiles = getProfiles(context).filter(predicate);
  if (profiles.length === 0) {
    await vscode.window.showInformationMessage('还没有符合条件的模型配置，请先添加。');
    return undefined;
  }

  const targetId = getSelectedTargetId(context);
  const activeRecord = getActiveTargets(context)[targetId];
  const activeId = activeRecord && activeRecord.profileId;
  const selected = await vscode.window.showQuickPick(profiles.map(profile => ({
    label: `${profile.id === activeId ? '$(check) ' : ''}${profile.name}`,
    description: providerDescription(profile),
    detail: `默认模型：${profile.selectedModel || '未设置'}`,
    profile
  })), {
    title,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  return selected && selected.profile;
}

function providerDescription(profile) {
  if (profile.kind === 'openai') return 'OpenAI 官方';
  if (profile.kind === 'anthropic') return 'Anthropic 官方';
  if (profile.kind === 'gemini') return 'Google Gemini 官方';
  if (profile.kind === 'grok') return 'xAI Grok 官方';
  if (profile.kind === 'ollama') return 'Ollama 本地 Provider';
  if (profile.kind === 'lmstudio') return 'LM Studio 本地 Provider';
  if (profile.kind === 'bedrock') return `Amazon Bedrock · ${profile.awsRegion || '未设置区域'}`;
  const auth = profile.authMode === 'env' ? `Bearer env:${profile.envKey || '?'}`
    : profile.authMode === 'envHeaders' ? '环境变量请求头'
      : profile.authMode === 'none' ? '无认证' : 'SecretStorage';
  return `${profile.providerId} · ${profile.baseUrl} · ${auth}`;
}

async function editProfile(context) {
  const existing = await chooseProfile(context, '选择要编辑的配置');
  if (!existing) return;
  await withProfileMutation(existing.id, async () => {
    const activeTarget = await activeManagedTargetForProfile(context, existing.id);
    if (activeTarget) {
      await vscode.window.showWarningMessage(`该 Provider 正在被 ${targetLabel(activeTarget)} 使用。请先恢复或切换 Provider，再编辑连接和认证设置。`);
      return;
    }
    let updated;
    if (isCustomProfile(existing)) updated = await createCustomProfile(context, existing);
    else if (existing.kind === 'bedrock') updated = await createBedrockProfile(existing);
    else if (existing.kind === 'openai') updated = await createOpenAIProfile(existing);
    else if (['anthropic', 'gemini', 'grok'].includes(existing.kind)) updated = await createNativeProfile(existing.kind, existing);
    else updated = await createLocalProfile(existing.kind, existing);
    if (!updated) return;
    const previous = getProfiles(context);
    const next = previous.map(item => item.id === updated.id ? updated : item);
    if (isCustomProfile(updated)) await commitProfileAndSecret(context, previous, next, updated, updated[PENDING_PROFILE_SECRET]);
    else await saveProfiles(context, next);
    await vscode.window.showInformationMessage(`已更新配置“${updated.name}”。`);
  });
}

async function deleteStoredProfile(context, profile, statusBar) {
  const managedTargets = await managedTargetsForProfile(context, profile.id);
  const targetNames = managedTargets.map(targetLabel).join(', ');
  const deleteLabel = managedTargets.length
    ? uiText('Restore and delete', '恢复并删除')
    : uiText('Delete', '删除');
  const message = managedTargets.length
    ? uiText(
        `“${profile.name}” is active in ${targetNames}. Restore the original configuration for ${targetNames}, then delete the provider and its saved API key?`,
        `“${profile.name}”正在被 ${targetNames} 使用。是否先恢复 ${targetNames} 的原配置，再删除该 Provider 及其保存的 API Key？`
      )
    : uiText(
        `Delete “${profile.name}” and its saved API key?`,
        `确定删除“${profile.name}”及其保存的 API Key 吗？`
      );
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, deleteLabel);
  if (answer !== deleteLabel) return { cancelled: true, restoredTargets: [] };

  const restoredTargets = [];
  for (const targetId of managedTargets) {
    const restored = await restoreTarget(context, targetId, statusBar, {
      showError: false,
      throwOnError: true,
      offerReload: false
    });
    if (!restored) return { cancelled: true, restoredTargets };
    restoredTargets.push(targetId);
  }

  // Remove stale references from targets that were already restored outside
  // ModelMux before deleting the shared provider record.
  for (const [targetId, active] of Object.entries(getActiveTargets(context))) {
    if (active && active.profileId === profile.id && TARGET_IDS.includes(targetId)) {
      await updateActiveTarget(context, targetId, undefined);
    }
  }
  const previousProfiles = getProfiles(context);
  const secretKey = profileSecretKey(context, profile.id);
  const previousSecret = await context.secrets.get(secretKey);
  await context.secrets.delete(secretKey);
  try {
    await saveProfiles(context, previousProfiles.filter(item => item.id !== profile.id));
  } catch (error) {
    if (previousSecret !== undefined) {
      try { await context.secrets.store(secretKey, previousSecret); }
      catch (rollbackError) {
        throw new Error(`${error.message || error}；API Key 回滚失败：${rollbackError.message || rollbackError}`, { cause: error });
      }
    }
    throw error;
  }
  await updateStatusBar(context, statusBar);
  return { cancelled: false, restoredTargets };
}

async function deleteProfile(context, statusBar) {
  const profile = await chooseProfile(context, '选择要删除的配置');
  if (!profile) return;
  await withProfileMutation(profile.id, async () => {
    const result = await deleteStoredProfile(context, profile, statusBar);
    if (!result.cancelled) await vscode.window.showInformationMessage(`已删除“${profile.name}”。`);
  });
}

async function refreshModels(context) {
  const profile = await chooseProfile(context, '选择要刷新模型列表的 Provider', item => isCustomProfile(item));
  if (!profile) return;

  const profileFingerprint = profileRevisionFingerprint(profile);
  const credentialBefore = await profileCredentialFingerprint(context, profile);
  try {
    const models = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `正在从 ${profile.name} 获取模型…`,
      cancellable: false
    }, () => fetchModelsForProfile(context, profile));

    const credentialAfterFetch = await profileCredentialFingerprint(context, profile);
    if (credentialBefore.available && credentialBefore.hash !== credentialAfterFetch.hash) {
      throw new Error(uiText('The provider credentials changed while models were loading. Refresh again.', '获取模型期间 Provider 凭据已变化，请重新刷新。'));
    }

    await withProfileMutation(profile.id, async () => {
      const current = getProfiles(context);
      const latest = current.find(item => item.id === profile.id);
      if (!latest) throw new Error('Provider 已被删除。');
      if (profileRevisionFingerprint(latest) !== profileFingerprint
        || (await profileCredentialFingerprint(context, latest)).hash !== credentialAfterFetch.hash) {
        throw new Error(uiText(
          'The provider or its credentials changed while models were loading. Refresh again to avoid applying a stale model list.',
          '获取模型期间 Provider 或凭据已变化。请重新刷新，避免写入过期模型列表。'
        ));
      }
      const updatedProfile = {
        ...latest,
        models: [...models],
        selectedModel: models.includes(latest.selectedModel) ? latest.selectedModel : models[0]
      };
      const files = pathsForCurrentUser();
      const catalogPath = modelCatalogPathForFiles(context, updatedProfile, files);
      const catalogSnapshot = catalogPath ? await readRegularFileSnapshot(catalogPath) : undefined;
      let catalog;
      try {
        if (catalogPath) catalog = await writeModelCatalogForProfile(
          context, updatedProfile, updatedProfile.selectedModel, files, catalogSnapshot, { path: catalogPath }
        );
        await saveProfiles(context, current.map(item => item.id === latest.id ? updatedProfile : item));
      } catch (error) {
        if (catalog && catalogPath && catalogSnapshot) {
          try {
            await restoreFileSnapshot(catalogPath, catalogSnapshot, { configExists: true, currentHash: contentHash(catalog.content) });
          } catch (rollbackError) {
            throw new Error(`${error.message || error}；模型目录回滚失败：${rollbackError.message || rollbackError}`, { cause: error });
          }
        }
        throw error;
      }
    });
    await vscode.window.showInformationMessage(`已获取 ${models.length} 个模型。`);
  } catch (error) {
    await vscode.window.showErrorMessage(`刷新模型列表失败：${error.message || error}`);
  }
}

async function chooseModelForProfile(context, profile) {
  while (true) {
    const items = [];
    for (const model of profile.models || []) {
      items.push({
        label: model,
        description: model === profile.selectedModel ? '当前默认' : '',
        value: model
      });
    }
    if (isCustomProfile(profile)) {
      items.push({ label: '$(sync) 刷新 /models 列表', action: 'refresh' });
    }
    items.push({ label: '$(edit) 手动输入模型 ID', action: 'manual' });

    const selected = await vscode.window.showQuickPick(items, {
      title: `${profile.name}：选择模型`,
      placeHolder: 'Claude 等模型必须由 Responses 兼容网关暴露，或通过 Amazon Bedrock 使用。',
      ignoreFocusOut: true,
      matchOnDescription: true
    });
    if (!selected) return undefined;

    if (selected.action === 'refresh') {
      try {
        const models = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: '正在刷新模型列表…',
          cancellable: false
        }, () => fetchModelsForProfile(context, profile));
        const updatedProfile = {
          ...profile,
          models: [...models],
          selectedModel: models.includes(profile.selectedModel) ? profile.selectedModel : models[0]
        };
        const files = pathsForCurrentUser();
        const catalogPath = modelCatalogPathForFiles(context, updatedProfile, files);
        const catalogSnapshot = catalogPath ? await readRegularFileSnapshot(catalogPath) : undefined;
        let catalog;
        try {
          if (catalogPath) catalog = await writeModelCatalogForProfile(
            context, updatedProfile, updatedProfile.selectedModel, files, catalogSnapshot, { path: catalogPath }
          );
          await saveProfiles(context, getProfiles(context).map(item => item.id === profile.id ? updatedProfile : item));
        } catch (error) {
          if (catalog && catalogPath && catalogSnapshot) {
            try {
              await restoreFileSnapshot(catalogPath, catalogSnapshot, { configExists: true, currentHash: contentHash(catalog.content) });
            } catch (rollbackError) {
              throw new Error(`${error.message || error}；模型目录回滚失败：${rollbackError.message || rollbackError}`, { cause: error });
            }
          }
          throw error;
        }
        Object.assign(profile, updatedProfile);
        continue;
      } catch (error) {
        await vscode.window.showErrorMessage(`刷新失败：${error.message || error}`);
        continue;
      }
    }

    if (selected.action === 'manual') {
      const model = await promptRequired({
        title: '模型 ID',
        prompt: '输入该 Provider 实际接受的模型 ID。',
        value: profile.selectedModel || ''
      });
      if (!model) return undefined;
      const value = model.trim();
      profile.models = Array.from(new Set([...(profile.models || []), value]));
      return value;
    }

    return selected.value;
  }
}

async function activateProfile(context, profileId, statusBar, modelOverride, options = {}) {
  if (!(await ensureSupportedPlatform())) return false;
  const profiles = getProfiles(context);
  const profile = profiles.find(item => item.id === profileId) || await chooseProfile(context, '选择要启用的模型 Provider');
  if (!profile) return false;

  const model = modelOverride || await chooseModelForProfile(context, profile);
  if (!model) return false;

  const files = options.files || pathsForCurrentUser();
  let createdBackup = false;
  let configWritten = false;
  let profileUpdateStarted = false;
  let tokenMutationStarted = false;
  let takeoverStarted = false;
  let activeUpdateStarted = false;
  let configSnapshot;
  let backupSnapshot;
  let stateSnapshot;
  let tokenSnapshot;
  let catalogSnapshot;
  let catalogPath;
  let catalogContent;
  let previousActive;
  let managedContent;
  let result;
  try {
    const management = await assertTargetCanApply(context, 'codex', files, true);
    if (!management) return false;

    const authMode = profile.authMode === 'bearer' ? 'secret' : profile.authMode;
    let resolvedSecret;
    if (profile.kind === 'customResponses' && authMode === 'secret') {
      resolvedSecret = await context.secrets.get(profileSecretKey(context, profile.id));
      if (!resolvedSecret) resolvedSecret = await promptForApiKey(context, profile, false);
      if (!resolvedSecret) return false;
    }

    // Capture the original only after all cancellable prompts have completed.
    configSnapshot = await readRegularFileSnapshot(files.config);
    assertSnapshotMatches(files.config, configSnapshot, management);
    backupSnapshot = await readRegularFileSnapshot(files.backup);
    stateSnapshot = await readRegularFileSnapshot(files.originalState);
    tokenSnapshot = await readRegularFileSnapshot(files.token);
    catalogPath = modelCatalogPathForFiles(context, profile, files);
    if (catalogPath) catalogSnapshot = await readRegularFileSnapshot(catalogPath);
    previousActive = getActiveTargets(context).codex;
    takeoverStarted = true;
    createdBackup = await ensureOriginalBackup(files, configSnapshot);
    await assertTargetSnapshotUnchanged(management, files);

    const updatedProfile = { ...profile, selectedModel: model };
    const desiredContent = buildManagedConfig(updatedProfile, model, files.token, resolvedSecret, {
      catalogPath,
      codexDir: files.codexDir
    });
    managedContent = management.configExists
      ? mergeManagedCodexConfig(desiredContent, await fs.promises.readFile(files.config, 'utf8'))
      : desiredContent;

    profileUpdateStarted = true;
    await saveProfiles(context, profiles.map(item => item.id === updatedProfile.id ? updatedProfile : item));
    tokenMutationStarted = true;
    if (profile.kind === 'customResponses' && authMode === 'secret' && process.platform !== 'win32') {
      await writeRuntimeToken(files.token, resolvedSecret);
    } else {
      // Windows embeds the bearer in the ACL-restricted managed config because
      // command-backed auth is unreliable in some bundled Codex versions.
      await removeRuntimeToken(files.token);
    }

    if (catalogPath) {
      const catalog = await writeModelCatalogForProfile(context, updatedProfile, model, files, catalogSnapshot, { path: catalogPath });
      catalogContent = catalog.content;
    }
    await writeAtomic(files.config, managedContent, management);
    configWritten = true;
    const originalState = await readOriginalState(files);
    await writeOriginalState(files, originalState ? originalState.existed : false, {
      lastAppliedHash: contentHash(managedContent),
      managedConfigHash: managedCodexConfigHash(managedContent, { maskSecrets: false }),
      profileId: updatedProfile.id,
      model,
      automaticRefreshDisabled: undefined,
      updatedAt: new Date().toISOString()
    });
    activeUpdateStarted = true;
    await updateActiveTarget(context, 'codex', { profileId: updatedProfile.id, model });

    const backupText = createdBackup
      ? originalState && originalState.existed ? `原配置已备份到 ${files.backup}。` : '原先没有 config.toml，已记录空白原始状态。'
      : '已有原始状态记录，未重复覆盖。';
    result = { profile: updatedProfile, model, backupText, files };
  } catch (error) {
    const rollbackErrors = [];
    let configRollbackComplete = !configWritten;
    if (configWritten && configSnapshot) {
      try {
        await restoreFileSnapshot(files.config, configSnapshot, {
          configExists: true,
          currentHash: contentHash(managedContent)
        });
        configRollbackComplete = true;
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (activeUpdateStarted) {
      try { await updateActiveTarget(context, 'codex', previousActive); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (tokenMutationStarted && tokenSnapshot) {
      try {
        if (tokenSnapshot.exists) await writeRuntimeToken(files.token, tokenSnapshot.content);
        else await removeRuntimeToken(files.token);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (catalogContent && catalogPath && catalogSnapshot) {
      try {
        await restoreFileSnapshot(catalogPath, catalogSnapshot, {
          configExists: true,
          currentHash: contentHash(catalogContent)
        });
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (profileUpdateStarted) {
      try { await saveProfiles(context, profiles); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (takeoverStarted && configRollbackComplete) {
      try { await restoreFileSnapshot(files.originalState, stateSnapshot); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try { await restoreFileSnapshot(files.backup, backupSnapshot); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      error = new Error(`${error.message || error}；回滚未完成：${rollbackErrors.map(item => item.message || item).join('；')}`, { cause: error });
    }
    if (options.showError !== false) {
      await vscode.window.showErrorMessage(`启用失败：${error.message || error}`);
    }
    if (options.throwOnError) throw error;
    return false;
  }

  try { await updateStatusBar(context, statusBar, files); }
  catch (error) { console.error('Failed to refresh ModelMux status bar after activation:', error); }
  if (options.offerReload !== false) {
    await offerReload(`已启用“${result.profile.name} / ${model}”。${result.backupText}`);
  }
  return result;
}

async function switchProfile(context, statusBar) {
  const profiles = getProfiles(context);
  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage('还没有模型配置。', '添加配置');
    if (action === '添加配置') await addProfile(context, statusBar);
    return;
  }
  const targetId = getSelectedTargetId(context);
  const profile = await chooseProfile(context, `切换 ${targetLabel(targetId)} Provider`, item => targetCompatibility(targetId, item).supported);
  if (profile) await activateProfileForTarget(context, targetId, profile.id, statusBar);
}

async function restoreOriginal(context, statusBar, options = {}) {
  if (!(await ensureSupportedPlatform())) return false;
  const files = options.files || pathsForCurrentUser();
  let result;
  try {
    const management = await assertManagedContentUnchanged(context, 'codex', files, true);
    if (!management) return false;
    if (management.status === 'original') throw new Error('Codex 当前未由 ModelMux 管理，不能再次恢复旧备份。');
    const state = management.originalState;
    if (!state) throw new Error('尚未记录 Codex 的原始配置。');
    const configSnapshot = await readRegularFileSnapshot(files.config);
    assertSnapshotMatches(files.config, configSnapshot, management);
    const stateSnapshot = await readRegularFileSnapshot(files.originalState);
    const tokenSnapshot = await readRegularFileSnapshot(files.token);
    const previousActive = getActiveTargets(context).codex;
    const original = await originalContentForTarget({ ...files, targetId: 'codex' });
    const managedProfile = getProfiles(context).find(item => item.id === state.profileId);
    const managedProviderId = managedProfile ? providerIdForProfile(managedProfile) : undefined;
    const restoredContent = buildRestoredCodexConfig(original, configSnapshot.content, managedProviderId);
    let configRestored = false;
    let tokenMutationStarted = false;
    let activeUpdateStarted = false;
    try {
      if (restoredContent.trim()) await writeAtomic(files.config, restoredContent, management);
      else await removeFileAtomicallyIfUnchanged(files.config, management);
      configRestored = true;
      tokenMutationStarted = true;
      await removeRuntimeToken(files.token);
      await writeOriginalState(files, state.existed, {
        lastAppliedHash: undefined,
        managedConfigHash: undefined,
        profileId: undefined,
        model: undefined,
        restoredAt: new Date().toISOString()
      });
      activeUpdateStarted = true;
      await updateActiveTarget(context, 'codex', undefined);
      result = { files, originallyExisted: state.existed };
    } catch (error) {
      const rollbackErrors = [];
      let configRollbackComplete = !configRestored;
      if (configRestored) {
        try {
          await restoreFileSnapshot(files.config, configSnapshot, restoredContent.trim()
            ? { configExists: true, currentHash: contentHash(restoredContent) }
            : { configExists: false });
          configRollbackComplete = true;
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (activeUpdateStarted) {
        try { await updateActiveTarget(context, 'codex', previousActive); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (tokenMutationStarted) {
        try {
          if (tokenSnapshot.exists) await writeRuntimeToken(files.token, tokenSnapshot.content);
          else await removeRuntimeToken(files.token);
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (configRollbackComplete) {
        try { await restoreFileSnapshot(files.originalState, stateSnapshot); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) {
        throw new Error(`${error.message || error}；恢复回滚未完成：${rollbackErrors.map(item => item.message || item).join('；')}`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    if (options.showError !== false) await vscode.window.showErrorMessage(`恢复失败：${error.message || error}`);
    if (options.throwOnError) throw error;
    return false;
  }
  try { await updateStatusBar(context, statusBar, files); }
  catch (error) { console.error('Failed to refresh ModelMux status bar after restore:', error); }
  if (options.offerReload !== false) await offerReload('已恢复原始 Codex 状态，并删除运行时临时密钥。');
  return result;
}

async function activateProfileForTargetUnlocked(context, targetId, profileId, statusBar, modelOverride, options = {}) {
  const normalizedTarget = normalizeTargetId(targetId);
  const profiles = getProfiles(context);
  const profile = profiles.find(item => item.id === profileId)
    || await chooseProfile(context, `选择用于 ${targetLabel(normalizedTarget)} 的 Provider`, item => targetCompatibility(normalizedTarget, item).supported);
  if (!profile) return false;
  const compatibility = targetCompatibility(normalizedTarget, profile);
  if (!compatibility.supported) throw new Error(compatibility.reason);
  const model = modelOverride || await chooseModelForProfile(context, profile);
  if (!model) return false;
  if (normalizedTarget === 'codex') return activateProfile(context, profile.id, statusBar, model, options);
  const updatedProfile = { ...profile, selectedModel: model };
  let profileSaved = false;
  let result;
  try {
    await saveProfiles(context, profiles.map(item => item.id === profile.id ? updatedProfile : item));
    profileSaved = true;
    result = await activateExternalTarget(context, normalizedTarget, updatedProfile, model);
    if (!result) {
      await saveProfiles(context, profiles);
      return false;
    }
  } catch (error) {
    if (profileSaved) {
      try { await saveProfiles(context, profiles); }
      catch (rollbackError) {
        error = new Error(`${error.message || error}；Provider 模型选择回滚失败：${rollbackError.message || rollbackError}`, { cause: error });
      }
    }
    if (options.showError !== false) await vscode.window.showErrorMessage(`启用失败：${error.message || error}`);
    if (options.throwOnError) throw error;
    return false;
  }
  try { await updateStatusBar(context, statusBar, result.files); }
  catch (error) { console.error(`Failed to refresh ModelMux status bar after activating ${normalizedTarget}:`, error); }
  if (options.offerReload !== false) {
    await vscode.window.showInformationMessage(`已为 ${targetLabel(normalizedTarget)} 启用“${updatedProfile.name} / ${model}”。新会话将使用该配置。`);
  }
  return result;
}

async function activateProfileForTarget(context, targetId, profileId, statusBar, modelOverride, options = {}) {
  return withProfileMutation(profileId, () => withTargetMutation(
    targetId,
    () => activateProfileForTargetUnlocked(context, targetId, profileId, statusBar, modelOverride, options)
  ));
}

async function restoreTargetUnlocked(context, targetId, statusBar, options = {}) {
  const normalizedTarget = normalizeTargetId(targetId);
  if (normalizedTarget === 'codex') return restoreOriginal(context, statusBar, options);
  try {
    const result = await restoreExternalTarget(context, normalizedTarget);
    if (!result) return false;
    await updateStatusBar(context, statusBar, result.files);
    if (options.offerReload !== false) {
      await vscode.window.showInformationMessage(`已恢复 ${targetLabel(normalizedTarget)} 的原始配置。`);
    }
    return result;
  } catch (error) {
    if (options.showError !== false) await vscode.window.showErrorMessage(`恢复失败：${error.message || error}`);
    if (options.throwOnError) throw error;
    return false;
  }
}

async function restoreTarget(context, targetId, statusBar, options = {}) {
  return withTargetMutation(targetId, () => restoreTargetUnlocked(context, targetId, statusBar, options));
}

async function clearApiKey(context, statusBar) {
  const profile = await chooseProfile(
    context,
    '选择要清除 API Key 的配置',
    item => item.kind === 'customResponses' && ['secret', 'bearer'].includes(item.authMode)
  );
  if (!profile) return;
  await withProfileMutation(profile.id, async () => {
    const activeTarget = await activeManagedTargetForProfile(context, profile.id);
    if (activeTarget) {
      await vscode.window.showWarningMessage(`该 API Key 正在被 ${targetLabel(activeTarget)} 使用。请先恢复该 CLI 的原配置或切换 Provider。`);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `确定清除“${profile.name}”的 API Key 吗？`,
      { modal: true },
      '清除'
    );
    if (answer !== '清除') return;
    const activeAfterConfirmation = await activeManagedTargetForProfile(context, profile.id);
    if (activeAfterConfirmation) throw new Error(`该 API Key 已被 ${targetLabel(activeAfterConfirmation)} 使用，清除操作已取消。`);
    await context.secrets.delete(profileSecretKey(context, profile.id));
    await updateStatusBar(context, statusBar);
    await vscode.window.showInformationMessage(`已清除“${profile.name}”的 API Key。`);
  });
}

async function showStatus(context) {
  const selectedTargetId = getSelectedTargetId(context);
  if (selectedTargetId !== 'codex') {
    const state = await getDashboardState(context);
    const active = state.activeProfile;
    const details = [
      `CLI：${state.targetLabel}`,
      `当前模式：${active ? `${active.name} / ${active.selectedModel}` : state.managed ? '受插件管理（活动记录缺失）' : '原始配置'}`,
      `运行环境：${state.platformLabel}`,
      `配置文件：${state.paths.config}`,
      `原始状态：${state.originalState ? (state.originalState.existed ? `已备份 (${state.paths.backup})` : '原先无配置文件（已记录）') : '尚未记录'}`,
      '',
      `兼容 Provider：${state.profiles.filter(item => item.supported).length}/${state.profiles.length}`,
      ...state.profiles.map(profile => `- ${profile.name}${profile.active ? ' [活动]' : ''}：${profile.selectedModel || '未设置模型'}${profile.supported ? '' : `（不兼容：${profile.unsupportedReason}）`}`)
    ];
    const doc = await vscode.workspace.openTextDocument({ language: 'text', content: details.join('\n') });
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  const files = pathsForCurrentUser();
  const managed = await isManagedConfig(files.config);
  const runtimeToken = await fileExists(files.token);
  const originalState = await readOriginalState(files);
  const profiles = getProfiles(context);
  const activeRecord = getActiveTargets(context).codex;
  const activeId = activeRecord && activeRecord.profileId;
  const active = profiles.find(item => item.id === activeId);
  const profileLines = [];
  for (const profile of profiles) {
    const authMode = profile.authMode === 'bearer' ? 'secret' : profile.authMode;
    const hasSecret = profile.kind === 'customResponses' && authMode === 'secret'
      ? Boolean(await context.secrets.get(profileSecretKey(context, profile.id))) : false;
    const authText = profile.kind !== 'customResponses' ? '内置/外部凭据'
      : authMode === 'secret' ? (hasSecret ? 'SecretStorage 已保存' : 'SecretStorage 缺失')
        : authMode === 'env' ? `${profile.envKey || '环境变量未设置名称'}：${process.env[profile.envKey] ? '当前进程可见' : '当前进程不可见'}`
          : authMode === 'envHeaders' ? `环境变量请求头：${Object.values(normalizeStringMap(profile.envHttpHeaders)).every(name => process.env[name]) ? '当前进程可见' : '存在缺失变量'}`
            : '无认证';
    profileLines.push(
      `- ${profile.name}${profile.id === activeId ? ' [活动]' : ''}`,
      `  类型：${providerDescription(profile)}`,
      `  默认模型：${profile.selectedModel || '未设置'}`,
      `  模型数量：${(profile.models || []).length}`,
      `  认证：${authText}`
    );
  }
  const originalText = originalState
    ? (originalState.existed ? `存在 (${files.backup})` : '原先不存在 config.toml（已记录）')
    : '尚未记录';
  const details = [
    `当前模式：${managed && active ? `${active.name} / ${active.selectedModel}` : managed ? '受插件管理（活动记录缺失）' : '原始配置'}`,
    `运行环境：${platformName()}`,
    `配置文件：${files.config}`,
    `原始状态：${originalText}`,
    `运行时密钥：${runtimeToken ? '存在' : '不存在'} (${files.token})`,
    '', `已保存 Provider：${profiles.length}`, ...profileLines
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'text', content: details });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function updateStatusBar(context, statusBar, files = pathsForTarget(getSelectedTargetId(context))) {
  const targetId = files.targetId || 'codex';
  const management = await getTargetManagementState(context, targetId, files);
  const profiles = getProfiles(context);
  const activeRecord = getActiveTargets(context)[targetId];
  const active = profiles.find(item => activeRecord && item.id === activeRecord.profileId);
  const label = targetLabel(targetId);

  if (management.status === 'managed-clean' && active) {
    statusBar.text = `$(server) ${label}: ${activeRecord.model || active.selectedModel || active.name}`;
    statusBar.tooltip = `${active.name}\n${providerDescription(active)}\n${uiText(`Click to manage ${label} model configuration.`, `点击管理 ${label} 的模型配置。`)}`;
  } else if (management.managed) {
    const stateLabels = {
      'managed-drifted': uiText('Changed outside ModelMux', '检测到外部修改'),
      'backup-missing': uiText('Backup missing', '原始备份缺失'),
      'managed-orphaned': uiText('State incomplete', '托管状态不完整')
    };
    statusBar.text = `$(warning) ${label}: ${stateLabels[management.status] || uiText('Needs attention', '需要检查')}`;
    statusBar.tooltip = uiText(
      `${path.basename(files.config)} needs attention. Open ModelMux diagnostics before applying another provider.`,
      `${path.basename(files.config)} 需要检查。再次写入 Provider 前请打开 ModelMux 诊断。`
    );
  } else {
    statusBar.text = `$(shield) ${label}: ${uiText('Original', '原配置')}`;
    statusBar.tooltip = uiText(
      `Using the original ${label} configuration. Click to open ModelMux.`,
      `当前使用 ${label} 的原始配置。点击打开 ModelMux。`
    );
  }
  statusBar.show();
}

function canAutomaticallyRefreshManagedConfig(management) {
  return Boolean(management && management.status === 'managed-clean'
    && management.originalState && !management.originalState.automaticRefreshDisabled);
}

async function recreateRuntimeTokenIfNeededUnlocked(context, statusBar, files = pathsForCurrentUser()) {
  if (!['linux', 'win32', 'darwin'].includes(process.platform)) {
    await updateStatusBar(context, statusBar);
    return;
  }

  if (!(await isManagedConfig(files.config))) {
    await removeRuntimeTokenBestEffort(files.token);
    await updateStatusBar(context, statusBar, files);
    return;
  }

  try {
    await reconcileManagedCodexState(context, files);
  } catch (error) {
    console.error('Failed to reconcile managed Codex state:', error);
  }
  const content = await readConfigText(files.config);
  const originalState = await readOriginalState(files);
  const activeRecord = getActiveTargets(context).codex;
  const resolved = resolveManagedCodexProfile(context, content, originalState, activeRecord);
  if (!resolved) {
    await removeRuntimeTokenBestEffort(files.token);
    await updateStatusBar(context, statusBar, files);
    return;
  }
  const { profile, model } = resolved;

  if (isCustomProfile(profile)) {
    try {
      validateProviderBaseUrl(profile.baseUrl);
      assertNoSensitiveStaticValues(profile.queryParams, 'Query parameters');
      assertNoSensitiveStaticValues(profile.httpHeaders, 'Static headers');
    } catch (error) {
      console.error('Refusing to refresh an unsafe legacy provider:', error);
      await removeRuntimeTokenBestEffort(files.token);
      await updateStatusBar(context, statusBar, files);
      return;
    }
  }

  const activeAuthMode = profile.authMode === 'bearer' ? 'secret' : profile.authMode;
  let resolvedSecret;
  if (profile.kind === 'customResponses' && activeAuthMode === 'secret') {
    resolvedSecret = await context.secrets.get(profileSecretKey(context, profile.id));
  }

  const management = await getTargetManagementState(context, 'codex', files);
  const currentContent = await readConfigText(files.config);
  const contentStillMatchesState = Boolean(
    management.originalState
    && management.originalState.lastAppliedHash
    && contentHash(currentContent) === management.originalState.lastAppliedHash
  );
  const canRefreshConfig = canAutomaticallyRefreshManagedConfig(management) && contentStillMatchesState;

  try { await assertTargetSnapshotUnchanged(management, files); }
  catch {
    await updateStatusBar(context, statusBar, files);
    return;
  }

  if (profile.kind === 'customResponses' && activeAuthMode === 'secret') {
    const canRestoreToken = canRefreshConfig || canRecreateRuntimeTokenFromManagedConfig(
      currentContent,
      profile,
      files.token,
      management
    );
    if (resolvedSecret && process.platform !== 'win32' && canRestoreToken) {
      try {
        await writeRuntimeToken(files.token, resolvedSecret);
      } catch (error) {
        console.error('Failed to recreate Codex runtime token:', error);
      }
    } else {
      await removeRuntimeTokenBestEffort(files.token);
    }
  } else {
    await removeRuntimeTokenBestEffort(files.token);
  }

  if (!canRefreshConfig) {
    await updateStatusBar(context, statusBar, files);
    return;
  }

  try {
    const desired = buildManagedConfig(profile, model, files.token, resolvedSecret, {
      catalogPath: modelCatalogPathForFiles(context, profile, files),
      codexDir: files.codexDir
    });
    const current = await readConfigText(files.config);
    if (contentHash(current) !== management.originalState.lastAppliedHash) {
      await updateStatusBar(context, statusBar, files);
      return;
    }
    if (profile.kind === 'customResponses') {
      const catalogPath = modelCatalogPathForFiles(context, profile, files);
      if (catalogPath && !(await fileExists(catalogPath))) {
        await writeModelCatalogForProfile(context, profile, model, files, undefined, { path: catalogPath });
      }
    }
    const merged = mergeManagedCodexConfig(desired, current);
    if (current !== merged) {
      await writeAtomic(files.config, merged, management);
      await writeOriginalState(files, originalState.existed, {
        lastAppliedHash: contentHash(merged),
        managedConfigHash: managedCodexConfigHash(merged, { maskSecrets: false }),
        profileId: profile.id,
        model,
        updatedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Failed to refresh managed Codex config:', error);
  }

  await updateStatusBar(context, statusBar, files);
}

async function recreateRuntimeTokenIfNeeded(context, statusBar, files = pathsForCurrentUser()) {
  return withProfileMutation('codex-runtime-refresh', () => withTargetMutation(
    'codex',
    () => recreateRuntimeTokenIfNeededUnlocked(context, statusBar, files)
  ));
}

function executableCandidates(name) {
  if (process.platform === 'win32') return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
  return [name];
}

function findExecutable(name) {
  const pathValue = String(process.env.PATH || '');
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of executableCandidates(name)) {
      const file = path.join(directory.replace(/^"|"$/g, ''), candidate);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) return file;
      } catch {}
    }
  }
  return undefined;
}

async function executableVersion(targetId) {
  const executable = findExecutable(TARGET_EXECUTABLES[targetId]);
  if (!executable) return { found: false, detail: `${TARGET_EXECUTABLES[targetId]} not found on PATH` };
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], { windowsHide: true, timeout: 5000 });
    const version = String(stdout || stderr || '').trim().split(/\r?\n/)[0].slice(0, 240);
    return { found: true, detail: version ? `${executable} · ${version}` : executable };
  } catch (error) {
    return { found: true, detail: `${executable} · ${String(error.message || error).slice(0, 240)}` };
  }
}

async function collectDiagnostics(context) {
  const files = pathsForCurrentUser();
  const checks = [];
  const add = (name, ok, detail, severity = 'error') => checks.push({ name, ok: Boolean(ok), detail: String(detail || ''), severity });
  const environment = runtimeEnvironmentInfo();
  add('受支持的平台', ['linux', 'win32', 'darwin'].includes(process.platform), environment.platformLabel);
  add('运行架构', ['x64', 'arm64', 'ia32', 'arm'].includes(process.arch), process.arch);
  const cli = await executableVersion('codex');
  add('CLI 可执行文件', cli.found, cli.detail, 'warning');

  if (process.platform === 'win32') {
    try {
      await fs.promises.access(files.codexDir, fs.constants.R_OK | fs.constants.W_OK);
      add('Codex 配置目录可读写', true, files.codexDir);
    } catch (error) { add('Codex 配置目录可读写', false, `${files.codexDir}：${error.message || error}`); }
  } else {
    try {
      await fs.promises.access(files.codexDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      add('Codex 配置目录可读写', true, files.codexDir);
    } catch (error) { add('Codex 配置目录可读写', false, `${files.codexDir}：${error.message || error}`); }
  }

  const managed = await isManagedConfig(files.config);
  const originalState = await readOriginalState(files);
  add('原始状态记录', Boolean(originalState) || !managed, originalState ? (originalState.existed ? '原配置存在并已记录' : '原配置原先不存在') : '尚未启用，无需记录');
  add('config.toml 状态', managed || await fileExists(files.config) || (originalState && originalState.existed === false), managed ? '插件管理配置' : await fileExists(files.config) ? '原始配置存在' : '原始配置不存在');
  if (originalState && originalState.existed) add('原始备份', await fileExists(files.backup), files.backup);

  let helperCommand;
  if (process.platform === 'win32') {
    helperCommand = resolveWindowsPowerShellCommand();
    try {
      await execFileAsync(helperCommand, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true, timeout: 10000 });
      add('Windows PowerShell helper', true, helperCommand);
    } catch (error) { add('Windows PowerShell helper', false, error.message || error); }
  } else {
    helperCommand = resolveUnixCatCommand();
    let executable = helperCommand === 'cat';
    if (helperCommand !== 'cat') try { await fs.promises.access(helperCommand, fs.constants.X_OK); executable = true; } catch { executable = false; }
    add('Unix Token helper 可执行', executable, helperCommand);
  }

  const tokenDir = path.dirname(files.token);
  try {
    const stat = await fs.promises.stat(tokenDir);
    let privateEnough = stat.isDirectory();
    if (process.platform !== 'win32') {
      privateEnough = privateEnough && (stat.mode & 0o077) === 0;
      if (typeof process.getuid === 'function') privateEnough = privateEnough && stat.uid === process.getuid();
    }
    add('运行时密钥目录', privateEnough, `${tokenDir}${privateEnough ? '' : '（权限或所有者需要检查）'}`);
  } catch (error) {
    const required = Boolean(managed && process.platform !== 'win32');
    add('运行时密钥目录', !required && error.code === 'ENOENT', required ? `${tokenDir}：${error.message || error}` : '当前认证方式尚未创建运行时密钥目录');
  }

  const activeRecord = getActiveTargets(context).codex;
  const activeId = activeRecord && activeRecord.profileId;
  const profile = getProfiles(context).find(item => item.id === activeId);
  add('活动 Provider 记录', !managed || Boolean(profile), profile ? `${profile.name} / ${activeRecord.model || profile.selectedModel || '未选择模型'}` : managed ? '配置受管理但记录缺失' : '当前无需活动记录');
  const authMode = profile && profile.authMode === 'bearer' ? 'secret' : profile && profile.authMode;
  const tokenExists = await fileExists(files.token);
  const tokenRequired = process.platform !== 'win32' && managed && profile && profile.kind === 'customResponses' && authMode === 'secret';
  add('运行时密钥文件', !tokenRequired || tokenExists, tokenExists ? files.token : tokenRequired ? '缺失' : '当前认证方式不需要');

  if (tokenExists && process.platform !== 'win32') {
    try {
      const stat = await fs.promises.stat(files.token);
      const modeOk = (stat.mode & 0o077) === 0;
      const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid();
      add('运行时密钥权限', modeOk && ownerOk, `mode=${(stat.mode & 0o777).toString(8)}${ownerOk ? '' : '，所有者不匹配'}`);
    } catch (error) { add('运行时密钥权限', false, error.message || error); }
  }
  if (tokenExists && process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('icacls.exe', [files.token], { windowsHide: true, timeout: 10000 });
      add('Windows Token ACL', !/Everyone:\(F\)|Users:\(F\)/i.test(stdout), '已读取 ACL；未发现明显的 Everyone/Users 完全控制');
    } catch (error) { add('Windows Token ACL', false, error.message || error); }
  }

  if (managed && profile && profile.kind === 'customResponses') {
    const configText = await readConfigText(files.config);
    add('Responses 协议', configText.includes('wire_api = "responses"'), 'wire_api = "responses"');
    if (authMode === 'secret') {
      const secret = await context.secrets.get(profileSecretKey(context, profile.id));
      add('SecretStorage 密钥', Boolean(secret), secret ? '已保存（内容未显示）' : '缺失');
      if (process.platform === 'win32') {
        add('Windows 兼容认证', Boolean(secret) && configText.includes('experimental_bearer_token ='), '托管配置使用受 ACL 保护的 experimental_bearer_token');
        try {
          await verifyWindowsPrivateAcl(files.config);
          add('Windows 配置 ACL', true, 'config.toml 仅允许当前账户与 SYSTEM 访问');
        } catch (error) { add('Windows 配置 ACL', false, error.message || error); }
      } else if (secret && tokenExists) {
        try {
          const runtime = await fs.promises.readFile(files.token, 'utf8');
          add('运行时密钥一致性', runtime === secret.trim(), runtime === secret.trim() ? '与 SecretStorage 一致' : '不一致，请重新启用 Provider');
          const helper = authCommandForToken(files.token);
          const { stdout } = await execFileAsync(helper.command, helper.args, { windowsHide: true, timeout: 10000 });
          add('Token helper 输出', stdout === secret.trim(), stdout === secret.trim() ? '输出准确且无额外换行' : '输出与密钥不一致');
        } catch (error) { add('Token helper 输出', false, error.message || error); }
      }
      if (process.platform !== 'win32') {
        const helper = authCommandForToken(files.token);
        add('配置中的 Token 路径', configText.includes(tomlString(files.token)), files.token);
        add('Token helper 配置', configText.includes(`command = "${tomlString(helper.command)}"`), helper.command);
      }
    } else if (authMode === 'env') {
      add('环境变量名称', /^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envKey || ''), profile.envKey || '未设置');
      add('环境变量当前可见', Boolean(process.env[profile.envKey]), process.env[profile.envKey] ? '已设置（内容未显示）' : '未在扩展进程中发现；重启 VS Code 后再检查');
      add('config.toml env_key', configText.includes(`env_key = "${tomlString(profile.envKey)}"`), profile.envKey || '未设置');
    } else if (authMode === 'envHeaders') {
      const mappings = normalizeStringMap(profile.envHttpHeaders);
      const missing = Object.values(mappings).filter(name => !process.env[name]);
      add('环境变量请求头映射', Object.keys(mappings).length > 0, Object.keys(mappings).join(', ') || '未设置');
      add('请求头环境变量当前可见', missing.length === 0, missing.length ? `未发现：${missing.join(', ')}` : '全部可见（内容未显示）');
      add('config.toml env_http_headers', configText.includes('env_http_headers ='), Object.keys(mappings).join(', '));
    }
    add('HTTP 请求重试', configText.includes(`request_max_retries = ${clampInteger(profile.requestMaxRetries, 0, 0, 20)}`), `request_max_retries = ${clampInteger(profile.requestMaxRetries, 0, 0, 20)}`);
  }

  const failed = checks.filter(item => !item.ok && item.severity !== 'warning').length;
  const warned = checks.filter(item => !item.ok && item.severity === 'warning').length;
  return { checks, failed, warned, passed: checks.length - failed - warned, files, platform: environment.platformLabel };
}

async function collectTargetDiagnostics(context, targetId) {
  const normalizedTarget = normalizeTargetId(targetId);
  if (normalizedTarget === 'codex') return collectDiagnostics(context);
  const files = pathsForTarget(normalizedTarget);
  const checks = [];
  const add = (name, ok, detail, severity = 'error') => checks.push({ name, ok: Boolean(ok), detail: String(detail || ''), severity });
  const cli = await executableVersion(normalizedTarget);
  add('CLI 可执行文件', cli.found, cli.detail, 'warning');
  try {
    await fs.promises.access(path.dirname(files.config), fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    add('配置目录可读写', true, path.dirname(files.config));
  } catch (error) { add('配置目录可读写', false, error.message || error); }
  const active = getActiveTargets(context)[normalizedTarget];
  const profile = active && getProfiles(context).find(item => item.id === active.profileId);
  const state = await readOriginalState(files);
  const configExists = await fileExists(files.config);
  add('配置路径', true, files.config);
  add('活动 Provider 记录', !active || Boolean(profile), profile ? `${profile.name} / ${active.model}` : active ? '活动记录对应的 Provider 不存在' : '当前未由插件接管');
  add('原始状态记录', !active || Boolean(state), state ? (state.existed ? '原配置已备份' : '已记录原先无配置文件') : '当前未接管');
  if (state && state.existed) add('原始备份', await fileExists(files.backup), files.backup);
  if (active) add('当前配置文件', configExists, configExists ? files.config : '缺失');
  if (active && profile) {
    const compatibility = targetCompatibility(normalizedTarget, profile);
    add('Provider 兼容性', compatibility.supported, compatibility.supported ? kindLabel(profile.kind) : compatibility.reason);
    if (isCustomProfile(profile) && profile.authMode === 'env') {
      add('认证环境变量', Boolean(process.env[profile.envKey]), process.env[profile.envKey] ? `${profile.envKey} 当前可见` : `${profile.envKey} 当前进程不可见`);
    }
  }
  if (active && state && state.lastAppliedHash && configExists) {
    const current = await fs.promises.readFile(files.config, 'utf8');
    add('托管配置完整性', contentHash(current) === state.lastAppliedHash, contentHash(current) === state.lastAppliedHash ? '配置与最后写入内容一致' : '配置已被其它程序修改');
  }
  const failed = checks.filter(item => !item.ok && item.severity !== 'warning').length;
  const warned = checks.filter(item => !item.ok && item.severity === 'warning').length;
  return { checks, failed, warned, passed: checks.length - failed - warned, files, platform: runtimeEnvironmentInfo().platformLabel, targetId: normalizedTarget };
}

async function showDiagnostics(context, targetId = getSelectedTargetId(context)) {
  const normalizedTarget = normalizeTargetId(targetId);
  const result = await collectTargetDiagnostics(context, normalizedTarget);
  const english = readGlobalSettings().uiLanguage !== 'zh-CN';
  const diagnosticNames = {
    '受支持的平台': 'Supported platform', '运行架构': 'Runtime architecture', 'CLI 可执行文件': 'CLI executable', 'Codex 配置目录可读写': 'Codex configuration directory is writable',
    '原始状态记录': 'Original state record', 'config.toml 状态': 'config.toml status', '原始备份': 'Original backup',
    'Unix Token helper 可执行': 'Unix token helper is executable', '运行时密钥目录': 'Runtime credential directory',
    '活动 Provider 记录': 'Active provider record', '运行时密钥文件': 'Runtime credential file', '运行时密钥权限': 'Runtime credential permissions',
    'Responses 协议': 'Responses protocol', 'SecretStorage 密钥': 'SecretStorage credential', 'Windows 兼容认证': 'Windows compatibility authentication',
    'Windows 配置 ACL': 'Windows configuration ACL', '运行时密钥一致性': 'Runtime credential consistency', 'Token helper 输出': 'Token helper output', '配置中的 Token 路径': 'Token path in configuration',
    'Token helper 配置': 'Token helper configuration', '环境变量名称': 'Environment-variable name', '环境变量当前可见': 'Environment variable visibility',
    '环境变量请求头映射': 'Environment header mapping', '请求头环境变量当前可见': 'Header environment-variable visibility', 'HTTP 请求重试': 'HTTP request retries',
    '配置目录可读写': 'Configuration directory is writable', '配置路径': 'Configuration path', '当前配置文件': 'Current configuration file',
    'Provider 兼容性': 'Provider compatibility', '认证环境变量': 'Authentication environment variable', '托管配置完整性': 'Managed configuration integrity'
  };
  const lines = [
    uiText(`ModelMux ${EXTENSION_VERSION} · ${targetLabel(normalizedTarget)} diagnostics`, `ModelMux ${EXTENSION_VERSION} · ${targetLabel(normalizedTarget)} 环境自检`),
    uiText(`Runtime: ${result.platform}`, `运行环境：${result.platform}`),
    uiText(
      `Result: ${result.passed} passed, ${result.warned || 0} warnings, ${result.failed} require action`,
      `结果：${result.passed} 项通过，${result.warned || 0} 项警告，${result.failed} 项需要处理`
    ),
    '',
    ...result.checks.map(item => {
      const name = english ? (diagnosticNames[item.name] || item.name) : item.name;
      const detail = english && /[\u4e00-\u9fff]/.test(item.detail)
        ? (item.ok ? 'Completed successfully.' : 'Review this check in the current CLI environment.') : item.detail;
      return `${item.ok ? uiText('[PASS]', '[通过]') : uiText('[CHECK]', '[检查]')} ${name}\n  ${detail}`;
    }),
    '',
    uiText('API key values are never included in this report.', '说明：报告不会显示 API Key 内容。')
  ];
  const document = await vscode.workspace.openTextDocument({ language: 'text', content: lines.join('\n') });
  await vscode.window.showTextDocument(document, { preview: true });
  return result;
}

const EXPORTABLE_PROFILE_FIELDS = [
  'id', 'kind', 'name', 'providerId', 'providerName', 'baseUrl', 'authMode', 'envKey',
  'envKeyInstructions', 'allowInsecureHttp', 'allowInsecureModelDiscovery', 'modelDiscoveryPath',
  'requestMaxRetries', 'streamMaxRetries', 'streamIdleTimeoutMs', 'supportsWebsockets',
  'queryParams', 'httpHeaders', 'envHttpHeaders', 'awsRegion', 'awsProfile', 'selectedModel',
  'models', 'reasoningPolicy'
];

function withoutSensitiveEntries(map) {
  return Object.fromEntries(Object.entries(normalizeStringMap(map)).filter(([key]) => !isSensitiveName(key)));
}

function sanitizedExportUrl(value) {
  try {
    const url = new URL(normalizeBaseUrl(value));
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveName(key)) url.searchParams.delete(key);
    }
    return normalizeBaseUrl(url.toString());
  } catch { return undefined; }
}

function sanitizedModelDiscoveryPath(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  if (/^https?:\/\//i.test(text)) return sanitizedExportUrl(text);
  try {
    const url = new URL(text.startsWith('/') ? text : `/${text}`, 'https://modelmux.invalid');
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveName(key)) url.searchParams.delete(key);
    }
    return `${url.pathname}${url.search}`;
  } catch { return undefined; }
}

function exportableProfile(profile) {
  const copy = {};
  for (const field of EXPORTABLE_PROFILE_FIELDS) {
    if (profile[field] !== undefined) copy[field] = profile[field];
  }
  if (copy.queryParams) copy.queryParams = withoutSensitiveEntries(copy.queryParams);
  if (copy.httpHeaders) copy.httpHeaders = withoutSensitiveEntries(copy.httpHeaders);
  if (copy.baseUrl !== undefined) {
    const baseUrl = sanitizedExportUrl(copy.baseUrl);
    if (baseUrl) copy.baseUrl = baseUrl;
    else delete copy.baseUrl;
  }
  if (copy.modelDiscoveryPath !== undefined) {
    const discoveryPath = sanitizedModelDiscoveryPath(copy.modelDiscoveryPath);
    if (discoveryPath) copy.modelDiscoveryPath = discoveryPath;
    else delete copy.modelDiscoveryPath;
  }
  return copy;
}

function parseImportPayload(parsed) {
  if (!parsed || ![PROFILE_EXPORT_FORMAT, LEGACY_PROFILE_EXPORT_FORMAT].includes(parsed.format) || !Array.isArray(parsed.profiles)) {
    throw new Error(uiText('This is not a supported ModelMux provider export file.', '不是受支持的 ModelMux Provider 导出文件。'));
  }
  if (parsed.profiles.length > 500) throw new Error(uiText('The import contains more than 500 providers.', '导入文件包含超过 500 个 Provider。'));
  return parsed.profiles;
}

function createImportPlan(current, rawProfiles) {
  const existingById = new Map(current.map(item => [item.id, item]));
  const entries = rawProfiles.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Provider #${index + 1} 不是有效对象。`);
    const requestedId = typeof item.id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(item.id) ? item.id : undefined;
    const existing = requestedId ? existingById.get(requestedId) : undefined;
    const sanitized = { ...item };
    if (sanitized.queryParams) sanitized.queryParams = withoutSensitiveEntries(parseJsonMap(sanitized.queryParams, 'Query parameters'));
    if (sanitized.httpHeaders) sanitized.httpHeaders = withoutSensitiveEntries(parseJsonMap(sanitized.httpHeaders, 'Static headers'));
    const profile = normalizeProfileFromGui(sanitized, existing);
    if (requestedId) profile.id = requestedId;
    return { status: existing ? 'conflict' : 'new', profile, existingId: existing && existing.id };
  });
  return {
    entries,
    added: entries.filter(item => item.status === 'new').length,
    conflicts: entries.filter(item => item.status === 'conflict').length
  };
}

function applyImportPlan(current, plan, strategy = 'skip') {
  if (!['skip', 'replace'].includes(strategy)) throw new Error('不支持的导入冲突策略。');
  const next = current.slice();
  const indexById = new Map(next.map((item, index) => [item.id, index]));
  let imported = 0;
  let replaced = 0;
  let skipped = 0;
  for (const entry of plan.entries) {
    if (entry.status === 'conflict') {
      if (strategy === 'skip') { skipped += 1; continue; }
      const index = indexById.get(entry.existingId);
      next[index] = entry.profile;
      replaced += 1;
      continue;
    }
    let profile = entry.profile;
    if (indexById.has(profile.id)) profile = { ...profile, id: createId() };
    indexById.set(profile.id, next.length);
    next.push(profile);
    imported += 1;
  }
  return { profiles: next, imported, replaced, skipped };
}

async function exportProfiles(context) {
  const exportLabel = uiText('Export', '导出');
  const uri = await vscode.window.showSaveDialog({
    title: uiText('Export ModelMux provider profiles (without secrets)', '导出 ModelMux Provider 配置（不含密钥）'),
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `modelmux-profiles-${new Date().toISOString().slice(0, 10)}.json`)),
    filters: { JSON: ['json'] }, saveLabel: exportLabel
  });
  if (!uri) return { status: 'cancelled' };
  const payload = { format: PROFILE_EXPORT_FORMAT, version: 2, exportedAt: new Date().toISOString(), profiles: getProfiles(context).map(exportableProfile) };
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
  await vscode.window.showInformationMessage(uiText(`Exported ${payload.profiles.length} providers without credentials.`, `已导出 ${payload.profiles.length} 个 Provider；文件不包含凭据。`));
  return { status: 'completed', count: payload.profiles.length };
}

async function pickImportPlan(context) {
  const picked = await vscode.window.showOpenDialog({ title: uiText('Import ModelMux provider profiles', '导入 ModelMux Provider 配置'), canSelectMany: false, filters: { JSON: ['json'] }, openLabel: uiText('Import', '导入') });
  if (!picked || !picked[0]) return { status: 'cancelled' };
  const bytes = await vscode.workspace.fs.readFile(picked[0]);
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(uiText('The import file exceeds 2 MB.', '导入文件超过 2 MB 限制。'));
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const plan = createImportPlan(getProfiles(context), parseImportPayload(parsed));
  return { status: 'completed', plan, source: picked[0].fsPath || picked[0].path || '' };
}

async function commitImportPlan(context, plan, strategy) {
  return withProfileMutation('import', async () => {
    if (strategy === 'replace') {
      const activeProfileIds = new Set(Object.values(getActiveTargets(context)).map(item => item && item.profileId).filter(Boolean));
      const activeConflicts = plan.entries.filter(entry => entry.status === 'conflict' && activeProfileIds.has(entry.existingId));
      if (activeConflicts.length) {
        throw new Error(uiText(
          'One or more conflicting providers are active. Restore or switch those CLI targets before replacing them.',
          '一个或多个冲突 Provider 正在使用中。请先恢复或切换对应 CLI，再执行替换导入。'
        ));
      }
    }
    const result = applyImportPlan(getProfiles(context), plan, strategy);
    await saveProfiles(context, result.profiles);
    return { status: 'completed', imported: result.imported, replaced: result.replaced, skipped: result.skipped };
  });
}

async function importProfiles(context) {
  const selected = await pickImportPlan(context);
  if (selected.status === 'cancelled') return selected;
  let strategy = 'skip';
  if (selected.plan.conflicts) {
    const picked = await vscode.window.showQuickPick([
      { label: uiText('Replace matching providers', '替换同 ID Provider'), value: 'replace' },
      { label: uiText('Skip matching providers', '跳过同 ID Provider'), value: 'skip' }
    ], { title: uiText(`${selected.plan.conflicts} provider conflicts found`, `发现 ${selected.plan.conflicts} 个 Provider 冲突`), ignoreFocusOut: true });
    if (!picked) return { status: 'cancelled' };
    strategy = picked.value;
  }
  const result = await commitImportPlan(context, selected.plan, strategy);
  await vscode.window.showInformationMessage(uiText(
    `Imported ${result.imported}, replaced ${result.replaced}, skipped ${result.skipped}. Configure credentials on this device.`,
    `已新增 ${result.imported} 个、替换 ${result.replaced} 个、跳过 ${result.skipped} 个 Provider。请在本机配置凭据。`
  ));
  return result;
}

async function testProviderConnection(context, profileId) {
  const profile = getProfiles(context).find(item => item.id === profileId);
  if (!profile) throw new Error(uiText('Provider not found.', '未找到 Provider。'));
  if (!isCustomProfile(profile)) {
    return {
      status: 'unsupported', native: true, ok: false,
      message: uiText(
        'Direct connection testing is only available for custom HTTP providers. Native providers use credentials owned by their CLI.',
        '仅自定义 HTTP Provider 支持直接连接测试；原生 Provider 使用对应 CLI 自己管理的凭据。'
      )
    };
  }
  const started = Date.now();
  const models = await fetchModelsForProfile(context, profile);
  return { status: 'completed', native: false, latencyMs: Date.now() - started, models: models.length };
}

function languageForTarget(targetId) {
  if (targetId === 'codex' || targetId === 'grok') return 'toml';
  if (targetId === 'hermes') return 'yaml';
  return 'json';
}

function redactedPreviewSecret() {
  return '<stored in protected configuration>';
}

async function proposedTargetContent(context, targetId, profile, model) {
  const files = pathsForTarget(targetId);
  if (targetId === 'codex') {
    const authMode = profile.authMode === 'bearer' ? 'secret' : profile.authMode;
    const placeholder = profile.kind === 'customResponses' && authMode === 'secret' && process.platform === 'win32'
      ? redactedPreviewSecret() : undefined;
    const desired = buildManagedConfig(profile, model, files.token, placeholder, {
      catalogPath: modelCatalogPathForFiles(context, profile, files),
      codexDir: files.codexDir
    });
    const current = await readConfigText(files.config);
    return current.trim() ? mergeManagedCodexConfig(desired, current) : desired;
  }
  const originalState = await readOriginalState(files);
  const original = originalState
    ? await originalContentForTarget(files)
    : await readConfigText(files.config);
  return buildTargetConfig(targetId, profile, model, original);
}

async function showContentDiff(targetId, before, after, title) {
  const language = languageForTarget(targetId);
  const beforeDocument = await vscode.workspace.openTextDocument({ language, content: before || '' });
  const afterDocument = await vscode.workspace.openTextDocument({ language, content: after || '' });
  await vscode.commands.executeCommand('vscode.diff', beforeDocument.uri, afterDocument.uri, title, { preview: true });
}

async function previewProfileConfig(context, targetId, profileId, modelOverride) {
  const normalizedTarget = normalizeTargetId(targetId);
  const profile = getProfiles(context).find(item => item.id === profileId);
  if (!profile) throw new Error(uiText('Provider not found.', '未找到 Provider。'));
  const compatibility = targetCompatibility(normalizedTarget, profile);
  if (!compatibility.supported) throw new Error(compatibility.reason);
  const model = String(modelOverride || profile.selectedModel || '').trim();
  if (!model) throw new Error(uiText('Select a model before previewing.', '预览前请选择模型。'));
  const files = pathsForTarget(normalizedTarget);
  const before = await readConfigText(files.config);
  const after = await proposedTargetContent(context, normalizedTarget, profile, model);
  await showContentDiff(normalizedTarget, before, after, `ModelMux · ${targetLabel(normalizedTarget)} · ${profile.name}`);
  return { status: 'completed' };
}

async function previewRestoreConfig(context, targetId) {
  const normalizedTarget = normalizeTargetId(targetId);
  const files = pathsForTarget(normalizedTarget);
  const management = await getTargetManagementState(context, normalizedTarget, files);
  if (!management.originalState || management.status === 'original') throw new Error(uiText('No active managed configuration can be restored.', '当前没有可恢复的托管配置。'));
  const before = await readConfigText(files.config);
  const original = await originalContentForTarget(files);
  const managedProfile = normalizedTarget === 'codex'
    ? getProfiles(context).find(item => item.id === management.originalState.profileId) : undefined;
  const after = normalizedTarget === 'codex'
    ? buildRestoredCodexConfig(original, before, managedProfile ? providerIdForProfile(managedProfile) : undefined)
    : original;
  await showContentDiff(normalizedTarget, before, after, `ModelMux · ${targetLabel(normalizedTarget)} · ${uiText('Restore preview', '恢复预览')}`);
  return { status: 'completed' };
}

const WEBVIEW_COMMAND_SCHEMAS = {
  ready: {}, refreshState: {},
  updateUiSettings: { fontSize: 'optionalFontSize', language: 'optionalLanguage', fontFamily: 'optionalFontFamily' },
  setFontSize: { fontSize: 'fontSize' }, saveProfile: { profile: 'profile', apiKey: 'optionalSecret' }, fetchModels: { profile: 'profile', apiKey: 'optionalSecret' },
  activateProfile: { targetId: 'target', profileId: 'id', model: 'short' },
  refreshModels: { profileId: 'id' }, deleteProfile: { profileId: 'id' }, clearApiKey: { profileId: 'id' },
  selectTarget: { targetId: 'target' }, restoreOriginal: { targetId: 'target' }, previewRestore: { targetId: 'target' },
  runDiagnostics: { targetId: 'target' }, getDiagnostics: { targetId: 'target' }, showDiagnosticsReport: { targetId: 'target' },
  exportProfiles: {}, importProfiles: {}, selectImportFile: {}, commitImport: { importId: 'id', strategy: 'importStrategy' }, openConfig: { targetId: 'target' },
  reloadWindow: {}, openSettings: {}, previewProfile: { targetId: 'target', profileId: 'id', model: 'short' },
  testProvider: { profileId: 'id', targetId: 'target', model: 'short' }
};

function validateBoundedString(value, field, maximum = 512, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    throw new Error(`消息字段 ${field} 无效。`);
  }
}

function validateWebviewMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Webview 消息必须是对象。');
  validateBoundedString(message.command, 'command', 64, true);
  const schema = WEBVIEW_COMMAND_SCHEMAS[message.command];
  if (!schema) throw new Error(uiText(`Unknown operation: ${message.command}`, `未知操作：${message.command}`));
  validateBoundedString(message.requestId, 'requestId', 128, false);
  for (const [field, type] of Object.entries(schema)) {
    if (type === 'target') {
      validateBoundedString(message[field], field, 32, true);
      if (!TARGET_IDS.includes(message[field])) throw new Error(`消息字段 ${field} 不是有效 CLI 目标。`);
    } else if (type === 'id') validateBoundedString(message[field], field, 128, true);
    else if (type === 'short') validateBoundedString(message[field], field, 512, false);
    else if (type === 'profile') {
      if (!message[field] || typeof message[field] !== 'object' || Array.isArray(message[field])) throw new Error(`消息字段 ${field} 必须是对象。`);
      if (Buffer.byteLength(JSON.stringify(message[field]), 'utf8') > 262144) throw new Error('Provider 表单超过 256 KB 限制。');
    } else if (type === 'optionalSecret') validateBoundedString(message[field], field, 16384, false);
    else if (type === 'fontSize' || type === 'optionalFontSize') {
      if (message[field] === undefined && type === 'optionalFontSize') continue;
      if (typeof message[field] !== 'number' || !Number.isFinite(message[field]) || message[field] < 10 || message[field] > 20) throw new Error(`消息字段 ${field} 无效。`);
    } else if (type === 'optionalLanguage' && message[field] !== undefined && !['en', 'zh-CN'].includes(message[field])) throw new Error(`消息字段 ${field} 无效。`);
    else if (type === 'optionalFontFamily' && message[field] !== undefined && !['default', 'system', 'monospace'].includes(message[field])) throw new Error(`消息字段 ${field} 无效。`);
    else if (type === 'importStrategy' && !['skip', 'replace'].includes(message[field])) throw new Error(`消息字段 ${field} 无效。`);
  }
  const allowedFields = new Set(['command', 'requestId', ...Object.keys(schema)]);
  for (const field of Object.keys(message)) {
    if (!allowedFields.has(field)) throw new Error(`消息包含未声明字段 ${field}。`);
  }
  return message;
}

async function openMenu(context, statusBar) {
  const selectedTargetId = getSelectedTargetId(context);
  const selectedLabel = targetLabel(selectedTargetId);
  const selected = await vscode.window.showQuickPick([
    {
      label: uiText('$(arrow-swap) Switch provider / model', '$(arrow-swap) 切换 Provider / 模型'),
      description: uiText(`Choose a compatible provider for ${selectedLabel}`, `从兼容 Provider 中选择并写入 ${selectedLabel}`),
      command: 'codexConfigSwitcher.switchProfile'
    },
    {
      label: uiText('$(add) Add provider', '$(add) 添加 Provider'),
      description: uiText('Open the visual provider editor', '打开图形化 Provider 编辑器'),
      command: 'codexConfigSwitcher.addProfile'
    },
    {
      label: uiText('$(edit) Edit provider', '$(edit) 编辑 Provider'),
      description: uiText('Change endpoint, models, authentication, and compatibility', '修改地址、模型、认证方式和兼容策略'),
      command: 'codexConfigSwitcher.editProfile'
    },
    {
      label: uiText('$(sync) Refresh model list', '$(sync) 刷新模型列表'),
      description: uiText('Fetch model IDs from a custom provider', '从自定义 Provider 的 /models 获取模型 ID'),
      command: 'codexConfigSwitcher.refreshModels'
    },
    {
      label: uiText('$(export) Export provider profiles', '$(export) 导出 Provider 配置'),
      description: uiText('Export portable JSON without API keys', '导出跨平台 JSON，不包含 API Key'),
      command: 'codexConfigSwitcher.exportProfiles'
    },
    {
      label: uiText('$(cloud-upload) Import provider profiles', '$(cloud-upload) 导入 Provider 配置'),
      description: uiText('Import JSON; credentials remain device-local', '导入 JSON；密钥需在当前设备重新设置'),
      command: 'codexConfigSwitcher.importProfiles'
    },
    {
      label: uiText('$(trash) Delete provider', '$(trash) 删除 Provider'),
      description: uiText('Delete a profile and its saved API key', '删除配置及其保存的 API Key'),
      command: 'codexConfigSwitcher.deleteProfile'
    },
    {
      label: uiText('$(history) Restore original configuration', '$(history) 恢复原配置'),
      description: uiText(`Restore the original ${selectedLabel} configuration`, `恢复 ${selectedLabel} 的原始配置`),
      command: 'codexConfigSwitcher.restoreOriginal'
    },
    {
      label: uiText('$(info) Show status', '$(info) 查看状态'),
      description: uiText('Inspect providers, models, backups, and credential state', '查看 Provider、模型、备份和密钥状态，不显示密钥内容'),
      command: 'codexConfigSwitcher.showStatus'
    },
    {
      label: uiText('$(key) Clear an API key', '$(key) 清除某个 API Key'),
      description: uiText('Remove a provider credential from SecretStorage', '从 SecretStorage 中删除指定 Provider 的密钥'),
      command: 'codexConfigSwitcher.clearApiKey'
    }
  ], {
    title: `ModelMux · ${selectedLabel}`,
    placeHolder: uiText('Choose an action', '选择操作')
  });

  if (selected) await vscode.commands.executeCommand(selected.command);
}


function kindLabel(kind) {
  if (kind === 'openai') return 'OpenAI 官方';
  if (kind === 'anthropic') return 'Anthropic 官方';
  if (kind === 'gemini') return 'Google Gemini';
  if (kind === 'grok') return 'xAI Grok';
  if (kind === 'bedrock') return 'Amazon Bedrock';
  if (kind === 'ollama') return 'Ollama';
  if (kind === 'lmstudio') return 'LM Studio';
  if (kind === 'customChat') return 'OpenAI Chat 网关';
  if (kind === 'customAnthropic') return 'Anthropic Messages 网关';
  return 'OpenAI Responses 网关';
}

function uniqueModels(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,]+/);
  return raw.map(item => String(item).trim()).filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

function normalizeReasoningPolicy(value, fallback = 'auto') {
  const allowed = new Set(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  return allowed.has(value) ? value : fallback;
}

function validateProviderId(value) {
  const trimmed = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new Error(uiText('Provider ID may contain letters, numbers, underscores, and hyphens, and cannot start with a number.', 'Provider ID 只能包含字母、数字、下划线和连字符，并且不能以数字开头。'));
  }
  if (RESERVED_PROVIDER_IDS.has(trimmed)) {
    throw new Error(uiText(`Provider ID “${trimmed}” is reserved by Codex.`, `Provider ID “${trimmed}”是 Codex 保留名称。`));
  }
  if (UNSAFE_OBJECT_KEYS.has(trimmed.toLowerCase())) {
    throw new Error(uiText(`Provider ID “${trimmed}” is reserved by the configuration runtime.`, `Provider ID “${trimmed}”是配置运行时保留名称。`));
  }
  return trimmed;
}

function normalizeProfileFromGui(input, existing) {
  const allowedKinds = ['customResponses', 'customChat', 'customAnthropic', 'openai', 'anthropic', 'gemini', 'grok', 'bedrock', 'ollama', 'lmstudio'];
  const kind = allowedKinds.includes(input && input.kind) ? input.kind : 'customResponses';
  const profile = existing ? { ...existing } : { id: createId(), models: [] };
  profile.kind = kind;
  profile.name = String(input && input.name || '').trim();
  if (!profile.name) throw new Error(uiText('Profile name is required.', '配置名称不能为空。'));
  if (/[\u0000-\u001F\u007F]/.test(profile.name)) {
    throw new Error(uiText('Profile name must not contain control characters or line breaks.', '配置名称不能包含控制字符或换行。'));
  }
  const models = uniqueModels(input && input.models);
  const selectedModel = String(input && input.selectedModel || '').trim();
  if (!selectedModel) throw new Error(uiText('Model ID is required.', '模型 ID 不能为空。'));
  profile.models = Array.from(new Set([...models, selectedModel]));
  profile.selectedModel = selectedModel;

  if (CUSTOM_KINDS.has(kind)) {
    profile.providerId = validateProviderId(input.providerId || providerIdFromName(profile.name));
    profile.providerName = String(input.providerName || profile.name).trim() || profile.name;
    if (!normalizeBaseUrl(input.baseUrl)) throw new Error(uiText('Base URL is required.', 'Base URL 不能为空。'));
    const validatedBase = validateProviderBaseUrl(input.baseUrl);
    profile.baseUrl = validatedBase.normalized;
    const { url } = validatedBase;
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    profile.allowInsecureHttp = Boolean(input.allowInsecureHttp);
    if (url.protocol === 'http:' && !localHost && !profile.allowInsecureHttp) {
      throw new Error(uiText('Remote HTTP transmits credentials in clear text. Use HTTPS or explicitly allow unsafe remote HTTP.', '远程 HTTP 会明文传输凭据。请改用 HTTPS，或明确勾选“允许远程 HTTP（危险）”。'));
    }
    const rawAuth = input.authMode === 'bearer' ? 'secret' : input.authMode;
    profile.authMode = ['secret', 'env', 'envHeaders', 'none'].includes(rawAuth) ? rawAuth : 'secret';
    if (kind !== 'customResponses' && !['env', 'none'].includes(profile.authMode)) {
      throw new Error(uiText(`${kindLabel(kind)} only supports environment-variable authentication or no authentication.`, `${kindLabel(kind)}仅支持环境变量认证或无认证。`));
    }
    profile.envKey = String(input.envKey || '').trim();
    profile.envKeyInstructions = String(input.envKeyInstructions || '').trim();
    if (profile.authMode === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envKey)) throw new Error(uiText('Invalid environment-variable name.', '环境变量名格式无效。'));
    profile.modelDiscoveryPath = String(input.modelDiscoveryPath || '/models').trim() || '/models';
    profile.allowInsecureModelDiscovery = Boolean(input.allowInsecureModelDiscovery);
    profile.requestMaxRetries = clampInteger(input.requestMaxRetries, 0, 0, 20);
    profile.streamMaxRetries = clampInteger(input.streamMaxRetries, 2, 0, 20);
    profile.streamIdleTimeoutMs = clampInteger(input.streamIdleTimeoutMs, 300000, 1000, 3600000);
    profile.supportsWebsockets = Boolean(input.supportsWebsockets);
    profile.queryParams = parseJsonMap(input.queryParams, uiText('Query parameters', '查询参数'));
    profile.httpHeaders = parseJsonMap(input.httpHeaders, uiText('Static headers', '静态请求头'));
    profile.envHttpHeaders = parseJsonMap(input.envHttpHeaders, uiText('Environment-variable header map', '环境变量请求头映射'));
    assertNoSensitiveStaticValues(profile.queryParams, uiText('Query parameters', '查询参数'));
    assertNoSensitiveStaticValues(profile.httpHeaders, uiText('Static headers', '静态请求头'));
    for (const [header, envName] of Object.entries(profile.envHttpHeaders)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) throw new Error(uiText(`Invalid HTTP header name: ${header}`, `HTTP Header 名称无效：${header}`));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error(uiText(`Invalid environment-variable name for header “${header}”: ${envName}`, `请求头“${header}”对应的环境变量名无效：${envName}`));
    }
    if (profile.authMode === 'envHeaders' && !Object.keys(profile.envHttpHeaders).length) {
      throw new Error(uiText('Environment-variable header authentication requires at least one header mapping.', '环境变量请求头认证至少需要一个请求头到环境变量的映射。'));
    }
    profile.reasoningPolicy = normalizeReasoningPolicy(input.reasoningPolicy, kind === 'customResponses' ? 'auto' : 'none');
    delete profile.awsRegion; delete profile.awsProfile;
  } else if (kind === 'bedrock') {
    profile.awsRegion = String(input.awsRegion || '').trim();
    if (!profile.awsRegion) throw new Error(uiText('AWS Region is required.', 'AWS Region 不能为空。'));
    profile.awsProfile = String(input.awsProfile || '').trim();
    profile.reasoningPolicy = normalizeReasoningPolicy(input.reasoningPolicy, 'none');
    for (const key of ['providerId','providerName','baseUrl','authMode','envKey','envKeyInstructions','allowInsecureModelDiscovery','allowInsecureHttp','modelDiscoveryPath','requestMaxRetries','streamMaxRetries','streamIdleTimeoutMs','supportsWebsockets','queryParams','httpHeaders','envHttpHeaders']) delete profile[key];
  } else {
    profile.reasoningPolicy = normalizeReasoningPolicy(input.reasoningPolicy, kind === 'openai' ? 'auto' : 'none');
    for (const key of ['providerId','providerName','baseUrl','authMode','envKey','envKeyInstructions','allowInsecureModelDiscovery','allowInsecureHttp','modelDiscoveryPath','requestMaxRetries','streamMaxRetries','streamIdleTimeoutMs','supportsWebsockets','queryParams','httpHeaders','envHttpHeaders','awsRegion','awsProfile']) delete profile[key];
  }
  return profile;
}

async function getDashboardState(context) {
  const selectedTargetId = getSelectedTargetId(context);
  const files = pathsForTarget(selectedTargetId);
  const profiles = getProfiles(context);
  const activeTargets = getActiveTargets(context);
  const activeRecord = activeTargets[selectedTargetId];
  const activeId = activeRecord && activeRecord.profileId;
  const management = await getTargetManagementState(context, selectedTargetId, files);
  const managed = management.managed;
  const targetMap = await managedTargetMap(context);
  const items = await Promise.all(profiles.map(async profile => {
    const authMode = profile.authMode === 'bearer' ? 'secret' : profile.authMode;
    const requiresSecret = isCustomProfile(profile) && authMode === 'secret';
    const hasSecret = requiresSecret ? Boolean(await context.secrets.get(profileSecretKey(context, profile.id))) : false;
    const envReady = isCustomProfile(profile) && authMode === 'env'
      ? Boolean(process.env[profile.envKey])
      : isCustomProfile(profile) && authMode === 'envHeaders'
        ? (() => {
            const names = Object.values(normalizeStringMap(profile.envHttpHeaders));
            return names.length > 0 && names.every(name => Boolean(process.env[name]));
          })()
        : undefined;
    const compatibility = targetCompatibility(selectedTargetId, profile);
    const active = management.status === 'managed-clean' && profile.id === activeId;
    const managedForSelectedTarget = Boolean(management.managed && profile.id === activeId);
    const activeTargetId = (targetMap.get(profile.id) || [])[0];
    return {
      ...profile,
      selectedModel: active && activeRecord.model ? activeRecord.model : profile.selectedModel,
      authMode,
      kindLabel: kindLabel(profile.kind),
      description: providerDescription(profile),
      active,
      managedForSelectedTarget,
      activeTargetId,
      requiresSecret,
      hasSecret,
      envReady,
      supported: compatibility.supported,
      unsupportedCode: compatibility.code,
      unsupportedReason: compatibility.reason,
      canEdit: !activeTargetId,
      canDelete: true,
      canClearSecret: !activeTargetId && requiresSecret,
      canApply: compatibility.supported && management.canApply
    };
  }));
  const env = runtimeEnvironmentInfo();
  const originalState = await readOriginalState(files);
  const targets = await Promise.all(TARGET_IDS.map(async id => {
    const targetFiles = pathsForTarget(id);
    const targetActive = activeTargets[id];
    const targetManagement = await getTargetManagementState(context, id, targetFiles);
    return {
      id,
      label: targetLabel(id),
      active: targetManagement.status === 'managed-clean',
      status: targetManagement.status,
      model: targetActive && targetActive.model,
      configExists: targetManagement.configExists
    };
  }));
  return {
    version: context.extension && context.extension.packageJSON && context.extension.packageJSON.version || EXTENSION_VERSION,
    ...env,
    selectedTargetId,
    targetLabel: targetLabel(selectedTargetId),
    targets,
    managed, managementStatus: management.status,
    canRestore: management.canRestore,
    canApply: management.canApply,
    activeId, activeProfile: items.find(item => item.active) || null, profiles: items, paths: files,
    backupExists: management.backupExists, originalState: management.originalState,
    runtimeTokenExists: Boolean(files.token && await fileExists(files.token)), configExists: management.configExists, settings: readGlobalSettings()
  };
}

function nonceValue() {
  return crypto.randomBytes(24).toString('base64url');
}

function getDashboardHtml(webview, extensionUri) {
  const nonce = nonceValue();
  const mediaUri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...parts));
  const replacements = {
    '{{CSP_SOURCE}}': webview.cspSource,
    '{{NONCE}}': nonce,
    '{{STYLE_URI}}': String(mediaUri('dashboard.css')),
    '{{CODICON_STYLE_URI}}': String(mediaUri('codicon.css')),
    '{{SCRIPT_URI}}': String(mediaUri('dashboard.js'))
  };
  let html = fs.readFileSync(path.join(extensionUri.fsPath, 'media', 'dashboard.html'), 'utf8');
  for (const [token, value] of Object.entries(replacements)) html = html.replaceAll(token, String(value));
  return html;
}

class DashboardViewProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context, statusBar) {
    this.context = context;
    this.statusBar = statusBar;
    this.view = undefined;
    this.stateRevision = 0;
    this.ready = false;
    this.pendingAction = undefined;
    this.importPlans = new Map();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message), undefined, this.context.subscriptions);
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh().catch(console.error);
    }, undefined, this.context.subscriptions);
    this.refresh().catch(console.error);
  }

  getHtml(webview) {
    return getDashboardHtml(webview, this.context.extensionUri);
  }

  async refresh() {
    if (!this.view) return;
    const revision = ++this.stateRevision;
    const state = await getDashboardState(this.context);
    if (revision !== this.stateRevision) return;
    await this.view.webview.postMessage({ type: 'state', revision, state });
  }

  async respond(requestId, ok, data, error) {
    if (!this.view || !requestId) return;
    await this.view.webview.postMessage({ type: 'response', requestId, ok, data, error });
  }

  async showAction(action, options = {}) {
    this.pendingAction = { action, ...options };
    await openDashboard();
    if (this.ready && this.view) {
      const payload = this.pendingAction;
      this.pendingAction = undefined;
      await this.view.webview.postMessage({ type: 'action', ...payload });
    }
  }

  async showAddProvider() {
    return this.showAction('addProvider');
  }

  async handleMessage(message) {
    const requestId = message && message.requestId;
    try {
      validateWebviewMessage(message);
      switch (message.command) {
        case 'ready':
          this.ready = true;
          await this.refresh();
          await this.respond(requestId, true, {});
          if (this.pendingAction && this.view) {
            const payload = typeof this.pendingAction === 'string' ? { action: this.pendingAction } : this.pendingAction;
            this.pendingAction = undefined;
            await this.view.webview.postMessage({ type: 'action', ...payload });
          }
          return;
        case 'refreshState':
          await this.refresh();
          await this.respond(requestId, true, {});
          return;
        case 'selectTarget': {
          const targetId = await setSelectedTargetId(this.context, message.targetId);
          await updateStatusBar(this.context, this.statusBar, pathsForTarget(targetId));
          await this.refresh();
          await this.respond(requestId, true, { targetId });
          return;
        }
        case 'setFontSize':
        case 'updateUiSettings': {
          const config = vscode.workspace.getConfiguration('codexConfigSwitcher');
          const target = vscode.ConfigurationTarget && vscode.ConfigurationTarget.Global !== undefined
            ? vscode.ConfigurationTarget.Global : true;
          if (message.fontSize !== undefined) {
            await config.update('uiFontSize', clampInteger(message.fontSize, 13, 10, 20), target);
          }
          if (message.language !== undefined) {
            await config.update('uiLanguage', ['en', 'zh-CN'].includes(message.language) ? message.language : 'en', target);
          }
          if (message.fontFamily !== undefined) {
            await config.update('uiFontFamily', ['default', 'system', 'monospace'].includes(message.fontFamily) ? message.fontFamily : 'default', target);
          }
          if (message.language !== undefined) await updateStatusBar(this.context, this.statusBar);
          await this.refresh();
          await this.respond(requestId, true, { settings: readGlobalSettings() });
          return;
        }
        case 'saveProfile': {
          if (!(await ensureSupportedPlatform())) throw new Error(uiText('ModelMux must run on a supported Windows, Linux, or macOS host.', 'ModelMux 必须运行在受支持的 Windows、Linux 或 macOS 环境。'));
          const input = message.profile || {};
          let profile;
          await withProfileMutation(input.id || 'new', async () => {
            const profiles = getProfiles(this.context);
            const existing = input.id ? profiles.find(item => item.id === input.id) : undefined;
            if (existing) {
              const activeTarget = await activeManagedTargetForProfile(this.context, existing.id);
              if (activeTarget) throw new Error(uiText(
                `This provider is active in ${targetLabel(activeTarget)}. Restore or switch providers before editing it.`,
                `该 Provider 正在被 ${targetLabel(activeTarget)} 使用。请先恢复或切换 Provider，再编辑。`
              ));
            }
            profile = normalizeProfileFromGui(input, existing);
            const apiKey = String(message.apiKey || '').trim();
            const next = existing
              ? profiles.map(item => item.id === profile.id ? profile : item)
              : [...profiles, profile];
            await commitProfileAndSecret(this.context, profiles, next, profile, apiKey);
          });
          // 先返回保存结果，让 Webview 立即关闭编辑窗口。
          // showInformationMessage 返回 Promise；等待它会导致弹窗在用户关闭通知前一直保持打开。
          await this.respond(requestId, true, { profileId: profile.id });
          await this.refresh();
          void vscode.window.showInformationMessage(uiText(`Saved provider “${profile.name}”.`, `已保存 Provider“${profile.name}”。`));
          return;
        }
        case 'fetchModels': {
          const input = message.profile || {};
          const existing = input.id ? getProfiles(this.context).find(item => item.id === input.id) : undefined;
          const temp = {
            ...(existing || {}),
            id: input.id || (existing && existing.id) || createId(),
            kind: CUSTOM_KINDS.has(input.kind) ? input.kind : 'customResponses',
            name: String(input.name || '临时 Provider'),
            providerId: validateProviderId(input.providerId || providerIdFromName(input.name || 'custom_proxy')),
            baseUrl: normalizeBaseUrl(input.baseUrl),
            authMode: input.authMode === 'bearer' ? 'secret' : (input.authMode || 'secret'),
            envKey: String(input.envKey || '').trim(),
            modelDiscoveryPath: String(input.modelDiscoveryPath || '/models').trim(),
            queryParams: parseJsonMap(input.queryParams, '查询参数'),
            httpHeaders: parseJsonMap(input.httpHeaders, '静态请求头'),
            envHttpHeaders: parseJsonMap(input.envHttpHeaders, '环境变量请求头映射'),
            allowInsecureHttp: Boolean(input.allowInsecureHttp),
            allowInsecureModelDiscovery: Boolean(input.allowInsecureModelDiscovery)
          };
          assertNoSensitiveStaticValues(temp.queryParams, uiText('Query parameters', '查询参数'));
          assertNoSensitiveStaticValues(temp.httpHeaders, uiText('Static headers', '静态请求头'));
          if (!temp.baseUrl) throw new Error(uiText('Enter a Base URL first.', '请先填写 Base URL。'));
          let apiKey = String(message.apiKey || '').trim() || undefined;
          if (temp.authMode === 'secret' && !apiKey && existing) apiKey = await this.context.secrets.get(profileSecretKey(this.context, existing.id));
          if (temp.authMode === 'secret' && !apiKey) throw new Error(uiText('Enter an API key or save the provider secret first.', '请先填写 API Key，或先保存该 Provider 的密钥。'));
          const models = await fetchModelsForProfile(this.context, temp, apiKey);
          await this.respond(requestId, true, { models });
          return;
        }
        case 'activateProfile': {
          const targetId = normalizeTargetId(message.targetId || getSelectedTargetId(this.context));
          const result = await activateProfileForTarget(
            this.context,
            targetId,
            message.profileId,
            this.statusBar,
            String(message.model || '').trim() || undefined,
            { showError: false, throwOnError: true, offerReload: false }
          );
          if (!result) {
            await this.respond(requestId, true, { status: 'cancelled' });
            return;
          }
          await this.refresh();
          await this.respond(requestId, true, { status: 'completed' });
          if (targetId === 'codex') void offerReload(uiText(
            `Enabled “${result.profile.name} / ${result.model}”. New sessions will use this configuration.`,
            `已启用“${result.profile.name} / ${result.model}”。${result.backupText}`
          ));
          else void vscode.window.showInformationMessage(uiText(
            `Enabled “${result.profile.name} / ${result.model}” for ${targetLabel(targetId)}. New sessions will use this configuration.`,
            `已为 ${targetLabel(targetId)} 启用“${result.profile.name} / ${result.model}”。新会话将读取该配置。`
          ));
          return;
        }
        case 'refreshModels': {
          const profiles = getProfiles(this.context);
          const profile = profiles.find(item => item.id === message.profileId);
          if (!profile || !isCustomProfile(profile)) throw new Error(uiText('No refreshable custom provider was found.', '未找到可刷新的自定义 Provider。'));
          const profileFingerprint = profileRevisionFingerprint(profile);
          const credentialBefore = await profileCredentialFingerprint(this.context, profile);
          const models = await fetchModelsForProfile(this.context, profile);
          const credentialAfterFetch = await profileCredentialFingerprint(this.context, profile);
          if (credentialBefore.available && credentialBefore.hash !== credentialAfterFetch.hash) {
            throw new Error(uiText('The provider credentials changed while models were loading. Refresh again.', '获取模型期间 Provider 凭据已变化，请重新刷新。'));
          }
          await withProfileMutation(profile.id, async () => {
            const current = getProfiles(this.context);
            const latest = current.find(item => item.id === profile.id);
            if (!latest) throw new Error(uiText('Provider was deleted while models were loading.', '获取模型期间 Provider 已被删除。'));
            if (profileRevisionFingerprint(latest) !== profileFingerprint
              || (await profileCredentialFingerprint(this.context, latest)).hash !== credentialAfterFetch.hash) {
              throw new Error(uiText(
                'The provider or its credentials changed while models were loading. Refresh again.',
                '获取模型期间 Provider 或凭据已变化，请重新刷新。'
              ));
            }
            const updatedProfile = {
              ...latest,
              models: [...models],
              selectedModel: models.includes(latest.selectedModel) ? latest.selectedModel : models[0]
            };
            const files = pathsForCurrentUser();
            const catalogPath = modelCatalogPathForFiles(this.context, updatedProfile, files);
            const catalogSnapshot = catalogPath ? await readRegularFileSnapshot(catalogPath) : undefined;
            let catalog;
            try {
              if (catalogPath) catalog = await writeModelCatalogForProfile(
                this.context, updatedProfile, updatedProfile.selectedModel, files, catalogSnapshot, { path: catalogPath }
              );
              await saveProfiles(this.context, current.map(item => item.id === latest.id ? updatedProfile : item));
            } catch (error) {
              if (catalog && catalogPath && catalogSnapshot) {
                try {
                  await restoreFileSnapshot(catalogPath, catalogSnapshot, { configExists: true, currentHash: contentHash(catalog.content) });
                } catch (rollbackError) {
                  throw new Error(`${error.message || error}；模型目录回滚失败：${rollbackError.message || rollbackError}`, { cause: error });
                }
              }
              throw error;
            }
          });
          await this.refresh();
          await this.respond(requestId, true, { models });
          return;
        }
        case 'deleteProfile': {
          const profile = getProfiles(this.context).find(item => item.id === message.profileId);
          if (!profile) throw new Error(uiText('Provider not found.', '未找到 Provider。'));
          let result;
          await withProfileMutation(profile.id, async () => {
            result = await deleteStoredProfile(this.context, profile, this.statusBar);
          });
          if (!result || result.cancelled) {
            await this.respond(requestId, true, { cancelled: true });
            return;
          }
          await updateStatusBar(this.context, this.statusBar);
          await this.refresh();
          await this.respond(requestId, true, {});
          return;
        }
        case 'clearApiKey': {
          const profile = getProfiles(this.context).find(item => item.id === message.profileId);
          if (!profile) throw new Error(uiText('Provider not found.', '未找到 Provider。'));
          let cancelled = false;
          await withProfileMutation(profile.id, async () => {
            const activeTarget = await activeManagedTargetForProfile(this.context, profile.id);
            if (activeTarget) throw new Error(uiText(
              `This API key is active in ${targetLabel(activeTarget)}. Restore or switch providers before clearing it.`,
              `该 API Key 正在被 ${targetLabel(activeTarget)} 使用。请先恢复该 CLI 的原配置或切换 Provider。`
            ));
            const clearLabel = uiText('Clear', '清除');
            const answer = await vscode.window.showWarningMessage(
              uiText(`Clear the API key for “${profile.name}”?`, `确定清除“${profile.name}”的 API Key 吗？`),
              { modal: true }, clearLabel
            );
            if (answer !== clearLabel) { cancelled = true; return; }
            await this.context.secrets.delete(profileSecretKey(this.context, profile.id));
          });
          if (cancelled) {
            await this.respond(requestId, true, { cancelled: true });
            return;
          }
          await this.refresh();
          await this.respond(requestId, true, {});
          return;
        }
        case 'restoreOriginal': {
          const targetId = normalizeTargetId(message.targetId || getSelectedTargetId(this.context));
          const result = await restoreTarget(this.context, targetId, this.statusBar, { showError: false, throwOnError: true, offerReload: false });
          if (!result) {
            await this.respond(requestId, true, { status: 'cancelled' });
            return;
          }
          await this.refresh();
          await this.respond(requestId, true, { status: 'completed' });
          if (targetId === 'codex') void offerReload(uiText('Restored the original Codex configuration and removed the runtime credential.', '已恢复原来的 Codex 配置，并删除运行时临时密钥。'));
          else void vscode.window.showInformationMessage(uiText(`Restored the original ${targetLabel(targetId)} configuration.`, `已恢复 ${targetLabel(targetId)} 的原始配置。`));
          return;
        }
        case 'previewRestore': {
          const result = await previewRestoreConfig(this.context, message.targetId);
          await this.respond(requestId, true, result);
          return;
        }
        case 'previewProfile': {
          const result = await previewProfileConfig(this.context, message.targetId, message.profileId, message.model);
          await this.respond(requestId, true, result);
          return;
        }
        case 'testProvider': {
          const result = await testProviderConnection(this.context, message.profileId);
          await this.respond(requestId, true, result);
          return;
        }
        case 'runDiagnostics':
        case 'getDiagnostics': {
          const result = await collectTargetDiagnostics(this.context, message.targetId || getSelectedTargetId(this.context));
          if (message.command === 'runDiagnostics') await showDiagnostics(this.context, message.targetId || getSelectedTargetId(this.context));
          await this.respond(requestId, true, { status: 'completed', checks: result.checks, passed: result.passed, warned: result.warned || 0, failed: result.failed, platform: result.platform });
          return;
        }
        case 'showDiagnosticsReport': {
          const result = await showDiagnostics(this.context, message.targetId || getSelectedTargetId(this.context));
          await this.respond(requestId, true, { status: 'completed', passed: result.passed, failed: result.failed });
          return;
        }
        case 'exportProfiles': {
          const result = await exportProfiles(this.context);
          await this.respond(requestId, true, result);
          return;
        }
        case 'importProfiles': {
          const result = await importProfiles(this.context);
          if (result.status === 'completed') await this.refresh();
          await this.respond(requestId, true, result);
          return;
        }
        case 'selectImportFile': {
          const result = await pickImportPlan(this.context);
          if (result.status === 'cancelled') {
            await this.respond(requestId, true, result);
            return;
          }
          const importId = crypto.randomBytes(18).toString('base64url');
          this.importPlans.clear();
          this.importPlans.set(importId, result.plan);
          await this.respond(requestId, true, {
            status: 'completed',
            importId,
            source: result.source,
            added: result.plan.added,
            conflicts: result.plan.conflicts,
            entries: result.plan.entries.map(entry => ({
              status: entry.status,
              id: entry.profile.id,
              name: entry.profile.name,
              kind: entry.profile.kind
            }))
          });
          return;
        }
        case 'commitImport': {
          validateBoundedString(message.importId, 'importId', 128, true);
          if (!['skip', 'replace'].includes(message.strategy)) throw new Error('导入冲突策略无效。');
          const plan = this.importPlans.get(message.importId);
          this.importPlans.delete(message.importId);
          if (!plan) throw new Error(uiText('The import preview expired. Select the file again.', '导入预览已过期，请重新选择文件。'));
          const result = await commitImportPlan(this.context, plan, message.strategy);
          await this.refresh();
          await this.respond(requestId, true, result);
          return;
        }
        case 'openConfig': {
          const file = pathsForTarget(message.targetId || getSelectedTargetId(this.context)).config;
          if (!(await fileExists(file))) throw new Error(uiText(`Configuration file does not exist: ${file}`, `配置文件不存在：${file}`));
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          await vscode.window.showTextDocument(document, { preview: false });
          await this.respond(requestId, true, {});
          return;
        }
        case 'reloadWindow':
          await this.respond(requestId, true, {});
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        case 'openSettings':
          const extensionId = this.context.extension && this.context.extension.id || 'cherry-local.codex-config-switcher';
          await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`);
          await this.respond(requestId, true, {});
          return;
        default:
          throw new Error(uiText(`Unknown operation: ${message.command || ''}`, `未知操作：${message.command || ''}`));
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      await this.respond(requestId, false, undefined, text);
      if (!requestId) await vscode.window.showErrorMessage(text);
    }
  }
}

async function chooseProfileForDashboardAction(context, title, predicate = () => true) {
  const profile = await chooseProfile(context, title, predicate);
  return profile && profile.id;
}

async function routeProfileCommand(context, action, title, predicate) {
  const profileId = await chooseProfileForDashboardAction(context, title, predicate);
  if (!profileId) return;
  await dashboardProvider.showAction(action, { profileId, targetId: getSelectedTargetId(context) });
}

async function openDashboard() {
  await vscode.commands.executeCommand('workbench.view.extension.codexModelManager');
  await vscode.commands.executeCommand('codexConfigSwitcher.dashboard.focus');
}

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  await migrateEnvironmentStorage(context);
  await migrateLegacyProfile(context);
  try {
    await reconcileManagedCodexState(context);
  } catch (error) {
    console.error('Failed to reconcile managed Codex state:', error);
  }

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'codexConfigSwitcher.openDashboard';
  context.subscriptions.push(statusBar);

  dashboardProvider = new DashboardViewProvider(context, statusBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'codexConfigSwitcher.dashboard',
      dashboardProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      const appearanceChanged = ['uiFontSize', 'uiFontFamily', 'uiLanguage']
        .some(key => event.affectsConfiguration(`codexConfigSwitcher.${key}`));
      if (!appearanceChanged) return;
      if (dashboardProvider) dashboardProvider.refresh().catch(console.error);
      updateStatusBar(context, statusBar).catch(console.error);
    }));
  }

  const runAndRefresh = handler => async (...args) => {
    await handler(...args);
    if (dashboardProvider) await dashboardProvider.refresh().catch(console.error);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codexConfigSwitcher.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('codexConfigSwitcher.refreshDashboard', () => dashboardProvider.refresh()),
    vscode.commands.registerCommand('codexConfigSwitcher.openMenu', () => openMenu(context, statusBar)),
    vscode.commands.registerCommand('codexConfigSwitcher.switchProfile', () => dashboardProvider.showAction('switchProfile', { targetId: getSelectedTargetId(context) })),
    vscode.commands.registerCommand('codexConfigSwitcher.enableCustom', () => dashboardProvider.showAction('switchProfile', { targetId: getSelectedTargetId(context) })),
    vscode.commands.registerCommand('codexConfigSwitcher.addProfile', () => dashboardProvider.showAddProvider()),
    vscode.commands.registerCommand('codexConfigSwitcher.editProfile', () => routeProfileCommand(context, 'editProfile', uiText('Choose a provider to edit', '选择要编辑的 Provider'))),
    vscode.commands.registerCommand('codexConfigSwitcher.deleteProfile', () => routeProfileCommand(context, 'deleteProfile', uiText('Choose a provider to delete', '选择要删除的 Provider'))),
    vscode.commands.registerCommand('codexConfigSwitcher.refreshModels', () => routeProfileCommand(context, 'refreshModels', uiText('Choose a provider to synchronize', '选择要同步模型的 Provider'), item => isCustomProfile(item))),
    vscode.commands.registerCommand('codexConfigSwitcher.restoreOriginal', () => dashboardProvider.showAction('restoreOriginal', { targetId: getSelectedTargetId(context) })),
    vscode.commands.registerCommand('codexConfigSwitcher.showStatus', () => dashboardProvider.showAction('showStatus', { targetId: getSelectedTargetId(context) })),
    vscode.commands.registerCommand('codexConfigSwitcher.runDiagnostics', () => showDiagnostics(context, getSelectedTargetId(context))),
    vscode.commands.registerCommand('codexConfigSwitcher.exportProfiles', () => exportProfiles(context)),
    vscode.commands.registerCommand('codexConfigSwitcher.importProfiles', runAndRefresh(() => importProfiles(context))),
    vscode.commands.registerCommand('codexConfigSwitcher.clearApiKey', () => routeProfileCommand(context, 'clearApiKey', uiText('Choose an API key to clear', '选择要清除密钥的 Provider'), item => isCustomProfile(item) && ['secret', 'bearer'].includes(item.authMode)))
  );

  const startupCodexFiles = pathsForCurrentUser();
  const startupStatusFiles = pathsForTarget(getSelectedTargetId(context));
  recreateRuntimeTokenIfNeeded(context, statusBar, startupCodexFiles).then(() => {
    updateStatusBar(context, statusBar, startupStatusFiles).catch(console.error);
    if (dashboardProvider) dashboardProvider.refresh().catch(console.error);
  }).catch(error => {
    console.error('Codex model profile manager startup error:', error);
  });
}

function deactivate() {
  // Reload 期间保留运行时密钥，避免 Codex 认证中断。
  // 恢复原配置、切换到无密钥 Provider 或清除密钥时会主动删除。
}

module.exports = {
  activate,
  deactivate,
  __test: {
    pathsForCurrentUser,
    runtimeTokenPath,
    modelCatalogPathForProfile,
    buildModelCatalog,
    writeModelCatalogForProfile,
    resolveUnixCatCommand,
    authCommandForToken,
    buildManagedConfig,
    writeRuntimeToken,
    removeRuntimeToken,
    writeAtomic,
    collectDiagnostics,
    normalizeProfileFromGui,
    parseJsonMap,
    modelDiscoveryUrl,
    validatedModelDiscoveryUrl,
    runtimeEnvironmentInfo,
    environmentScopeId,
    environmentStateKey,
    profileSecretKey,
    migrateEnvironmentStorage,
    getProfiles,
    saveProfiles,
    readOriginalState,
    ensureOriginalBackup,
    originalContentForTarget,
    pathsForTarget,
    targetCompatibility,
    buildTargetConfig,
    activateExternalTarget,
    restoreExternalTarget,
    getActiveTargets,
    updateActiveTarget,
    contentHash,
    managedCodexConfigProjection,
    managedCodexConfigHash,
    managedCodexConfigMatches,
    mergeManagedCodexConfig,
    buildRestoredCodexConfig,
    parseManagedCodexMetadata,
    reconcileManagedCodexState,
    canRecreateRuntimeTokenFromManagedConfig,
    recreateRuntimeTokenIfNeeded,
    deleteStoredProfile,
    withTargetMutation,
    withProfileMutation,
    readGlobalSettings,
    getTargetManagementState,
    canAutomaticallyRefreshManagedConfig,
    assertManagedContentUnchanged,
    assertTargetCanApply,
    assertTargetSnapshotUnchanged,
    removeFileAtomicallyIfUnchanged,
    activateProfile,
    activateProfileForTargetUnlocked,
    restoreOriginal,
    requestJson,
    commitProfileAndSecret,
    exportableProfile,
    createImportPlan,
    applyImportPlan,
    validateWebviewMessage,
    getDashboardHtml,
    collectTargetDiagnostics,
    verifyWindowsPrivateAcl,
    testProviderConnection,
    previewProfileConfig
  }
};
