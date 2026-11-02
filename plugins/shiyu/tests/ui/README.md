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

`goal.verify-lifecycle` 仅返回合成的任务／Goal／Session 标识和四步回执，不创建真实 Goal、Session 或 Task。相关测试核对最近成功本地任务的选择、严格回执字段及独立暂停通道：`npm run test:ui -- goal-verification.spec.js`。

`conversation.linkLocalTask` 仅在内存中关联合成任务和对话控制投影。回执可延迟、缺字段或与 GET 不匹配；测试核对受理与快照分离、固定 local-owner 范围、背景来源只读且刷新不确认消费，以及独立暂停通道。不会创建真实 Conversation、Session 或调用模型。定向运行：`npm run test:ui -- conversations.spec.js`。

`conversation.verifyContext` 返回合成的背景持久化、每轮草稿放行核验及同 Session 两轮检查回执。GET 的 pending 投影和保存记录可独立设定，不因回执成功自动清空；可模拟延迟、错误和篡改字段。测试覆盖显式请求、对话／绑定一致性、切换详情、历史记录、暂停通道及 95 秒客户端等待上限；不加载真实背景或调用模型。定向运行：`npm run test:ui -- context-verification.spec.js`。
