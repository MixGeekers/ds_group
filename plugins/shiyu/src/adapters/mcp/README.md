# 控制域私有 MCP stdio 接缝

2026-11-02：`PrivateStdioMcpClient` 只提供可信控制代码使用的 stdio 连接。不注册 DSH Agent 工具、server instructions 或 resources，不创建 Session、不请求模型；构造只校验和复制受信配置，必须显式 `connect()` 才启动所拥有的子进程。

```ts
const transport = new PrivateStdioMcpClient({
  command: '/absolute/path/to/python',
  args: ['-m', 'approved_server'],
  cwd: '/absolute/isolated/server/workdir',
  env: { APPROVED_SETTING: 'explicit-value' },
});
try {
  await transport.connect({ signal, timeoutMs: 10000 });
  const tools = transport.listTools(); // detached discovery snapshot; no Agent registration
  const result = await transport.callTool({ name: 'approved_tool', arguments: {} }, { signal, timeoutMs: 15000 });
} finally {
  await transport.close();
}
```

`callTool({name,arguments})` 的结构兼容 `OmbreMcpTransport`，可由已授权的 composition 注入 `OmbrePublicApiAdapter`。它不接收模型提供的 executable、env、cwd 或配置，不认证业务 actor，也不代替 MemoryOperation/Effect 的派发许可与结果核验。`isError` 原样保留给上层；MCP success 不证明业务成功。调用异常/超时/取消/断连后连接终结，不重连或重放；单连接只准一个在途调用，后续恢复须由业务明确对账后创建新实例。

连接完成时只发现一次工具，默认最多 4 页、128 项。消息默认上限 1 MiB，可配置到 4 MiB；连接默认 10 秒、调用默认 15 秒，均最高 60 秒，外层计时覆盖整段异步操作。`listTools()` 仅返回分离的已发现 schema，工具列表通知不会自动刷新或重调。callTool 传入固定 toolDefinition，拒绝要求 task-based execution 的工具，不实现 MCP task 引擎。

客户端明确使用 `versionNegotiation:{mode:'legacy'}`，避免自动协商额外启动临时 stdio probe；关闭 `inputRequired.autoFulfill`，不声明 sampling/elicitation/roots，拒绝服务端请求。固定 toolDefinition 同时阻断 SDK 现代 header mismatch 的刷新/重发分支。没有 HTTP、OAuth UI、浏览器登录或全局 profile 修改。

stdio 使用 SDK 的 shell=false 子进程能力和默认安全环境名集合，加上明确 env；没有继承整个 `process.env`。stderr 设为 pipe 并持续排空，**不保存或输出任何正文**，只统计至默认 16 KiB（最高 64 KiB）及截断标志。错误使用固定 code/message，不输出命令、环境、后端文本或原始 SDK error。`status()` 只读 state/pid/toolCount/stderr 统计。

close 只调用本实例 Client/Transport 的公开 close，不向任意外部 PID 发信号。SDK 先关 stdin，最多等 2 秒、SIGTERM、再等 2 秒，最后必要时 SIGKILL；适配器还等待实际 transport onclose，并以 5.5 秒总期限报告 `CLOSE_UNCONFIRMED`，不将未确认的退出称作成功。它不宣称已关闭服务端另行启动的进程树或已回滚未知外部效果。

## 固定宿主证据与依赖

静态来源为本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 中 DSH `0.2.1-rc.5`。以下路径为 ASAR 内部路径，未执行宿主源码或读取 profile/凭据：

| 入口与行 | 已核查事实 |
|---|---|
| `dsh/node_modules/@deepseek-ai/dsh-mcp-client/package.json:4,40–43`、`lib/index.js:836` | 该插件 0.2.1-rc.5 依赖 client2.2.0；公开 Config/apply/createMcpToolDefinition/inject/name，未公开内部 startConnection/raw Client，不存在据此可用的 `ctx.mcp` |
| 同插件 `lib/index.js:38–46,127–153,732–742,810–833` | stdio/Streamable HTTP 配置桥会发现并注册工具，且可发布 server instructions/resources；所以控制域私有调用不挂载此桥 |
| `dsh/node_modules/@modelcontextprotocol/client/package.json:2–35,118–125` | 实际公共包为 client2.2.0、Node≥20，manifest 标 MIT；root 导出 Client，`./stdio` 导出 StdioClientTransport。依赖 core2.2.0/cross-spawn/eventsource/eventsource-parser/jose/pkce-challenge/zod；不是旧 `@modelcontextprotocol/sdk` |
| 同 client `dist/index.mjs:3126–3138,3307–3359,4210–4272,4301–4316` | 构造、connect、两参数 callTool、分页 listTools；connect 自行启动 transport，不额外手动 start |
| 同 client `dist/index.mjs:2550–2578,3362–3394,4244–4259` | legacy 默认与 auto probe；显式 toolDefinition 阻断现代 header-mismatch 重发 |
| 同 client `dist/stdio.mjs:63–134,181–205` | 公开 command/args/env/cwd/stderr/maxBufferSize、pid 与 close；仅关闭自身 spawned child |
| `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:716–758,785–795,1347–1350,1676–1728` | 安装依赖递归闭包包含 client；linked plugin 显式 peer 命中该映射，optional 不影响名称映射 |

产品声明精确 optional peer `@modelcontextprotocol/client:2.2.0`，不会绕过缺依赖；开发测试安装同版 devDependency 并锁定实际传递版本。不复制 SDK，不硬编码 ASAR import，不假称存在宿主 service。首次 npm 下载实际因 DNS `ENOTFOUND` 失败，重试同一固定安装后成功；未修改全局 npm/proxy 配置。后续宿主版本变化需复核映射与契约。

许可核查区分 manifest 与实包：npm 安装的 client/core2.2.0 `LICENSE` 描述 MIT 向 Apache-2.0 过渡；已同意和新代码采用 Apache-2.0，尚未同意重许可的旧贡献仍为 MIT，非规范文档为 CC-BY-4.0。MIT 部分版权为 Model Context Protocol a Series of LF Projects, LLC。完整说明保留在依赖自己的 LICENSE，产品 NOTICE 同步记录该差异；没有把 manifest 的 MIT 字段当作完整许可结论，也未复制其实现或文档。

## 本轮验证边界

`node --import tsx --test tests/mcp.test.ts` **8/8**、类型检查通过。测试使用真实 client2.2.0 与临时合成 JSON-RPC 子进程，覆盖 constructor 零 I/O、initialize/listTools/call 恰好一次、采样/询问拒绝、有界 stderr、错误标志、取消、超时、断连、无重试和 owned child 实际退出。测试不使用 fake client，不启动实际 Ombre 或模型；没有产品 HTTP 接口，其他 Python HTTP/Ombre 实验不能算作本模块实际联通证据。真实服务接线与业务权限仍由主实施记录单独留证。

同日后续主线程已使用此产品客户端＋Ombre 薄适配器完成真实原版 stdio 接线：独立空 vault，connect/listTools 后仅 readI 一次，固定空库答复匹配，close 与 PID 退出均确认。见[实际探针](../../../../../测试/2026-11-02-Ombre服务验证/artifacts/stdio-run.json)。这一 Node/Python 实测与上述合成 8 项、Python HTTP 主实验分别留证；仍未验证 DSH 内 peer 装载或正式记忆业务。
