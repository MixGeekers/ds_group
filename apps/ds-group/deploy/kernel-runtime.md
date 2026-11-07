# DSCord 0.4.0-alpha.1 内核运行

本发行包的版本为 `0.4.0-alpha.1`；其 Bot 内核标识为 `dscord-kernel`，内核版本字段为 `0.4.0`，管理 API 版本为 `1`，基于 DS-Bot `0.3.1`。Node 支持范围见 [package.json](../package.json)，固定 DSH SDK 基线为 `0.2.2-rc.1`，接口依据见[宿主契约](../dsh-connect/KERNEL.md)。业务模型由部署者在 DSH 中选择。

## 服务器和 Bot 节点

聊天服务器按 [Compose 指南](README.md)部署。`/healthz` 只检查 Core 进程，`/readyz` 还检查 Matrix 连通性；两者不证明 Bot 业务模型或工具任务成功。

在 DSH 安装并启用同版本包，登录服务器后，在“此节点的 Bot”显式创建或选择 Bot，并加入服务器。[图形安装](npm.md#在-dsh-中连接)

每个实际 Bot home 只能有一个内核。已有 `ds-bot` 团队先停用旧插件，再重载 DSCord；冲突时返回 `DSCORD_KERNEL_CONFLICT`，不会退回旧内核继续处理。网页关闭或断开服务器只停止相应传输，DSH 停止则内核也停止。

## 数据和采用

图形节点默认采用实际 DSH home 下的 `bot/`，连接元数据在 `dscord/<profile>/`。独立节点使用自己的数据根、home 和桥接端口；[独立节点指南](README.md#cli-节点导出)与[systemd 模板](systemd/README.md)使用的路径均为可调整示例。

采用已有团队时保留 Bot 与 Session 身份，保存 `migrations/dscord-0.4.0/` 快照，并以 `dscord-kernel.json` 记录当前生命周期。程序不要求复制 Session 到第二套 home，也不会自动合并两套团队或历史。

已经绑定原生 Bot 的导出文件含 `nativeBinding`，必须从所属 DSH 连接。独立 CLI 会在启动前返回 `DSCORD_NATIVE_BOT_HOST_REQUIRED`；导出文件不是在别处复制同一 Bot 身份的方法。

采用时保留的未知旧请求需要先核对 `migration-work`，再显式恢复。对已经发生但没有回执的外部操作，未知状态不能当成重新执行的许可。

## 依赖与宿主位置

运行库按 [runtime-dependencies.json](../dsh-plugin/runtime-dependencies.json) 及随包锁安装到私有目录；SDK 解析到实际 DSH。启动器在目标机器准备所需依赖。

启动器可从 PATH 查找 `dsh`，也可使用部署者提供的 `DS_GROUP_DSH_CLI` 和 `DS_GROUP_DSH_RUNTIME`。后者是实际 SDK 包根或 npm 安装前缀，不是任意 DSH 数据 home。来源 profile 与模型的配置见[模型指南](../模型配置与迁移.md)。

## 健康与版本查询

在已经登录 DSH 的同源页面中执行：

```js
const response = await fetch('/api/dscord/kernel', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ endpoint: 'kernel-info', payload: {} }),
});
const result = await response.json();
if (!result.ok) throw new Error(result.error?.message || 'Kernel unavailable');
console.log(result.value.runtime);
```

正常返回包含内核、上游和 API 版本，运行状态、当前实例身份与实际 home。`state` 也是纯读，不自动创建首个 Bot。模型目录由显式模型操作刷新，可用状态和配置状态应分别核对。

## 升级与备份

先停止节点正在执行的工作，备份 Core/Synapse/治理数据，以及各 Bot home、连接目录和可选记忆后端。安装相同发行版本后恢复同一数据路径，确认原 Bot ID、Session、连接状态与工作回执再继续使用。

停止等待内核和后台记忆整理收尾，避免两个实例争用同一库。不要仅因心跳暂时过期就夺取仍存活进程的锁。数据库格式较新或损坏时应检查备份与版本，不手改成可启动状态。

源码开发者可按包内测试脚本运行隔离检查。它们创建合成 home 和测试 provider，不能代替用户自己的网络、模型和连接器验证。
