# herdr-ide

[English](README.md) | 简体中文

面向 [herdr](https://herdr.dev) 的 Web IDE，以终端为中心，支持多台机器，围绕 agent 工作流设计：在一个浏览器标签页里使用所有机器上的 herdr workspace，VS Code（code-server）一个快捷键就能打开。

> 英文版 README 为主版本，本文与其保持相同的章节结构。参数、快捷键等参考资料统一维护在英文文档 [docs/reference.md](docs/reference.md) 中。

## 功能

- **直接讲 herdr 协议**：workspace、tab、分屏布局和 agent 状态都来自 herdr 的 socket API；每个 pane 都是一个 xterm.js 终端，画面由 herdr 自己渲染，支持输入、鼠标、滚动回看、中文输入法和拖动调整分屏。快捷键沿用你的 herdr 配置（前缀 `ctrl+b`）。
- **多机器**：直接使用 herdr 里保存的 SSH 机器。每台机器只开一条 ssh 连接，在上面运行一个自动上传的静态 agent（linux/macOS × amd64/arm64），所有通信都在这条连接里多路复用；机器上不监听任何端口。
- **为 agent 设计**：
  - 汇总所有机器上 blocked 和 done 的 agent，并发浏览器通知；
  - 可以从命令面板新建 agent；
  - 可以从 VS Code 把代码发给当前聚焦的 agent；
  - 可以把图片直接粘贴进 agent 的输入框。
- **按需打开 VS Code**：
  - code-server 由本机下载后推送到各机器，机器本身不需要外网；会一并装好 Git Graph 和桥接扩展。
  - 一个快捷键就能打开 pane 所在的目录、它的 Diff 或 Git Graph；终端里的 `path:line` 可以直接跳到编辑器。
  - 长时间不用的 code-server 会自动停止。
- **快速预览**：在终端里 ⌘/Ctrl+点击路径，即可预览图片、GIF、视频（可拖动进度）、音频、PDF、文本和目录。
- **多浏览器同时使用**：最近操作的浏览器控制 pane，其他浏览器以相同尺寸观看，按键即可接管。
- **中英文界面**。

## 快速开始

需要：

- 要使用的每台机器上都装好 [herdr](https://herdr.dev)，远程机器已用 `herdr machine add` 保存；
- 能正常连到这些机器的 OpenSSH 客户端；
- 构建需要：Go（版本见 `go.mod`）、Node.js 22+ 和 pnpm（`corepack enable` 会使用固定的版本）。

```bash
make deps && make build
./dist/herdr-ide-$(go env GOOS)-$(go env GOARCH)
```

打开 <http://127.0.0.1:7780>。`ctrl+b space` 打开命令面板，`ctrl+b ?` 查看快捷键。全部参数见 [docs/reference.md](docs/reference.md)。

## 远程访问

herdr-ide 本身不带登录：让它只监听 `127.0.0.1`，前面放一个负责登录和 HTTPS 的反向代理（Tailscale、Caddy、nginx），再用 `--allowed-origin` 告诉它代理的对外地址。另外还有几项可选的安全围栏：反代密钥头、只读模式、审计日志。详见 [docs/deployment.md](docs/deployment.md) 和 [SECURITY.md](SECURITY.md)。

## 离线（air-gap）环境

各台机器永远不需要下载任何东西。如果运行 herdr-ide 的主机也不能联网：
1. 在一台能联网的机器上运行 `herdr-ide fetch-assets DIR`；
2. 把 `DIR` 拷进内网；
3. 用 `--offline --seed-dir DIR` 启动。

所有下载都会用写死在代码里的 SHA-256 校验。详见 [docs/deployment.md](docs/deployment.md#air-gapped-networks)。

## 文档

- [docs/reference.md](docs/reference.md)：参数、快捷键、环境变量、文件位置
- [docs/deployment.md](docs/deployment.md)：反向代理、离线安装、远程资源、作为服务运行
- [docs/architecture.md](docs/architecture.md)：组件与协议
- [docs/features/](docs/features/README.md)：每个功能一篇设计文档，包括考虑过的方案与取舍
- [SECURITY.md](SECURITY.md)：威胁模型与漏洞报告

## 开发

```bash
herdr --session herdr-ide-dev server &   # 隔离的 herdr session
make dev-core                            # 在 :7790 以 --instance dev 运行 core
make dev-web                             # 前端热更新，端口 5173
make check test                          # 提交 PR 之前运行
```

见 [CONTRIBUTING.md](CONTRIBUTING.md)；编码 agent 请先读 [AGENTS.md](AGENTS.md)。

## 参与贡献

欢迎用中文或英文提 issue 和 PR，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和[行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE)。第三方许可证：Go 依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，前端打包的依赖见程序提供的 `/licenses.md`。code-server、Git Graph 和 herdr 是独立的项目，各自使用自己的许可证；Git Graph 的许可证不允许再分发，因此由每个安装各自下载，不随程序打包。
