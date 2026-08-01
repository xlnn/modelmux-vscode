(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const pending = new Map();
  let state = null;
  let editingProfile = null;
  let searchText = '';
  let targetTransition = false;
  let fontSizeDraft = 13;
  let fontWritePromise = Promise.resolve();
  let fontWritesPending = 0;
  let settingsWriteFailed = false;
  let stateRevision = 0;
  let locale = 'en';

  const I18N = {
    en: {
      requestTimeout: 'The operation timed out. Try again.', brandTagline: 'One workspace for seven AI CLIs',
      settings: 'Settings', addProvider: 'Add provider', selectCli: 'Select CLI', currentTarget: 'Current target',
      cliTarget: 'CLI target', cliStatus: 'CLI configuration status', loadingConfig: 'Reading configuration…',
      configSummary: 'Configuration summary', commonActions: 'Common actions', restoreOriginal: 'Restore original',
      restoreOriginalNote: 'Return to the backed-up state', openConfig: 'Open config', openConfigNote: 'Inspect the current CLI file',
      diagnostics: 'Diagnostics', diagnosticsNote: 'Check platform and credentials', reload: 'Reload window',
      reloadNote: 'Refresh the VS Code extension host', exportProfiles: 'Export profiles', exportProfilesNote: 'Portable JSON without secrets',
      importProfiles: 'Import profiles', importProfilesNote: 'Merge providers from JSON', platformCompatibility: 'Platform compatibility',
      providersAndModels: 'Providers & models', search: 'Search', searchAria: 'Search providers or models', refreshStatus: 'Refresh status',
      appearance: 'Appearance', settingsSubtitle: 'Tune ModelMux for your workspace.', close: 'Close', language: 'Language',
      languageNote: 'Choose the language used in this panel.', typography: 'Typography', typographyNote: 'Use a readable typeface and scale for the sidebar.',
      fontFamily: 'Font family', fontDefault: 'VS Code default', fontSystem: 'System UI', fontMonospace: 'Monospace',
      fontSize: 'Font size', fontDecrease: 'Decrease font size', fontIncrease: 'Increase font size', previewLabel: 'Preview',
      previewText: 'Switch models without losing your original CLI configuration.', useDefaultFont: 'Use VS Code default font',
      resetAppearance: 'Reset appearance', openVsCodeSettings: 'VS Code settings', done: 'Done',
      basicInfo: 'Basics', basicInfoNote: 'Choose a connection type and recognizable name.', providerType: 'Provider type',
      kindCustomResponses: 'OpenAI Responses gateway', kindCustomChat: 'OpenAI Chat Completions gateway', kindCustomAnthropic: 'Anthropic Messages gateway',
      kindOpenAi: 'Official OpenAI', kindAnthropic: 'Official Anthropic', kindGemini: 'Official Google Gemini', kindGrok: 'Official xAI Grok',
      kindOllama: 'Local Ollama', kindLmStudio: 'Local LM Studio', profileName: 'Profile name', profileNamePlaceholder: 'Example: Lab gateway',
      connectionAuth: 'Connection & authentication', connectionAuthNote: 'Use SecretStorage, environment variables, or no authentication.',
      authMode: 'Authentication', authSecret: 'SecretStorage / Windows compatibility', authEnv: 'Bearer environment variable',
      authEnvHeaders: 'Environment-variable headers', authNone: 'No authentication', baseUrlNote: 'Usually ends at /v1; do not include the request path.',
      apiKeyPlaceholder: 'Leave blank to keep the saved secret', toggleApiKey: 'Show or hide API Key', show: 'Show', hide: 'Hide',
      apiKeyNote: 'Stored in VS Code SecretStorage. Codex may create a protected runtime credential while active.', envKey: 'API Key environment variable',
      envKeyNote: 'The target CLI reads this variable from its launch environment.', envHint: 'Environment setup hint (optional)',
      envHintPlaceholder: 'Set MODEL_SWITCH_API_KEY', allowHttp: 'Allow remote HTTP (unsafe)',
      allowHttpNote: 'Remote HTTP sends credentials in clear text. Enable only when the risk is understood.',
      ignoreTls: 'Ignore TLS errors for model discovery (unsafe)', ignoreTlsNote: 'Only affects the plugin model-list request, never CLI inference requests.',
      advancedCompatibility: 'Advanced compatibility', discoveryPath: 'Model discovery path',
      discoveryPathNote: 'A relative path or full same-origin URL. Default: /models.', requestRetries: 'HTTP request retries',
      streamRetries: 'Stream retries', streamTimeout: 'Stream idle timeout (ms)', websocketSupport: 'Provider supports Responses WebSocket transport',
      queryParams: 'Query parameters JSON', staticHeaders: 'Static headers JSON (no secrets)', envHeaders: 'Environment-variable headers JSON',
      envHeadersNote: 'Keys are HTTP headers; values are environment-variable names.', awsCredentials: 'AWS credentials',
      awsCredentialsNote: 'Uses the current system AWS credential chain.', awsProfile: 'AWS Profile (optional)', models: 'Models',
      modelsNote: 'Choose a default model or synchronize from /models.', modelId: 'Model ID', modelIdPlaceholder: 'Enter a model ID accepted by the target CLI',
      availableModels: 'Available models', availableModelsPlaceholder: 'One model ID per line', fetchModels: 'Fetch /models',
      compatibilityPolicy: 'Compatibility policy', compatibilityPolicyNote: 'Controls whether reasoning effort is written.',
      reasoningPolicy: 'Reasoning effort policy', reasoningAuto: 'Auto: high for GPT/Codex, omit elsewhere', reasoningNone: 'Do not write reasoning_effort',
      cancel: 'Cancel', saveProvider: 'Save provider', addProviderTitle: 'Add provider', editProviderTitle: 'Edit provider',
      addProviderSubtitle: 'Create a portable model connection. Secrets are never exported.', editProviderSubtitle: 'Update the connection, models, and authentication for “{name}”.',
      connectionCustom: '{kind} connection. Codex can use SecretStorage; other CLIs use environment-variable references.',
      connectionBedrock: 'Uses the current system AWS credential chain.', connectionOllama: 'Uses the built-in Codex Ollama provider. Ensure Ollama is reachable.',
      connectionLmStudio: 'Uses the built-in Codex LM Studio provider. Start the local server first.', connectionNative: 'Uses existing {kind} credentials or standard environment variables.',
      activeConfiguration: 'Active configuration', configurationStatus: 'Configuration status', noModelSelected: 'No model selected',
      configMismatch: 'Managed config and active record do not match', usingOriginal: 'Using the original {target} configuration',
      mismatchHelp: 'Run diagnostics or apply a provider again.', chooseProviderHelp: 'Choose a compatible provider to configure {target}.',
      originalRecorded: 'Original state recorded', originalNotRecorded: 'Original state not recorded', runtimeReady: 'Runtime credential ready',
      noRuntime: 'No runtime credential', envReference: 'Secrets use environment references', environment: 'Environment',
      compatibleProviders: 'Compatible providers', configFile: 'Config file', exists: 'Exists', missing: 'Missing', management: 'Management',
      managed: 'Managed', original: 'Original', tomlMerge: 'Focused TOML update', yamlMerge: 'Structured YAML merge', structuredMerge: 'Structured config merge',
      local: 'Local', safeRestore: 'Safe to restore', recordOnFirst: 'Recorded on first activation', targetManaged: '{target} · {model}',
      targetOriginal: '{target} · original config', targetManagedAria: '{target}, managed, model {model}', targetOriginalAria: '{target}, original configuration',
      noModels: 'No available models', modelAria: '{name} model', unsupported: 'Not compatible with this CLI',
      unsupportedAuth: 'This CLI supports environment-variable authentication or no authentication for custom providers.',
      unsupportedKind: '{target} does not support {kind} profiles.', claudeEnvRequired: 'Claude Code requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.',
      active: 'Active', missingSecret: 'Missing secret',
      envHeadersReady: 'Environment headers ready', envNotReady: 'Environment unavailable', tlsException: 'TLS exception',
      tlsExceptionTitle: 'Only model discovery skips certificate validation; CLI inference still validates TLS.', regionUnset: 'Region not set',
      builtInProvider: 'Built-in {kind} or existing credentials', modelsAvailable: '{count} available models', reapply: 'Reapply', activate: 'Activate',
      enableFor: 'Enable for {target}', selectModel: 'Select model', edit: 'Edit', switchBeforeEdit: 'Restore or switch providers first',
      editProvider: 'Edit provider', syncModels: 'Sync models', clearSecret: 'Clear secret', clearSecretTitle: 'Clear SecretStorage credential',
      delete: 'Delete', profileCount: '{count}', addFirstProvider: 'Add first provider', noProviders: 'No providers yet',
      noProvidersNote: 'Add an official provider or a compatible Responses, Chat, or Anthropic gateway.', noResults: 'No matching results',
      noResultsNote: 'Search by provider name, model ID, or endpoint.', stateRefreshed: 'Status refreshed.', restored: 'Restored the original {target} configuration.',
      diagnosticsIssues: 'Diagnostics complete: {count} item(s) need attention.', diagnosticsPassed: 'Diagnostics complete: all {count} checks passed.',
      profilesExported: 'Provider profiles exported without API keys.', profilesImported: 'Provider profiles imported. Configure credentials on this device.',
      connecting: 'Connecting…', modelsFetched: 'Fetched {count} models', providerSaved: 'Provider saved.', providerDeleted: 'Provider deleted.',
      modelsSynced: 'Synchronized {count} models.', secretCleared: 'API Key removed from SecretStorage.', activatedToast: 'Applied {model} to {target}.',
      operationFailed: 'Operation failed', defaultRestored: 'Default appearance restored.', defaultFontRestored: 'VS Code default font restored.'
    },
    'zh-CN': {
      requestTimeout: '操作超时，请重试。', brandTagline: '七种 AI CLI，一套 Provider 工作台', settings: '设置', addProvider: '添加 Provider',
      selectCli: '选择 CLI', currentTarget: '当前目标', cliTarget: 'CLI 目标', cliStatus: 'CLI 配置状态', loadingConfig: '正在读取配置…',
      configSummary: '配置摘要', commonActions: '常用操作', restoreOriginal: '恢复原配置', restoreOriginalNote: '回到备份状态', openConfig: '打开配置',
      openConfigNote: '查看当前 CLI 文件', diagnostics: '环境自检', diagnosticsNote: '检查当前平台与凭据', reload: '重新加载', reloadNote: '刷新 VS Code 扩展状态',
      exportProfiles: '导出配置', exportProfilesNote: '跨平台迁移，不含密钥', importProfiles: '导入配置', importProfilesNote: '从 JSON 合并 Provider',
      platformCompatibility: '平台兼容状态', providersAndModels: 'Provider 与模型', search: '搜索', searchAria: '搜索 Provider 或模型', refreshStatus: '刷新状态',
      appearance: '外观', settingsSubtitle: '调整 ModelMux 的语言与阅读体验。', close: '关闭', language: '语言', languageNote: '选择此面板使用的显示语言。',
      typography: '字体', typographyNote: '为侧边栏选择清晰易读的字体和字号。', fontFamily: '字体族', fontDefault: 'VS Code 默认字体', fontSystem: '系统界面字体',
      fontMonospace: '等宽字体', fontSize: '字体大小', fontDecrease: '缩小字体', fontIncrease: '放大字体', previewLabel: '预览',
      previewText: '切换模型，同时保留每个 CLI 的原始配置。', useDefaultFont: '使用 VS Code 默认字体', resetAppearance: '恢复默认外观',
      openVsCodeSettings: 'VS Code 设置', done: '完成', basicInfo: '基本信息', basicInfoNote: '定义连接类型与便于识别的名称。', providerType: 'Provider 类型',
      kindCustomResponses: 'OpenAI Responses 网关', kindCustomChat: 'OpenAI Chat Completions 网关', kindCustomAnthropic: 'Anthropic Messages 网关',
      kindOpenAi: 'OpenAI 官方', kindAnthropic: 'Anthropic 官方', kindGemini: 'Google Gemini 官方', kindGrok: 'xAI Grok 官方',
      kindOllama: 'Ollama 本地', kindLmStudio: 'LM Studio 本地', profileName: '配置名称', profileNamePlaceholder: '例如：实验室网关',
      connectionAuth: '连接与认证', connectionAuthNote: '支持 SecretStorage、环境变量和无认证模式。', authMode: '认证方式',
      authSecret: 'SecretStorage / Windows 兼容认证', authEnv: 'Bearer 环境变量', authEnvHeaders: '环境变量请求头', authNone: '无认证',
      baseUrlNote: '通常填写到 /v1，不要包含具体请求路径。', apiKeyPlaceholder: '留空表示保留已保存的密钥', toggleApiKey: '显示或隐藏 API Key', show: '显示', hide: '隐藏',
      apiKeyNote: '保存在 VS Code SecretStorage；Codex 启用期间可能创建受保护的运行时凭据。', envKey: 'API Key 环境变量名',
      envKeyNote: '目标 CLI 从它的启动环境读取该变量。', envHint: '环境变量配置提示（可选）', envHintPlaceholder: '请设置 MODEL_SWITCH_API_KEY',
      allowHttp: '允许远程 HTTP（危险）', allowHttpNote: '远程 HTTP 会明文传输凭据；仅在明确了解风险时启用。',
      ignoreTls: '获取模型列表时忽略 TLS 错误（危险）', ignoreTlsNote: '只影响插件的模型列表请求，不影响 CLI 推理请求。',
      advancedCompatibility: '高级兼容设置', discoveryPath: '模型发现路径', discoveryPathNote: '可填写相对路径或同源完整 URL；默认 /models。',
      requestRetries: 'HTTP 请求重试', streamRetries: '流中断重试', streamTimeout: '流空闲超时（毫秒）', websocketSupport: 'Provider 支持 Responses WebSocket 传输',
      queryParams: '查询参数 JSON', staticHeaders: '静态请求头 JSON（不要放密钥）', envHeaders: '环境变量请求头映射 JSON',
      envHeadersNote: '键是 HTTP Header，值是环境变量名。', awsCredentials: 'AWS 凭据', awsCredentialsNote: '使用当前系统的 AWS 凭据链。',
      awsProfile: 'AWS Profile（可选）', models: '模型', modelsNote: '选择默认模型，也可从 /models 自动同步。', modelId: '模型 ID',
      modelIdPlaceholder: '输入目标 CLI 接受的模型 ID', availableModels: '可用模型列表', availableModelsPlaceholder: '每行一个模型 ID', fetchModels: '从 /models 获取',
      compatibilityPolicy: '兼容策略', compatibilityPolicyNote: '控制是否写入模型推理强度。', reasoningPolicy: '推理强度兼容策略',
      reasoningAuto: '自动：GPT/Codex 写入 high，其它省略', reasoningNone: '不写入 reasoning_effort', cancel: '取消', saveProvider: '保存 Provider',
      addProviderTitle: '添加 Provider', editProviderTitle: '编辑 Provider', addProviderSubtitle: '创建跨平台模型连接；导出文件不包含密钥。',
      editProviderSubtitle: '修改“{name}”的连接、模型和认证设置。', connectionCustom: '{kind}连接。Codex 可使用 SecretStorage；其它 CLI 使用环境变量引用。',
      connectionBedrock: '使用当前系统的 AWS 凭据链。', connectionOllama: '使用 Codex 内置 Ollama Provider；请确保当前环境可访问 Ollama。',
      connectionLmStudio: '使用 Codex 内置 LM Studio Provider；请先启动本地服务。', connectionNative: '使用 {kind} 的现有凭据或标准环境变量。',
      activeConfiguration: '活动配置', configurationStatus: '配置状态', noModelSelected: '未选择模型', configMismatch: '管理配置与活动记录不一致',
      usingOriginal: '正在使用 {target} 原始配置', mismatchHelp: '建议运行环境自检，或重新启用一个 Provider。', chooseProviderHelp: '选择兼容的 Provider 后即可写入 {target} 配置。',
      originalRecorded: '原始状态已记录', originalNotRecorded: '尚未记录原始状态', runtimeReady: '运行时凭据已创建', noRuntime: '无运行时凭据',
      envReference: '密钥使用环境变量引用', environment: '环境', compatibleProviders: '兼容 Provider', configFile: '配置文件', exists: '存在', missing: '不存在',
      management: '管理状态', managed: '已接管', original: '原配置', tomlMerge: 'TOML 局部写入', yamlMerge: 'YAML 结构合并', structuredMerge: '结构化配置合并',
      local: '本机', safeRestore: '可安全恢复', recordOnFirst: '首次启用时记录原状态', targetManaged: '{target} · {model}', targetOriginal: '{target} · 原配置',
      targetManagedAria: '{target}，已接管，模型 {model}', targetOriginalAria: '{target}，使用原配置', noModels: '没有可用模型', modelAria: '{name} 模型',
      unsupported: '当前 CLI 不兼容', unsupportedAuth: '该 CLI 的自定义 Provider 仅支持环境变量认证或无认证。',
      unsupportedKind: '{target} 不支持 {kind} 配置。', claudeEnvRequired: 'Claude Code 必须使用 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。',
      active: '当前使用', missingSecret: '缺少密钥', envHeadersReady: '环境请求头就绪', envNotReady: '环境变量未就绪',
      tlsException: 'TLS 例外', tlsExceptionTitle: '仅模型发现跳过证书验证；CLI 推理仍会验证 TLS。', regionUnset: '未设置区域',
      builtInProvider: '{kind} 内置或已有凭据', modelsAvailable: '{count} 个可用模型', reapply: '重新应用', activate: '启用', enableFor: '为 {target} 启用',
      selectModel: '选择模型', edit: '编辑', switchBeforeEdit: '请先恢复或切换 Provider', editProvider: '编辑 Provider', syncModels: '同步模型',
      clearSecret: '清除密钥', clearSecretTitle: '清除 SecretStorage 密钥', delete: '删除', profileCount: '{count} 个', addFirstProvider: '添加第一个 Provider',
      noProviders: '还没有 Provider', noProvidersNote: '添加官方 Provider 或兼容 Responses、Chat、Anthropic 的网关。', noResults: '没有匹配结果',
      noResultsNote: '尝试搜索 Provider 名称、模型 ID 或接口地址。', stateRefreshed: '状态已刷新。', restored: '已恢复 {target} 的原始配置。',
      diagnosticsIssues: '自检完成：{count} 项需要检查。', diagnosticsPassed: '自检完成：{count} 项全部通过。', profilesExported: 'Provider 配置已导出，不包含 API Key。',
      profilesImported: 'Provider 配置已导入；请在当前设备配置密钥。', connecting: '正在连接…', modelsFetched: '已获取 {count} 个模型', providerSaved: 'Provider 已保存。',
      providerDeleted: 'Provider 已删除。', modelsSynced: '已同步 {count} 个模型。', secretCleared: 'API Key 已从 SecretStorage 中清除。',
      activatedToast: '已为 {target} 写入 {model}。', operationFailed: '操作失败', defaultRestored: '已恢复默认外观。', defaultFontRestored: '已恢复 VS Code 默认字体。'
    }
  };

  const $ = id => document.getElementById(id);

  function t(key, values = {}) {
    const table = I18N[locale] || I18N.en;
    let text = table[key] || I18N.en[key] || key;
    Object.entries(values).forEach(([name, value]) => { text = text.replaceAll(`{${name}}`, String(value)); });
    return text;
  }

  function applyTranslations() {
    document.documentElement.lang = locale;
    document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach(node => { node.title = t(node.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-aria]').forEach(node => { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  }

  function request(command, payload = {}) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    vscode.postMessage({ command, requestId, ...payload });
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      window.setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error(t('requestTimeout')));
      }, 120000);
    });
  }

  function toast(message, isError = false) {
    const node = $('toast');
    node.textContent = message;
    node.className = isError ? 'visible error' : 'visible';
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => { node.className = ''; }, 3800);
  }

  function create(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'title') node.title = value;
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (key === 'selected') node.selected = Boolean(value);
      else node.setAttribute(key, value);
    });
    const list = Array.isArray(children) ? children : [children];
    list.filter(child => child !== undefined && child !== null && child !== false).forEach(child => node.append(child));
    return node;
  }

  async function busy(button, task) {
    button.disabled = true;
    button.classList.add('busy');
    try { return await task(); }
    finally {
      button.classList.remove('busy');
      button.disabled = false;
    }
  }

  function kindLabel(kind) {
    if (kind === 'openai') return t('kindOpenAi');
    if (kind === 'anthropic') return t('kindAnthropic');
    if (kind === 'gemini') return 'Google Gemini';
    if (kind === 'grok') return 'xAI Grok';
    if (kind === 'bedrock') return 'Amazon Bedrock';
    if (kind === 'ollama') return 'Ollama';
    if (kind === 'lmstudio') return 'LM Studio';
    if (kind === 'customChat') return 'OpenAI Chat';
    if (kind === 'customAnthropic') return 'Anthropic Messages';
    return 'OpenAI Responses';
  }

  function isCustomKind(kind) {
    return ['customResponses', 'customChat', 'customAnthropic'].includes(kind);
  }

  function compatibilityReason(profile) {
    if (profile.unsupportedCode === 'auth') return t('unsupportedAuth');
    if (profile.unsupportedCode === 'kind') return t('unsupportedKind', { target: state.targetLabel, kind: kindLabel(profile.kind) });
    if (profile.unsupportedCode === 'claudeEnv') return t('claudeEnvRequired');
    return profile.unsupportedReason || t('unsupported');
  }

  function providerInitial(profile) {
    if (profile.kind === 'openai') return 'O';
    if (profile.kind === 'anthropic') return 'A';
    if (profile.kind === 'gemini') return 'G';
    if (profile.kind === 'grok') return 'X';
    if (profile.kind === 'bedrock') return 'AWS';
    if (profile.kind === 'ollama') return 'OL';
    if (profile.kind === 'lmstudio') return 'LM';
    const name = String(profile.name || profile.providerId || 'P').trim();
    const latin = name.match(/[A-Za-z0-9]/);
    return latin ? latin[0].toUpperCase() : name.slice(0, 1) || 'P';
  }

  function shortPath(value) {
    const text = String(value || '');
    if (text.length <= 38) return text;
    return '…' + text.slice(-37);
  }

  function renderStatus() {
    const card = $('statusCard');
    card.className = 'status-card';
    card.replaceChildren();
    const active = state.activeProfile;
    const statusKind = active ? 'active' : state.managed ? 'warning' : '';
    const indicator = active ? '✓' : state.managed ? '!' : '◇';
    const title = active
      ? `${active.name} · ${active.selectedModel || t('noModelSelected')}`
      : state.managed ? t('configMismatch') : t('usingOriginal', { target: state.targetLabel });
    const detail = active
      ? kindLabel(active.kind)
      : state.managed ? t('mismatchHelp') : t('chooseProviderHelp', { target: state.targetLabel });
    card.append(create('div', { className: 'status-top' }, [
      create('div', { className: `status-indicator ${statusKind}`, text: indicator }),
      create('div', { className: 'status-copy' }, [
        create('div', { className: 'status-eyebrow', text: active ? t('activeConfiguration') : t('configurationStatus') }),
        create('div', { className: 'status-title', text: title }),
        create('div', { className: 'status-detail', text: detail })
      ])
    ]));
    const originalReady = Boolean(state.originalState) || state.backupExists;
    card.append(create('div', { className: 'status-pills' }, [
      create('span', { className: 'status-pill', text: state.platformLabel || state.platform }),
      create('span', { className: originalReady ? 'status-pill ok' : 'status-pill warn', text: originalReady ? t('originalRecorded') : t('originalNotRecorded') }),
      create('span', {
        className: state.selectedTargetId === 'codex' && state.runtimeTokenExists ? 'status-pill ok' : 'status-pill',
        text: state.selectedTargetId === 'codex'
          ? (state.runtimeTokenExists ? t('runtimeReady') : t('noRuntime'))
          : t('envReference')
      })
    ]));

    const metricGrid = $('metricGrid');
    metricGrid.replaceChildren();
    const metrics = [
      [t('environment'), state.platformLabel || state.platform, ''],
      [t('compatibleProviders'), `${state.profiles.filter(item => item.supported).length}/${state.profiles.length}`, state.profiles.some(item => item.supported) ? 'ok' : ''],
      [t('configFile'), state.configExists ? t('exists') : t('missing'), state.configExists ? 'ok' : ''],
      [t('management'), state.managed ? t('managed') : t('original'), state.managed ? 'ok' : '']
    ];
    metrics.forEach(([label, value, tone]) => {
      metricGrid.append(create('div', { className: 'metric-card', title: label === t('configFile') ? state.paths.config : '' }, [
        create('div', { className: 'metric-label', text: label }),
        create('div', { className: `metric-value ${tone}`, text: value })
      ]));
    });

    const compatibility = $('compatibilityBar');
    const helperLabel = state.selectedTargetId === 'codex'
      ? (state.platform === 'win32' ? 'PowerShell helper' : 'Unix cat helper')
      : state.selectedTargetId === 'grok' ? t('tomlMerge')
        : state.selectedTargetId === 'hermes' ? t('yamlMerge') : t('structuredMerge');
    const hostLabel = state.codespaces ? 'Codespaces' : state.devContainer ? 'Dev Container' : state.wsl ? 'WSL' : state.isRemote ? (state.remoteName || 'Remote') : t('local');
    compatibility.replaceChildren(
      create('div', { className: 'compatibility-head' }, [
        create('span', { className: 'compatibility-title', text: t('platformCompatibility') }),
        create('span', { className: 'compatibility-path', text: shortPath(state.paths.config), title: state.paths.config })
      ]),
      create('div', { className: 'compatibility-chips' }, [
        create('span', { className: 'compatibility-chip ok', text: helperLabel }),
        create('span', { className: 'compatibility-chip ok', text: hostLabel }),
        create('span', { className: 'compatibility-chip', text: state.arch || '' }),
        create('span', { className: state.originalState ? 'compatibility-chip ok' : 'compatibility-chip warn', text: state.originalState ? t('safeRestore') : t('recordOnFirst') })
      ])
    );
    $('versionBadge').textContent = `v${state.version || ''}`;
    $('platformFooter').textContent = `${state.platformLabel || state.platform} · ${shortPath(state.paths.config)}`;
  }

  function renderTargets() {
    $('targetSelect').value = state.selectedTargetId;
    $('targetName').textContent = state.targetLabel;
    const rail = $('targetRail');
    rail.replaceChildren();
    state.targets.forEach(target => {
      const button = create('button', {
        className: `target-chip${target.id === state.selectedTargetId ? ' selected' : ''}${target.active ? ' active' : ''}`,
        text: target.label,
        title: target.active ? t('targetManaged', { target: target.label, model: target.model || t('managed') }) : t('targetOriginal', { target: target.label }),
        'aria-pressed': target.id === state.selectedTargetId ? 'true' : 'false',
        'aria-label': target.active
          ? t('targetManagedAria', { target: target.label, model: target.model || t('managed') })
          : t('targetOriginalAria', { target: target.label }),
        disabled: targetTransition
      });
      button.type = 'button';
      button.addEventListener('click', () => selectTarget(target.id));
      rail.append(button);
    });
  }

  function modelSelect(profile) {
    const select = create('select', { 'aria-label': t('modelAria', { name: profile.name }) });
    const models = Array.isArray(profile.models) ? profile.models.slice() : [];
    if (profile.selectedModel && !models.includes(profile.selectedModel)) models.unshift(profile.selectedModel);
    if (models.length === 0) {
      select.append(create('option', { value: '', text: t('noModels') }));
      select.disabled = true;
    } else {
      models.forEach(model => {
        select.append(create('option', { value: model, text: model, selected: model === profile.selectedModel }));
      });
    }
    return select;
  }

  function providerCard(profile) {
    const card = create('article', { className: `provider-card${profile.active ? ' active' : ''}${profile.supported ? '' : ' unsupported'}` });
    const badges = create('div', { className: 'badges' });
    badges.append(create('span', { className: 'badge', text: kindLabel(profile.kind) }));
    if (!profile.supported) badges.append(create('span', { className: 'badge warn', text: t('unsupported'), title: compatibilityReason(profile) }));
    if (profile.active) badges.append(create('span', { className: 'badge success', text: t('active') }));
    if (profile.requiresSecret) {
      badges.append(create('span', {
        className: profile.hasSecret ? 'badge success' : 'badge warn',
        text: profile.hasSecret ? 'SecretStorage' : t('missingSecret')
      }));
    }
    if (profile.authMode === 'env' || profile.authMode === 'envHeaders') {
      const envNames = profile.authMode === 'env'
        ? profile.envKey || ''
        : Object.values(profile.envHttpHeaders || {}).join(', ');
      badges.append(create('span', {
        className: profile.envReady ? 'badge success' : 'badge warn',
        text: profile.envReady ? (profile.authMode === 'env' ? `env:${profile.envKey}` : t('envHeadersReady')) : t('envNotReady'),
        title: envNames
      }));
    }
    if (profile.allowInsecureModelDiscovery) {
      badges.append(create('span', {
        className: 'badge warn',
        text: t('tlsException'),
        title: t('tlsExceptionTitle')
      }));
    }

    const endpoint = isCustomKind(profile.kind)
      ? profile.baseUrl || ''
      : profile.kind === 'bedrock'
        ? `${profile.awsRegion || t('regionUnset')}${profile.awsProfile ? ` · ${profile.awsProfile}` : ''}`
        : profile.kind === 'ollama'
          ? 'Codex · Ollama'
          : profile.kind === 'lmstudio'
            ? 'Codex · LM Studio'
            : t('builtInProvider', { kind: kindLabel(profile.kind) });

    card.append(create('div', { className: 'card-header' }, [
      create('div', { className: 'provider-identity' }, [
        create('div', { className: 'provider-avatar', text: providerInitial(profile) }),
        create('div', { className: 'provider-copy' }, [
          create('div', { className: 'provider-name', text: profile.name }),
          create('div', { className: 'provider-description', text: t('modelsAvailable', { count: (profile.models || []).length }) }),
          create('div', { className: 'provider-endpoint', text: endpoint, title: endpoint })
        ])
      ]),
      badges
    ]));
    if (!profile.supported) {
      card.append(create('div', { className: 'unsupported-note', text: compatibilityReason(profile) }));
    }

    const select = modelSelect(profile);
    const activate = create('button', {
      className: 'primary',
      text: profile.active ? t('reapply') : t('activate'),
      disabled: select.disabled || !profile.supported,
      title: profile.supported ? t('enableFor', { target: state.targetLabel }) : compatibilityReason(profile)
    });
    activate.addEventListener('click', () => busy(activate, async () => {
      const targetId = state.selectedTargetId;
      const targetName = state.targetLabel;
      try {
        await request('activateProfile', { targetId, profileId: profile.id, model: select.value });
        toast(t('activatedToast', { target: targetName, model: select.value }));
      } catch (error) {
        toast(error.message, true);
      }
    }));
    card.append(create('label', { className: 'model-label', text: t('selectModel') }));
    card.append(create('div', { className: 'model-row' }, [select, activate]));

    const actions = create('div', { className: 'card-actions' });
    const edit = create('button', { className: 'ghost', text: t('edit'), disabled: profile.active, title: profile.active ? t('switchBeforeEdit') : t('editProvider') });
    edit.addEventListener('click', () => openDialog(profile));
    actions.append(edit);

    if (isCustomKind(profile.kind)) {
      const refresh = create('button', { className: 'ghost', text: t('syncModels') });
      refresh.addEventListener('click', () => busy(refresh, async () => {
        try {
          const result = await request('refreshModels', { profileId: profile.id });
          toast(t('modelsSynced', { count: result.models.length }));
        } catch (error) {
          toast(error.message, true);
        }
      }));
      actions.append(refresh);
      if (profile.requiresSecret) {
        const clear = create('button', { className: 'ghost', text: t('clearSecret'), disabled: profile.active, title: profile.active ? t('switchBeforeEdit') : t('clearSecretTitle') });
        clear.addEventListener('click', async () => {
          try {
            const result = await request('clearApiKey', { profileId: profile.id });
            if (!result.cancelled) toast(t('secretCleared'));
          } catch (error) { toast(error.message, true); }
        });
        actions.append(clear);
      }
    }

    actions.append(create('span', { className: 'spacer' }));
    const remove = create('button', { className: 'danger', text: t('delete') });
    remove.addEventListener('click', async () => {
      try {
        const result = await request('deleteProfile', { profileId: profile.id });
        if (!result.cancelled) toast(t('providerDeleted'));
      } catch (error) { toast(error.message, true); }
    });
    actions.append(remove);
    card.append(actions);
    return card;
  }

  function filteredProfiles() {
    const query = searchText.trim().toLowerCase();
    const profiles = state.profiles.slice().sort((a, b) => Number(b.active) - Number(a.active));
    if (!query) return profiles;
    return profiles.filter(profile => [
      profile.name,
      profile.providerId,
      profile.baseUrl,
      profile.envKey,
      profile.selectedModel,
      ...(profile.models || [])
    ].some(value => String(value || '').toLowerCase().includes(query)));
  }

  function renderProviders() {
    const list = $('providerList');
    list.replaceChildren();
    $('profileCount').textContent = t('profileCount', { count: state.profiles.length });
    if (state.profiles.length === 0) {
      const add = create('button', { className: 'primary', text: t('addFirstProvider') });
      add.addEventListener('click', () => openDialog());
      list.append(create('div', { className: 'empty-state' }, [
        create('div', { className: 'empty-icon', text: '＋' }),
        create('strong', { text: t('noProviders') }),
        create('p', { text: t('noProvidersNote') }),
        add
      ]));
      return;
    }

    const profiles = filteredProfiles();
    if (profiles.length === 0) {
      list.append(create('div', { className: 'empty-state' }, [
        create('div', { className: 'empty-icon', text: '⌕' }),
        create('strong', { text: t('noResults') }),
        create('p', { text: t('noResultsNote') })
      ]));
      return;
    }
    profiles.forEach(profile => list.append(providerCard(profile)));
  }

  function render() {
    if (!state) return;
    applyTranslations();
    renderTargets();
    renderStatus();
    renderProviders();
    if ($('profileDialog').open) {
      $('dialogTitle').textContent = editingProfile ? t('editProviderTitle') : t('addProviderTitle');
      $('dialogSubtitle').textContent = editingProfile
        ? t('editProviderSubtitle', { name: editingProfile.name }) : t('addProviderSubtitle');
      $('toggleApiKey').textContent = $('apiKey').type === 'password' ? t('show') : t('hide');
      updateDialogFields();
    }
  }

  function updateSettingsControls() {
    if (!state) return;
    const settings = state.settings || {};
    document.documentElement.dataset.fontSize = String(fontSizeDraft);
    document.documentElement.dataset.fontFamily = settings.uiFontFamily || 'default';
    $('fontSizeRange').value = String(fontSizeDraft);
    $('fontSizeValue').textContent = `${fontSizeDraft} px`;
    $('fontFamilySelect').value = settings.uiFontFamily || 'default';
    document.querySelectorAll('#languageControl [data-language]').forEach(button => {
      const selected = button.dataset.language === locale;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function openSettingsDialog() {
    updateSettingsControls();
    $('settingsDialog').showModal();
    window.setTimeout(() => $('languageControl').querySelector('.selected').focus(), 50);
  }

  function closeSettingsDialog() {
    if ($('settingsDialog').open) $('settingsDialog').close();
  }

  async function updateUiSettings(payload, successKey) {
    if (!state) return;
    if (payload.language) {
      locale = payload.language;
      state.settings.uiLanguage = payload.language;
    }
    if (payload.fontFamily) state.settings.uiFontFamily = payload.fontFamily;
    if (payload.fontSize !== undefined) {
      fontSizeDraft = Math.min(20, Math.max(10, Number(payload.fontSize) || 13));
      state.settings.uiFontSize = fontSizeDraft;
    }
    updateSettingsControls();
    render();
    fontWritesPending += 1;
    try {
      fontWritePromise = fontWritePromise.catch(() => {}).then(() => request('updateUiSettings', payload));
      await fontWritePromise;
      if (successKey) toast(t(successKey));
    } catch (error) {
      settingsWriteFailed = true;
      toast(error.message, true);
    } finally {
      fontWritesPending -= 1;
      if (fontWritesPending === 0 && settingsWriteFailed) {
        settingsWriteFailed = false;
        request('refreshState').catch(() => {});
      }
    }
  }

  async function selectTarget(targetId) {
    if (!state || targetTransition || targetId === state.selectedTargetId) return;
    targetTransition = true;
    $('targetSelect').value = state.selectedTargetId;
    $('targetSelect').disabled = true;
    document.body.classList.add('target-switching');
    document.body.setAttribute('aria-busy', 'true');
    try { await request('selectTarget', { targetId }); }
    catch (error) { toast(error.message, true); }
    finally {
      targetTransition = false;
      $('targetSelect').disabled = false;
      document.body.classList.remove('target-switching');
      document.body.removeAttribute('aria-busy');
      if (state) renderTargets();
    }
  }

  async function changeFontSize(delta, reset = false) {
    const fontSize = reset ? 13 : Math.min(20, Math.max(10, fontSizeDraft + delta));
    if (fontSize === fontSizeDraft) return;
    await updateUiSettings({ fontSize });
  }

  function setValue(id, value) { $(id).value = value == null ? '' : String(value); }

  function updateDialogFields() {
    const kind = $('kind').value;
    const custom = isCustomKind(kind);
    const bedrock = kind === 'bedrock';
    const local = kind === 'ollama' || kind === 'lmstudio';
    $('customFields').classList.toggle('hidden', !custom);
    $('bedrockFields').classList.toggle('hidden', !bedrock);
    $('fetchRow').classList.toggle('hidden', !custom);
    const responseCustom = kind === 'customResponses';
    $('authMode').querySelector('option[value="secret"]').disabled = custom && !responseCustom;
    $('authMode').querySelector('option[value="envHeaders"]').disabled = custom && !responseCustom;
    if (custom && !responseCustom && !['env', 'none'].includes($('authMode').value)) $('authMode').value = 'env';
    const authMode = $('authMode').value;
    $('apiKeyLabel').classList.toggle('hidden', !custom || authMode !== 'secret');
    $('envKeyLabel').classList.toggle('hidden', !custom || authMode !== 'env');
    $('envKeyInstructionsLabel').classList.toggle('hidden', !custom || authMode !== 'env');
    $('connectionHint').textContent = custom
      ? t('connectionCustom', { kind: kindLabel(kind) })
      : bedrock
        ? t('connectionBedrock')
        : kind === 'ollama'
          ? t('connectionOllama')
          : kind === 'lmstudio'
            ? t('connectionLmStudio')
            : t('connectionNative', { kind: kindLabel(kind) });
    if ((bedrock || local) && (!$('reasoningPolicy').value || $('reasoningPolicy').value === 'auto')) $('reasoningPolicy').value = 'none';
  }

  function updateModelSuggestions(models) {
    const datalist = $('modelSuggestions');
    datalist.replaceChildren();
    models.forEach(model => datalist.append(create('option', { value: model })));
  }

  function openDialog(profile) {
    editingProfile = profile || null;
    $('dialogTitle').textContent = profile ? t('editProviderTitle') : t('addProviderTitle');
    $('dialogSubtitle').textContent = profile
      ? t('editProviderSubtitle', { name: profile.name })
      : t('addProviderSubtitle');
    setValue('profileId', profile && profile.id);
    const defaultKinds = {
      codex: 'customResponses', claude: 'customAnthropic', gemini: 'gemini', grok: 'grok',
      opencode: 'customChat', openclaw: 'customChat', hermes: 'customChat'
    };
    const defaultKind = defaultKinds[state && state.selectedTargetId] || 'customResponses';
    setValue('kind', profile && profile.kind || defaultKind);
    $('kind').disabled = Boolean(profile);
    setValue('name', profile && profile.name || kindLabel(defaultKind));
    setValue('providerId', profile && profile.providerId || 'custom_proxy');
    setValue('baseUrl', profile && profile.baseUrl || '');
    setValue('authMode', profile && profile.authMode || (state && state.selectedTargetId === 'codex' ? 'secret' : 'env'));
    setValue('apiKey', '');
    const defaultEnvKey = defaultKind === 'customAnthropic' ? 'ANTHROPIC_API_KEY' : 'MODEL_SWITCH_API_KEY';
    setValue('envKey', profile && profile.envKey || defaultEnvKey);
    setValue('envKeyInstructions', profile && profile.envKeyInstructions || '');
    $('apiKey').type = 'password';
    $('toggleApiKey').textContent = t('show');
    $('allowInsecureHttp').checked = Boolean(profile && profile.allowInsecureHttp);
    $('allowInsecureModelDiscovery').checked = Boolean(profile && profile.allowInsecureModelDiscovery);
    setValue('modelDiscoveryPath', profile && profile.modelDiscoveryPath || '/models');
    setValue('requestMaxRetries', profile && profile.requestMaxRetries != null ? profile.requestMaxRetries : 0);
    setValue('streamMaxRetries', profile && profile.streamMaxRetries != null ? profile.streamMaxRetries : 2);
    setValue('streamIdleTimeoutMs', profile && profile.streamIdleTimeoutMs != null ? profile.streamIdleTimeoutMs : 300000);
    $('supportsWebsockets').checked = Boolean(profile && profile.supportsWebsockets);
    setValue('queryParams', profile && profile.queryParams ? JSON.stringify(profile.queryParams, null, 2) : '');
    setValue('httpHeaders', profile && profile.httpHeaders ? JSON.stringify(profile.httpHeaders, null, 2) : '');
    setValue('envHttpHeaders', profile && profile.envHttpHeaders ? JSON.stringify(profile.envHttpHeaders, null, 2) : '');
    setValue('awsRegion', profile && profile.awsRegion || 'us-east-1');
    setValue('awsProfile', profile && profile.awsProfile || '');
    setValue('selectedModel', profile && profile.selectedModel || '');
    setValue('models', profile && Array.isArray(profile.models) ? profile.models.join('\n') : '');
    setValue('reasoningPolicy', profile && profile.reasoningPolicy || (profile && ['bedrock','ollama','lmstudio'].includes(profile.kind) ? 'none' : 'auto'));
    $('fetchResult').textContent = '';
    updateModelSuggestions(profile && profile.models || []);
    updateDialogFields();
    $('profileDialog').showModal();
    window.setTimeout(() => $('name').focus(), 60);
  }

  function closeDialog() {
    if ($('profileDialog').open) $('profileDialog').close();
    editingProfile = null;
    $('apiKey').value = '';
  }

  function formProfile() {
    const models = $('models').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
    const selectedModel = $('selectedModel').value.trim();
    if (selectedModel && !models.includes(selectedModel)) models.unshift(selectedModel);
    return {
      id: $('profileId').value || undefined,
      kind: $('kind').value,
      name: $('name').value.trim(),
      providerId: $('providerId').value.trim(),
      providerName: $('name').value.trim(),
      baseUrl: $('baseUrl').value.trim(),
      authMode: $('authMode').value,
      envKey: $('envKey').value.trim(),
      envKeyInstructions: $('envKeyInstructions').value.trim(),
      allowInsecureHttp: $('allowInsecureHttp').checked,
      allowInsecureModelDiscovery: $('allowInsecureModelDiscovery').checked,
      modelDiscoveryPath: $('modelDiscoveryPath').value.trim(),
      requestMaxRetries: Number($('requestMaxRetries').value),
      streamMaxRetries: Number($('streamMaxRetries').value),
      streamIdleTimeoutMs: Number($('streamIdleTimeoutMs').value),
      supportsWebsockets: $('supportsWebsockets').checked,
      queryParams: $('queryParams').value.trim(),
      httpHeaders: $('httpHeaders').value.trim(),
      envHttpHeaders: $('envHttpHeaders').value.trim(),
      awsRegion: $('awsRegion').value.trim(),
      awsProfile: $('awsProfile').value.trim(),
      selectedModel,
      models,
      reasoningPolicy: $('reasoningPolicy').value
    };
  }

  $('addProvider').addEventListener('click', () => openDialog());
  $('appearanceSettings').addEventListener('click', openSettingsDialog);
  $('openSettings').addEventListener('click', openSettingsDialog);
  $('closeSettings').addEventListener('click', closeSettingsDialog);
  $('doneSettings').addEventListener('click', closeSettingsDialog);
  $('settingsDialog').addEventListener('cancel', event => { event.preventDefault(); closeSettingsDialog(); });
  document.querySelectorAll('#languageControl [data-language]').forEach(button => {
    button.addEventListener('click', () => updateUiSettings({ language: button.dataset.language }));
  });
  $('fontFamilySelect').addEventListener('change', event => updateUiSettings({ fontFamily: event.target.value }));
  $('fontSizeRange').addEventListener('input', event => {
    fontSizeDraft = Number(event.target.value);
    document.documentElement.dataset.fontSize = String(fontSizeDraft);
    $('fontSizeValue').textContent = `${fontSizeDraft} px`;
  });
  $('fontSizeRange').addEventListener('change', event => updateUiSettings({ fontSize: Number(event.target.value) }));
  $('useDefaultFont').addEventListener('click', () => updateUiSettings({ fontFamily: 'default' }, 'defaultFontRestored'));
  $('resetAppearance').addEventListener('click', () => updateUiSettings({ fontFamily: 'default', fontSize: 13 }, 'defaultRestored'));
  $('openVsCodeSettings').addEventListener('click', () => request('openSettings').catch(error => toast(error.message, true)));
  $('closeDialog').addEventListener('click', closeDialog);
  $('cancelDialog').addEventListener('click', closeDialog);
  $('kind').addEventListener('change', () => {
    const kind = $('kind').value;
    if (kind === 'customAnthropic' && (!$('envKey').value || $('envKey').value === 'MODEL_SWITCH_API_KEY')) $('envKey').value = 'ANTHROPIC_API_KEY';
    if (['customChat', 'customAnthropic'].includes(kind) && $('authMode').value === 'secret') $('authMode').value = 'env';
    if (!editingProfile) $('name').value = kindLabel(kind);
    updateDialogFields();
  });
  $('authMode').addEventListener('change', updateDialogFields);
  $('providerSearch').addEventListener('input', event => {
    searchText = event.target.value;
    renderProviders();
  });
  $('targetSelect').addEventListener('change', event => selectTarget(event.target.value));
  $('fontDecrease').addEventListener('click', () => changeFontSize(-1));
  $('fontIncrease').addEventListener('click', () => changeFontSize(1));
  $('toggleApiKey').addEventListener('click', () => {
    const input = $('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('toggleApiKey').textContent = input.type === 'password' ? t('show') : t('hide');
  });
  $('profileDialog').addEventListener('cancel', event => {
    event.preventDefault();
    closeDialog();
  });

  $('refreshState').addEventListener('click', event => busy(event.currentTarget, async () => {
    try { await request('refreshState'); toast(t('stateRefreshed')); }
    catch (error) { toast(error.message, true); }
  }));
  $('restoreOriginal').addEventListener('click', event => busy(event.currentTarget, async () => {
    const targetId = state.selectedTargetId;
    const targetName = state.targetLabel;
    try { await request('restoreOriginal', { targetId }); toast(t('restored', { target: targetName })); }
    catch (error) { toast(error.message, true); }
  }));
  $('openConfig').addEventListener('click', () => request('openConfig', { targetId: state.selectedTargetId }).catch(error => toast(error.message, true)));
  $('reloadWindow').addEventListener('click', () => request('reloadWindow').catch(error => toast(error.message, true)));
  $('runDiagnostics').addEventListener('click', event => busy(event.currentTarget, async () => {
    try {
      const result = await request('runDiagnostics', { targetId: state.selectedTargetId });
      toast(result.failed ? t('diagnosticsIssues', { count: result.failed }) : t('diagnosticsPassed', { count: result.passed }), Boolean(result.failed));
    } catch (error) { toast(error.message, true); }
  }));

  $('exportProfiles').addEventListener('click', event => busy(event.currentTarget, async () => {
    try { await request('exportProfiles'); toast(t('profilesExported')); }
    catch (error) { toast(error.message, true); }
  }));
  $('importProfiles').addEventListener('click', event => busy(event.currentTarget, async () => {
    try { await request('importProfiles'); toast(t('profilesImported')); }
    catch (error) { toast(error.message, true); }
  }));

  $('fetchModels').addEventListener('click', event => busy(event.currentTarget, async () => {
    $('fetchResult').textContent = t('connecting');
    try {
      const result = await request('fetchModels', { profile: formProfile(), apiKey: $('apiKey').value });
      $('models').value = result.models.join('\n');
      if (!$('selectedModel').value || !result.models.includes($('selectedModel').value)) {
        $('selectedModel').value = result.models[0] || '';
      }
      updateModelSuggestions(result.models);
      $('fetchResult').textContent = t('modelsFetched', { count: result.models.length });
    } catch (error) {
      $('fetchResult').textContent = '';
      toast(error.message, true);
    }
  }));

  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('saveProfile');
    await busy(button, async () => {
      try {
        await request('saveProfile', { profile: formProfile(), apiKey: $('apiKey').value });
        closeDialog();
        toast(t('providerSaved'));
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
      if (Number(message.revision || 0) < stateRevision) return;
      stateRevision = Number(message.revision || 0);
      const pendingSettings = state && state.settings ? { ...state.settings, uiFontSize: fontSizeDraft, uiLanguage: locale } : undefined;
      state = message.state;
      if (fontWritesPending === 0) {
        fontSizeDraft = Number(state.settings && state.settings.uiFontSize) || 13;
        locale = state.settings && state.settings.uiLanguage === 'zh-CN' ? 'zh-CN' : 'en';
      } else if (pendingSettings) state.settings = { ...state.settings, ...pendingSettings };
      document.documentElement.dataset.fontSize = String(fontSizeDraft);
      document.documentElement.dataset.fontFamily = state.settings && state.settings.uiFontFamily || 'default';
      render();
      updateSettingsControls();
      return;
    }
    if (message.type === 'response') {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      if (message.ok) item.resolve(message.data || {});
      else item.reject(new Error(message.error || t('operationFailed')));
      return;
    }
    if (message.type === 'action' && message.action === 'addProvider') openDialog();
  });

  vscode.postMessage({ command: 'ready' });
})();
