# CYAPI Toolbox Client

面向 **Codex、Claude Code 和 OpenCode** 的本地 AI 桌面工具箱，将常用配置与能力管理集中到一个界面。支持 Windows 10 / 11 x64 和 macOS 11+（Apple 芯片 / Intel），提供浅色、深色及跟随系统外观。

可管理 API 与模型、安装 Skill、配置 MCP、准备 Node / Python 运行环境，并查看本机日志与用量统计。除 Codex、Claude Code、OpenCode 外，模型接入也覆盖 Cline、Kilo Code、Qwen Code、Kimi Code CLI、Continue、Roo Code、Aider、Cursor、Gemini CLI、Grok Build，以及 DeepSeek Harness、WorkBuddy、Pi Coding Agent、MiniMax Code；各工作区分别管理，配置写入前备份；软件接入提供教程、版本核对与首次使用引导。

**下载：** [官方网站](https://tool.cyapi.cyou/#download) · [GitHub Releases](https://github.com/CYAPICYOU/CYAPI-toolbox-client/releases)。

**隐私：** 工具接入的 API Key 与工具配置保存在本机。客户端不额外上报 Skill / MCP 操作结果，也不为此生成设备标识或统计队列。下载量可由服务端根据下载请求统计；本机日志与模型用量统计保留在本地。

**工作流：** 托管 ComfyUI 创作入口尚未完成，本版未显示该入口；源码保留在仓库中，完成后会在后续版本重新开放。届时它与「工具接入」平级，每个用户在服务端拥有独立的 CPU-only ComfyUI 容器，ComfyUI 只负责编辑器和工作流编排，模型调用统一经 server AI 代理转发到 `sub2api`/模型 API。客户端不启动本机 ComfyUI、Python、模型服务或 GPU worker。

本项目使用 Tauri 2、React、TypeScript 和 Vite。公开源码仅供查阅、本地编译与审查评估，不授权修改、衍生、再分发或商业使用，详见 [LICENSE](LICENSE)；第三方组件许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
