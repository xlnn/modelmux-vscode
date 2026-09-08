# Changelog

## 1.5.2

- Treat Codex model and reasoning-effort picker updates as runtime selection changes instead of external configuration drift, while continuing to protect provider, endpoint, authentication, catalog, approval, and sandbox settings.
- Migrate existing managed-configuration fingerprints without requiring users to reapply a provider, and surface Codex's current model in the dashboard after it changes the shared config file.

## 1.5.1

- Restore Codex's native model names and reasoning-effort choices for custom Responses providers by reusing matching metadata from the local Codex model catalog.
- Keep a multi-level reasoning picker and canonical GPT model names available when matching local metadata has not been cached yet.

## 1.5.0

- Persist refreshed upstream model IDs in the active Codex provider definition so the VS Code Codex model picker can discover models added by a provider after `/models` refresh.
- Keep each provider's endpoint, model list, selected model, credentials, and managed configuration independent; local edits or refreshes do not overwrite other providers or other CLI targets.
- Scope Codex updates to the selected provider and current Extension Host while preserving unrelated local and remote configurations.

## 1.4.0

- Codex 配置改为结构化 TOML 合并与恢复；保留 Codex 自行写入的根设置、Desktop、MCP、Projects、Features 和其它 Provider，不再把这些追加内容误报为托管配置漂移。
- 加强配置、备份、状态、运行时 Token 与活动 Provider 的事务回滚；原子写入、原子删除和首次备份会校验普通文件、快照与并发变化。
- 修复多行 TOML 字符串中的表头或管理标记被误识别，以及 Grok `[models]`、OpenClaw 数组配置、危险 Provider ID 等适配问题。
- 修复第三方 Base URL 带查询参数或 `/responses` 后缀时的模型发现路径，并加强非法 URL、凭据字段和响应大小校验。
- 新增 Codex 外部设置保留、故障注入、恢复补偿、URL 边界、Grok/OpenClaw 异常结构及测试目录隔离回归。

## 1.3.2

- Provider、CLI 选择、活动记录与 SecretStorage 密钥改为按实际 Extension Host 分区，本机、WSL、容器、Codespaces 与 Remote-SSH 不再共享配置。
- Remote-SSH 使用远程 authority 区分不同服务器；连接不同 SSH 主机时分别显示各自主机保存的 Provider 与密钥。
- 1.3.1 及更早版本的无分区状态只迁移到本机作用域，远程首次启动保持空白，避免再次读取 Windows 本地 Provider。
- 当前作用域找不到匹配 Provider 时删除遗留的 Linux/macOS 运行时 Token，同时保留托管配置文件供用户诊断或恢复，避免远程 CLI 继续使用其它环境的凭据。
- 扩展固定作为 Workspace Extension 运行；远程窗口必须在远程 Extension Host 安装并运行，避免回退到本地 UI Host 后误操作本机 CLI 配置。
- 新增本机、两台 Remote-SSH 主机之间的状态、活动记录及 SecretStorage 隔离回归测试。

## 1.3.1

- 修复 Remote-SSH/Linux 上配置出现哈希漂移后，面板提示“重新应用”但按钮与后端同时禁止应用 Provider 的问题。
- 漂移状态现在允许在明确确认后重新应用或切换 Provider；自动刷新仍不会覆盖外部修改，确认后文件再次变化时也会中止写入。
- 漂移状态下正确显示“重新应用”，并允许预览拟写入配置与测试 Provider 连接；取消确认不再显示为启用失败。

## 1.3.0

- 修复 Remote-SSH/Linux 扩展主机重连后活动状态与运行时 Token 丢失的问题；从通过完整性校验的 Codex 配置元数据和状态文件恢复托管状态。
- 配置发生外部修改时继续拒绝恢复活动状态和自动重写；仅在 Provider 身份、目标地址、协议与 Token helper 路径仍匹配时安全补建私有运行时 Token。
- 支持删除正在使用的 Provider：确认后先恢复所有关联 CLI 的原配置，再删除 Provider 及保存的 API Key；恢复失败或取消时保留 Provider。
- Provider 关联关系同时依据活动记录、完整性状态和 Codex 配置元数据识别，覆盖远程活动记录或托管配置文件缺失的情况。
- 启动凭据恢复与 Provider/CLI 修改统一串行，并在写入前再次校验配置哈希，避免删除或外部修改竞态。
- 修复短侧边栏中 Provider 操作菜单显示不全的问题；菜单随列表项展开、自动滚入视口，并在空间不足时独立滚动。

## 1.2.1

- 维护版本发布，功能基线延续 1.2.0。

## 1.2.0

- 将 `codexConfigSwitcher.approvalPolicy` 与 `codexConfigSwitcher.sandboxMode` 设为机器级配置，并在扩展清单中限制不受信任工作区修改这两项。
- Windows 私有文件写入改为失败即停止：无法确认当前账户或无法应用并验证 ACL 时不再继续，并清理该次写入产生的不完整文件。
- Provider 状态变更统一串行处理，避免并发面板与命令操作互相覆盖。
- OpenCode 新增 Anthropic Messages 网关兼容。
- 重构为适合侧边栏的紧凑工作台：单一 CLI 选择器、明确的托管状态、Provider 操作菜单与命令面板意图直达。
- 新增 Provider 启用和恢复 Diff 预览、面板内结构化诊断与连接测试；预览不会修改真实 CLI 配置。
- 导入前校验并预览新增/冲突项，支持跳过或替换冲突；导出采用字段白名单并脱敏敏感 Header/查询参数。
- 开发与发布升级到 Node.js 22，bundle 继续以 Node 20 为目标；新增 Ubuntu、Windows、macOS 的 pull request 与 `main` push CI，统一运行安装、检查、测试和构建。
- 新增导出脱敏、Webview CSP/DOM/可访问性与导入冲突 smoke test，并在构建时同步 Codicon CSS/字体运行时资源。
- VSIX 文件名改为从包版本动态生成 `modelmux-${npm_package_version}.vsix`。
- 保留包名 `codex-config-switcher` 与 Publisher `cherry-local`，Marketplace 扩展 ID 与 1.1.2 相同；更早的 `lichao-local.codex-config-switcher` 属于不同扩展身份，需要导出/导入 Provider 并重新录入密钥。

## 1.1.2

- 修正 Marketplace 清单中的仓库、主页和问题反馈链接。
- 改进 Linux Token helper 冒烟测试的路径断言。

## 1.1.0

- 品牌更新为 ModelMux，仓库名为 `modelmux-vscode`；保留原扩展 ID 以兼容旧版升级数据。
- 新增独立外观设置面板，将字号控制从标题栏移入设置。
- 新增 VS Code 默认、系统界面和等宽字体选择，以及默认字体和外观重置操作。
- 新增英语、简体中文界面，默认使用英语。
- 新增 ModelMux 活动栏 SVG 和 Marketplace PNG 图标。

## 1.0.0

- 新增 Claude Code、Gemini CLI、Grok Build、OpenCode、OpenClaw 与 Hermes 目标适配器。
- 每个 CLI 独立备份、接管、外部改动校验和恢复，可同时启用不同模型。
- 新增 OpenAI Chat Completions、Anthropic Messages、Anthropic、Gemini 与 Grok Provider 类型及兼容矩阵。
- 新增 CLI 目标切换器、接管状态轨道、不兼容原因提示和 10–20px 持久化字体调节。
- OpenCode 使用 JSONC 局部编辑以保留注释，Hermes 使用 YAML 结构化合并，Grok 仅修改 `[models].default`。
- 保留 0.7.x Codex Profile、SecretStorage、备份文件和命令 ID。

## 0.7.1

- 修复 Windows 部分 Codex 版本无法可靠执行 command-backed provider auth，导致空认证连续重试并触发 429 的问题。
- Windows SecretStorage 模式改用 schema 支持的 `experimental_bearer_token` 兼容路径，并继续将托管配置限制为当前用户访问。
- Linux 与 macOS 仍使用临时 Token helper，不改变原有安全路径。
- 保持 `request_max_retries = 0`，避免认证失败被连续放大。

## 0.7.0

- 增强 Windows、macOS、Linux、WSL、Remote-SSH、Dev Container 与 GitHub Codespaces 兼容性。
- 增加架构和远程环境识别，支持 x64、arm64 等运行架构展示。
- 新增 Ollama 与 LM Studio 内置 Provider。
- 新增 Bearer `env_key`、`env_http_headers` 和无认证模式。
- 新增自定义模型发现路径、查询参数、静态请求头、环境变量请求头、请求重试、流重试、流超时和 WebSocket 设置。
- 新增 Provider JSON 导入、导出；导出文件不包含密钥。
- 支持原本不存在 `config.toml` 的用户安全恢复。
- 修复 Windows PowerShell Token helper 的参数解析问题，改用 `-EncodedCommand`。
- 改进 Windows 原子写入重试与 ACL 检查。
- 改进 Linux/macOS 运行时目录所有者、权限和符号链接安全检查。
- 修复状态页面原始配置状态文本逻辑。
- 移除默认个人中转地址。
- 美化平台兼容状态条、高级设置和宽屏布局。
- 新增跨平台配置生成测试与 Linux 端到端冒烟测试。

## 0.6.0

- 全面美化图形界面，增加状态卡片、搜索、Provider 卡片和环境自检。
- 新增 Windows、macOS、Linux 通用环境自检，重点检查 Linux Token helper、路径、所有者与权限。
- 加强 Linux `/run/user/<uid>` 检查、Unix `cat` 查找和符号链接防护。
- 自动修复过期的临时 Token 路径。

## 0.5.2

- 修复 Windows PowerShell `$args[0]` 认证读取问题。
- 自定义 Provider 默认关闭认证失败自动重试。

## 0.5.0

- 增加 macOS 支持。

## 0.4.0

- 增加 Windows 本机支持。

## 0.3.0

- 增加图形化管理界面。

## 0.2.0

- 增加多个 Provider 与模型管理。

## 0.1.0

- 初始版本。
