# DSCord 内核运行与检查

DSCord 的 Bot 运行时为 `dscord-kernel`，当前内核版本 `0.4.0`、管理 API 版本 `1`，基于 DS-Bot `0.3.1`。发行宿主固定为官方 `@deepseek-ai/dsh@0.2.2-rc.1`，使用 Node `>=24.19.0 <25`。Linux amd64 和 arm64 是服务器发行目标。

## 聊天服务器入口

在源码的 `apps/ds-group/` 或解压后的发行包根目录执行。首次部署先编辑 `deploy/.env` 中的身份域和公开地址，详细参数见[服务器部署](README.md)。

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
curl --fail http://127.0.0.1:18100/readyz
```

`/healthz` 检查 Core 进程；`/readyz` 同时检查 Matrix。默认浏览器入口为 `http://localhost:18100`。公开 HTTPS 部署使用[HTTPS overlay](README.md#https-和手机通知)。Docker 数据卷与 DSH Bot 数据目录各自持久保存。

## Bot 宿主与数据归属

在 DSH 中安装同版本 DSCord 包后，由 DSCord 持有 Bot 内核生命周期，管理 API 为 `/api/dscord/kernel`。每个实际 Bot home 只能有一个运行内核；另一个 DSCord 实例或仍活动的旧 `ds-bot` 插件会得到 `DSCORD_KERNEL_CONFLICT`。升级已有 DSH 时先停用旧 `ds-bot` 插件，再重载 DSCord。

原 Bot home 在原位置接管，保留 Bot 和原生 Session 身份。首次接管会在该目录的 `migrations/dscord-0.4.0/` 保存状态快照与接管记录，生命周期写入 `dscord-kernel.json`。程序不会要求用户复制 Session 到第二套运行目录。启动、停止和重新启动分别更新生命周期；健康查询不自动创建 Bot。

独立远端节点使用[节点导入与启动](README.md#cli-节点导出)或[systemd 单元](systemd/README.md)。不同 Bot 使用各自的 home、配置目录和桥接端口；同一个 Bot 的 DSH 与 Matrix 适配进程共享自己的节点配置。不要让两个服务同时运行同一份节点配置。

已经绑定原生 Bot 的导出文件含 `nativeBinding`，只能从所属 DSH 的 DSCord 连接。独立 CLI 会在创建 home、依赖或子进程前返回 `DSCORD_NATIVE_BOT_HOST_REQUIRED`，避免把原身份复制到另一套内核。明确创建全新独立成员且没有已有绑定的节点仍可使用独立启动入口。

固定运行依赖包括 MCP client `2.4.0`、deep-view `0.1.2`、imapflow `2.9.1`、mailparser `3.12.4`、nodemailer `10.2.1`、YAML `2.9.1` 和 zod `4.6.7`。启动器按随包的 npm/pnpm 锁安装私有依赖并核验版本和入口，随后将 vendored 代码的依赖解析到该目录，DSH SDK 则解析到实际宿主。用户无需手工复制依赖目录。zod 从已有传递依赖提升为直接冻结依赖的核对见[依赖收尾记录](evidence/zod-direct-dependency.json)。

## 健康查询

在已经登录 DSH 的同源页面中，可调用以下只读接口。`state` 同样不会自动建立首个 Bot；创建由用户操作或明确的 `create-bot` 请求触发。

```js
const response = await fetch('/api/dscord/kernel', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ endpoint: 'kernel-info', payload: {} }),
});
const { ok, value } = await response.json();
console.log(ok, value.runtime);
```

正常运行时 `runtime` 包含 `id: "dscord-kernel"`、`version: "0.4.0"`、`upstreamVersion: "0.3.1"`、`apiVersion: 1`、`status: "running"`、当前 `instanceId` 与实际 `home`。重启后 `instanceId` 更新，原 home 和身份保留。

## 隔离的零模型检查

下列命令在发行包根目录安装独立测试宿主，然后运行真实 DSH 检查。脚本创建合成 home 和本地拒绝所有请求的 provider，不读取用户 DSH 配置或真实凭据，也不使用业务模型。

```sh
npm install --prefix .local/dsh-install --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1
export DS_GROUP_DSH_RUNTIME="$PWD/.local/dsh-install"
npm run test:kernel-host
node scripts/kernel-runtime-smoke.mjs
node scripts/runtime-smoke.mjs
```

`test:kernel-host` 使用固定宿主的真实 SDK 编译内存工具，验证 basis reference 的必填字段、整数修订号和额外字段限制，并运行内核与合成 CLI 契约检查。`kernel-runtime-smoke` 检查 owner API、初始纯读空状态、同 home 重复运行拒绝，再明确创建一个不问候的 Bot，实际编译记忆及文件工具并核对重启后的 Bot/Session 身份。`runtime-smoke` 检查独立节点的模型配置及中断请求不重放。两个运行报告分别写入 `.local/kernel-runtime-smoke.json` 和 `.local/runtime-smoke.json`。成功后清理合成 home；失败时保留私有诊断目录并在报告中指明路径。

`npm run runtime:native-check` 与 `npm run runtime:work-check` 进一步用本地脚本 provider 验证完整原生工具、自动记忆回顾和实际文件工作。它们会分别记录本地脚本响应次数，远端业务模型调用为 0。

CI 保留十项正式门禁：四组 Linux/Node、两组 Docker/Compose、两组独立 DSH、一组浏览器和一个汇总门禁。DSH 检查从经过 SHA-256 校验并提取的发行源码执行。容器和同机独立宿主证据不代表物理跨机器的网络与故障环境已经验收。
