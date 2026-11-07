# 独立 DSH 节点适配器

本模块为 DSCord 0.4.0-alpha.1 的独立 CLI 节点提供 HTTP 桥接。在独立 DSH 宿主中运行 `dscord-kernel`，由 Matrix 适配进程接收消息并回传结果。直接安装到正在使用的 DSH 的图形连接插件位于 [`dsh-connect/`](../dsh-connect/KERNEL.md)，两种运行方式的数据与模型配置方式不同。

## 兼容与依赖

Node 支持范围 `>=24.19.0 <25` 来自 [package.json](../package.json)。DSH 接入固定为官方 `@deepseek-ai/dsh@0.2.2-rc.1`，版本常量见 [runtime-config.mjs](../scripts/runtime-config.mjs)；内核依赖该 SDK 的原生 Session、inbox、工具、附件和生命周期服务，见[宿主契约](../dsh-connect/KERNEL.md)。不应据此假定其他 DSH 版本可用。

内核基于 DS-Bot 0.3.1，来源和许可保存在 [UPSTREAM.json](../vendor/ds-bot/UPSTREAM.json)、LICENSE 和 NOTICE。运行依赖由 [runtime-dependencies.json](runtime-dependencies.json) 及其锁文件定义，启动器准备私有依赖目录并核验版本。SDK imports 解析到实际宿主，运行库解析到私有目录，无需手工复制依赖到源码树。

## 启动和停止

先按[节点导出与导入](../deploy/README.md#cli-节点导出)取得属于该 Bot 的配置。已有 `nativeBinding` 的 Bot 必须从所属 DSH 连接，不能以独立 CLI 建立身份副本。

以下命令从应用或发行包根目录执行。账号部分、数据路径和空闲端口均须替换；`BOT_ACCOUNT` 是 Matrix ID 中 `@` 与 `:` 之间的部分。

```sh
BOT_ACCOUNT='your-bot-account'
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-nodes/$BOT_ACCOUNT"
export DS_GROUP_BRIDGE_PORT=23100
node scripts/dsh-node.mjs start "$BOT_ACCOUNT"
node scripts/dsh-node.mjs status "$BOT_ACCOUNT"
node scripts/dsh-node.mjs stop "$BOT_ACCOUNT"
```

这些命令只管理 DSH 宿主，Matrix 适配进程按部署指南另行启动。`dsh-node.mjs run` 用于服务管理器前台运行。每个独立 Bot 使用自己的 home、配置目录与桥接端口；同一个 Bot 不同时运行两个接入进程。

模型与所需凭据从部署者指定的 `DS_GROUP_DSH_SOURCE_HOME`、`DS_GROUP_DSH_SOURCE_PROFILE` 读取。`DS_GROUP_MODEL='provider/model-id'` 是引用格式示例，不是指定模型。未指定来源时 CLI 回退到用户 home 下的 `.dsh` 和 `desktop` profile，应按实际安装核对。[模型和额度](../模型配置与迁移.md)

## HTTP 接口

接口供节点适配进程使用，不是公开互联网聊天入口：

| 方法与路径 | 用途 |
|---|---|
| `GET /api/ds-group-node/status` | 当前节点、Bot、Session 与进程状态 |
| `GET /api/ds-group-node/models` | 模型目录元信息 |
| `POST /api/ds-group-node/bots` | 注册外部 Bot 身份与内核身份的映射 |
| `POST /api/ds-group-node/turns` | 提交 `requestId/botId/event/history/files`；异步模式返回 202 |
| `GET /api/ds-group-node/turns/:requestId` | 查询任务、工具和成果回执 |
| `POST /api/ds-group-node/turns/:requestId/cancel` | 取消排队或执行中的工作 |

同 Bot 串行。相同完整请求重试复用持久回执，同 ID 不同内容拒绝；不明完成状态保存为 `unknown`。完成回执包含文字、实际文件、Session、用量及工具回执，模型输出协议由 [runtime-rules.mjs](runtime-rules.mjs) 定义。未知状态不构成成功证明。

## 工具与交付

兼容适配器开放其实际工具目录，默认每任务最多 64 步、15 分钟；这是该适配器的默认值，不是所有原生 Bot 的统一上限。原生图形节点使用自己的内核和 DSH 权限配置。

适配层核对成果文件并上传，普通任务回当前会话，明确私聊交付按原始人类发起者解析私聊。Bot 委派保留 `returnTo` 与原始交付关系。发送计划和 Matrix transaction ID 持久化，恢复不依靠重新猜测收件人。

该适配器的模型 stream 向 Core 申请并回报预算。provider 内部重试与完整费用仍需服务商账单核对；这套 CLI 预算不覆盖原生图形连接的全部调用。
