# 识雨 · 工作台 v0.1.0

安装在 DeepSeek Harness 当前 profile 的持久插件，不是独立网页。左侧 **识雨** 入口打开工作台；不会替换聊天界面。

## 第一版

- **主要工作区**：初始指向创建此插件时的识雨目录；可用原生文件夹选择器或输入绝对路径，再点「设为主要工作区」。目录存在性校验通过后持久保存，保留最近 8 个目录。不会更改任何会话的工作目录或注册新的会话。
- **技术候选**：读取所选工作区 `技术候选/` 的直属 Markdown 文件，排除 `目录.md`。目录表提供标题、类型、方向、状态、判断、顺序、更新日期；没有被索引的文件仍展示并标注「尚未列入目录」。支持搜索、状态筛选与原文阅读。
- **架构图纸**：读取 `架构与设计/`，将设计状态与实现状态分开显示。提取文档内的 `text` / `plaintext` / 无语言代码围栏，保留 Unicode 框线、箭头、空白及源行号。可缩放、横向滚动并跳转原文；不把设计图冒充实时运行拓扑。
- **阅读器**：标题、表格、列表、引用、代码块、粗体、链接和 Markdown 源码视图。工作区内 Markdown 链接打开在工作台中；HTTP(S) 链接在新标签打开。原始 HTML 不执行，远端图片不自动加载。
- **刷新资料**：重新从磁盘读取，不自动写入、重排或修订源资料。此版本不自动监控文件变化，别的会话新增内容后请刷新。

## 边界

收录不等于采用；设计不等于实现；源码写过「已测试」不是此插件重新验证了它。第一版没有技术安装、记忆写入、数据库集成、自动执行、候选审批或设计编辑功能。唯一写操作是主要工作区选择，保存于 Harness JSON storage 的独立 `shiyu_workbench_v1` 单元。

每个资料目录最多展示 120 份 Markdown，单文档最多 512 KiB；超限、丢失、非法 UTF-8、目录不可读、索引引用缺失文件均返回提示，不悄悄截断原文。读取拒绝路径穿越及指向工作区外部的符号链接。不会读取任意 URL、执行文档命令或上传内容。

Mermaid 围栏仅标为源码，第一版不渲染 Mermaid；图片、PDF、Draw.io、任意 HTML 不作为图纸导入。现有架构文档中的字符图可直接展示。

## Agent 与 UI 共用操作

`shiyu_workbench` 工具：

```json
{ "action": "snapshot" }
{ "action": "read_document", "path": "架构与设计/总体架构.md", "workspacePath": "/absolute/workspace" }
{ "action": "select_workspace", "path": "/absolute/workspace" }
```

`read_document.workspacePath` 可防止跨工作区的过期点击。工具与 UI 都调用同一个 `ShiyuWorkbench.operate()`；返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`。工具操作的记录由 Harness 工具管线保存。UI 通过 Connection 的 owner-authenticated `/api/shiyu-workbench` POST 入口操作，不开放未认证文件服务。

## 文件与安装

- `index.js`：Cordis Host 挂载、存储与传输绑定。
- `core.js`：资料解析、路径边界、共享业务服务与 Agent 工具。
- `client.js`：React 主面板、侧栏图标、双语界面；只从内建模块表导入 React。
- `cordis.patch.yml`：插入独立 `shiyu-workbench` 行，`initialWorkspace` 只在首次使用时生效。
- `locale/` 与 `icon.svg`：中英管理元数据与原创雨滴/桥梁图标，无第三方图形素材。
- `tests/`：Node 内建测试，无安装依赖，无构建脚本。

通过 Harness 的 `plugin_manager install_bundle` 安装此绝对目录。不要手动改 profile。该插件对同一 profile 下所有会话可见；主要工作区选择也在该 profile 共享。插件管理中关闭或卸载即可移除 UI/工具/路由，不删除原始文档。若要完整清理选择历史，请在卸载后另行明确要求清理独立 storage 单元。

本地目录安装链接源目录，请不要移动或删除插件目录。修改已安装 Host 模块后可能需要重启 Harness；刷新浏览器并不等于 Host 代码已更新。源码检查与测试可运行：

```sh
node --check core.js && node --check index.js && node --check client.js
node --test tests/*.test.js
```

## 验证说明

2026-10-30 本机验收记录：

- Node v24.21.0：22/22 测试通过；三份运行 JavaScript 语法检查通过。
- 安装状态 `application: applied`，无 warnings；已纠正首次安装发现的 storage 单元命名限制（名称必须匹配 `^[a-z][a-z0-9_]*$`）。
- 当前连接页面的 `sidebar.panellist` 和 `main` 均有 active 的 `shiyu-workbench` 注册。
- 已通过实际 Agent 工具验证默认工作区、同路径保存、目录扫描、原文读取、非法选择与路径穿越拒绝；测试未改变用户的主要工作区。
- 对当前 GUI 的 API 路由发出无凭据请求，实际返回 HTTP 401。
- 中英元数据与原创 SVG 已从安装后的包路径回读；SVG XML、尺寸及包内资源检查通过。未进行实际图标渲染、页面截图、浅深色外观、原生文件选择器或点击端到端验收。
- 工作区同期有其他写入，数量不写死。测试按实时文件/目录核对；缺失的索引目标给出警告，不自动恢复或删除索引。
- 新增 1 个 Agent 工具（3 个参数），schema 序列化 571 字符 / 789 UTF-8 字节；无额外系统提示段。此为字符/字节占用测量，不是特定模型 tokenizer 的精确 token 数。

自动化测试覆盖解析、真实资料、两入口等价、目录切换与持久化、失败回滚、路径/符号链接边界、文件大小及编码；安装后另查 Host 行和实时 Client 槽位。没有浏览器控制时，不能仅凭槽位注册声称已经完成点击、截图、浅深色外观或原生选择器验收。
