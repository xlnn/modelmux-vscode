# ModelMux: AI CLI Model Manager 1.1.2

[中文说明](#中文说明)

ModelMux is a visual VS Code extension for managing AI CLI providers, models, credentials, and original configuration files across **Windows, macOS, Linux, WSL, Remote-SSH, Dev Containers, and GitHub Codespaces**.

It independently manages Codex, Claude Code, Gemini CLI, Grok Build, OpenCode, OpenClaw, and Hermes. Each CLI has its own active profile, backup, integrity check, and restore state.

## Highlights

- Manage seven AI CLIs from one focused dashboard.
- Switch official providers and compatible custom gateways without manually editing configuration files.
- Keep independent model selections active for different CLIs at the same time.
- Back up the original configuration before first activation and restore it safely later.
- Detect external changes before overwriting a managed configuration.
- Store Codex credentials in VS Code SecretStorage and use environment-variable references for other CLIs.
- Import and export portable provider profiles without API keys.
- Use English or Simplified Chinese. English is the default language.
- Choose the VS Code default font, system UI font, or monospace font.
- Adjust the dashboard font size from `10px` to `20px` in the ModelMux Settings panel.
- Restore the VS Code default font or reset the complete appearance configuration with one action.

## What's New in 1.1.2

- Renamed and redesigned the extension as **ModelMux**.
- Added a dedicated appearance and language settings interface.
- Moved all font-size controls out of the dashboard header and into Settings.
- Added English and Simplified Chinese dashboard localization with English as the default.
- Added VS Code default, system UI, and monospace font options.
- Added new monochrome Activity Bar and color Marketplace icons.
- Added responsive safeguards for narrow sidebars at all supported font sizes.
- Kept the existing command and configuration IDs so local profiles and settings remain compatible.

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

Provider cards show whether a profile is compatible with the currently selected CLI. Incompatible profiles remain editable but cannot be applied to the wrong configuration format. Codex custom gateways must support the OpenAI Responses API; a Chat Completions-only endpoint cannot be used directly by Codex.

## Installation

1. Open the VS Code Extensions view.
2. Open the `...` menu in the upper-right corner.
3. Select **Install from VSIX...**.
4. Select `modelmux-1.1.2.vsix`.
5. Run `Developer: Reload Window`.

For Remote-SSH, WSL, Dev Containers, or Codespaces, install ModelMux in the corresponding remote extension host. ModelMux only changes CLI configuration files in the environment where the extension is running.

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
- Restoring the selected CLI's original configuration.
- Opening the selected CLI configuration file.
- Running environment and credential diagnostics.
- Importing and exporting provider profiles.
- Clearing API keys stored in SecretStorage.

## ModelMux Settings

Open the gear button in the dashboard header or select **Settings** in the dashboard footer.

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

## Configuration Paths and Overrides

- Codex supports `CODEX_HOME`.
- Claude Code supports `CLAUDE_CONFIG_DIR`.
- Grok Build supports `GROK_HOME`.
- OpenCode supports `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and `XDG_CONFIG_HOME`; it detects `opencode.json`, `opencode.jsonc`, and `config.json`.
- OpenClaw supports `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_HOME`.
- Hermes supports `HERMES_HOME`; its Windows default is `%LOCALAPPDATA%\hermes\config.yaml`.

## Credential Safety

### SecretStorage

Codex API keys can be stored in VS Code SecretStorage and are never included in exported profile JSON. Linux and macOS use a user-only runtime token file. On Windows, compatibility with some Codex versions may require a bearer token in the managed `config.toml`; ModelMux applies a restricted ACL and removes or replaces that managed file when the original configuration is restored.

### Environment Variables

Custom providers for other CLIs store only an environment-variable name or supported secret reference in the target configuration. The API key value is never written to provider exports or ModelMux state.

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
npm install
npm run check
npm test
npm run package
```

The package command generates:

```text
modelmux-1.1.2.vsix
```

The test suite covers branding and Marketplace metadata, appearance settings, default-English localization, Codex configuration generation, all six additional CLI adapters, concurrent target state, isolated restore, credential handling, model discovery security, and the bundled extension entry point.

## Publishing

Local Marketplace publishing requires a Personal Access Token for the `cherry-local` publisher:

```bash
npx vsce publish --packagePath modelmux-1.1.2.vsix -p "$VSCE_PAT"
```

The repository is configured as `xlnn/modelmux-vscode`. The included `.github/workflows/release.yml` runs checks, packages the VSIX, attaches it to a GitHub Release, and publishes to the VS Code Marketplace when the `VSCE_PAT` repository secret is available.

## Notes

- New configuration normally applies to newly started CLI sessions.
- SecretStorage values do not migrate between devices through profile exports.
- The Marketplace extension ID is `cherry-local.codex-config-switcher`. The product name shown to users is ModelMux.
- ModelMux is not affiliated with OpenAI, Anthropic, Google, xAI, Amazon, OpenCode, OpenClaw, Nous Research, Ollama, or LM Studio.

## License

MIT

---

## 中文说明

### ModelMux：AI CLI 模型管理器 1.1.2

一个面向 **Windows、macOS、Linux、WSL、Remote-SSH、Dev Container 与 GitHub Codespaces** 的 VS Code 图形化 AI CLI 配置管理插件。

插件可独立切换 Codex、Claude Code、Gemini CLI、Grok Build、OpenCode、OpenClaw 与 Hermes 的默认 Provider/模型，支持原配置备份、恢复、外部改动检测、环境自检以及不含密钥的 Provider 迁移。

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

Provider 卡片会根据当前 CLI 和协议显示是否兼容。不兼容组合保持可编辑，但不会允许写入错误格式。Codex 仍要求 Responses API；只有 `/chat/completions` 的网关不能直接用于 Codex。

## 安装

1. 打开 VS Code 扩展面板。
2. 点击右上角 `...`。
3. 选择 **从 VSIX 安装…**。
4. 选择本项目生成的 `.vsix` 文件。
5. 执行 `Developer: Reload Window`。

在 Remote-SSH、WSL、Dev Container 或 Codespaces 窗口中，应将插件安装在对应的远程扩展主机上。插件只修改它实际运行环境中的 CLI 配置，不会跨环境误改另一台设备的配置。

## 配置路径与覆盖

- Codex：支持 `CODEX_HOME`。
- Claude Code：支持 `CLAUDE_CONFIG_DIR`。
- Grok Build：支持 `GROK_HOME`。
- OpenCode：支持 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME`，并检测 `opencode.json`、`opencode.jsonc`、`config.json`。
- OpenClaw：支持 `OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`、`OPENCLAW_HOME`。
- Hermes：支持 `HERMES_HOME`；Windows 默认位于 `%LOCALAPPDATA%\hermes\config.yaml`。

在 Remote-SSH、WSL、容器或 Codespaces 中，插件修改它实际运行的远程扩展主机配置。

## 凭据安全

### SecretStorage 模式

Codex API Key 长期保存在 VS Code SecretStorage 中，不写入导出 JSON。Linux/macOS 使用仅当前用户可读的临时令牌文件。Windows 为兼容部分 Codex 版本，会在启用期间将 Bearer Token 写入受 ACL 保护的托管 `config.toml`；恢复原配置后该文件被替换或删除。

- Windows：位于 `%TEMP%\codex-model-profile-manager\...`，并尝试收紧 ACL；
- Linux：优先位于 `/run/user/<uid>`，否则回退到用户临时目录；
- macOS：位于当前用户的 `$TMPDIR`。

### 环境变量模式

其它 CLI 的自定义 Provider 只写环境变量名称或官方 SecretRef，不把 API Key 明文写入配置。应从设置了相应变量的终端启动 CLI，例如：

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
- 从自定义 `/models` 地址同步模型；
- 导入、导出 Provider 配置；
- 恢复原始配置；
- 运行环境自检；
- 打开当前 CLI 的用户配置；
- 清除 SecretStorage 中的 API Key。

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
npm install
npm run check
npm test
npm run package
```

## 发布

本地发布需要 Marketplace Publisher `cherry-local` 的 Personal Access Token：

```bash
npx vsce publish --packagePath modelmux-1.1.2.vsix -p "$VSCE_PAT"
```

仓库包含 `.github/workflows/release.yml`。在 GitHub Repository Secret 中配置 `VSCE_PAT` 后，发布 GitHub Release 会自动运行测试、附加 VSIX，并上传到 VS Code Marketplace。

测试覆盖：

- Linux 配置、权限、Token helper、符号链接防护和环境自检；
- Windows EncodedCommand 生成；
- macOS/Linux Unix helper 配置；
- SecretStorage、`env_key`、`env_http_headers`；
- OpenAI、Bedrock、Ollama、LM Studio 与自定义 Responses 配置生成；
- Claude、Gemini、Grok、OpenCode、OpenClaw 与 Hermes 配置生成；
- 多目标同时启用及独立恢复；
- 查询参数、请求头、重试与超时设置。

## 注意事项

- 新配置通常只影响新启动的 CLI 会话；已经固定模型的会话可能继续使用原模型。
- 插件恢复的是首次接管前的完整配置。接管期间检测到外部修改时，恢复操作会要求确认。
- OpenClaw 与 Hermes 等常驻服务必须自行获得配置中引用的环境变量；VS Code SecretStorage 不会注入到独立后台服务。
- 不同设备的 VS Code SecretStorage 不会通过导出文件迁移。
- 本项目与 OpenAI、Anthropic、Google、xAI、Amazon、OpenCode、OpenClaw、Nous Research、Ollama 和 LM Studio 无官方隶属关系。

## License

MIT
