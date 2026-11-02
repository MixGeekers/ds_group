# 原生客户端 UI 合成验证

此目录模拟 DSH 的 ModuleLoader、slots、locale 与只读快照接口，使用明确标记的合成数据。它不装载真实 DSH、不导入 Lab、不建立任务或调用模型；结果只证明客户端交互和显示行为。

在 `plugins/shiyu/` 安装本包开发依赖后执行：

```sh
npx playwright test --config tests/ui/playwright.config.mjs
```

依赖为 `react`、`react-dom`、`vite`、`@playwright/test`。默认使用已安装的 Google Chrome；可用 `SHIYU_CHROME_PATH` 指定 Chromium 可执行文件。测试输出和 Vite 缓存位于本包 `.local/ui/`，不得提交运行产物。

测试端点 `/__test/control` 与 `/__test/stats` 仅由本测试服务实现。生产插件不能导入或暴露它们。

`session.verify-model` 在此服务中只返回明确标记的合成回执，可通过测试控制端点延迟、删除确认字段或返回错误。测试验证显式发起、两轮回执确认、独立暂停通道和 250 秒客户端等待上限；界面中的模型名与合成 token 数不代表发生过真实调用。

`task.createLocal` 只在测试服务内存中按 `requestId` 保留合成任务。可延迟或丢失受理回执，任务仍能由合成 GET 快照读取；不会创建 `note.txt`、执行 worker 或调用模型。定向运行该交互检查：`npm run test:ui -- task-validation.spec.js`。
