# Changelog

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
