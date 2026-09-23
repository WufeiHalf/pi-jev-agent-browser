# pi-jev-agent-browser

一个 Pi 浏览器插件：保留 native 的 `agent_browser` 工具，并增加 Jev 多步分段目标委托（开发中）。当前 checkout 只完成原工具的包装与注册；**尚未提供 `jev_browser`**。

## 开发安装与回退

使用本插件前，停用原版 `pi-agent-browser-native`，避免两份扩展注册同名工具。用 `pi -e .` 在本仓库临时加载，或在完成开发后用 `pi install` 安装本地包。回退时移除本插件并重新启用原版 native。不修改 Pi 核心，不把 `agent-browser` 浏览器 CLI 打包进本插件；仍需按 native 的说明安装它。

本插件通过依赖锁定 [WufeiHalf/pi-agent-browser-native](https://github.com/WufeiHalf/pi-agent-browser-native) 的 fork。它来自 [fitchmultz/pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native)，原作者 Mitch Fultz，MIT 许可证；原版的许可证随依赖包保留。Jev 决策功能参考 [forvela/jev-agent-browser](https://github.com/forvela/jev-agent-browser) 和 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（均为 MIT）；目前未复制这两个项目的代码。
