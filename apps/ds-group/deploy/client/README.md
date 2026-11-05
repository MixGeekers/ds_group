# 独立聊天客户端

客户端产物为 `dist/web/`，可以由中央平台或独立静态 HTTPS 服务托管。运行时不需要 Core 源码、Matrix 凭据、Node 管理密钥或运维后台。产品界面只在 `/` 和 `/index.html` 运行，PWA 的 scope 是当前客户端 origin 的 `/`；本切片不支持挂到 URL 子目录。

## 构建和配置

在 `apps/ds-group/` 执行：

```sh
npm ci --ignore-scripts
npm run build
```

将 `dist/web/` 的完整内容部署到静态站点根目录。将 [client-config.example.json](client-config.example.json) 的内容保存为站点根目录 `client-config.json`，填写已经确定的归属 Core 和 Matrix origin。若在构建前修改 `web/client-config.json`，构建会校验公开字段并把文件连同应用壳纳入 PWA 版本；在部署后修改时也需要使 `client-config.json` 网络可更新。

```json
{
  "schemaVersion": 1,
  "homeCoreUrl": "https://core.example.com",
  "homeMatrixUrl": "https://matrix.example.com"
}
```

`authUrl` 可显式指定受信任的认证 origin，默认与 `homeCoreUrl` 相同。当前中央身份服务的登录接口由归属 Core 提供，通常无需单独指定。独立部署的新增地址必须是完整 HTTPS origin，不能带账号、密码、路径、查询或片段；本机验证允许 HTTP loopback。既有 HTTP 同源网页继续使用其原 origin，包括 HTTP 私网 Core 和从该服务发现的私网 Matrix 地址。普通 token 仍只发往固定 Core；HTTP 私网网页不能使用浏览器要求安全上下文的 PWA 和系统推送能力。配置文件只允许这四个公开字段，不接受 token、密码或管理凭据。

原有同源部署继续使用 `{"schemaVersion":1}`，已有没有该文件的服务在文件返回真实 404 时回退同源。配置返回 HTML、其他错误或不合法地址时会停止启动，避免误把错误配置当成登录入口。客户端不从 URL 参数、远端发现或旧存储数据改写归属服务。

静态服务可参考 [nginx.conf](nginx.conf)，并由现有 HTTPS 入口终止 TLS。`sw.js`、`index.html` 和 `client-config.json` 应支持更新，带内容哈希的 `/assets/` 可以长期缓存。独立静态服务无需代理 `/api/`；客户端会请求配置中的 Core。正式发布及公共 TLS 由主线程协调，本切片没有执行生产部署。

## 归属服务允许的客户端

中央身份服务的 `identity.clientOrigins` 必须包含实际客户端 origin，例如 `https://client.example.com`。CORS 需要允许 `Authorization`、`Content-Type`、`X-Upload-Id` 和对应业务方法。浏览器所有业务请求均设置 `credentials: omit`、`redirect: error`，不依赖 cookie。登录密码只交给固定认证入口，普通 Matrix token 只交给固定归属 Core。远端协作使用归属 Core 的 `/api/spaces` 和完整 Matrix 房间 ID，不把普通 token 发送给外服 Core。

`/.well-known/dscord/client` 的 `authorityId`、归属 Matrix server name 及返回会话中的稳定主体会相互核对。修改归属配置会产生另一组会话和草稿作用域；旧未绑定 `ds-group.session` 只在原同源入口迁移。既有房间、草稿、待确认消息按原完整身份保留，确认发送前保持原 transaction ID。

## PWA、附件和通知

service worker 从静态客户端 origin 注册并只缓存应用壳。API、发现响应、消息和附件不进入离线缓存；断线时保留各身份及空间的草稿，重连后重新核对归属与成员资格。上传、下载和元信息请求使用同一个固定 Core，附件预览使用鉴权读取后的 blob URL。

上传使用 `fetch` 以阻止重定向，保留取消和幂等上传 ID；浏览器未提供 fetch 上传进度时显示待完成状态，实际成功由附件回执确认。跨服附件读取会带原消息的完整 `roomId` 作为证明上下文；真实外服媒体读取还需要服务端的相应实现和联调，不能由发现地址代替。

通知订阅属于客户端 origin，订阅管理请求仍交归属 Core。worker 保存的接收人绑定只有完整 userId、homeCoreUrl 和 authorityId，没有 token 或消息。通知后端应在 `payload.data` 带这三个字段及完整 `roomId`、`eventId`，以便过滤旧身份推送并安全导航。旧后端未带接收人信息的推送只显示通用 DSCord 通知并打开主页，不自动打开消息。手机系统推送送达和真实外服附件在本切片之外继续单独验收。

## 可重复验证

```sh
node --test tests/unified-client.test.mjs
node --test tests/unified-client.browser.mjs
npm run test:browser
```

正常生产入口的浏览器夹具使用 24360–24363 端口；已占用时会失败并关闭自己启动的服务，不终止已有进程。API 为合成夹具，浏览器和 service worker 使用真实生产构建。结果写入 `.local/unified-client-browser/`，公开的脱敏证据见 [统一客户端实施记录](../../统一客户端实施记录.md)。真实中央 Core/Synapse 和 A/B/C 联邦另行记录。
