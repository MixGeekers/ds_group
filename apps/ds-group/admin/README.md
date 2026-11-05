# DSCord 独立后台与治理切片

更新于 2026-11-04（America/Caracas）。本文件同时作为主聊天及中央身份、统一客户端实施聊天的接口交接入口。

## 基线、职责与状态

- 工作树：`/Users/caja/.codex/worktrees/dscord-federation-admin`，分支 `codex/dscord-federation-admin`，基线 `5078ab2`（本轮已 fetch 核对 `origin/main`）。
- 本聊天负责独立管理服务、实例管理员、治理策略、Core 路由接线、Synapse 联邦与准入门禁，以及对应部署和验证。
- 管理 UI 代码独立位于 `admin/`，不改动统一聊天客户端的 `web/src/`。只读取既有 `web/tokens.css`、`web/theme.js` 和 `web/i18n.js`。
- 中央身份、全局产品 ID 与 Matrix ID 绑定、默认归属服务由另一聊天实施；统一聊天入口由客户端聊天实施。当前兼容本服账号与完整 Matrix ID，不建立外服影子账号，不接收外服普通 access token。
- 当前为第一切片；本文件中的接口已接线。独立后台已通过真实管理 HTTP 服务和生产构建的浏览器检查。Synapse 与跨服 Bot 工作尚未作为验收通过登记；Bot 工具限制当前仅定义策略契约，因此后台暂不显示 Bot 工作菜单。

## 共享文件改动清单

供主聊天整合时核对：

| 文件 | 本切片所需改动 |
|---|---|
| `package.json` | 新增 `build:admin`、`admin:init`、`admin:start`；`typecheck` 与 `build` 包含独立后台。没有新增依赖，锁文件不变 |
| `scripts/check.mjs` | 检查后台 JS 与独立后台 TS 配置 |
| `Dockerfile`、`.dockerignore` | 构建和复制 `admin/` 与 `dist/admin`，将 Synapse 门禁源码带入运行镜像 |
| `scripts/npm-pack.mjs`、`scripts/release-pack.mjs` | 将后台产物、源码和 Synapse 门禁纳入既有发行白名单；本轮不发布发行包 |
| `scripts/server-init.mjs` | 初始化治理策略和 Synapse 模块覆盖配置，保留原身份与凭据 |
| `deploy/compose.yaml` | 新增管理服务和治理卷；Synapse 加载门禁覆盖配置。管理端口只绑定宿主回环地址 |
| `src/core.mjs` | 接入下述目录、协作空间和邀请 API；读取实时注册/上传策略；管理 API 不由聊天监听器承载 |

根 `vite.config.ts`、聊天前端、账号实现和启动 CLI 当前未改。后台使用 `admin/vite.config.ts` 与 `admin/tsconfig.json`。后续 CLI 若需要 `dscord admin` 子命令，可由主聊天协调接入已独立提供的 `src/admin.mjs` 与 `scripts/admin.mjs`。

## 客户端 API 契约

客户端始终向登录账号的归属 Core 发送普通聊天 token，Core 只将它发送给配置好的归属 homeserver。访问伙伴的公开站点不附加该 token。

| 接口 | 契约 |
|---|---|
| `GET /api/bootstrap` | 保留旧字段，新增 `serverName`。公开 `participants` 继续只含本服身份，不公开准入名单。中央身份可追加映射元数据，现有 `id` 仍为 Matrix ID |
| `GET /api/directory` | 归属服聊天会话认证，返回 `{participants:[{id,name,kind,ownerId?,localpart?,homeServer}]}`。包括本服身份及当前已准入的外部身份。外部 Bot 的 owner 信息仅作资料，不能成为本服所有权凭据 |
| `GET /api/spaces` | 归属服会话认证，返回 `{homeServer,userId,spaces:[{serverName,name,home,status,rooms,invitations}]}`。只根据真实 `/sync` 成员关系、邀请及本服政策组织空间；`status` 为 `connected` 或 `revoked` |
| `spaces[].rooms[]` | `{roomId,name,status:'joined'|'restricted',canSend,authoritySource}`。优先采用管理员登记的房间与服务器关系；创建者域名仅作兼容推断。已加入但被撤权的空间仍可被展示为受限 |
| `spaces[].invitations[]` | `{roomId,name,inviterId,canJoin,status:'invited'|'approval_required'}`。伙伴不等于全部账号准入，`canJoin` 还需本服的精确房间与身份规则 |
| `POST /api/rooms/:roomId/join` | 必须有已启用的精确房间规则；外服房间需本服身份在 `memberIds`、伙伴启用及实际 Matrix 邀请。通过归属 homeserver 加入，保留完整账号 ID |
| `POST /api/rooms/:roomId/leave` | 当前归属账号离开该 Matrix 房间 |
| `POST /api/rooms/:roomId/invite` | 保留本人 Bot 的旧路径。外部成员必须在本服准入与精确房间规则中，普通房间成员的邀请还受 Matrix 自身权限限制。外部邀请返回 `status:'invited'`，不会拿远端凭据代为加入 |

既有 `/api/rooms`、消息和私聊接口继续兼容。外服私聊、附件的房间证明读取与跨服 Bot 工作门禁属于后续切片，不通过发现按钮冒充已验收。中央产品 ID 的新字段由主聊天统一，服务器名和 Matrix ID 保持不可随意迁移的既有归属。

## 独立管理 API 与策略

监听默认 `127.0.0.1:18110`，可用独立管理域名或管理网络反向代理。`/admin-api/*` 只接受本实例签发、`dscord_admin_` 前缀的管理会话；会话哈希、角色和密码 scrypt 保存在 `administrators.sqlite`。有效期 8 小时、空闲上限 1 小时。没有管理 cookie，也不开放跨域 CORS。普通聊天 token、房间管理员和另一实例管理员会话均不能调用本实例管理 API。

| 接口 | 职责 |
|---|---|
| `POST /admin-api/login`、`logout`，`GET me` | 独立实例管理员认证与会话 |
| `GET /admin-api/overview` | 身份、服务状态、应用状态与不含凭据的存储摘要 |
| `GET /admin-api/policy`、`PUT /admin-api/policy` | 读取、以 revision CAS 保存伙伴、外部成员、房间、Bot 限制和本服设置 |
| `POST /admin-api/apply` | `{revision}`。准备 Synapse 配置并逐房间应用邀请制、成员撤权、ACL 和公开工作限制。失败逐房间保留，网络变更仍需外部重启 |
| `POST /admin-api/invite` | `{revision,roomId,memberId}`，只邀请已批准的精确成员到本服房间 |
| `GET /admin-api/administrators`、`PUT /admin-api/administrators` | 列出、增改实例管理员；只有 owner 可写。变更撤销该管理员全部会话，至少保留一位有效 owner |
| `GET /admin-api/audit?before=SEQUENCE` | 每页最多 100 条管理审计，不含密码和会话 token |

角色为 `owner`、`operator`、`auditor`。后两者分别具有运维写权限和只读权限，均不能增改管理员。

策略位于 `DS_GROUP_GOVERNANCE_DIR/policy.json`（缺省 `DATA_DIR/governance/policy.json`）。字段见 `src/governance.mjs`。伙伴域名、完整外部成员、精确房间、Bot 工作限制和管理员分别保存。新策略须由运行中的门禁模块读取后，才改变动态准入检查；`apply` 负责实际成员封禁和 ACL。配置保存、房间应用、待重启及模块观察到的版本分别展示，不能用一次保存回执代替实际生效。

## 本机使用

```sh
npm ci --ignore-scripts
npm run build:admin
DS_GROUP_DATA_DIR=/path/to/core-data npm run admin:init
DS_GROUP_DATA_DIR=/path/to/core-data DS_GROUP_SYNAPSE_DIR=/path/to/synapse npm run admin:start
```

初始化只允许本机命令行且实例尚无管理员。未通过环境变量提供密码时，随机密码写入私有文件 `initial-administrator.json`，终端只返回路径。记录到密码管理器后可移除该文件。

Compose 新增 `administration` 服务；通过 `docker compose -f deploy/compose.yaml exec administration node scripts/admin.mjs init` 初始化管理员。`http://127.0.0.1:18110` 是独立后台入口。公共 HTTPS 聊天代理不自动公开管理端口。

## 门禁依据及验收边界

固定官方 Synapse 1.164.2，模块使用正式 `user_may_invite`、`user_may_join_room` 回调及第三方事件检查。后者具实验性质，本项目固定版本并以真实 Matrix 直连验证。模块只对本服事件与本服权威房间的新成员做准入；远端聊天历史不任意重写，以免房间事件图分叉。撤权通过真实封禁与 ACL 协调。已复制历史不会因撤权变成未披露。

来源：[Synapse 准入回调](https://element-hq.github.io/synapse/latest/modules/spam_checker_callbacks.html)、[第三方事件回调及联邦限制](https://element-hq.github.io/synapse/latest/modules/third_party_rules_callbacks.html)、[联邦域名名单](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#federation_domain_whitelist)、[Matrix server ACL](https://spec.matrix.org/latest/client-server-api/#mroomserver_acl)。上一轮完整设计和来源保留于主工作树 `research/2026-11-04-跨服务器与独立后台/方案与来源.json`。

## 本轮验证

独立后台 TS7 类型检查与生产构建通过。新增 7 项安全/契约模块检查通过，真实管理 HTTP 服务配合合成 Matrix 控制适配器完成 12 项生产界面检查，覆盖登录、策略表单、保存版本、应用失败、管理员、审计、中英/亮暗、手机布局和只读角色。该层不等于真实 Synapse 验收。

浏览器首轮发现 select 的标签包含选项文本，修补为显式 `label/for`；第二轮暴露退出后保留旧页与界面状态，修补为退出即清空管理数据并回到概览。两轮失败独立保留。全量模块及发行夹具更新的最终结果见 `artifacts/governance/foundation-validation.json`。真实联邦、真实模型和物理跨机器均未在本切片运行。

后台新增代码已按可审阅格式展开，保存提示收敛到保存、应用及实际观察到三个独立状态。格式切片的 7 项治理模块、12 项后台浏览器检查及后台构建通过，见 [后续验证](../artifacts/governance/format-validation.json)。

## 真实联邦增量

三套独立 Synapse/Core/后台部署在一台物理主机，端口为 24100–24150。9 项真实场景与 288 项模块通过，包含真实 C 签名请求、双向文本/媒体、直连越权、断线补收、真实封禁及重新批准。详见 [联邦汇总](../artifacts/governance/federation-validation.json)与[端点及命令](../artifacts/governance/endpoints.json)。此增量的媒体证据是 Matrix 真实存取；Core 的房间证明读取和可信工作策略 v1 在下一切片。模型调用为 0，物理跨机未验。

使用 `node scripts/federation-lab.mjs up|verify|status|down --data-root DIR --project NAME --port-base PORT` 可创建独立合成部署；`reload` 只重启该目录登记的 Core/后台，`refresh-guard` 更新并重启本样本门禁，`refresh-tls` 仅更新本样本测试证书。默认数据位于 `.local/federation-lab/`，所有账号和密钥被 Git 排除。测试的私有 IP 联邦及自建 CA 仅属于该隔离验证，不进入生产默认配置。

Matrix ACL 不区分端口。本轮核对官方规范及固定 Synapse 源码后，以主机名作为有效 ACL 图案，并附带固定 Synapse 本地校验器所需的完整含端口名称。真正的伙伴名单和成员完整 ID 仍精确包含端口；ACL 不能独立隔离同一主机名的不同端口。
