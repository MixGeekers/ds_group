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

实际 27 张截图位于被忽略的绝对路径 `/Users/caja/.codex/worktrees/dscord-platform-integration/apps/ds-group/.local/ui-foundation-review/`，`manifest.json` 列出每张图、视口、语言、主题、实际回环抓取地址和合成数据。聊天主流程图来自生产 web 构建的正常入口、独立合成归属服务；后台图来自实际 `createAdmin` HTTP 服务及合成控制器；身份组表单图来自真实 React 组件的浏览器夹具。抓取端口在测试完成后关闭，可运行 `node --test tests/unified-client.browser.mjs tests/admin.browser.mjs tests/ui-controls.browser.mjs tests/react-settings.browser.mjs` 重现。物理跨机、真实手机推送和真实模型行为没有在本 UI 切片中执行。生产构建仍有 Vite 对大于 500 kB 的聊天 JS chunk 与非 module 主题脚本的非阻断提示。

## 验收边界

本轮截图和浏览器检查使用真实 Chromium 与产品入口，但账号、消息、管理控制器和推送行为使用合成夹具。跨物理机器部署、真实 Matrix 服务和真实模型业务闭环分别按其实施记录验收，不能由本 UI 切片推定通过。
