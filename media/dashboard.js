(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const pending = new Map();
  const dialogReturnFocus = new WeakMap();
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
  let openMenu = null;
  let importSession = null;

  const I18N = {
    en: {
      requestTimeout: 'The operation timed out. Try again.',
      brandTagline: 'Provider workspace for AI CLIs',
      settings: 'Settings', addProvider: 'Add provider', tools: 'Tools', close: 'Close', done: 'Done', cancel: 'Cancel',
      cliTarget: 'CLI target', loadingConfig: 'Reading configuration...', configurationDetails: 'Configuration details',
      providersAndModels: 'Providers & models', searchAria: 'Search providers or models', refreshStatus: 'Refresh status',
      restoreOriginal: 'Restore original', previewRestore: 'Preview restore', openConfig: 'Open config', diagnostics: 'Diagnostics', reload: 'Reload window',
      exportProfiles: 'Export profiles', importProfiles: 'Import profiles',
      appearance: 'Appearance', settingsSubtitle: 'Tune ModelMux for your workspace.', language: 'Language',
      languageNote: 'Choose the language used in this panel.', typography: 'Typography',
      typographyNote: 'Use a readable typeface and scale for the sidebar.', fontFamily: 'Font family',
      fontDefault: 'VS Code default', fontSystem: 'System UI', fontMonospace: 'Monospace', fontSize: 'Font size',
      fontDecrease: 'Decrease font size', fontIncrease: 'Increase font size', previewLabel: 'Preview',
      previewText: 'Switch models without losing your original CLI configuration.', useDefaultFont: 'Use VS Code default font',
      resetAppearance: 'Reset appearance', openVsCodeSettings: 'VS Code settings',
      basicInfo: 'Basics', basicInfoNote: 'Choose a connection type and recognizable name.', providerType: 'Provider type',
      kindCustomResponses: 'OpenAI Responses gateway', kindCustomChat: 'OpenAI Chat Completions gateway',
      kindCustomAnthropic: 'Anthropic Messages gateway', kindOpenAi: 'Official OpenAI', kindAnthropic: 'Official Anthropic',
      kindGemini: 'Official Google Gemini', kindGrok: 'Official xAI Grok', kindOllama: 'Local Ollama', kindLmStudio: 'Local LM Studio',
      profileName: 'Profile name', profileNamePlaceholder: 'Example: Lab gateway',
      connectionAuth: 'Connection & authentication', connectionAuthNote: 'Use SecretStorage, environment variables, or no authentication.',
      authMode: 'Authentication', authSecret: 'SecretStorage / Windows compatibility', authEnv: 'Bearer environment variable',
      authEnvHeaders: 'Environment-variable headers', authNone: 'No authentication',
      baseUrlNote: 'Usually ends at /v1; do not include the request path.', apiKeyPlaceholder: 'Leave blank to keep the saved secret',
      toggleApiKey: 'Show or hide API Key', apiKeyNote: 'Stored in VS Code SecretStorage. Secrets are never exported.',
      envKey: 'API Key environment variable', envKeyNote: 'The target CLI reads this variable from its launch environment.',
      envHint: 'Environment setup hint (optional)', envHintPlaceholder: 'Set MODEL_SWITCH_API_KEY',
      allowHttp: 'Allow remote HTTP (unsafe)', allowHttpNote: 'Remote HTTP sends credentials in clear text.',
      ignoreTls: 'Ignore TLS errors for model discovery (unsafe)', ignoreTlsNote: 'Only affects the plugin model-list request.',
      advancedCompatibility: 'Advanced compatibility', discoveryPath: 'Model discovery path',
      discoveryPathNote: 'A relative path or full same-origin URL. Default: /models.', requestRetries: 'HTTP request retries',
      streamRetries: 'Stream retries', streamTimeout: 'Stream idle timeout (ms)', websocketSupport: 'Provider supports Responses WebSocket transport',
      queryParams: 'Query parameters JSON', staticHeaders: 'Static headers JSON (no secrets)', envHeaders: 'Environment-variable headers JSON',
      envHeadersNote: 'Keys are HTTP headers; values are environment-variable names.', awsCredentials: 'AWS credentials',
      awsCredentialsNote: 'Uses the current system AWS credential chain.', awsProfile: 'AWS Profile (optional)',
      models: 'Models', modelsNote: 'Choose a default model or synchronize from /models.', modelId: 'Model ID',
      modelIdPlaceholder: 'Enter a model ID accepted by the target CLI', availableModels: 'Available models',
      availableModelsPlaceholder: 'One model ID per line', fetchModels: 'Fetch /models', compatibilityPolicy: 'Compatibility policy',
      compatibilityPolicyNote: 'Controls whether reasoning effort is written.', reasoningPolicy: 'Reasoning effort policy',
      reasoningAuto: 'Auto: high for GPT/Codex, omit elsewhere', reasoningNone: 'Do not write reasoning_effort', saveProvider: 'Save provider',
      addProviderTitle: 'Add provider', editProviderTitle: 'Edit provider',
      addProviderSubtitle: 'Create a portable model connection. Secrets are never exported.',
      editProviderSubtitle: 'Update the connection, models, and authentication for “{name}”.',
      connectionCustom: '{kind} connection. Authentication support depends on the selected CLI.',
      connectionBedrock: 'Uses the current system AWS credential chain.', connectionOllama: 'Uses the built-in Codex Ollama provider.',
      connectionLmStudio: 'Uses the built-in Codex LM Studio provider.', connectionNative: 'Uses existing {kind} credentials or standard environment variables.',
      activeConfiguration: 'Active configuration', configurationStatus: 'Configuration status', noModelSelected: 'No model selected',
      statusManagedClean: 'Configuration is managed and current', statusManagedCleanDetail: '{provider} is applied to {target}.',
      statusManagedDrifted: 'Managed configuration was changed externally', statusManagedDriftedDetail: 'Reapply the provider or inspect diagnostics before restoring.',
      statusManagedOrphaned: 'Managed configuration has no matching provider', statusManagedOrphanedDetail: 'The active record is missing. Run diagnostics before making changes.',
      statusBackupMissing: 'Original backup is missing', statusBackupMissingDetail: 'Restore is unavailable until the original state can be recovered.',
      statusOriginal: 'Using the original {target} configuration', statusOriginalDetail: 'Choose a compatible provider to manage this CLI.',
      configMismatch: 'Managed config and active record do not match', usingOriginal: 'Using the original {target} configuration',
      mismatchHelp: 'Run diagnostics or apply a provider again.', chooseProviderHelp: 'Choose a compatible provider to configure {target}.',
      originalRecorded: 'Original recorded', originalNotRecorded: 'Original not recorded', runtimeReady: 'Runtime credential ready',
      noRuntime: 'No runtime credential', envReference: 'Environment authentication', configExists: 'Config exists', configMissing: 'Config missing',
      targetManaged: '{target} is managed', targetOriginal: '{target} uses its original configuration',
      restoreUnavailable: 'The original configuration cannot be restored in the current state.', applyUnavailable: 'This provider cannot be applied in the current state.',
      editUnavailable: 'This provider cannot be edited while it is in use.', deleteUnavailable: 'This provider cannot be deleted while it is in use.',
      clearSecretUnavailable: 'This credential cannot be cleared while it is in use.', openConfigUnavailable: 'The configuration file does not exist.',
      noModels: 'No available models', modelAria: '{name} model', unsupported: 'Not compatible',
      unsupportedAuth: 'This CLI supports environment-variable authentication or no authentication for custom providers.',
      unsupportedKind: '{target} does not support {kind} profiles.', claudeEnvRequired: 'Claude Code requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.',
      active: 'Active', missingSecret: 'Missing secret', secretReady: 'Secret ready', envReady: 'Environment ready', envNotReady: 'Environment unavailable',
      tlsException: 'TLS exception', regionUnset: 'Region not set', builtInProvider: '{kind} credentials', modelsAvailable: '{count} models',
      reapply: 'Reapply', activate: 'Activate', enableFor: 'Enable for {target}', selectModel: 'Select model', providerActions: 'Actions for {name}',
      edit: 'Edit', switchBeforeEdit: 'Restore or switch providers first', previewConfig: 'Preview configuration', testConnection: 'Test connection',
      syncModels: 'Sync models', clearSecret: 'Clear secret', delete: 'Delete', profileCount: '{count}', addFirstProvider: 'Add first provider',
      noProviders: 'No providers yet', noProvidersNote: 'Add an official provider or a compatible gateway.', noResults: 'No matching results',
      noResultsNote: 'Search by provider name, model ID, or endpoint.', stateRefreshed: 'Status refreshed.',
      restored: 'Restored the original {target} configuration.', connecting: 'Connecting...', modelsFetched: 'Fetched {count} models.',
      providerSaved: 'Provider saved.', providerDeleted: 'Provider deleted.', modelsSynced: 'Synchronized {count} models.',
      secretCleared: 'API key removed from SecretStorage.', activatedToast: 'Applied {model} to {target}.', operationFailed: 'Operation failed',
      defaultRestored: 'Default appearance restored.', defaultFontRestored: 'VS Code default font restored.',
      operationCancelled: 'Operation cancelled.', editCancelled: 'Provider changes discarded.', importCancelled: 'Import cancelled.',
      exportCancelled: 'Export cancelled.', importFinished: 'Import dialog closed.',
      exportFinished: 'Export dialog closed.', fixErrors: 'Fix the following fields', formHasErrors: 'Review {count} highlighted field(s).',
      requiredField: '{field} is required.', invalidProviderId: 'Use letters, numbers, underscores, or hyphens; do not start with a number.',
      invalidUrl: 'Enter a valid HTTP or HTTPS URL.', unsafeHttp: 'Use HTTPS or explicitly allow unsafe remote HTTP.',
      invalidEnvName: 'Enter a valid environment-variable name.', invalidJson: 'Enter a JSON object.', invalidRange: 'Enter a value from {min} to {max}.',
      fieldProfileName: 'Profile name', fieldProviderId: 'Provider ID', fieldBaseUrl: 'Base URL', fieldApiKey: 'API Key',
      fieldEnvKey: 'Environment variable', fieldSelectedModel: 'Model ID', fieldAwsRegion: 'AWS Region',
      fieldQueryParams: 'Query parameters', fieldHttpHeaders: 'Static headers', fieldEnvHttpHeaders: 'Environment-variable headers',
      fieldRequestRetries: 'HTTP request retries', fieldStreamRetries: 'Stream retries', fieldStreamTimeout: 'Stream idle timeout',
      diagnosticsRunning: 'Running diagnostics...', diagnosticsIssues: '{failed} failed, {warned} warning(s), {passed} passed.',
      diagnosticsWarnings: '{warned} warning(s), {passed} passed, no failures.', diagnosticsPassed: 'All {passed} checks passed.', diagnosticsUnavailable: 'Detailed checks are not available from this extension host.',
      runAgain: 'Run again', openReport: 'Open report', reportOpened: 'Diagnostics report opened.',
      importPreview: 'Import preview', importSummary: '{added} new, {conflicts} conflict(s) from {source}.', importNoProfiles: 'No providers are available to import.',
      importCredentialsWarning: 'Credentials are not imported. Re-enter secrets or configure environment variables on this device.',
      conflictStrategy: 'Conflict strategy', skipConflicts: 'Skip conflicting providers', replaceConflicts: 'Replace conflicting providers',
      importComplete: 'Imported {count} provider(s).', previewOpened: 'Configuration diff opened.',
      testSucceeded: 'Connection succeeded{latency}.', testFailed: 'Connection test failed.', latency: ' in {ms} ms',
      clearedCancelled: 'Secret was not cleared.', deleteCancelled: 'Provider was not deleted.',
      showApiKey: 'Show API Key', hideApiKey: 'Hide API Key'
    },
    'zh-CN': {
      requestTimeout: '操作超时，请重试。', brandTagline: '面向 AI CLI 的 Provider 工作台', settings: '设置', addProvider: '添加 Provider', tools: '工具',
      close: '关闭', done: '完成', cancel: '取消', cliTarget: 'CLI 目标', loadingConfig: '正在读取配置...', configurationDetails: '配置详情',
      providersAndModels: 'Provider 与模型', searchAria: '搜索 Provider 或模型', refreshStatus: '刷新状态', restoreOriginal: '恢复原配置',
      openConfig: '打开配置', diagnostics: '环境自检', reload: '重新加载窗口', previewRestore: '预览恢复内容', exportProfiles: '导出配置', importProfiles: '导入配置',
      appearance: '外观', settingsSubtitle: '调整 ModelMux 的语言与阅读体验。', language: '语言', languageNote: '选择此面板使用的显示语言。',
      typography: '字体', typographyNote: '为侧边栏选择清晰易读的字体和字号。', fontFamily: '字体族', fontDefault: 'VS Code 默认字体',
      fontSystem: '系统界面字体', fontMonospace: '等宽字体', fontSize: '字体大小', fontDecrease: '缩小字体', fontIncrease: '放大字体',
      previewLabel: '预览', previewText: '切换模型，同时保留每个 CLI 的原始配置。', useDefaultFont: '使用 VS Code 默认字体',
      resetAppearance: '恢复默认外观', openVsCodeSettings: 'VS Code 设置', basicInfo: '基本信息', basicInfoNote: '定义连接类型与便于识别的名称。',
      providerType: 'Provider 类型', kindCustomResponses: 'OpenAI Responses 网关', kindCustomChat: 'OpenAI Chat Completions 网关',
      kindCustomAnthropic: 'Anthropic Messages 网关', kindOpenAi: 'OpenAI 官方', kindAnthropic: 'Anthropic 官方', kindGemini: 'Google Gemini 官方',
      kindGrok: 'xAI Grok 官方', kindOllama: 'Ollama 本地', kindLmStudio: 'LM Studio 本地', profileName: '配置名称',
      profileNamePlaceholder: '例如：实验室网关', connectionAuth: '连接与认证', connectionAuthNote: '支持 SecretStorage、环境变量和无认证模式。',
      authMode: '认证方式', authSecret: 'SecretStorage / Windows 兼容认证', authEnv: 'Bearer 环境变量', authEnvHeaders: '环境变量请求头',
      authNone: '无认证', baseUrlNote: '通常填写到 /v1，不要包含具体请求路径。', apiKeyPlaceholder: '留空表示保留已保存的密钥',
      toggleApiKey: '显示或隐藏 API Key', apiKeyNote: '保存在 VS Code SecretStorage；密钥不会被导出。', envKey: 'API Key 环境变量名',
      envKeyNote: '目标 CLI 从它的启动环境读取该变量。', envHint: '环境变量配置提示（可选）', envHintPlaceholder: '请设置 MODEL_SWITCH_API_KEY',
      allowHttp: '允许远程 HTTP（危险）', allowHttpNote: '远程 HTTP 会明文传输凭据。', ignoreTls: '获取模型列表时忽略 TLS 错误（危险）',
      ignoreTlsNote: '只影响插件的模型列表请求。', advancedCompatibility: '高级兼容设置', discoveryPath: '模型发现路径',
      discoveryPathNote: '可填写相对路径或同源完整 URL；默认 /models。', requestRetries: 'HTTP 请求重试', streamRetries: '流中断重试',
      streamTimeout: '流空闲超时（毫秒）', websocketSupport: 'Provider 支持 Responses WebSocket 传输', queryParams: '查询参数 JSON',
      staticHeaders: '静态请求头 JSON（不要放密钥）', envHeaders: '环境变量请求头映射 JSON', envHeadersNote: '键是 HTTP Header，值是环境变量名。',
      awsCredentials: 'AWS 凭据', awsCredentialsNote: '使用当前系统的 AWS 凭据链。', awsProfile: 'AWS Profile（可选）', models: '模型',
      modelsNote: '选择默认模型，也可从 /models 自动同步。', modelId: '模型 ID', modelIdPlaceholder: '输入目标 CLI 接受的模型 ID',
      availableModels: '可用模型列表', availableModelsPlaceholder: '每行一个模型 ID', fetchModels: '从 /models 获取', compatibilityPolicy: '兼容策略',
      compatibilityPolicyNote: '控制是否写入模型推理强度。', reasoningPolicy: '推理强度兼容策略', reasoningAuto: '自动：GPT/Codex 写入 high，其它省略',
      reasoningNone: '不写入 reasoning_effort', saveProvider: '保存 Provider', addProviderTitle: '添加 Provider', editProviderTitle: '编辑 Provider',
      addProviderSubtitle: '创建跨平台模型连接；导出文件不包含密钥。', editProviderSubtitle: '修改“{name}”的连接、模型和认证设置。',
      connectionCustom: '{kind}连接；认证支持取决于当前 CLI。', connectionBedrock: '使用当前系统的 AWS 凭据链。',
      connectionOllama: '使用 Codex 内置 Ollama Provider。', connectionLmStudio: '使用 Codex 内置 LM Studio Provider。',
      connectionNative: '使用 {kind} 的已有凭据或标准环境变量。', activeConfiguration: '活动配置', configurationStatus: '配置状态',
      noModelSelected: '未选择模型', statusManagedClean: '托管配置完整且为最新状态', statusManagedCleanDetail: '{provider} 已应用到 {target}。',
      statusManagedDrifted: '托管配置已被外部修改', statusManagedDriftedDetail: '恢复前请重新应用 Provider 或检查环境自检。',
      statusManagedOrphaned: '托管配置缺少对应 Provider', statusManagedOrphanedDetail: '活动记录已丢失；继续修改前请运行环境自检。',
      statusBackupMissing: '原始备份缺失', statusBackupMissingDetail: '恢复原配置暂不可用，请先找回原始状态。',
      statusOriginal: '正在使用 {target} 原始配置', statusOriginalDetail: '选择兼容的 Provider 后即可管理此 CLI。',
      configMismatch: '管理配置与活动记录不一致', usingOriginal: '正在使用 {target} 原始配置',
      mismatchHelp: '建议运行环境自检，或重新启用一个 Provider。', chooseProviderHelp: '选择兼容的 Provider 后即可写入 {target} 配置。',
      originalRecorded: '原状态已记录', originalNotRecorded: '原状态未记录', runtimeReady: '运行时凭据就绪', noRuntime: '无运行时凭据',
      envReference: '环境变量认证', configExists: '配置文件存在', configMissing: '配置文件不存在', targetManaged: '{target} 已由 ModelMux 管理',
      targetOriginal: '{target} 使用原配置', restoreUnavailable: '当前状态下无法恢复原配置。', applyUnavailable: '当前状态下无法应用此 Provider。',
      editUnavailable: '此 Provider 正在使用，无法编辑。', deleteUnavailable: '此 Provider 正在使用，无法删除。',
      clearSecretUnavailable: '此凭据正在使用，无法清除。', openConfigUnavailable: '配置文件不存在。', noModels: '没有可用模型', modelAria: '{name} 模型', unsupported: '当前 CLI 不兼容',
      unsupportedAuth: '该 CLI 的自定义 Provider 仅支持环境变量认证或无认证。', unsupportedKind: '{target} 不支持 {kind} 配置。',
      claudeEnvRequired: 'Claude Code 必须使用 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。', active: '当前使用', missingSecret: '缺少密钥',
      secretReady: '密钥就绪', envReady: '环境变量就绪', envNotReady: '环境变量不可用', tlsException: 'TLS 例外', regionUnset: '未设置区域',
      builtInProvider: '{kind} 凭据', modelsAvailable: '{count} 个模型', reapply: '重新应用', activate: '启用', enableFor: '为 {target} 启用',
      selectModel: '选择模型', providerActions: '{name} 的操作', edit: '编辑', switchBeforeEdit: '请先恢复或切换 Provider', previewConfig: '预览配置',
      testConnection: '测试连接', syncModels: '同步模型', clearSecret: '清除密钥', delete: '删除', profileCount: '{count}', addFirstProvider: '添加第一个 Provider',
      noProviders: '还没有 Provider', noProvidersNote: '添加官方 Provider 或兼容网关。', noResults: '没有匹配结果',
      noResultsNote: '尝试搜索 Provider 名称、模型 ID 或接口地址。', stateRefreshed: '状态已刷新。', restored: '已恢复 {target} 的原始配置。',
      connecting: '正在连接...', modelsFetched: '已获取 {count} 个模型。', providerSaved: 'Provider 已保存。', providerDeleted: 'Provider 已删除。',
      modelsSynced: '已同步 {count} 个模型。', secretCleared: 'API Key 已从 SecretStorage 中清除。', activatedToast: '已为 {target} 写入 {model}。',
      operationFailed: '操作失败', defaultRestored: '已恢复默认外观。', defaultFontRestored: '已恢复 VS Code 默认字体。', operationCancelled: '操作已取消。',
      editCancelled: '已放弃 Provider 修改。', importCancelled: '已取消导入。', exportCancelled: '已取消导出。',
      importFinished: '导入对话框已关闭。', exportFinished: '导出对话框已关闭。', fixErrors: '请修正以下字段',
      formHasErrors: '请检查 {count} 个标记字段。', requiredField: '{field}不能为空。', invalidProviderId: '仅可使用字母、数字、下划线和连字符，且不能以数字开头。',
      invalidUrl: '请输入有效的 HTTP 或 HTTPS 地址。', unsafeHttp: '请使用 HTTPS，或明确允许不安全的远程 HTTP。', invalidEnvName: '请输入有效的环境变量名。',
      invalidJson: '请输入 JSON 对象。', invalidRange: '请输入 {min} 到 {max} 之间的数值。', fieldProfileName: '配置名称', fieldProviderId: 'Provider ID',
      fieldBaseUrl: 'Base URL', fieldApiKey: 'API Key', fieldEnvKey: '环境变量名', fieldSelectedModel: '模型 ID', fieldAwsRegion: 'AWS Region',
      fieldQueryParams: '查询参数', fieldHttpHeaders: '静态请求头', fieldEnvHttpHeaders: '环境变量请求头', fieldRequestRetries: 'HTTP 请求重试',
      fieldStreamRetries: '流中断重试', fieldStreamTimeout: '流空闲超时', diagnosticsRunning: '正在运行环境自检...',
      diagnosticsIssues: '{failed} 项失败，{warned} 项警告，{passed} 项通过。', diagnosticsWarnings: '{warned} 项警告，{passed} 项通过，无失败项。',
      diagnosticsPassed: '{passed} 项检查全部通过。', diagnosticsUnavailable: '当前扩展主机未返回详细检查项。',
      runAgain: '再次运行', openReport: '打开报告', reportOpened: '已打开环境自检报告。', importPreview: '导入预览',
      importSummary: '来自 {source}：新增 {added} 个，冲突 {conflicts} 个。', importNoProfiles: '没有可导入的 Provider。',
      importCredentialsWarning: '密钥不会随文件导入；请在本机重新填写密钥或设置环境变量。', conflictStrategy: '冲突处理策略',
      skipConflicts: '跳过冲突 Provider', replaceConflicts: '替换冲突 Provider', importComplete: '已导入 {count} 个 Provider。', previewOpened: '已打开配置差异对比。',
      testSucceeded: '连接成功{latency}。', testFailed: '连接测试失败。',
      latency: '，耗时 {ms} 毫秒', clearedCancelled: '未清除密钥。', deleteCancelled: '未删除 Provider。', showApiKey: '显示 API Key', hideApiKey: '隐藏 API Key'
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

  function create(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'title') node.title = value;
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (key === 'selected') node.selected = Boolean(value);
      else if (key === 'checked') node.checked = Boolean(value);
      else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    });
    const list = Array.isArray(children) ? children : [children];
    list.filter(child => child !== undefined && child !== null && child !== false).forEach(child => node.append(child));
    return node;
  }

  function icon(name, className = '') {
    return create('span', { className: `codicon codicon-${name}${className ? ` ${className}` : ''}`, 'aria-hidden': 'true' });
  }

  function announce(message) {
    const node = $('announcement');
    node.textContent = '';
    window.setTimeout(() => { node.textContent = message; }, 20);
  }

  function toast(message, tone = '') {
    const node = $('toast');
    node.textContent = message;
    node.className = `visible${tone ? ` ${tone}` : ''}`;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => { node.className = ''; }, 4000);
  }

  function request(command, payload = {}) {
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    vscode.postMessage({ command, requestId, ...payload });
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, command });
      window.setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error(t('requestTimeout')));
      }, 120000);
    });
  }

  async function busy(button, task, region) {
    const wasDisabled = button.disabled;
    button.disabled = true;
    button.classList.add('busy');
    button.setAttribute('aria-busy', 'true');
    if (region) region.setAttribute('aria-busy', 'true');
    try { return await task(); }
    finally {
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
      if (region) region.setAttribute('aria-busy', 'false');
      if (button.isConnected) button.disabled = wasDisabled || button.dataset.capabilityDisabled === 'true';
    }
  }

  function isUnknownOperation(error) {
    return /unknown operation|未知操作/i.test(String(error && error.message || ''));
  }

  function isCancellation(error) {
    return /cancelled|canceled|已取消|取消操作/i.test(String(error && error.message || ''));
  }

  function reportOperationError(error) {
    if (isCancellation(error)) {
      toast(t('operationCancelled'));
      announce(t('operationCancelled'));
      return;
    }
    toast(error && error.message || t('operationFailed'), 'error');
  }

  function rememberDialogFocus(dialog, fallback) {
    const active = document.activeElement;
    dialogReturnFocus.set(dialog, active instanceof HTMLElement ? active : fallback);
  }

  function showDialog(dialog, initialFocus, returnFocus) {
    if (returnFocus) dialogReturnFocus.set(dialog, returnFocus);
    else rememberDialogFocus(dialog, initialFocus);
    closeActiveMenu(false);
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => {
      const target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
      if (target && target.focus) target.focus();
    }, 30);
  }

  function closeDialogElement(dialog, announcement) {
    if (!dialog.open) return;
    const returnFocus = dialogReturnFocus.get(dialog);
    dialog.close();
    if (returnFocus && returnFocus.isConnected) window.setTimeout(() => returnFocus.focus(), 0);
    if (announcement) {
      toast(announcement);
      announce(announcement);
    }
  }

  function menuItems(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
  }

  function showMenu(menu, button) {
    if (openMenu && openMenu.menu !== menu) closeActiveMenu(false);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const row = button.closest('.provider-row');
    if (row) row.classList.add('menu-open');
    openMenu = { menu, button, row };
    const items = menuItems(menu);
    if (items[0]) items[0].focus({ preventScroll: true });
    if (row) menu.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function closeActiveMenu(restoreFocus = true) {
    if (!openMenu) return;
    const { menu, button, row } = openMenu;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (row) row.classList.remove('menu-open');
    openMenu = null;
    if (restoreFocus && button.isConnected) button.focus();
  }

  function toggleMenu(menu, button) {
    if (openMenu && openMenu.menu === menu) closeActiveMenu(true);
    else showMenu(menu, button);
  }

  function handleMenuKeydown(event) {
    if (!openMenu || !openMenu.menu.contains(event.target)) return;
    const items = menuItems(openMenu.menu);
    const current = items.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      closeActiveMenu(event.key === 'Escape');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(current + 1) % items.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1].focus();
    }
  }

  function kindLabel(kind) {
    const keys = {
      openai: 'kindOpenAi', anthropic: 'kindAnthropic', gemini: 'kindGemini', grok: 'kindGrok', ollama: 'kindOllama',
      lmstudio: 'kindLmStudio', customResponses: 'kindCustomResponses', customChat: 'kindCustomChat', customAnthropic: 'kindCustomAnthropic'
    };
    if (kind === 'bedrock') return 'Amazon Bedrock';
    return t(keys[kind] || 'kindCustomResponses');
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
    const initials = { openai: 'O', anthropic: 'A', gemini: 'G', grok: 'X', bedrock: 'AWS', ollama: 'OL', lmstudio: 'LM' };
    if (initials[profile.kind]) return initials[profile.kind];
    const name = String(profile.name || profile.providerId || 'P').trim();
    const latin = name.match(/[A-Za-z0-9]/);
    return latin ? latin[0].toUpperCase() : name.slice(0, 1) || 'P';
  }

  function shortPath(value, length = 54) {
    const text = String(value || '');
    return text.length <= length ? text : `...${text.slice(-(length - 3))}`;
  }

  function endpointLabel(profile) {
    if (isCustomKind(profile.kind)) return profile.baseUrl || '';
    if (profile.kind === 'bedrock') return `${profile.awsRegion || t('regionUnset')}${profile.awsProfile ? ` · ${profile.awsProfile}` : ''}`;
    if (profile.kind === 'ollama') return 'Codex · Ollama';
    if (profile.kind === 'lmstudio') return 'Codex · LM Studio';
    return t('builtInProvider', { kind: kindLabel(profile.kind) });
  }

  function capability(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function currentManagementStatus() {
    const known = ['managed-clean', 'managed-drifted', 'managed-orphaned', 'backup-missing', 'original'];
    if (known.includes(state.managementStatus)) return state.managementStatus;
    if (!state.managed) return 'original';
    return state.activeProfile ? 'managed-clean' : 'managed-orphaned';
  }

  function targetName(targetId) {
    const target = (state.targets || []).find(item => item.id === targetId);
    return target ? target.label : targetId;
  }

  function renderTarget() {
    const select = $('targetSelect');
    const targets = Array.isArray(state.targets) ? state.targets : [];
    if (targets.length) {
      select.replaceChildren();
      targets.forEach(target => select.append(create('option', { value: target.id, text: target.label, selected: target.id === state.selectedTargetId })));
    }
    select.value = state.selectedTargetId;
    const current = targets.find(target => target.id === state.selectedTargetId);
    $('targetContext').textContent = currentManagementStatus() !== 'original' || current && current.active
      ? t('targetManaged', { target: state.targetLabel })
      : t('targetOriginal', { target: state.targetLabel });
  }

  function renderStatus() {
    const banner = $('statusBanner');
    const active = state.activeProfile;
    const managementStatus = currentManagementStatus();
    const presentations = {
      'managed-clean': {
        tone: 'active', icon: 'pass-filled',
        title: active ? `${active.name} · ${active.selectedModel || t('noModelSelected')}` : t('statusManagedClean'),
        detail: t('statusManagedCleanDetail', { provider: active && active.name || t('activeConfiguration'), target: state.targetLabel })
      },
      'managed-drifted': { tone: 'warning', icon: 'warning', title: t('statusManagedDrifted'), detail: t('statusManagedDriftedDetail') },
      'managed-orphaned': { tone: 'error', icon: 'error', title: t('statusManagedOrphaned'), detail: t('statusManagedOrphanedDetail') },
      'backup-missing': { tone: 'error', icon: 'error', title: t('statusBackupMissing'), detail: t('statusBackupMissingDetail') },
      original: { tone: '', icon: 'circle-outline', title: t('statusOriginal', { target: state.targetLabel }), detail: t('statusOriginalDetail') }
    };
    const presentation = presentations[managementStatus];
    banner.className = `status-banner${presentation.tone ? ` ${presentation.tone}` : ''}`;
    banner.dataset.managementStatus = managementStatus;
    $('statusIcon').className = `status-icon codicon codicon-${presentation.icon}`;
    $('statusTitle').textContent = presentation.title;
    $('statusDetail').textContent = presentation.detail;

    const originalReady = Boolean(state.originalState) || Boolean(state.backupExists);
    const runtimeLabel = state.selectedTargetId === 'codex'
      ? (state.runtimeTokenExists ? t('runtimeReady') : t('noRuntime'))
      : t('envReference');
    $('statusMeta').replaceChildren(
      create('li', { text: state.platformLabel || state.platform || '' }),
      create('li', { className: originalReady ? 'ok' : 'warn', text: originalReady ? t('originalRecorded') : t('originalNotRecorded') }),
      create('li', { className: state.configExists ? 'ok' : '', text: state.configExists ? t('configExists') : t('configMissing') }),
      create('li', { className: state.runtimeTokenExists ? 'ok' : '', text: runtimeLabel }),
      create('li', { text: shortPath(state.paths && state.paths.config) , title: state.paths && state.paths.config || '' })
    );
    const canRestore = capability(state.canRestore, managementStatus !== 'original' && originalReady);
    $('previewRestore').disabled = !canRestore;
    $('previewRestore').dataset.capabilityDisabled = canRestore ? 'false' : 'true';
    $('previewRestore').title = canRestore ? '' : t('restoreUnavailable');
    $('restoreOriginal').disabled = !canRestore;
    $('restoreOriginal').dataset.capabilityDisabled = canRestore ? 'false' : 'true';
    $('restoreOriginal').title = canRestore ? '' : t('restoreUnavailable');
    $('openConfig').disabled = !state.configExists;
    $('openConfig').dataset.capabilityDisabled = state.configExists ? 'false' : 'true';
    $('openConfig').title = state.configExists ? '' : t('openConfigUnavailable');
    $('versionBadge').textContent = state.version ? `v${state.version}` : '';
    $('platformFooter').textContent = `${state.platformLabel || state.platform || ''} · ${shortPath(state.paths && state.paths.config)}`;
  }

  function modelSelect(profile) {
    const select = create('select', { 'aria-label': t('modelAria', { name: profile.name }) });
    const models = Array.isArray(profile.models) ? profile.models.slice() : [];
    if (profile.selectedModel && !models.includes(profile.selectedModel)) models.unshift(profile.selectedModel);
    if (!models.length) {
      select.append(create('option', { value: '', text: t('noModels') }));
      select.disabled = true;
    } else {
      models.forEach(model => select.append(create('option', { value: model, text: model, selected: model === profile.selectedModel })));
    }
    return select;
  }

  function makeMenuItem(labelKey, iconName, handler, options = {}) {
    const button = create('button', { type: 'button', role: 'menuitem', disabled: options.disabled, title: options.title || '' }, [icon(iconName), create('span', { text: t(labelKey) })]);
    if (options.danger) button.classList.add('danger-menu-item');
    button.addEventListener('click', event => {
      const returnFocus = openMenu && openMenu.button;
      closeActiveMenu(true);
      handler(event.currentTarget, returnFocus);
    });
    return button;
  }

  async function activate(profile, select, button) {
    const canApply = capability(state.canApply, true) && capability(profile.canApply, Boolean(profile.supported));
    if (!canApply) {
      announce(t('applyUnavailable'));
      return;
    }
    const targetId = state.selectedTargetId;
    const targetName = state.targetLabel;
    try {
      await busy(button, () => request('activateProfile', { targetId, profileId: profile.id, model: select.value }), $('providerList'));
      toast(t('activatedToast', { target: targetName, model: select.value }));
    } catch (error) { reportOperationError(error); }
  }

  async function syncProvider(profile, button) {
    if (!capability(profile.canEdit, !profile.active)) {
      announce(t('editUnavailable'));
      return;
    }
    try {
      const result = await busy(button, () => request('refreshModels', { profileId: profile.id }), $('providerList'));
      toast(t('modelsSynced', { count: Array.isArray(result.models) ? result.models.length : 0 }));
    } catch (error) { reportOperationError(error); }
  }

  async function clearProviderSecret(profile, button) {
    if (!capability(profile.canClearSecret, !profile.active)) {
      announce(t('clearSecretUnavailable'));
      return;
    }
    try {
      const result = await busy(button, () => request('clearApiKey', { profileId: profile.id }), $('providerList'));
      if (result.cancelled || result.status === 'cancelled') {
        toast(t('clearedCancelled'));
        announce(t('clearedCancelled'));
      } else toast(t('secretCleared'));
    } catch (error) { reportOperationError(error); }
  }

  async function deleteProvider(profile, button) {
    if (!capability(profile.canDelete, !profile.active)) {
      announce(t('deleteUnavailable'));
      return;
    }
    try {
      const result = await busy(button, () => request('deleteProfile', { profileId: profile.id }), $('providerList'));
      if (result.cancelled || result.status === 'cancelled') {
        toast(t('deleteCancelled'));
        announce(t('deleteCancelled'));
      } else toast(t('providerDeleted'));
    } catch (error) { reportOperationError(error); }
  }

  async function testProvider(profile, model, button) {
    const canApply = capability(state.canApply, true) && capability(profile.canApply, Boolean(profile.supported));
    if (!canApply) {
      announce(t('applyUnavailable'));
      return;
    }
    try {
      const result = await busy(button, () => request('testProvider', {
        profileId: profile.id,
        targetId: state.selectedTargetId,
        model: model || profile.selectedModel || ''
      }), $('providerList'));
      if (result.status === 'cancelled') {
        toast(t('operationCancelled'));
        announce(t('operationCancelled'));
        return;
      }
      const latency = result.latencyMs === undefined ? '' : t('latency', { ms: result.latencyMs });
      const message = result.message || (result.ok === false ? t('testFailed') : t('testSucceeded', { latency }));
      toast(message, result.ok === false ? 'error' : '');
    } catch (error) { reportOperationError(error); }
  }

  async function previewProvider(profile, model, button) {
    const canApply = capability(state.canApply, true) && capability(profile.canApply, Boolean(profile.supported));
    if (!canApply) {
      announce(t('applyUnavailable'));
      return;
    }
    try {
      const result = await busy(button, () => request('previewProfile', {
        profileId: profile.id,
        targetId: state.selectedTargetId,
        model: model || profile.selectedModel || ''
      }), $('providerList'));
      if (result.status === 'cancelled') {
        toast(t('operationCancelled'));
        announce(t('operationCancelled'));
      } else toast(t('previewOpened'));
    } catch (error) { reportOperationError(error); }
  }

  function providerRow(profile) {
    const row = create('article', {
      className: `provider-row${profile.active ? ' active' : ''}${profile.supported ? '' : ' unsupported'}`,
      role: 'listitem', 'data-profile-id': profile.id
    });
    const select = modelSelect(profile);
    const canEdit = capability(profile.canEdit, !profile.active);
    const canDelete = capability(profile.canDelete, !profile.active);
    const canClearSecret = capability(profile.canClearSecret, !profile.active);
    const canApply = capability(state.canApply, true) && capability(profile.canApply, Boolean(profile.supported));
    const summary = [
      kindLabel(profile.kind), endpointLabel(profile),
      profile.activeTargetId && profile.activeTargetId !== state.selectedTargetId ? targetName(profile.activeTargetId) : '',
      t('modelsAvailable', { count: (profile.models || []).length })
    ].filter(Boolean).join(' · ');
    const badges = create('span', { className: 'provider-badges' });
    if (profile.active) badges.append(create('span', { className: 'provider-badge active', text: t('active') }));
    if (!profile.supported) badges.append(create('span', { className: 'provider-badge warning', text: t('unsupported') }));
    if (profile.requiresSecret) badges.append(create('span', {
      className: `provider-badge ${profile.hasSecret ? '' : 'warning'}`,
      text: profile.hasSecret ? t('secretReady') : t('missingSecret')
    }));
    if (profile.authMode === 'env' || profile.authMode === 'envHeaders') badges.append(create('span', {
      className: `provider-badge ${profile.envReady ? '' : 'warning'}`,
      text: profile.envReady ? t('envReady') : t('envNotReady')
    }));
    if (profile.allowInsecureModelDiscovery) badges.append(create('span', { className: 'provider-badge warning', text: t('tlsException') }));

    const menuId = `provider-menu-${String(profile.id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const menuButton = create('button', {
      className: 'icon-button', type: 'button', title: t('providerActions', { name: profile.name }),
      'aria-label': t('providerActions', { name: profile.name }), 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId
    }, icon('ellipsis'));
    const menu = create('div', { id: menuId, className: 'menu', role: 'menu', 'aria-label': t('providerActions', { name: profile.name }), hidden: '' });
    menu.hidden = true;
    menu.append(
      makeMenuItem('edit', 'edit', (_button, returnFocus) => openProfileDialog(profile, returnFocus), { disabled: !canEdit, title: canEdit ? '' : t('editUnavailable') }),
      makeMenuItem('previewConfig', 'preview', button => previewProvider(profile, select.value, button), { disabled: !canApply, title: canApply ? '' : t('applyUnavailable') }),
      makeMenuItem('testConnection', 'debug-start', button => testProvider(profile, select.value, button), { disabled: !canApply, title: canApply ? '' : t('applyUnavailable') })
    );
    if (isCustomKind(profile.kind)) menu.append(makeMenuItem('syncModels', 'sync', button => syncProvider(profile, button), { disabled: !canEdit, title: canEdit ? '' : t('editUnavailable') }));
    if (profile.requiresSecret) menu.append(makeMenuItem('clearSecret', 'key', button => clearProviderSecret(profile, button), { disabled: !canClearSecret, title: canClearSecret ? '' : t('clearSecretUnavailable') }));
    menu.append(create('div', { className: 'menu-separator', role: 'separator' }));
    menu.append(makeMenuItem('delete', 'trash', button => deleteProvider(profile, button), { danger: true, disabled: !canDelete, title: canDelete ? '' : t('deleteUnavailable') }));
    menuButton.addEventListener('click', () => toggleMenu(menu, menuButton));

    row.append(create('div', { className: 'provider-main' }, [
      create('span', { className: 'provider-avatar', text: providerInitial(profile), 'aria-hidden': 'true' }),
      create('div', { className: 'provider-content' }, [
        create('div', { className: 'provider-heading' }, [create('span', { className: 'provider-name', text: profile.name }), badges]),
        create('div', { className: 'provider-summary', text: summary, title: summary }),
        !profile.supported ? create('div', { className: 'unsupported-note', text: compatibilityReason(profile) }) : null
      ]),
      menuButton
    ]));

    const activateButton = create('button', {
      className: 'primary', type: 'button', text: profile.active ? t('reapply') : t('activate'),
      disabled: select.disabled || !profile.supported || !canApply,
      title: !profile.supported ? compatibilityReason(profile) : canApply ? t('enableFor', { target: state.targetLabel }) : t('applyUnavailable')
    });
    activateButton.addEventListener('click', () => activate(profile, select, activateButton));
    row.append(create('div', { className: 'provider-controls' }, [select, activateButton]), menu);
    return row;
  }

  function filteredProfiles() {
    const query = searchText.trim().toLowerCase();
    const profiles = (state.profiles || []).slice().sort((a, b) => Number(b.active) - Number(a.active));
    if (!query) return profiles;
    return profiles.filter(profile => [profile.name, profile.providerId, profile.baseUrl, profile.envKey, profile.selectedModel, ...(profile.models || [])]
      .some(value => String(value || '').toLowerCase().includes(query)));
  }

  function renderProviders() {
    closeActiveMenu(false);
    const list = $('providerList');
    list.replaceChildren();
    list.setAttribute('aria-busy', 'false');
    $('profileCount').textContent = t('profileCount', { count: (state.profiles || []).length });
    if (!state.profiles || !state.profiles.length) {
      const add = create('button', { className: 'primary', type: 'button', text: t('addFirstProvider') });
      add.addEventListener('click', () => openProfileDialog());
      list.append(create('div', { className: 'empty-state' }, [icon('server-process'), create('strong', { text: t('noProviders') }), create('p', { text: t('noProvidersNote') }), add]));
      return;
    }
    const profiles = filteredProfiles();
    if (!profiles.length) {
      list.append(create('div', { className: 'empty-state' }, [icon('search-stop'), create('strong', { text: t('noResults') }), create('p', { text: t('noResultsNote') })]));
      return;
    }
    profiles.forEach(profile => list.append(providerRow(profile)));
  }

  function render() {
    if (!state) return;
    applyTranslations();
    renderTarget();
    renderStatus();
    renderProviders();
    $('app').setAttribute('aria-busy', 'false');
    if ($('profileDialog').open) {
      $('dialogTitle').textContent = editingProfile ? t('editProviderTitle') : t('addProviderTitle');
      $('dialogSubtitle').textContent = editingProfile
        ? t('editProviderSubtitle', { name: editingProfile.name }) : t('addProviderSubtitle');
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

  function openSettingsDialog(returnFocus) {
    updateSettingsControls();
    showDialog($('settingsDialog'), () => $('languageControl').querySelector('.selected'), returnFocus);
  }

  function closeSettingsDialog() {
    closeDialogElement($('settingsDialog'));
  }

  async function updateUiSettings(payload, successKey) {
    if (!state) return;
    state.settings = state.settings || {};
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
      reportOperationError(error);
    } finally {
      fontWritesPending -= 1;
      if (!fontWritesPending && settingsWriteFailed) {
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
    $('app').setAttribute('aria-busy', 'true');
    try { await request('selectTarget', { targetId }); }
    catch (error) { reportOperationError(error); }
    finally {
      targetTransition = false;
      $('targetSelect').disabled = false;
      document.body.classList.remove('target-switching');
      $('app').setAttribute('aria-busy', 'false');
      if (state) renderTarget();
    }
  }

  function setValue(id, value) {
    $(id).value = value == null ? '' : String(value);
  }

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
      : bedrock ? t('connectionBedrock')
        : kind === 'ollama' ? t('connectionOllama')
          : kind === 'lmstudio' ? t('connectionLmStudio') : t('connectionNative', { kind: kindLabel(kind) });
    if ((bedrock || local) && (!$('reasoningPolicy').value || $('reasoningPolicy').value === 'auto')) $('reasoningPolicy').value = 'none';
  }

  function updateModelSuggestions(models) {
    $('modelSuggestions').replaceChildren(...models.map(model => create('option', { value: model })));
  }

  function clearFormErrors() {
    $('profileErrorSummary').classList.add('hidden');
    $('profileErrorList').replaceChildren();
    document.querySelectorAll('[data-field-error]').forEach(node => { node.textContent = ''; });
    $('profileForm').querySelectorAll('[aria-invalid="true"]').forEach(node => node.removeAttribute('aria-invalid'));
  }

  function openProfileDialog(profile, returnFocus) {
    editingProfile = profile || null;
    clearFormErrors();
    $('dialogTitle').textContent = profile ? t('editProviderTitle') : t('addProviderTitle');
    $('dialogSubtitle').textContent = profile ? t('editProviderSubtitle', { name: profile.name }) : t('addProviderSubtitle');
    setValue('profileId', profile && profile.id);
    const defaultKinds = { codex: 'customResponses', claude: 'customAnthropic', gemini: 'gemini', grok: 'grok', opencode: 'customChat', openclaw: 'customChat', hermes: 'customChat' };
    const defaultKind = defaultKinds[state && state.selectedTargetId] || 'customResponses';
    setValue('kind', profile && profile.kind || defaultKind);
    $('kind').disabled = Boolean(profile);
    setValue('name', profile && profile.name || kindLabel(defaultKind));
    setValue('providerId', profile && profile.providerId || 'custom_proxy');
    setValue('baseUrl', profile && profile.baseUrl || '');
    setValue('authMode', profile && profile.authMode || (state && state.selectedTargetId === 'codex' ? 'secret' : 'env'));
    setValue('apiKey', '');
    const kind = profile && profile.kind || defaultKind;
    setValue('envKey', profile && profile.envKey || (kind === 'customAnthropic' ? 'ANTHROPIC_API_KEY' : 'MODEL_SWITCH_API_KEY'));
    setValue('envKeyInstructions', profile && profile.envKeyInstructions || '');
    $('apiKey').type = 'password';
    updateApiKeyButton();
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
    setValue('reasoningPolicy', profile && profile.reasoningPolicy || (profile && ['bedrock', 'ollama', 'lmstudio'].includes(profile.kind) ? 'none' : 'auto'));
    $('fetchResult').textContent = '';
    updateModelSuggestions(profile && profile.models || []);
    updateDialogFields();
    showDialog($('profileDialog'), $('name'), returnFocus);
  }

  function closeProfileDialog(options = {}) {
    const announcement = options.cancelled ? t('editCancelled') : '';
    closeDialogElement($('profileDialog'), announcement);
    editingProfile = null;
    $('apiKey').value = '';
    clearFormErrors();
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

  const FIELD_LABEL_KEYS = {
    name: 'fieldProfileName', providerId: 'fieldProviderId', baseUrl: 'fieldBaseUrl', apiKey: 'fieldApiKey', envKey: 'fieldEnvKey',
    selectedModel: 'fieldSelectedModel', awsRegion: 'fieldAwsRegion', queryParams: 'fieldQueryParams', httpHeaders: 'fieldHttpHeaders',
    envHttpHeaders: 'fieldEnvHttpHeaders', requestMaxRetries: 'fieldRequestRetries', streamMaxRetries: 'fieldStreamRetries',
    streamIdleTimeoutMs: 'fieldStreamTimeout'
  };

  function fieldLabel(field) {
    return t(FIELD_LABEL_KEYS[field] || field);
  }

  function validateJsonObject(id, errors) {
    const value = $(id).value.trim();
    if (!value) return;
    try {
      const parsed = JSON.parse(value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') errors[id] = t('invalidJson');
    } catch { errors[id] = t('invalidJson'); }
  }

  function validateRange(id, min, max, errors) {
    const value = Number($(id).value);
    if (!Number.isFinite(value) || value < min || value > max) errors[id] = t('invalidRange', { min, max });
  }

  function validateProfileForm() {
    const errors = {};
    if (!$('name').value.trim()) errors.name = t('requiredField', { field: fieldLabel('name') });
    if (!$('selectedModel').value.trim()) errors.selectedModel = t('requiredField', { field: fieldLabel('selectedModel') });
    const kind = $('kind').value;
    if (isCustomKind(kind)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test($('providerId').value.trim())) errors.providerId = t('invalidProviderId');
      const baseUrl = $('baseUrl').value.trim();
      try {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) errors.baseUrl = t('invalidUrl');
        const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
        if (url.protocol === 'http:' && !local && !$('allowInsecureHttp').checked) errors.baseUrl = t('unsafeHttp');
      } catch { errors.baseUrl = t('invalidUrl'); }
      if ($('authMode').value === 'secret' && !editingProfile?.hasSecret && !$('apiKey').value.trim()) {
        errors.apiKey = t('requiredField', { field: fieldLabel('apiKey') });
      }
      if ($('authMode').value === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test($('envKey').value.trim())) errors.envKey = t('invalidEnvName');
      validateRange('requestMaxRetries', 0, 20, errors);
      validateRange('streamMaxRetries', 0, 20, errors);
      validateRange('streamIdleTimeoutMs', 1000, 3600000, errors);
      validateJsonObject('queryParams', errors);
      validateJsonObject('httpHeaders', errors);
      validateJsonObject('envHttpHeaders', errors);
      if ($('authMode').value === 'envHeaders' && !$('envHttpHeaders').value.trim()) errors.envHttpHeaders = t('requiredField', { field: fieldLabel('envHttpHeaders') });
    }
    if (kind === 'bedrock' && !$('awsRegion').value.trim()) errors.awsRegion = t('requiredField', { field: fieldLabel('awsRegion') });
    return errors;
  }

  function normalizeFieldErrors(input) {
    if (!input) return {};
    if (Array.isArray(input)) return Object.fromEntries(input.map(item => [item.field || item.path, item.message || item.error]).filter(([field, message]) => field && message));
    if (typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([field, value]) => [field, typeof value === 'string' ? value : value && (value.message || value.error)]).filter(([, message]) => message));
    return {};
  }

  function showFormErrors(fieldErrors, generalMessage) {
    clearFormErrors();
    const errors = normalizeFieldErrors(fieldErrors);
    const entries = Object.entries(errors);
    if (!entries.length && generalMessage) entries.push(['', generalMessage]);
    const list = $('profileErrorList');
    entries.forEach(([field, message]) => {
      const input = field && $(field);
      const errorNode = field && document.querySelector(`[data-field-error="${CSS.escape(field)}"]`);
      if (input) input.setAttribute('aria-invalid', 'true');
      if (errorNode) errorNode.textContent = message;
      const item = create('li');
      if (input) {
        const button = create('button', { type: 'button', text: `${fieldLabel(field)}: ${message}` });
        button.addEventListener('click', () => input.focus());
        item.append(button);
      } else item.textContent = message;
      list.append(item);
    });
    $('profileErrorSummary').classList.remove('hidden');
    $('profileErrorSummary').focus();
    announce(t('formHasErrors', { count: entries.length }));
  }

  function updateApiKeyButton() {
    const visible = $('apiKey').type === 'text';
    const button = $('toggleApiKey');
    button.title = visible ? t('hideApiKey') : t('showApiKey');
    button.setAttribute('aria-label', button.title);
    const glyph = button.querySelector('.codicon');
    glyph.className = `codicon codicon-${visible ? 'eye-closed' : 'eye'}`;
  }

  async function fetchModels(button) {
    const errors = validateProfileForm();
    delete errors.selectedModel;
    if (Object.keys(errors).length) {
      showFormErrors(errors);
      return;
    }
    $('fetchResult').textContent = t('connecting');
    try {
      const result = await busy(button, () => request('fetchModels', { profile: formProfile(), apiKey: $('apiKey').value }), $('profileForm'));
      const models = Array.isArray(result.models) ? result.models : [];
      $('models').value = models.join('\n');
      if (!$('selectedModel').value || !models.includes($('selectedModel').value)) $('selectedModel').value = models[0] || '';
      updateModelSuggestions(models);
      $('fetchResult').textContent = t('modelsFetched', { count: models.length });
      announce($('fetchResult').textContent);
    } catch (error) {
      $('fetchResult').textContent = '';
      if (error.fieldErrors) showFormErrors(error.fieldErrors, error.message);
      else reportOperationError(error);
    }
  }

  async function saveProfile(button) {
    const errors = validateProfileForm();
    if (Object.keys(errors).length) {
      showFormErrors(errors);
      return;
    }
    clearFormErrors();
    try {
      await busy(button, () => request('saveProfile', { profile: formProfile(), apiKey: $('apiKey').value }), $('profileForm'));
      closeProfileDialog();
      toast(t('providerSaved'));
    } catch (error) {
      showFormErrors(error.fieldErrors, error.message);
    }
  }

  function renderDiagnostics(result) {
    const checks = Array.isArray(result.checks) ? result.checks : [];
    const passed = Number(result.passed ?? checks.filter(item => item.ok).length);
    const warned = Number(result.warned ?? checks.filter(item => !item.ok && item.severity === 'warning').length);
    const failed = Number(result.failed ?? checks.filter(item => !item.ok && item.severity !== 'warning').length);
    $('diagnosticsSummary').textContent = failed
      ? t('diagnosticsIssues', { failed, warned, passed })
      : warned ? t('diagnosticsWarnings', { warned, passed }) : t('diagnosticsPassed', { passed });
    const body = $('diagnosticsBody');
    body.replaceChildren();
    if (!checks.length) body.append(create('div', { className: 'notice', text: t('diagnosticsUnavailable') }));
    checks.forEach(check => {
      const tone = check.ok ? 'passed' : check.severity === 'warning' ? 'warning' : 'failed';
      const iconName = check.ok ? 'pass-filled' : check.severity === 'warning' ? 'warning' : 'error';
      body.append(create('div', { className: `diagnostic-row ${tone}` }, [
        icon(iconName),
        create('div', {}, [create('strong', { text: check.name || '' }), create('p', { text: check.detail || '' })])
      ]));
    });
  }

  async function loadDiagnostics(button) {
    $('diagnosticsSummary').textContent = t('diagnosticsRunning');
    $('diagnosticsBody').replaceChildren();
    try {
      let result;
      try {
        result = await busy(button, () => request('getDiagnostics', { targetId: state.selectedTargetId }), $('diagnosticsBody'));
      } catch (error) {
        if (!isUnknownOperation(error)) throw error;
        result = await busy(button, () => request('runDiagnostics', { targetId: state.selectedTargetId }), $('diagnosticsBody'));
      }
      renderDiagnostics(result || {});
    } catch (error) {
      $('diagnosticsSummary').textContent = '';
      reportOperationError(error);
      closeDialogElement($('diagnosticsDialog'));
    }
  }

  function openDiagnosticsDialog(button, returnFocus) {
    showDialog($('diagnosticsDialog'), $('closeDiagnostics'), returnFocus);
    loadDiagnostics(button || $('refreshDiagnostics'));
  }

  async function openDiagnosticsReport(button) {
    try {
      await busy(button, async () => {
        try { await request('showDiagnosticsReport', { targetId: state.selectedTargetId }); }
        catch (error) {
          if (!isUnknownOperation(error)) throw error;
          await request('runDiagnostics', { targetId: state.selectedTargetId });
        }
      });
      toast(t('reportOpened'));
    } catch (error) { reportOperationError(error); }
  }

  function showImportPreview(result) {
    importSession = result;
    const entries = Array.isArray(result.entries) ? result.entries : [];
    const added = Number(result.added || entries.filter(entry => entry.status === 'added').length || 0);
    const conflicts = Number(result.conflicts || entries.filter(entry => entry.status === 'conflict').length || 0);
    const source = result.source || 'JSON';
    $('importPreviewSummary').textContent = entries.length
      ? t('importSummary', { added, conflicts, source }) : t('importNoProfiles');
    $('importWarning').textContent = t('importCredentialsWarning');
    $('importWarning').classList.remove('hidden');
    $('importStrategy').value = 'skip';
    $('importStrategy').disabled = conflicts === 0;
    const list = $('importPreviewList');
    list.replaceChildren();
    entries.forEach(entry => {
      list.append(create('li', {}, [
        icon(entry.status === 'conflict' ? 'warning' : 'server'),
        create('span', {}, [
          create('strong', { text: entry.name || entry.id || '' }),
          create('small', { text: [kindLabel(entry.kind), entry.status].filter(Boolean).join(' · ') })
        ])
      ]));
    });
    $('commitImport').disabled = !entries.length;
    showDialog($('importPreviewDialog'), $('importStrategy'));
  }

  async function startImport(button) {
    try {
      let result;
      try {
        result = await busy(button, () => request('selectImportFile'), $('app'));
      } catch (error) {
        if (!isUnknownOperation(error)) throw error;
        result = await busy(button, () => request('importProfiles'), $('app'));
        if (result.cancelled || result.status === 'cancelled') {
          toast(t('importCancelled'));
          announce(t('importCancelled'));
        } else toast(t('importFinished'));
        return;
      }
      if (result.status === 'cancelled') {
        toast(t('importCancelled'));
        announce(t('importCancelled'));
      } else showImportPreview(result);
    } catch (error) { reportOperationError(error); }
  }

  async function commitImport(button) {
    if (!importSession) return;
    const strategy = $('importStrategy').value === 'replace' ? 'replace' : 'skip';
    try {
      const result = await busy(button, () => request('commitImport', { importId: importSession.importId, strategy }), $('importPreviewDialog'));
      if (result.status === 'cancelled') {
        closeDialogElement($('importPreviewDialog'), t('importCancelled'));
      } else {
        closeDialogElement($('importPreviewDialog'));
        toast(t('importComplete', { count: result.importedCount == null ? importSession.added || 0 : result.importedCount }));
      }
      importSession = null;
    } catch (error) { reportOperationError(error); }
  }

  async function exportProfiles(button) {
    try {
      const result = await busy(button, () => request('exportProfiles'), $('app'));
      if (result.cancelled || result.status === 'cancelled') {
        toast(t('exportCancelled'));
        announce(t('exportCancelled'));
      } else toast(t('exportFinished'));
    } catch (error) { reportOperationError(error); }
  }

  function findProfile(profileId) {
    return state && (state.profiles || []).find(profile => profile.id === profileId);
  }

  function profileForAction(message) {
    return message.profileId ? findProfile(message.profileId) : null;
  }

  function focusProvider(profileId) {
    searchText = '';
    $('providerSearch').value = '';
    renderProviders();
    window.setTimeout(() => {
      const rows = Array.from($('providerList').querySelectorAll('.provider-row'));
      const requested = profileId && rows.find(row => row.dataset.profileId === profileId);
      const compatible = requested || rows.find(row => {
        const profile = findProfile(row.dataset.profileId);
        return profile && profile.supported && capability(profile.canApply, true);
      });
      const target = compatible && compatible.querySelector('.provider-controls select:not(:disabled)') || $('providerList');
      if (!target.hasAttribute('tabindex') && target === $('providerList')) target.setAttribute('tabindex', '-1');
      target.focus();
    }, 20);
  }

  function focusRestoreAction() {
    const button = $('restoreOriginal');
    showMenu($('toolsMenu'), $('toolsMenuButton'));
    if (button.disabled) {
      closeActiveMenu(true);
      announce(button.title || t('restoreUnavailable'));
      return;
    }
    button.focus();
  }

  async function handleAction(message) {
    if (message.targetId && state && message.targetId !== state.selectedTargetId) await selectTarget(message.targetId);
    const profile = profileForAction(message);
    if (message.action === 'addProvider') openProfileDialog();
    else if (message.action === 'switchProfile') focusProvider(message.profileId);
    else if (message.action === 'editProfile' && profile && capability(profile.canEdit, !profile.active)) openProfileDialog(profile);
    else if (message.action === 'editProfile' && profile) announce(t('editUnavailable'));
    else if (message.action === 'deleteProfile' && profile) deleteProvider(profile, $('refreshState'));
    else if (message.action === 'refreshModels' && profile) syncProvider(profile, $('refreshState'));
    else if (message.action === 'clearApiKey' && profile) clearProviderSecret(profile, $('refreshState'));
    else if (message.action === 'restoreOriginal') focusRestoreAction();
    else if (message.action === 'showStatus') $('statusBanner').focus();
    else if (message.action === 'previewProfile' && profile) previewProvider(profile, profile.selectedModel, $('refreshState'));
    else if (message.action === 'testProvider' && profile) testProvider(profile, profile.selectedModel, $('refreshState'));
    else if (message.action === 'diagnostics' || message.action === 'getDiagnostics') openDiagnosticsDialog($('refreshDiagnostics'));
    else if (message.action === 'importProfiles') startImport($('importProfiles'));
    else if (message.action === 'importPreview' && message.data) showImportPreview(message.data);
    else if (message.action === 'refreshState') request('refreshState').catch(reportOperationError);
  }

  $('toolsMenuButton').addEventListener('click', () => toggleMenu($('toolsMenu'), $('toolsMenuButton')));
  $('addProvider').addEventListener('click', () => openProfileDialog());
  $('appearanceSettings').addEventListener('click', () => {
    const returnFocus = openMenu && openMenu.button;
    openSettingsDialog(returnFocus);
  });
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
  $('fontDecrease').addEventListener('click', () => updateUiSettings({ fontSize: Math.max(10, fontSizeDraft - 1) }));
  $('fontIncrease').addEventListener('click', () => updateUiSettings({ fontSize: Math.min(20, fontSizeDraft + 1) }));
  $('useDefaultFont').addEventListener('click', () => updateUiSettings({ fontFamily: 'default' }, 'defaultFontRestored'));
  $('resetAppearance').addEventListener('click', () => updateUiSettings({ fontFamily: 'default', fontSize: 13 }, 'defaultRestored'));
  $('openVsCodeSettings').addEventListener('click', () => request('openSettings').catch(reportOperationError));

  $('closeDialog').addEventListener('click', () => closeProfileDialog({ cancelled: true }));
  $('cancelDialog').addEventListener('click', () => closeProfileDialog({ cancelled: true }));
  $('profileDialog').addEventListener('cancel', event => { event.preventDefault(); closeProfileDialog({ cancelled: true }); });
  $('kind').addEventListener('change', () => {
    const kind = $('kind').value;
    if (kind === 'customAnthropic' && (!$('envKey').value || $('envKey').value === 'MODEL_SWITCH_API_KEY')) $('envKey').value = 'ANTHROPIC_API_KEY';
    if (['customChat', 'customAnthropic'].includes(kind) && $('authMode').value === 'secret') $('authMode').value = 'env';
    if (!editingProfile) $('name').value = kindLabel(kind);
    updateDialogFields();
  });
  $('authMode').addEventListener('change', updateDialogFields);
  $('toggleApiKey').addEventListener('click', () => {
    $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password';
    updateApiKeyButton();
  });
  $('profileForm').addEventListener('input', event => {
    const field = event.target && event.target.id;
    if (!field) return;
    event.target.removeAttribute('aria-invalid');
    const errorNode = document.querySelector(`[data-field-error="${CSS.escape(field)}"]`);
    if (errorNode) errorNode.textContent = '';
  });
  $('profileForm').addEventListener('submit', event => {
    event.preventDefault();
    saveProfile($('saveProfile'));
  });
  $('fetchModels').addEventListener('click', event => fetchModels(event.currentTarget));

  $('providerSearch').addEventListener('input', event => { searchText = event.target.value; renderProviders(); });
  $('targetSelect').addEventListener('change', event => selectTarget(event.target.value));
  $('refreshState').addEventListener('click', event => busy(event.currentTarget, async () => {
    try { await request('refreshState'); toast(t('stateRefreshed')); }
    catch (error) { reportOperationError(error); }
  }, $('app')));
  $('restoreOriginal').addEventListener('click', event => {
    closeActiveMenu(true);
    const targetId = state.selectedTargetId;
    const targetName = state.targetLabel;
    busy(event.currentTarget, async () => {
      try { await request('restoreOriginal', { targetId }); toast(t('restored', { target: targetName })); }
      catch (error) { reportOperationError(error); }
    }, $('app'));
  });
  $('previewRestore').addEventListener('click', event => {
    closeActiveMenu(true);
    busy(event.currentTarget, async () => {
      try {
        const result = await request('previewRestore', { targetId: state.selectedTargetId });
        if (result.status === 'cancelled') {
          toast(t('operationCancelled'));
          announce(t('operationCancelled'));
        } else toast(t('previewOpened'));
      } catch (error) { reportOperationError(error); }
    }, $('app'));
  });
  $('openConfig').addEventListener('click', () => { closeActiveMenu(true); request('openConfig', { targetId: state.selectedTargetId }).catch(reportOperationError); });
  $('reloadWindow').addEventListener('click', () => { closeActiveMenu(true); request('reloadWindow').catch(reportOperationError); });
  $('runDiagnostics').addEventListener('click', event => {
    const returnFocus = openMenu && openMenu.button;
    closeActiveMenu(false);
    openDiagnosticsDialog(event.currentTarget, returnFocus);
  });
  $('exportProfiles').addEventListener('click', event => { closeActiveMenu(true); exportProfiles(event.currentTarget); });
  $('importProfiles').addEventListener('click', event => { closeActiveMenu(true); startImport(event.currentTarget); });

  $('closeDiagnostics').addEventListener('click', () => closeDialogElement($('diagnosticsDialog')));
  $('doneDiagnostics').addEventListener('click', () => closeDialogElement($('diagnosticsDialog')));
  $('diagnosticsDialog').addEventListener('cancel', event => { event.preventDefault(); closeDialogElement($('diagnosticsDialog')); });
  $('refreshDiagnostics').addEventListener('click', event => loadDiagnostics(event.currentTarget));
  $('showDiagnosticsReport').addEventListener('click', event => openDiagnosticsReport(event.currentTarget));

  const cancelImport = () => {
    importSession = null;
    closeDialogElement($('importPreviewDialog'), t('importCancelled'));
  };
  $('closeImportPreview').addEventListener('click', cancelImport);
  $('cancelImport').addEventListener('click', cancelImport);
  $('importPreviewDialog').addEventListener('cancel', event => { event.preventDefault(); cancelImport(); });
  $('commitImport').addEventListener('click', event => commitImport(event.currentTarget));

  document.addEventListener('keydown', handleMenuKeydown);
  document.addEventListener('pointerdown', event => {
    if (!openMenu) return;
    if (openMenu.menu.contains(event.target) || openMenu.button.contains(event.target)) return;
    closeActiveMenu(false);
  });
  window.addEventListener('resize', () => closeActiveMenu(false));
  window.addEventListener('blur', () => closeActiveMenu(false));

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'state') {
      if (Number(message.revision || 0) < stateRevision) return;
      stateRevision = Number(message.revision || 0);
      const pendingSettings = state && state.settings ? { ...state.settings, uiFontSize: fontSizeDraft, uiLanguage: locale } : undefined;
      state = message.state;
      state.settings = state.settings || {};
      if (!fontWritesPending) {
        fontSizeDraft = Number(state.settings.uiFontSize) || 13;
        locale = state.settings.uiLanguage === 'zh-CN' ? 'zh-CN' : 'en';
      } else if (pendingSettings) state.settings = { ...state.settings, ...pendingSettings };
      document.documentElement.dataset.fontSize = String(fontSizeDraft);
      document.documentElement.dataset.fontFamily = state.settings.uiFontFamily || 'default';
      render();
      updateSettingsControls();
      return;
    }
    if (message.type === 'response') {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      if (message.ok) item.resolve(message.data || {});
      else {
        const error = new Error(message.error || message.data && message.data.message || t('operationFailed'));
        error.code = message.code || message.data && message.data.code;
        error.fieldErrors = normalizeFieldErrors(message.fieldErrors || message.errors || message.data && (message.data.fieldErrors || message.data.errors));
        error.data = message.data;
        item.reject(error);
      }
      return;
    }
    if (message.type === 'action') handleAction(message).catch(reportOperationError);
  });

  applyTranslations();
  vscode.postMessage({ command: 'ready' });
})();
