# pi-jev-agent-browser

一个 Pi 浏览器插件。调用 agent 继续使用原来的 `agent_browser` 打开网页、输入文字并验收；需要多步导航时，调用 `jev_browser` 把**一段明确的目标**交给 Jev。两种工具使用同一份 native 浏览器状态。Jev 不生成或填写文字，也不替调用 agent 判断 E2E 是否通过。

## 安装

需要 Node.js ≥22.19、Pi ≥0.87 和单独安装的 `agent-browser` CLI（native 当前最低支持 0.35.0）。先用 `pi list` 找到原版 `pi-agent-browser-native` 的安装来源，再用 `pi remove <来源>` 停用它；**不要同时加载原版和本插件**。在本仓库运行 `npm install` 后，用 `pi -e .` 临时试用，或用 `pi install .` 安装为一个 Pi 插件。原 `agent_browser` 的名称和直接调用方式保持不变；无需改 Pi 核心。

回退：`pi remove <本插件的来源>`，再按原来源重新安装 native。本插件把 [native fork](https://github.com/WufeiHalf/pi-agent-browser-native) 固定为依赖；fork 只增加同一运行实例的宿主调用入口，浏览器执行仍走 native 原路径。

## Jev 配置

在 `~/.pi/agent/pi-jev-agent-browser/config.json` 写入三个字段（若 Pi 的 agent 目录经过 `PI_CODING_AGENT_DIR` 定制，则放在该目录下）：

```json
{
  "baseUrl": "https://your-provider.example/v1/systemone",
  "apiKey": "your-key",
  "modelId": "your-jev-model-id"
}
```

Command Code 的 `baseUrl` 是 `https://api.commandcode.ai/provider/v1/systemone`，`modelId` 是 `typesafe/jev`；这里只需另外填写其 API key。`baseUrl` 是**完整的 System One 请求地址**，不是只有域名。可以使用任何兼容 `{model, state, questions}` 请求与 `answers` 决策响应的服务；不要填普通聊天接口。插件按字面使用这三个值，不预设提供方。不要把含真实密钥的配置文件提交到仓库；密钥不出现在普通工具结果中。当前页面的可见文字、控件名和 URL 会作为决策状态发往配置的服务。

## 使用方式

1. 调用 agent 使用 `agent_browser` 打开应用，例如 `open http://127.0.0.1:3000`。
2. 调用 `jev_browser`，传入 `goal`，例如“走到新建项目表单并停下”。Jev 每次重新观察页面，可以连续点击、滚动、等待及选择页面已有下拉选项；它也能跟进本次点击产生的新标签页。
3. 工具返回 `completed`、`input-required`、`blocked`、`limit`、`cancelled` 或 `error`，以及当前 URL、标签页、浏览器会话、动作摘要和调用次数。`completed` 只是 Jev 对本段目标的判断，调用 agent 要自行验收。
4. 如需文字输入，调用 agent 用原 `agent_browser` 在同一页面填写；再给 `jev_browser` 一个**新目标**。新的委托不延续 Jev 上次任务的上下文。

一次委托最多 16 个浏览器动作、90 秒；每次 Jev 请求最多等待 25 秒。重复动作没有页面变化、目标控件失效、标签页变化无法确认或请求失败时会停下交接；不按按钮文字设置额外操作禁令。

## 验证与来源

`npm run typecheck` 和 `npm test` 运行确定性测试。测试通过真实 native 执行路径和本地网页，但 Jev 决策由本地兼容服务模拟。写入真实配置后，`npx tsx scripts/live-e2e.ts` 使用真实 Jev 服务运行工具边界交接。`npx tsx scripts/benchmark.ts 3` 则通过真实 Pi 入口、同一 fixture 和同一调用 agent 模型各跑三次直接流程与混合流程，把非敏感指标写入 `benchmarks/local-commandcode.json`；重测用 `PI_JEV_BENCHMARK_FRESH=1`。基准需要安装 `pi-commandcode-provider`，也可以用 `PI_JEV_BENCHMARK_PROVIDER` 指向其扩展入口并用 `PI_JEV_BENCHMARK_MODEL` 指定调用 agent 模型。

在当前本机三对测试中，直接流程成功 2/3、混合流程成功 3/3；耗时中位数分别为 63.2 秒与 48.2 秒，调用 agent 轮次中位数为 24 与 12，Jev 决策请求为 0 与 9 次，native 浏览器执行调用为 24 与 58 次。直接流程有一轮虽自报 PASS，却没有实际执行约定的 `get value #category` 验收，因此计为未通过。另用 `PI_JEV_BENCHMARK_FRESH=1 PI_JEV_BENCHMARK_MODEL=commandcode/deepseek/deepseek-v4.1-flash PI_JEV_BENCHMARK_THINKING=off PI_JEV_BENCHMARK_OUTPUT=benchmarks/local-commandcode-deepseek-v4.1-flash-off.json npx tsx scripts/benchmark.ts 3` 重跑：两组都通过 3/3，耗时中位数分别为 71.0 与 59.8 秒，调用 agent 轮次中位数为 26 与 16，浏览器调用中位数为 25 与 63。混合组有一次中途 Jev 报错、由调用 agent 接手后继续完成。两次结果都只是当前 fixture、提示词、模型和网络条件下的小样本，不代表通用提速或稳定成功率。

本插件依赖的 [WufeiHalf/pi-agent-browser-native](https://github.com/WufeiHalf/pi-agent-browser-native) fork 来自 [fitchmultz/pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native)，作者 Mitch Fultz，MIT 许可证；许可证随依赖保留。决策与交接设计参考 [forvela/jev-agent-browser](https://github.com/forvela/jev-agent-browser) 和 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)，两者均为 MIT；本项目没有复制它们的源码。`agent-browser` CLI 是外部运行依赖，不随本插件打包。
