# UI 基础组件实施记录

更新于 2026-11-05（America/Caracas）。用户批准采用 **shadcn/ui + Base UI**，授权在聊天客户端与独立服务器后台建立共享基础组件、迁移全部可见表单并要求真实渲染截图。实施位于 `codex/dscord-platform-integration`，起点 `1f38cc5`；首批本地提交为 `a515a02`，第二批覆盖其余表单。本记录不改变中央账号、服务器管理权限或 Bot 任务边界。

## 首批范围

- `ui/` 保存共享按钮、输入、文本域、原生选择器、Base UI Popover/Dialog、`cn` 和 Tailwind theme/utilities。Tailwind Preflight 未导入；既有 token、系统/明暗偏好、五种强调色和中英文继续由页面根节点驱动。
- 左栏底部头像打开账号浮层；个人设置的账号、外观、通知页使用共享控件。设置关闭后焦点回到可见头像。PWA 的 DOM 监听在持久挂载的 Dialog Portal 就绪后连接；通知网络恢复后清除旧刷新错误。
- 独立后台的准入成员、伙伴服务器、房间和 Bot 政策表单采用共享输入/选择控件；邀请使用显式提交按钮。窄屏导航自动将当前页完整滚入可见范围。
- Docker 前端构建、源码发行包和 npm 预构建产物均纳入新组件及许可证。新增的 `ui/` 属产品源码，`.local/ui-foundation-review/` 截图及合成运行数据不入 Git。

## 固定来源与许可

| 来源 | 固定版本或提交 | 许可 |
|---|---|---|
| shadcn/ui Base registry，可编辑组件形态 | `8a3536678a528cc012b9e62484290e79d0be410f` | MIT |
| `@base-ui/react` | 1.9.0 | MIT |
| `tailwindcss`、`@tailwindcss/vite` | 4.3.4 | MIT |
| `class-variance-authority` | 0.7.1 | Apache-2.0 |
| `clsx`、`tailwind-merge` | 2.1.1、3.7.0 | MIT |

上游许可证文字及实际复制来源归档在 `web/licenses/ui-foundation.txt`；构建将该通知复制到 `dist/web/licenses/` 与 `dist/admin/licenses/`。Lucide 沿用既有 1.68.0 和原许可文件，本切片没有替换图标体系。依赖版本由 `package-lock.json` 固定。

## 第二批表单清单与实现

| 入口 | 覆盖的表单或操作 | 采用的共享控件 |
|---|---|---|
| 聊天账号 | 登录、注册、密码显示、账号外观设置 | Base Button/Input、NativeSelect |
| 聊天协作 | 建群、邀请成员、Bot 创建与管理、Bot 工作授权、身份组、服务器发现与加入 | Base Button/Input/Checkbox、Textarea、NativeSelect、原生 ColorInput |
| 聊天消息 | 通知偏好、收件箱筛选、富文本消息发送和附件选择 | Base Button/Checkbox/RadioGroup/Radio、原生 FileInput |
| 独立后台 | 登录、伙伴/成员/房间/Bot 政策、房间邀请、部署设置、管理员账号、导出和审计操作 | Base Button/Input/Checkbox、Textarea、NativeSelect |

两入口应用 TSX 中不再直接写 `input`、`select`、`textarea` 标签。共享 `Checkbox` 与 `RadioGroup/Radio` 使用 Base UI 正式原语和状态回调；隐藏原生 input 参与 FormData。共享封装在未受控表单的有效 `reset` 后重建可见控件状态，取消的 reset 保持现状。禁用状态显式传入 Base UI 组件，不能只依赖 HTML `fieldset`。NativeSelect 遵循 shadcn 的原生选择器形态，保留浏览器键盘与表单契约；文件、颜色输入保留浏览器原生能力，统一由共享封装与 token 呈现。富文本编辑区继续使用既有提及、IME 和附件生命周期。

建群成员选择项同时显示名称与完整 Matrix ID；同名的跨服人类和 Bot 在窄屏仍可辨认，提交继续使用精确 ID。收件箱两类筛选改用按钮组与 `aria-pressed`，选中样式跟随该状态。

## 本轮实测

| 检查 | 结果 | 证据级别 |
|---|---|---|
| `npm run typecheck`、`npm run build` | 通过，TS7 与两个 Vite 生产入口生成 | 本轮本机实测 |
| `npm run check` | 第二批完成后 376/376 模块通过，包含源码发行及 npm 打包约束 | 本轮本机实测 |
| `npm run test:browser` | 第二批完成后 10/10 浏览器文件通过；真实 Chromium、合成 API、模型调用 0 | 本轮本机实测 |
| 独立后台邀请 | 从表单按钮经实际管理 HTTP API 提交，回执和精确成员/房间/版本已断言 | 本轮浏览器合成服务实测 |
| 焦点、Escape、外部关闭、手机导航、主题/语言持久化、草稿与账号切换 | 正常产品入口与设置夹具通过 | 本轮真实 Chromium 合成数据实测 |
| 通知启用、测试、安装提示、断网错误后恢复 | 真实按钮键盘激活及 PWA DOM 事件，Web Push 和安装能力由夹具提供 | 浏览器交互通过，非真实推送送达 |
| 共享表单语义 | FormData、有效与取消的 reset、fieldset 禁用、标签点击、键盘选择；后台管理员保存后的 reset | 本轮真实 Chromium 夹具与后台 HTTP 页面实测 |
| 建群跨服身份 | 两位同名 Bob、两位 Helper 显示完整 Matrix ID，390px 手机图无横向溢出 | 生产 web 入口、合成身份实测 |

首批第一次全套浏览器运行因旧 React App 夹具未加载新增共享浮层样式而失败；补齐夹具 CSS 后 9/9 通过。先前 PWA Portal 初始化过早和后台邀请按钮缺少 `type="submit"` 也由针对性测试发现并修复。第二批首次测试因旧用例点击 Base UI 隐藏 input 失败，改为点击可见角色控件后通过；目视截图发现建群复选框被旧 flex 样式拉长，已修复。独立探针又发现原生 reset 只恢复隐藏 input、不恢复 Base UI 可见状态，封装修复后有效与取消的 reset、后台实际页面均通过。失败及复验均保留为本轮历史，不当作真实服务器验收。

实际 27 张截图位于被忽略的绝对路径 `/Users/caja/.codex/worktrees/dscord-platform-integration/apps/ds-group/.local/ui-foundation-review/`，`manifest.json` 列出每张图、视口、语言、主题、实际回环抓取地址和合成数据。聊天主流程图来自生产 web 构建的正常入口、独立合成归属服务；后台图来自实际 `createAdmin` HTTP 服务及合成控制器；身份组表单图来自真实 React 组件的浏览器夹具。独立共享控件夹具与生产入口一样加载 Tailwind Vite 插件、`ui/tailwind.css` 和 `ui/styles.css`；角色图另断言名称输入框宽度至少达到表单宽度的 95%。此前角色图只加载共享 CSS，名称框偏窄，该旧图已被重新生成的截图替换。抓取端口在测试完成后关闭，可运行 `node --test tests/unified-client.browser.mjs tests/admin.browser.mjs tests/ui-controls.browser.mjs tests/react-settings.browser.mjs` 重现。物理跨机、真实手机推送和真实模型行为没有在本 UI 切片中执行。生产构建仍有 Vite 对大于 500 kB 的聊天 JS chunk 与非 module 主题脚本的非阻断提示。

## 验收边界

本轮截图和浏览器检查使用真实 Chromium 与产品入口，但账号、消息、管理控制器和推送行为使用合成夹具。跨物理机器部署、真实 Matrix 服务和真实模型业务闭环分别按其实施记录验收，不能由本 UI 切片推定通过。

## 全局 Bot 导航与稳定弹窗（2026-11-05）

本切片将“我的 Bot”从服务器频道侧栏移至最左全局 rail。进入后，二级侧栏只列归属当前账号的 Bot，逐行显示完整 Matrix ID，并提供管理、新建入口；选中自己 Bot 的私聊后，服务器 rail 不再高亮，频道列表不再展示。点击已高亮的 Bot 入口保留当前私聊及草稿；从服务器回到 Bot 区优先恢复最近已验证的自己 Bot 私聊。服务器频道和 Bot 私聊分别保留最近选择：合成夹具中先选归属服务器第二频道，再进入 Bot 私聊，点击归属服务器仍回到第二频道。私聊继续使用归属 Core 的 `/api/dm`，房间仍由归属 Matrix 提供；仅在 Bot 实际属于群房间时显示在群成员栏。账号、房间、草稿和未读仍按完整身份与空间隔离，未增加后端路径。

Base UI 设置弹窗与原生弹窗采用固定外框高度：标题及底部操作留在外框内，内容区单独滚动。设置的账号、外观、通知页签共用同一外框；语言切换、通知加载或网络错误不会改动位置。外观页桌面把语言和主题排成两列，手机保持单列；桌面连接状态在未滚动时完整可见。短屏以 `100dvh` 上限压缩外框，输入焦点和底部按钮保持可达。群组、Bot、身份组、服务器、登录、收件箱、通知、任务记录、成员资料和附件预览使用同一布局约定。服务器相关弹窗沿用共享 Button/Input/Checkbox 与现有语义 token。聊天顶部、消息行和输入框共用 24px 桌面/16px 手机水平基线；输入框添加、文字和发送控件垂直中心一致。

本轮 `react-settings.browser.mjs` 在真实 Chromium 组件夹具中对设置三页签、通知错误、中文及短屏运行 `boundingBox` 断言：桌面 1000×850 时均为 `(180,105,640,640)`；390×844 时均为 `(8,102,374,640)`；390×540 时外框为 `(8,8,374,524)`，输入可聚焦且底部按钮在视口内。身份组列表/编辑、通知加载/就绪和收件箱筛选也通过固定外框断言。`unified-client.browser.mjs` 重新构建生产 Web，在独立静态与归属 Core 合成 HTTP 服务上验证同名跨服 Bot 的精确 ID、不同所有者排除、全局私聊上下文、归属路由、草稿与未读、刷新、迟到响应、第二频道恢复和真实群成员边界；此轮 26 项检查通过，模型调用 0。实际测得桌面消息正文与输入文字起点分别为 x=392/393，消息头像与输入框外框起点为 x=338/336，添加/输入/发送控件中心均为 y=945。全量 `npm run check` 为 376/376、`npm run test:browser` 为 10/10。合成服务器不是实际 Matrix 服务，物理跨机与模型行为不在本轮复验范围。

截图位于被忽略的 `.local/unified-client-browser/` 与 `.local/react-settings-browser/`：`desktop-server-with-bot-rail.png`、`desktop-global-bots-from-server.png`、`desktop-owned-bot-dm.png`、`mobile-owned-bot-navigation.png`、`mobile-owned-bot-dm.png`，以及 `settings-{account,appearance,notifications}-desktop.png` 与手机设置图。两个浏览器脚本可重复生成这些截图与 JSON 结果。

同日对首次 Bot 私聊偶发停留在选择页的报告做了限定诊断。真实预览 986×822 视口的 DOM 命中测试显示，首次点击全局“我的 Bot”后，财务 Bot 按钮中心命中 `#panel-backdrop`，第一下实际关闭了遮罩。合成浏览器在相同视口复现：成员抽屉沿用 1180px 断点，而 Bot 入口误将其当作 760px 手机侧栏断点，开启了遮罩。现将手机导航判断独立为 `max-width: 760px`，跨到更宽视口时关闭手机侧栏；986px 下 Bot 按钮可直接命中，首次点击会发送 `/api/dm`。此外，生产构建加合成服务将首次 `/api/dm` 响应延后 3.2 秒、跨过后台刷新周期：原界面会在请求期间无提示地停留在选择页，响应释放后正常打开私聊。现增加明确的“打开中”状态，手机关闭侧栏后也能在主区看到，成功或失败会清除；手动切换服务器后的迟到响应仍不能抢回导航。没有修改请求 guard 或后端。定向 `unified-client.browser.mjs` 28 项与 TS7 类型检查通过；本次合成证据为 `.local/unified-client-browser/report.json`、`medium-owned-bot-navigation.png` 和 `desktop-owned-bot-opening.png`。修复后的真实预览尚待更新并复核。

随后修补刷新时 `/api/me` 尚未返回的 Bot 归属跳变。此前本地房间和目录先恢复，`ownedBots` 初值却为空，已有自己的 Bot 私聊短暂显示为服务器上下文，Bot 也进入服务器私聊联系人。现只缓存通过 `/api/me` 验证、且与归属 authority、subject 和 Matrix 用户精确绑定的 Bot 列表，供同一身份刷新及离线展示；新 Profile 返回后更新，退出时移除当前身份的快照。缓存只控制展示，私聊创建和管理授权仍由服务端处理。旧会话没有归属快照时，直接私聊显示中性加载态，全局计数显示省略号，待 Profile 核实后再决定归属；加载期间 Bot 不进入服务器联系人。986px 静态侧栏也不再显示只对 760px 以下手机抽屉有效的关闭按钮，成员抽屉原断点不变。生产构建的 Chromium 合成测试将 `/api/me` 响应保持在途，分别验证了已有快照和只有旧房间缓存两条路径，并验证退出后缓存清除，以及 986px/手机关闭按钮行为：定向 30 项通过，页面错误、路由失败和模型调用均为 0；TS7 类型检查通过。截图为 `.local/unified-client-browser/owned-bot-refresh-profile-pending.png` 与 `owned-bot-refresh-legacy-loading.png`。这是单机合成服务证据，更新后的真实预览刷新行为待复核。

## 管理后台与主线程最终验收（2026-11-05）

独立后台已统一侧栏、页面标题、列表与编辑器的布局，以及状态条、操作按钮、边框和表面颜色。桌面采用列表与编辑器双栏，窄屏顺序堆叠。策略状态与保存、应用操作集中在相关页面，其他页面按实际待处理状态显示入口。品牌使用已有鲸鱼气泡图的灰度透明遮罩。移除当前编辑记录后会重置编辑器。常见管理员认证、权限和会话错误按当前语言显示，未知错误保留原始内容。侧栏角色与成员类型使用对应翻译，策略编辑文案明确说明暂存、保存、准备并应用的顺序。

主线程在代码提交 `1919f68` 上完成生产构建、376/376 模块检查和 10/10 浏览器文件检查。统一客户端包含 30 项场景，独立后台包含 22 项场景，消息编辑器包含 9 项场景。Docker `frontend` 构建通过，镜像为 `dscord-ui-consistency-review:local`。最终日志位于 `.local/ui-consistency-acceptance/parent-{build,check,browser,docker}-final-ui.log`。构建继续报告聊天 JS chunk 大于 500 kB 和非 module 主题脚本的非阻断提示。

本机实际预览已更新，聊天入口为 `http://127.0.0.1:24470`，伙伴服务器独立管理入口为 `http://127.0.0.1:24410`。主线程在现有本地 Core 与 Matrix 服务上复核了以下行为，覆盖上文两项待更新的真实预览检查。

- 986×822 视口中，Bot 按钮中心准确命中自身，第一次点击直接进入私聊。静态侧栏的关闭按钮隐藏。
- 从伙伴服务器返回全局 Bot 区会恢复最近私聊，两个 Bot 可分别打开。刷新后继续保持全局 Bot 导航，服务器入口保持普通状态。延迟 Profile 和旧缓存加载路径另由合成浏览器控制请求时序验证。
- 设置的账号、外观和通知页均实测为 `(173,91,640,640)`，切页期间外框位置与尺寸一致。
- 实际管理页显示中文角色和准确的策略流程说明，列表、编辑器与操作区使用统一布局。

最终目视检查还发现原生删除全部文本会留下浏览器占位 `br`，被编辑器误存为换行，导致占位文字消失且刷新后输入框增高。主线程先加入回归并复现失败，再把孤立的原生占位换行恢复为编辑器空状态。整段删除、最后一个字符删除、撤销、重做和主动换行均通过。实际预览清空及刷新后 `data-empty` 均为 `true`，文字区高度均为 42px，占位文字恢复。失败与修复日志保存在 `.local/ui-consistency-acceptance/editor-empty-*.log`。

一次并行全量浏览器检查暴露了私有 HTTP 旧会话夹具在编辑器挂载前读取 `textContent` 的时序假设。补充等待实际可见编辑器后，定向与最终全量检查均通过。此前后台中文提示调整后的旧精确文本断言也已同步，失败日志保留在同一验收目录。

本轮模型调用为 0。手机检查采用 Chromium 视口模拟，实际设备推送与物理跨机器验收继续按各自范围开展。附件评审提供“附件集合”“轻量文件行”“独立卡片”三套交互样式矩阵，覆盖单文件、图片、多附件和上传状态，整体附件样式待用户选定方向。
