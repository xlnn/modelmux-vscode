# ModelMux: AI CLI Model Manager 1.5.6

[中文说明](#中文说明)

ModelMux is a visual VS Code extension for managing AI CLI providers, models, credentials, and original configuration files across **Windows, macOS, Linux, WSL, Remote-SSH, Dev Containers, and GitHub Codespaces**.

It independently manages Codex, Claude Code, Gemini CLI, Grok Build, OpenCode, OpenClaw, and Hermes. Each CLI has its own active profile, backup, integrity check, and restore state.

## Highlights

- Manage seven AI CLIs from one focused dashboard.
- Switch official providers and compatible custom gateways without manually editing configuration files.
- Keep independent model selections active for different CLIs at the same time.
- Back up the original configuration before first activation and restore it safely later.
- Detect external changes before overwriting a managed configuration.
- Store Codex and Anthropic Messages gateway credentials in VS Code SecretStorage, or use environment-variable references for Anthropic gateways.
- Import and export portable provider profiles without API keys.
- Use English or Simplified Chinese. English is the default language.
- Choose the VS Code default font, system UI font, or monospace font.
- Adjust the dashboard font size from `10px` to `20px` in the ModelMux Settings panel.
- Restore the VS Code default font or reset the complete appearance configuration with one action.

## What's New in 1.5.6

- Anthropic Messages gateways now support both a direct API key stored in VS Code SecretStorage and an environment-variable reference.
- Direct keys are copied into the selected CLI's protected managed configuration only while that provider is active; restoring the original configuration removes or replaces the managed key.
- Provider exports, diagnostics, and configuration previews never include the direct API key.

## What's New in 1.5.5

- Filter model choices by the selected response format: OpenAI Responses and Chat providers show OpenAI-compatible models, while Anthropic Messages providers show Claude-compatible models.
- Apply the same filtering to provider rows, searchable model suggestions, editing, and `/models` refresh results.

## What's New in 1.5.4

- Publish the provider-editor and Codex reasoning updates in a correctly versioned `1.5.4` package.
- Clarify that the release commit must be pushed before its matching GitHub tag is created and published.

## What's New in 1.5.3

- Replace the clipped provider-editor model datalist with a searchable, keyboard-accessible list that expands inside the dialog and remains scrollable.
- Show all model IDs returned by `/models` without separating OpenAI and Claude model families.
- Expose the complete `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` reasoning-effort picker for non-GPT models used through Codex custom Responses providers.

## What's New in 1.5.2

- Accept model and reasoning-effort changes written by Codex's own pickers without reporting external configuration drift.
- Keep integrity protection for the active provider, endpoint, authentication, model catalog, approval policy, and sandbox mode.
- Migrate ModelMux 1.5.1 integrity records automatically and show Codex's current model in the dashboard.

## What's New in 1.5.1

- Preserve Codex's native display name and complete reasoning-effort choices when a custom Responses gateway exposes a model already known to Codex.
- Fall back to canonical GPT names and an adjustable multi-level reasoning picker before matching Codex metadata is cached locally.

## What's New in 1.5.0

- Persist refreshed upstream model IDs in the active Codex provider definition so the VS Code Codex model picker can discover the same models after the provider is refreshed.
- Keep each provider's endpoint, model list, selected model, and credentials independent; editing or refreshing one local provider does not replace another provider or another CLI's configuration.
- Keep Codex configuration changes scoped to the selected provider and current Extension Host, preserving unrelated providers and configurations in other local or remote systems.

## What's New in 1.4.0

- Preserve Codex-owned root settings, Desktop, MCP, Projects, Features, and unrelated providers when applying or restoring a ModelMux provider.
- Parse TOML structurally so table headers and management markers inside multiline strings do not cause false drift reports.
- Add snapshot-checked atomic writes, backup verification, and compensating rollback for configuration, state, runtime credentials, and active-provider records.
- Correct third-party Base URL and model-discovery paths that contain query parameters or endpoint suffixes such as `/responses`.
- Harden Grok and OpenClaw configuration generation and reject unsafe provider identifiers.

## CLI Support Matrix

| CLI | Official/native providers | Custom protocols | User configuration |
|---|---|---|---|
| Codex | OpenAI, Bedrock, Ollama, LM Studio | OpenAI Responses | `~/.codex/config.toml` |
| Claude Code | Anthropic | Anthropic Messages | `~/.claude/settings.json` |
| Gemini CLI | Google Gemini | Official provider only | `~/.gemini/settings.json` |
| Grok Build | xAI Grok | Official provider only | `$GROK_HOME/config.toml` |
| OpenCode | OpenAI, Anthropic, Google, xAI, Ollama | OpenAI Chat, Anthropic Messages | `~/.config/opencode/opencode.json` |
| OpenClaw | OpenAI, Anthropic, Google, xAI, Ollama | Responses, Chat, Anthropic Messages | `~/.openclaw/openclaw.json` |
| Hermes | OpenAI, Anthropic, Google, xAI, LM Studio | Responses, Chat, Anthropic Messages | `~/.hermes/config.yaml` |

Provider rows show whether a profile is compatible with the currently selected CLI. Incompatible profiles remain editable but cannot be applied to the wrong configuration format. Codex custom gateways must support the OpenAI Responses API; a Chat Completions-only endpoint cannot be used directly by Codex.

## Installation

From the VS Code Marketplace:

1. Open the VS Code Extensions view.
2. Search for `@id:cherry-local.codex-config-switcher` or `ModelMux`.
3. Select **ModelMux: AI CLI Model Manager** and click **Install**.

To install the packaged VSIX manually:

1. Open the VS Code Extensions view.
2. Open the `...` menu in the upper-right corner.
3. Select **Install from VSIX...**.
4. Select `modelmux-1.5.6.vsix`.
5. Run `Developer: Reload Window`.

For Remote-SSH, WSL, Dev Containers, or Codespaces, install ModelMux in the corresponding remote extension host. ModelMux only changes CLI configuration files in the environment where the extension is running. Provider profiles, active records, and stored API keys are isolated from the local host and from other remote authorities.

## Usage

Open **ModelMux** from the Activity Bar or run:

```text
ModelMux: Open dashboard
```

The dashboard supports:

- Selecting a CLI target and viewing the management state of every target.
- Adding, editing, deleting, and searching provider profiles.
- Selecting and applying models.
- Synchronizing models from a custom `/models` endpoint.
- For Codex custom providers, refreshed model IDs are persisted with that provider so the VS Code Codex model picker can use the same list. Start a new Codex session or reload the window if the picker was already open during a refresh.
- Restoring the selected CLI's original configuration.
- Opening the selected CLI configuration file.
- Previewing provider activation or restore changes in the VS Code Diff Editor without modifying the target file.
- Testing custom provider connectivity with the same timeout, same-origin credential, HTTP, and TLS rules used for model discovery.
- Running per-CLI environment, credential, and managed-configuration diagnostics.
- Importing and exporting provider profiles through dashboard actions or direct Command Palette commands.
- Clearing API keys stored in SecretStorage.

## ModelMux Settings

Open **Tools > Settings** from the dashboard header, or select **Settings** in the dashboard footer.

### Language

- `English` is selected by default.
- `中文` switches the complete dashboard and provider editor to Simplified Chinese.
- Changes are applied immediately and persisted globally.

### Typography

- **VS Code default** uses the current VS Code interface font.
- **System UI** uses the operating system interface font.
- **Monospace** uses the current VS Code editor font.
- The font-size slider supports `10px` through `20px`.
- **Use VS Code default font** restores only the font family.
- **Reset appearance** restores the default font family and `13px` font size.

The Settings panel previews typography changes immediately. Provider actions can open the proposed activation configuration in the VS Code Diff Editor without changing the target file. The Tools menu can similarly preview the original configuration before restore. Diagnostic checks are also available in a structured dashboard dialog and as a text report.

## Configuration Paths and Overrides

- Codex supports `CODEX_HOME`.
- Claude Code supports `CLAUDE_CONFIG_DIR`.
- Grok Build supports `GROK_HOME`.
- OpenCode supports `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and `XDG_CONFIG_HOME`; it detects `opencode.json`, `opencode.jsonc`, and `config.json`.
- OpenClaw supports `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_HOME`.
- Hermes supports `HERMES_HOME`; its Windows default is `%LOCALAPPDATA%\hermes\config.yaml`.

## Credential Safety

- `codexConfigSwitcher.approvalPolicy` and `codexConfigSwitcher.sandboxMode` are machine-scoped. The manifest lists both as restricted configurations in untrusted workspaces; VS Code controls whether users may change those restricted values in that workspace.
- On Windows, ModelMux aborts private-file writes if it cannot apply and verify the requested current-user ACL, and removes an incomplete file created by that write attempt.

### SecretStorage

Codex and Anthropic Messages gateway API keys can be stored in VS Code SecretStorage and are never included in exported profile JSON, diagnostics, or configuration previews. SecretStorage remains ModelMux's source of truth.

Codex on Linux and macOS uses a user-only runtime token file. On Windows, compatibility with some Codex versions may require a bearer token in the managed `config.toml`; ModelMux applies a restricted ACL and removes or replaces that managed file when the original configuration is restored.

When a direct Anthropic Messages key is activated for Claude Code, OpenCode, OpenClaw, or Hermes, ModelMux copies the key into that CLI's protected managed configuration because these CLIs read credentials from their own configuration. The target file therefore contains the credential while the provider is active. Restoring or replacing the managed configuration removes or replaces that copy. Environment-variable mode is preferable for long-running services and shared machines.

### Environment Variables

Custom providers can store an environment-variable name or supported secret reference in the target configuration instead of a direct key. The API key value is never written to provider exports or ModelMux state.

Example:

```bash
MODEL_SWITCH_API_KEY=your-key
```

For gateways requiring a custom header such as `api-key`, configure an environment-variable header map:

```json
{
  "api-key": "AZURE_OPENAI_API_KEY"
}
```

Long-running OpenClaw or Hermes services must receive referenced environment variables from their own service environment. VS Code SecretStorage is not injected into independent background services.

## Backups and Restore

- ModelMux records whether the target configuration existed before first activation.
- Existing configuration files are backed up before ModelMux writes managed values.
- A target that originally had no configuration file is restored to that same state.
- Every managed write stores a content hash.
- If another process changes the configuration, ModelMux stops automatic replacement and asks before restore.
- Restoring one CLI never resets another CLI's active model or backup state.

## Profile Migration

Exported JSON includes providers, model IDs, endpoints, protocol options, headers, retry settings, and compatibility flags. It never includes SecretStorage values or environment-variable values.

After importing profiles on another device, re-enter API keys or configure the referenced environment variables locally.

## TLS and HTTP

- Use an HTTPS hostname covered by the server certificate whenever possible.
- Remote non-localhost HTTP is rejected by default to prevent clear-text credential transmission.
- The TLS exception affects only ModelMux model discovery; it never disables TLS validation for CLI inference requests.
- Model discovery credentials cannot be forwarded to a different origin from the configured Base URL.
- Do not globally set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Development and Packaging

```bash
npm ci
npm run check
npm test
npm run build
npm run package
```

Development and CI use Node.js 22 or newer. The extension bundle remains targeted at Node 20 for the VS Code extension host.

The package command reads the package version dynamically and generates:

```text
modelmux-1.5.6.vsix
```

The smoke suite covers manifest metadata, appearance settings and localization, export redaction, Webview CSP/DOM/accessibility boundaries, import conflict handling, Codex configuration generation, all six additional CLI adapters, concurrent target state, isolated restore, credential handling, model discovery security, and the bundled extension entry point. GitHub CI runs `npm ci`, `npm run check`, `npm test`, and `npm run build` on Ubuntu, Windows, and macOS.

## Publishing

Upload `modelmux-1.5.6.vsix` from the Visual Studio Marketplace publisher portal, or publish it from the command line with a Personal Access Token for the `cherry-local` publisher:

```bash
npx vsce publish --packagePath modelmux-1.5.6.vsix -p "$VSCE_PAT"
```

PowerShell:

```powershell
npx vsce publish --packagePath modelmux-1.5.6.vsix -p $env:VSCE_PAT
```

The repository is configured as `xlnn/modelmux-vscode`. Push the version commit first, then create `v1.5.6` on that exact commit and publish the GitHub Release. The included `.github/workflows/release.yml` runs checks, packages exactly one versioned VSIX, verifies the release tag against `package.json`, attaches the package to that release, and publishes to the VS Code Marketplace when the `VSCE_PAT` repository secret is available.

## Extension Identity

- Product brand: **ModelMux**; manifest display name: **ModelMux: AI CLI Model Manager**.
- Package name: `codex-config-switcher`; publisher: `cherry-local`.
- Marketplace extension ID: `cherry-local.codex-config-switcher`. This is unchanged from ModelMux 1.1.2, so 1.1.2 installations can upgrade in place.
- Builds previously installed under `cherry-local.codex-config-switcher` have a different VS Code extension identity. Export profiles from that installation and import them into the current extension; SecretStorage credentials must be entered again.
- Source repository: `xlnn/modelmux-vscode`. The repository name is not the Marketplace extension ID.
- Existing command and setting IDs keep the `codexConfigSwitcher` prefix for compatibility.

## Notes

- New configuration normally applies to newly started CLI sessions.
- SecretStorage values do not migrate between devices through profile exports.
- ModelMux is not affiliated with OpenAI, Anthropic, Google, xAI, Amazon, OpenCode, OpenClaw, Nous Research, Ollama, or LM Studio.

## License

MIT

---

## 中文说明

### ModelMux：AI CLI 模型管理器 1.5.6

一个面向 **Windows、macOS、Linux、WSL、Remote-SSH、Dev Container 与 GitHub Codespaces** 的 VS Code 图形化 AI CLI 配置管理插件。

插件可独立切换 Codex、Claude Code、Gemini CLI、Grok Build、OpenCode、OpenClaw 与 Hermes 的默认 Provider/模型，支持原配置备份、恢复、外部改动检测、环境自检以及不含密钥的 Provider 迁移。

## 1.5.6 Anthropic Messages 双认证

- Anthropic Messages 网关同时支持两种方式：直接填写 Base URL + API Key（密钥保存在 VS Code SecretStorage），或填写 Base URL + API Key 环境变量名。
- 直接密钥模式启用后，ModelMux 会在 Provider 活动期间把密钥写入目标 CLI 受保护的托管配置；恢复原配置时会删除或替换该托管密钥。
- Provider 导出、诊断和配置预览不会显示或包含直接 API Key。

## 1.5.5 响应格式模型筛选

- 根据 Provider 的响应格式筛选模型：OpenAI Responses/Chat 仅显示 OpenAI 兼容模型，Anthropic Messages 仅显示 Claude 兼容模型。
- Provider 列表、可搜索模型候选项、编辑窗口和 `/models` 刷新结果使用同一筛选规则，避免误选不兼容模型。

## 1.5.4 发布修复

- 将 Provider 编辑器和 Codex 思考强度更新以正确的 `1.5.4` 版本重新打包发布。
- 明确发布顺序：先推送包含新版本号的提交，再从该提交创建并发布对应的 GitHub 标签。

## 1.5.3 模型下拉框与 Codex 思考强度

- Provider 编辑器改用可搜索、支持键盘操作、在弹窗内容区内展开的模型列表，解决原生下拉框显示不全的问题。
- `/models` 返回的模型不再按 OpenAI 或 Claude 分类过滤，所有模型 ID 都会显示。
- 通过 Codex 自定义 Responses Provider 使用的非 GPT 模型，也会显示 `low`、`medium`、`high`、`xhigh`、`max` 和 `ultra` 完整思考强度选项。

## 1.5.2 Codex 模型选择状态修复

- Codex 自带模型选择器写回模型或思考强度时，不再误报“托管配置已被外部修改”。
- Provider、端点、认证、模型目录、审批策略和沙箱模式仍受完整性校验保护。
- 自动迁移 ModelMux 1.5.1 的完整性记录，并在面板中显示 Codex 当前选择的模型。

## 1.5.1 Codex 原生模型名称与思考强度

- 自定义 Responses 网关暴露 Codex 已知模型时，沿用 Codex 本机模型目录中的原生显示名称和完整思考强度选项。
- 本机尚未缓存匹配元数据时，也会使用规范的 GPT 模型名称，并保留可调整的多档思考强度。

## 1.5.0 Codex 模型同步与 Provider 独立性

- 从上游 `/models` 刷新模型后，模型 ID 会写入当前 Codex Provider 的定义，VS Code Codex 模型选择器可在刷新后识别相同模型列表。
- 每个 Provider 独立保存地址、模型列表、当前模型和凭据；编辑或刷新本机某个 Provider 不会替换其它 Provider 或其它 CLI 的配置。
- Codex 配置更新只作用于当前 Provider 和实际运行插件的 Extension Host，并保留其它 Provider 及其它本机、远程系统的配置。
- 已经打开的 Codex 会话或模型选择器可能缓存旧列表；刷新后请重新加载窗口或启动新的 Codex 会话。

## 1.4.0 配置保留与事务安全

- 应用或恢复 Provider 时保留 Codex 自行写入的根设置、Desktop、MCP、Projects、Features 和其它 Provider。
- 使用结构化 TOML 识别配置，多行字符串中的表头和管理标记不再造成外部修改误报。
- 配置、备份、状态、运行时密钥和活动 Provider 更新增加快照校验与补偿回滚。
- 修复第三方 Base URL 带查询参数或 `/responses` 等端点后缀时的模型发现路径。
- 加强 Grok、OpenClaw 配置生成，并拒绝危险的 Provider ID。

## 1.1.0 ModelMux

- 插件品牌更新为 ModelMux，仓库名为 `modelmux-vscode`；保留原命令和配置 ID 以兼容本地 Profile 与设置。
- 新增独立设置界面，字体大小控制不再占用标题栏。
- 支持 VS Code 默认字体、系统界面字体和等宽字体，可一键恢复默认字体或默认外观。
- 新增英语与简体中文界面，首次安装默认显示英语。
- 更新活动栏和 Marketplace 彩色图标。

## 1.0.0 多 CLI 工作台

- 七个 CLI 目标使用独立的活动状态、备份和恢复记录，可以同时启用不同模型。
- Claude/Gemini/OpenClaw 使用结构化 JSON 合并，OpenCode 保留 JSONC 注释，Hermes 使用 YAML 合并，Grok 只修改 TOML 的 `[models].default`。
- 恢复前校验最后写入内容；配置被其它程序修改时不会静默覆盖。
- 新增 OpenAI Chat Completions、Anthropic Messages、Anthropic、Gemini 与 Grok Provider 类型。
- UI 新增 CLI 状态轨道、协议兼容提示和 `10–20px` 字体调节。
- 保留 0.7.x Codex Profile、SecretStorage、备份文件和旧命令 ID，无需迁移。

## CLI 支持矩阵

| CLI | 官方/原生模型 | 自定义协议 | 用户配置文件 |
|---|---|---|---|
| Codex | OpenAI、Bedrock、Ollama、LM Studio | OpenAI Responses | `~/.codex/config.toml` |
| Claude Code | Anthropic | Anthropic Messages | `~/.claude/settings.json` |
| Gemini CLI | Google Gemini | 暂不写入非官方网关 | `~/.gemini/settings.json` |
| Grok Build | xAI Grok | 暂不写入自定义 Provider | `$GROK_HOME/config.toml` |
| OpenCode | OpenAI、Anthropic、Google、xAI、Ollama | OpenAI Chat、Anthropic Messages | `~/.config/opencode/opencode.json` |
| OpenClaw | OpenAI、Anthropic、Google、xAI、Ollama | Responses、Chat、Anthropic Messages | `~/.openclaw/openclaw.json` |
| Hermes | OpenAI、Anthropic、Google、xAI、LM Studio | Responses、Chat、Anthropic Messages | `~/.hermes/config.yaml` |

Provider 列表项会根据当前 CLI 和协议显示是否兼容。不兼容组合保持可编辑，但不会允许写入错误格式。Codex 仍要求 Responses API；只有 `/chat/completions` 的网关不能直接用于 Codex。

## 安装

从 VS Code Marketplace 安装：

1. 打开 VS Code 扩展面板。
2. 搜索 `@id:cherry-local.codex-config-switcher` 或 `ModelMux`。
3. 选择 **ModelMux: AI CLI Model Manager** 并点击 **安装**。

手动安装已打包的 VSIX：

1. 打开 VS Code 扩展面板。
2. 点击右上角 `...`。
3. 选择 **从 VSIX 安装…**。
4. 选择 `modelmux-1.5.6.vsix`。
5. 执行 `Developer: Reload Window`。

在 Remote-SSH、WSL、Dev Container 或 Codespaces 窗口中，应将插件安装在对应的远程扩展主机上。插件只修改它实际运行环境中的 CLI 配置；Provider、活动记录和 API Key 与本机及其它远程 authority 分开保存。

## 配置路径与覆盖

- Codex：支持 `CODEX_HOME`。
- Claude Code：支持 `CLAUDE_CONFIG_DIR`。
- Grok Build：支持 `GROK_HOME`。
- OpenCode：支持 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME`，并检测 `opencode.json`、`opencode.jsonc`、`config.json`。
- OpenClaw：支持 `OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`、`OPENCLAW_HOME`。
- Hermes：支持 `HERMES_HOME`；Windows 默认位于 `%LOCALAPPDATA%\hermes\config.yaml`。

在 Remote-SSH、WSL、容器或 Codespaces 中，插件修改它实际运行的远程扩展主机配置。

## 凭据安全

- `codexConfigSwitcher.approvalPolicy` 与 `codexConfigSwitcher.sandboxMode` 的 scope 为 `machine`。扩展清单将两项列为不受信任工作区的受限配置；是否允许在该工作区修改受限值由 VS Code 控制。
- Windows 私有文件无法应用并验证当前用户 ACL 时，ModelMux 会中止写入，并删除该次写入产生的不完整文件。

### SecretStorage 模式

Codex 和 Anthropic Messages 网关的 API Key 可长期保存在 VS Code SecretStorage 中；SecretStorage 是 ModelMux 内部的凭据来源。密钥不会进入 Provider 导出、诊断或配置预览。

Codex 在 Linux/macOS 使用仅当前用户可读的临时令牌文件。Windows 为兼容部分 Codex 版本，会在启用期间将 Bearer Token 写入受 ACL 保护的托管 `config.toml`；恢复原配置后该文件被替换或删除。

直接密钥模式用于 Claude Code、OpenCode、OpenClaw 或 Hermes 时，由于这些 CLI 从自身配置读取凭据，ModelMux 会在 Provider 活动期间把 API Key 复制到目标 CLI 受保护的托管配置中。因此目标文件在启用期间含有该密钥；恢复或替换托管配置后，这份密钥会被删除或替换。常驻服务和共享设备更建议使用环境变量模式。

- Windows：位于 `%TEMP%\codex-model-profile-manager\...`，并强制应用及验证当前用户 ACL；
- Linux：优先位于 `/run/user/<uid>`，否则回退到用户临时目录；
- macOS：位于当前用户的 `$TMPDIR`。

### 环境变量模式

自定义 Provider 可选择只在目标配置中写入环境变量名称或官方 SecretRef，而不写入直接 API Key。应从设置了相应变量的终端启动 CLI，例如：

```bash
MODEL_SWITCH_API_KEY=your-key
```

对于要求 `api-key` 等请求头的服务，可配置：

```json
{
  "api-key": "AZURE_OPENAI_API_KEY"
}
```

环境变量值不会被写入 Provider、备份状态或导出文件。官方登录型 Provider 继续使用各 CLI 已有的 OAuth、凭据文件或标准变量。

## 使用

打开左侧活动栏中的 **ModelMux**，或运行：

```text
ModelMux: Open dashboard
```

主要操作包括：

- 添加、编辑、删除 Provider；
- 选择和启用模型；
- 在七个 CLI 之间切换并查看各自接管状态；
- 在设置界面选择中英文、字体族和 `10–20px` 字号；
- 一键恢复 VS Code 默认字体或全部默认外观；
- 从自定义 `/models` 地址同步模型并测试连接；
- 在 VS Code Diff Editor 中预览 Provider 启用或恢复的拟写入内容；
- 在面板内查看结构化环境自检，或从命令面板打开文本报告；
- 导入前预览新增与冲突 Provider，并选择跳过或替换；
- 通过面板或命令面板导入、导出不含密钥的 Provider 配置；
- 恢复当前 CLI 的原始配置；
- 打开当前 CLI 的用户配置；
- 清除 SecretStorage 中的 API Key。

设置面板会即时预览字体外观调整。Provider 启用和恢复操作可先在 VS Code Diff Editor 中查看拟写入内容，预览过程不会修改目标文件。环境自检可在面板中结构化查看，也可打开文本报告。

## 跨平台迁移

点击 **导出配置** 可生成 JSON。导出内容包含 Provider、模型、地址及兼容参数，但不包含任何 SecretStorage 密钥或环境变量值。

在另一台设备点击 **导入配置** 后，需要重新输入 API Key，或在新环境中设置相应环境变量。

## TLS 与 HTTP

- 推荐使用证书匹配的 HTTPS 域名。
- 非 localhost 的 HTTP 默认被拒绝，以避免明文传输凭据。
- “忽略 TLS 证书错误”只用于插件获取模型列表，不会关闭 Codex 调用 `/responses` 时的证书校验。
- 不建议全局设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

## 开发与测试

```bash
npm ci
npm run check
npm test
npm run build
npm run package
```

开发与 CI 要求 Node.js 22 或更高版本；扩展 bundle 继续以 Node 20 为目标。`npm run package` 根据 `package.json` 版本动态生成 `modelmux-1.5.6.vsix`。

## 发布

可在 Visual Studio Marketplace 的 Publisher 管理页面直接上传 `modelmux-1.5.6.vsix`，也可以使用 Publisher `cherry-local` 的 Personal Access Token 从命令行发布：

```bash
npx vsce publish --packagePath modelmux-1.5.6.vsix -p "$VSCE_PAT"
```

Windows PowerShell：

```powershell
npx vsce publish --packagePath modelmux-1.5.6.vsix -p $env:VSCE_PAT
```

仓库包含 `.github/workflows/release.yml`。先推送版本提交，再从该提交创建并发布 `v1.5.6` 标签。发布流程使用 Node.js 22，执行与 CI 相同的 `npm ci`、`npm run check`、`npm test`、`npm run build`，随后校验标签与 `package.json` 版本一致，只生成并上传当前版本的 VSIX；仓库配置 `VSCE_PAT` 后会继续发布到 VS Code Marketplace。

GitHub CI 在 Ubuntu、Windows、macOS 上使用 Node.js 22 执行安装、语法检查、冒烟测试和 bundle 构建。现有测试覆盖：

- Provider 导出脱敏、导入冲突处理与 Webview CSP、DOM 安全、可访问性结构；
- Linux 配置、权限、Token helper、符号链接防护和环境自检；
- Windows EncodedCommand 生成；
- macOS/Linux Unix helper 配置；
- SecretStorage、`env_key`、`env_http_headers`；
- OpenAI、Bedrock、Ollama、LM Studio 与自定义 Responses 配置生成；
- Claude、Gemini、Grok、OpenCode、OpenClaw 与 Hermes 配置生成；
- 多目标同时启用及独立恢复；
- 查询参数、请求头、重试与超时设置。

## 扩展身份

- 产品品牌：**ModelMux**；manifest 展示名称：**ModelMux: AI CLI Model Manager**。
- 包名：`codex-config-switcher`；Publisher：`cherry-local`。
- Marketplace 扩展 ID：`cherry-local.codex-config-switcher`，与 ModelMux 1.1.2 保持一致，因此 1.1.2 可原地升级。
- 早期安装在 `cherry-local.codex-config-switcher` 身份下的构建属于另一个 VS Code 扩展 ID；需要从旧扩展导出 Provider 后导入当前扩展，并重新填写 SecretStorage 密钥。
- 源码仓库：`xlnn/modelmux-vscode`；仓库名不是 Marketplace 扩展 ID。
- 命令与设置 ID 继续使用 `codexConfigSwitcher` 前缀，以保持兼容。

## 注意事项

- 新配置通常只影响新启动的 CLI 会话；已经固定模型的会话可能继续使用原模型。
- 插件恢复的是首次接管前的完整配置。接管期间检测到外部修改时，恢复操作会要求确认。
- OpenClaw 与 Hermes 等常驻服务必须自行获得配置中引用的环境变量；VS Code SecretStorage 不会注入到独立后台服务。
- 不同设备的 VS Code SecretStorage 不会通过导出文件迁移。
- 本项目与 OpenAI、Anthropic、Google、xAI、Amazon、OpenCode、OpenClaw、Nous Research、Ollama 和 LM Studio 无官方隶属关系。

## License

MIT
