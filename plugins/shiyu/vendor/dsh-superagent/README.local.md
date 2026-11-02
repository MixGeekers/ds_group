# DSH-Superagent 任务领域核心源码快照

来源为 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e)，固定 commit `6337fc823ce20251c8de8085948165c81aaa701e`。2026-11-02 通过 GitHub 连接器按该 commit 获取；所有上游文件保留原路径及原始字节，未应用本地补丁。完整 MIT 许可和 `Copyright (c) 2026 DeepSeek Harness Team` 保存在 `LICENSE`。

`SOURCE_MANIFEST.json` 记录每个上游文件的固定来源 URL、Git blob SHA、上游及当前本地 SHA256、字节数和本地修改。`DEPENDENCY_AUDIT.json` 记录静态导入及缺失路径。两份记录描述本快照，不代表识雨的产品实现或运行验收。

## 范围与依赖

共保留 25 个上游文件：13 个任务领域 core 文件、测试所需的 `memory.ts` 与 `index.ts`、8 个相关测试、完整许可、原始 `package.json`。该 `package.json` 只是上游元数据证据；它描述完整 DSH 插件，不能用本快照运行其构建或一键检查脚本，也不应为本体集成安装它的全套依赖。

从 `src/core/engine.ts` 追踪静态导入（含类型导入与重新导出）得到完整 13 文件闭包；唯一非相对导入为 Node 内置 `node:crypto`，没有第三方运行时包依赖。`memory.ts` 是测试/临时实例的内存仓储；`index.ts` 是上游测试使用的聚合出口。生产接入宜直接导入需要的领域文件，避免把测试仓储当成持久存储。这里的 Engine 是任务状态协调器，宿主 Session 及模型执行须经识雨适配层完成。

原始语义尚未适配识雨，包括 `ready` 对任务结束的处理、重启/恢复和终态重开条件。原始内存仓储也不证明 SQLite 持久性、异步事务隔离或外部副作用的一致性。实现阶段仍须按识雨 Task / Assignment / Effect 契约补足这些边界。

## 已做的静态验证

25 个上游文件的 Git blob SHA 均与固定 commit 的 GitHub 内容/tree 返回值一致；逐文件 SHA256 已记录。13 文件闭包没有缺失的相对导入。原核心测试用本地 fake assessor / executor / outbox 和内存仓储，不需要 DSH 宿主、真实模型或凭据。获取与静态核查过程没有安装依赖或执行上游指令；之后主 agent 单独安装了所需 Vitest 开发依赖并执行下述原核心测试。

可重复的本地完整性检查（只读文件，不加载上游 TypeScript）：

```sh
python3 /Users/caja/Documents/识雨/plugins/shiyu/vendor/dsh-superagent/verify_snapshot.py
```

## 原核心测试方案

`tests/core-engine.spec.ts` 与 `tests/stage.spec.ts` 的完整本地源码依赖已包含在本快照内；第三方测试依赖仅为 `vitest`。上游锁定 `vitest@4.1.8`，声明 Node `^22.19.0 || >=24.0.0`；本轮读取的本机 Node 为 `v24.19.0`。

在识雨本体安装 `vitest@4.1.8` 开发依赖后，从本体根目录显式运行这两个文件：

```sh
cd /Users/caja/Documents/识雨/plugins/shiyu
./node_modules/.bin/vitest run --root vendor/dsh-superagent tests/core-engine.spec.ts tests/stage.spec.ts
```

本轮实测（2026-11-02）：主 agent 执行了上面的命令，退出码 0，2 个测试文件、144 个测试通过，Vitest 报告耗时 243 ms。此结果建立上游原行为基线；识雨适配层仍需自己的任务生命周期、事务回滚、Effect 幂等和取消/恢复测试。不得把原核心通过等同于识雨本体验收。

其余 6 个上游测试保留作适配审阅资料，未包含其应用/宿主闭包，当前不能直接运行：

| 测试 | 尚缺的主要领域 |
|---|---|
| `effects.spec.ts` | 应用层 Effects、Store、HealthBoard、异步 fixture |
| `store.spec.ts` | 应用层 Store、records 视图、KV、policy |
| `outbox.spec.ts` | Commands、source kind、宿主 fixture；另需 zod |
| `followups.spec.ts` | Links、DSH Executor、宿主 fixture |
| `policy.spec.ts` | Policy、migration、source registry 与 GitHub/Feishu source |
| `runtime-concurrency.spec.ts` | Effects、Notices、DSH Executor、Commands、Policy 和 fixtures |

逐项缺失路径见 `DEPENDENCY_AUDIT.json`。这里没有宣称其递归依赖闭包已全部核查，也未把完整上游 DSH 插件引入识雨。
