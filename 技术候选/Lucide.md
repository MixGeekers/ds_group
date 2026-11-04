# Lucide

更新于 2026-11-04。用于 DS-Group 的聊天导航、成员、提及、文件、通知与设置图标。

用户要求界面采用开源图标库，并授权代理选择。实施代理选择 Lucide，固定 `lucide-react@1.68.0` 和 `lucide@1.68.0`。当前状态为已接入，并通过 TS7、生产构建和 45 项浏览器交互检查。

## 选择依据

Lucide 提供独立 React SVG 组件、TypeScript 声明和可按需打包的具名导出。官方包的 React peer 范围接受当前 React 19.3.1，发布元数据声明 `sideEffects: false`。React 组件使用 `lucide-react`，原有 DOM 附件模块通过 `lucide` 的具名节点和 `createElement` 使用同一套图标。[React 指南](https://lucide.dev/guide/react) · [JavaScript 指南](https://lucide.dev/guide/packages/lucide)

本项目采用轮廓风格，默认 20px、`currentColor` 与 2px 笔画，按控件使用 16px 或 24px。统一笔画与较简洁的形状适合聊天工具栏，这是本轮设计判断。[图标预览](https://lucide.dev/icons)

## 对照候选

| 候选 | 本轮核查版本 | 许可 | 适配判断 |
|---|---|---|---|
| Lucide | 1.68.0 | ISC，Feather 衍生图标另含 MIT 通知 | 选用，轮廓与 React/DOM 两种接入保持一致 |
| Tabler Icons | 3.50.0 | MIT | 轮廓体系完整，应用与业务领域图标丰富 |
| Phosphor | 2.1.10 | MIT | 多种字重和填充方式适合需要明显状态差异的界面 |
| Heroicons | 2.2.0 | MIT | 按 16、20、24px 和轮廓/实心入口组织，适合紧凑控件 |

这些候选均提供 React 包和 TypeScript 声明。本轮核对官方文档与发布元数据，实际产品编译及浏览器验收按应用实施记录登记。[Tabler](https://docs.tabler.io/icons/libraries/react) · [Phosphor](https://github.com/phosphor-icons/react) · [Heroicons](https://github.com/tailwindlabs/heroicons#react) · [元数据快照](../research/2026-11-04-图标库选型/npm-metadata.json)

## 许可与接入边界

完整 ISC 与 Feather MIT 通知保存在 `apps/ds-group/web/licenses/lucide.txt`，随源码发行包和生产 PWA 分发。应用使用静态具名导入，按实际使用的图标打包。[官方许可](https://lucide.dev/license)

本轮验证覆盖 TS7 严格检查、Vite 生产构建、React 控件与原生 DOM 附件图标、可访问名称、深浅主题、手机布局及离线资源。最终实施状态与测试证据见[应用实施记录](../apps/ds-group/实施记录.md)。
