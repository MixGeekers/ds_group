# DSCord 界面组件库

更新于 2026-11-05（America/Caracas）。类型为 React 界面组件组合，候选状态为**用户批准采用、两入口表单已迁移并完成合成浏览器验证**。用户先要求推荐符合 DSCord 目标的组件库，随后明确批准 shadcn/ui + Base UI 方案及本轮实施。原初评的来源与未执行状态保留在下文，实施范围和实测结果见[UI 基础组件实施记录](<../apps/ds-group/UI基础组件实施记录.md>)。

## 目标与基线

DSCord 需要统一账号与跨服务器聊天入口、独立服务器后台、人类与 Bot 身份展示、个人设置、明暗模式和多语言。当前应用采用 React 19.3.1、TypeScript 7.0.2、Vite 8.3.5、自建 TSX 组件、全局 CSS token 和 Lucide 1.68.0。核对基线为 `b3473100eb93f53cc7ac0c7cbbd2b7f788077835`。

优先补齐的能力是菜单、弹窗、选择器、组合框、表单、焦点管理和键盘交互。消息同步、跨服身份、白名单及 Bot 任务由业务状态和服务接口负责，组件通过明确属性呈现这些状态。

## 推荐与比较

推荐优先验证 **shadcn/ui 的 Base UI 方案**，以可修改的组件源码建立 DSCord 的公共 UI 层。聊天客户端与管理后台可共同使用基础控件、翻译接口和设计 token，各入口分别组织页面、身份状态和权限操作。这是基于当前定制界面需求的适配判断。

| 方案 | 官方能力与项目适配判断 | 接入成本 |
|---|---|---|
| shadcn/ui + Base UI | 可组合组件源码、默认样式、CSS 变量主题及 Vite 接入路径，适合自有品牌聊天界面与统一设置体系 | 按官方路径配置 Tailwind，映射既有 token，维护入库源码并审阅上游改动 |
| 直接使用 Base UI | 提供交互原语并支持普通 CSS，适合先提升现有菜单、弹窗和选择器的交互能力 | 样式及公共控件封装由项目维护，基础改造涉及的样式范围较小 |
| Mantine | 成套组件、表单工具和主题 Provider，适合优先完成设置页、账号表单与运维页面 | 需要将现有主题偏好、CSS token 与 MantineProvider 统一接线 |
| Ant Design | 表格筛选、排序、行选择、复杂表单及组件语言配置，适合数据管理较密集的服务器后台 | 聊天界面的紧凑布局与品牌外观需要专门定制；若客户端使用其他体系，需维护两套公共 UI 适配 |

以上组件能力依据官方文档，适配优先级属于本项目判断。[shadcn/ui](https://ui.shadcn.com/docs) · [Base UI](https://base-ui.com/react/overview/about) · [Mantine](https://mantine.dev/) · [Ant Design Table](https://ant.design/components/table/)

## 机制与证据

| 结论 | 证据层级 | 核查位置 | 待验范围 |
|---|---|---|---|
| shadcn 的 Base Dialog 包装使用 Base UI 原语和可编辑样式 | 限定源码核查 | `8a3536678a528cc012b9e62484290e79d0be410f` 的 `apps/v4/registry/bases/base/ui/dialog.tsx` | 本项目嵌套弹窗、移动端交互和样式映射 |
| Base UI DialogPopup 接入初始焦点、返回焦点和 ARIA 关联 | 限定源码核查 | `cf696d6f6e08c699c5bda24d5a033430909f2285` 的 `packages/react/src/dialog/popup/DialogPopup.tsx` | 真实浏览器键盘、读屏和触屏表现 |
| Base UI、Mantine、Ant Design 的声明覆盖项目 React 主版本 | package.json 静态核查 | 分别为 `1.9.0`、`9.7.5`、`6.7.0` 的仓库快照 | React 19.3.1、TS7 和当前构建配置的实际兼容性 |
| 主题可以通过 CSS 变量映射 | 官方文档 | shadcn theming、Base UI About、MantineProvider | 现有五种强调色、明暗与系统偏好、跨标签更新 |
| 默认组件文案需要纳入产品翻译 | 限定源码核查 | shadcn Dialog 源码含英文关闭标签 | 中英文可访问名称、业务文案及未来 RTL 布局 |

shadcn CLI 快照版本为 `4.23.0`，组件源码以固定提交定位。四个候选的包清单声明 MIT，其中 shadcn 与 Base UI 的根许可证也已读取。版本、文件 SHA-256 与选取的源码行见[来源核查快照](<../research/2026-11-05-UI组件库/source-check.json>)，官方链接见[调研目录](<../research/2026-11-05-UI组件库/目录.md>)。

## 初评时建议的首个验证切片

1. 固定组件和依赖版本，建立公共 UI 入口，将主题颜色、明暗状态和翻译函数映射到现有偏好存储。
2. 用账号菜单、个人设置弹窗与一张服务器白名单表单验证客户端和后台的共同基础控件。
3. 通过 TS7 检查和生产构建，验证 Escape、Tab、焦点返回、嵌套浮层、中文输入法与手机窄屏。
4. 复验语言及颜色切换、草稿恢复、账号切换和服务器切换，核对消息与任务原有行为。

初评阶段实验执行为 0 次。2026-11-05 用户随后批准采用，并指定聊天端与独立后台的第一批入口。首批接入在 `apps/ds-group/ui/` 实施，采用固定 shadcn/ui Base registry 提交的可编辑组件形态、`@base-ui/react@1.9.0` 和 Tailwind 4.3.4；账号浮层、设置弹窗、个人外观与通知及后台准入表单通过实际 Chromium 复验。用户随后明确要求扩展至全部可见表单；第二批将登录、建群、Bot、身份组、通知、收件箱、消息表单及后台其余表单接入共享控件。最终通过 TS7、生产构建、376 项模块和 10 个浏览器测试文件；这是合成数据下的实现验证，不是物理跨机或真实 Matrix 验收。
