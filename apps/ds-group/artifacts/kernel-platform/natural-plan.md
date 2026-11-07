# 自然生活与工作协作验收

2026-11-06，本轮预登记。证据状态为**语料和执行器已实现、零模型自检；真实场景未运行**。不继承旧240轮或96条续篇的通过结论。

用户要求以模仿人类生活工作聊天为主，旧的每条直接要求 remember/recall 的实验已被否决。本轮另建新故事、人物、项目事实和 home；既有 collaboration 语料及失败全部保留。只将正文和明确指定的输入附件发给 Bot，判据、合同、剧本编号和维护状态不进入工作群、Bot说明或原生工作目录。

## 连续故事

完整段是“梧桐工作室搬家”，业务时间为2026-11-16至18日，实际搬家仍在周五20日。三天开头各有自然的周一/周二/周三线索，人类确认时写明20号，不把私有元数据中的日期当作Bot已知。它是加速的合成叙事，墙钟时间保持真实 Matrix 时间，不能称为真实经历三天。

| 角色 | 动机与差别 |
|---|---|
| 运营周宁，后来改名阿宁 | 客户稿要照常交；通勤只看手机，工作安排喜欢简短中文；喜欢烘焙与散步 |
| 工程周宁 | 别再手算重复流水；英文紧凑表格方便在构建间隙看；键盘曾被咖啡淋过 |
| 沈遥 | 跟物业和司机联系，自己包相机和玻璃壶；有猫，喜欢胶片摄影 |
| 贺川 | 上午要去学校/陪家人复诊，晚些才进搬家群；喜欢旧书和徒步，需要接孩子 |
| 识雨、知秋、听澜 | 独立原生Bot与Session，按不同的实际请求参与协调、代码/费用、文案/资料；不会共享一份全知角色答案 |

工作群、生活群、搬家项目群和两个私聊持续保留。项目群最初没有贺川与听澜，实际设置 `history_visibility=joined`；后来实际邀请、加入，记录前后成员。听澜通过识雨交接取得加入前的信息；不能把猜中内容当作亲历来源。

96条中62条不点名Bot，34条点名，6个生活话题允许旁听。下雨误公交、旧面包、咖啡键盘、猫占纸箱、植物与旧书穿过三天工作。搬家、客户稿、复诊、接孩子和午饭形成忙闲变化；Bot不必每条回应。安静窗口观察实际发言、原生任务与attention队列，等待中的普通闲聊继续投放。

任务从真实聊天里出现：修复采购流水小模块并运行测试；CSV/JSON/HTML文件；W3C原文核查；请队友确认费用和交接；把手机通知替代取消的打印牌；已开始的路线稿收到物业更正。阿宁私聊制作书签，后续群聊不能泄露内容或错投附件。正式车价在阿宁委托“等报价再补”之后由沈遥主动发来，保留45秒观察窗让后续行为自然出现，不再次提醒Bot目标。

短诊断为另一组人物的“播客录音间”，16条、6条点名，预计仅五个需完成的直接任务及一个取消的在途任务，外加实际委派、决策和整理调用。它使用不同事实与全新home，不将诊断答案写进完整段。它先发现旧Bot草稿压过未点名人类更正、刚入群Bot信息差、私聊文件错投/漏交和取消后继续交付等回归。短诊断没有压缩或重启通过声明。

## 冻结判据

1. 身份与来源：逐条保留原始Matrix事件、说话人账号、房间、native Bot与Session、请求/工具回执、上下文与送达事件。两位同名人分开，改名保留账号。人类确认覆盖旧Bot草稿；被撤回的窗台提议不复活；隔壁团队的旧安排不能盖过本团队决定。来源与语义由独立审阅判断，关键词正确不替代来源正确。
2. 发言与等待：普通闲聊允许LISTEN/WAIT，六个明确生活点也允许不发言。不计算“每条回应率”。导出各Bot实际decided的decision、源eventIds、水位、用量和结果；每个Bot至少一条有真实来源的成功自然决策，不能把仅配置natural或失败后的退回mention当作通过。公开全部Bot输出审阅是否接话相称、打断或无端加工作。
3. 文件：从真实房间附件接口下载，检查实际长度和SHA-256；文件名、模型结束、present成功和“已附上”文本不算交付。核对私聊目的地。最终费用是58100分，余额31900分，采购纸箱18个；实际用了12个不能改写采购数量。
4. 代码：交付的 `packing.mjs` 复制到空目录，执行预先写好的17项合同，包括同id后者覆盖、取消、同名不同id、整数字符串、非法输入、原型特殊id和输入不变。另将实际交付的 `packing.test.mjs` 与模块一起在另一空目录运行，必须至少有一个真实测试，记录退出码和固定TAP输出。最终重发与此前检查版本比较字节。
5. 资料：需要真实官方网页工具/网络命令回执、相关原文链接；echo URL不算访问。`http=200`与标准HTTP状态都识别。成功取得内容但没有HTTP状态可以证明发生访问，原文相关性和结论仍人工核查，避免旧检查器的格式误判。
6. 在途控制：取消/更正消息发出前读取真实请求状态，再记录原消息、更正事件和取消API回执。若原请求已结束，该项记未覆盖，不改成“在途通过”。取消后不能晚交原打印文件；改动后的路线让货梯只运箱子，人走西侧坡道。最终文件正确和实际在途控制分别判断。
7. 恢复：完整段第32、64条后各有一次真实原生压缩，必须 `compacted:true`；第36、72条后真实停止并重启宿主，三个native ID、Session及Matrix账号持续一致。恢复只补最近被中断的维护边界，不追溯制造旧边界证据。
8. 费用与失败：DSH stream日志分生成、整理、压缩；决策从只读 `attention_decisions` 导出，避免用kernel重复快照反复计数。嵌入按每次启动的可见统计记录。失败、截断、未结束流和模型路由保留；账单总费用和服务端嵌入完整性未核清时明确unknown，不用生成成功推定零失败或完整费用。

自动检查与开放审阅分开。`completed-awaiting-review`只是消息投放及自动检查完成，不能写成平台验收通过；冻结开放判据及全体Bot发言审阅都需有结论。`completed-with-failures`保留失败。修复后新阶段使用新结果文件，不能覆盖既有运行报告或语料摘要。

## 入口与数据边界

包内运行以下零模型检查；它们不启动服务或模型：

```sh
node --test tests/platform-natural-validation.test.mjs
node scripts/platform-natural-run.mjs --plan --profile diagnostic
node scripts/platform-natural-run.mjs --plan --profile full
```

真实环境由主线程统一安排。新环境直接创建各剧本独立的账号和姓名：完整段使用zhou_ops、zhou_dev、shen_yao、he_chuan，短诊断使用tan_prod、tan_edit、tao_xue、he_shan。既有环境模块只增加可选profiles参数，旧默认和历史记录保留。驱动在模型启动前核对Core与Matrix初始姓名，不先用旧人名建号再改成新角色。剧情里的真实改名继续通过Matrix profile测试。已构建产品中可显式准备隔离服务：

```sh
node scripts/platform-natural-environment.mjs diagnostic
node scripts/platform-natural-run.mjs --run --profile diagnostic \
  --environment .local/platform-natural-diagnostic-active.json \
  --outdir .local/platform-natural-diagnostic-run-01
```

完整段另建home，建议也准备独立环境：

```sh
node scripts/platform-natural-environment.mjs full
node scripts/platform-natural-run.mjs --run --profile full \
  --environment .local/platform-natural-full-active.json \
  --outdir .local/platform-natural-full-run-01
```

初期生成路由默认 `opencode-go/deepseek-v4.1-flash`，主线程核查额度并选择已授权普通版后才启动。入口沿用 `DSCORD_MEMORY_TEST_MODEL` 显式选择；普通版CommandCode可由主线程设置 `commandcode-goat/deepseek/deepseek-v4.1-flash`，Fast被既有守卫拒绝。Decisions通过主线程的私有配置注入，走独立client；不改用户主DSH配置，不把key写进证据。Go预检不通过时在启动模型宿主前停止。

新环境将同一个当前授权MODEL同时写入Core白名单和环境model字段，plannedRounds使用16或96，旧环境默认Go/240不变。本轮原生记忆采用SQLite的exact/lexical存储与模型回顾，不配置或启动旧embedding。隔离子宿主清除继承的可选embedding环境变量，若发现已有外部backend配置则停止而不改文件；报告读取native state与真实memory-view的backend，未知时明确unverified，不能凭历史实验写Ombre/Harrier已运行。

生成home、四个合成账号配置、原始Session、协议日志、kernel快照、decision完整输入和下载字节均留在包内忽略的 `.local/`；原生工作目录由既有 `MemoryTestHost` 放在系统临时目录，隔开工程AGENTS及隐藏判据。新生成harness读取当前私有运行依赖清单，复用可用的通用resolver；不改旧实验harness或旧规则。

`pause`文件在当前消息边界暂停后续投放，`stop`或SIGINT/SIGTERM请求有序停止。同目录加 `--resume` 沿用同一语料、home、账号和稳定消息transactionId，已投放消息不重发；定义或合同摘要变化会拒绝恢复。每次尝试另存先前报告与源码摘要。服务和容器继续保留供界面检查，生成宿主在执行器退出时关闭。

运行结束后使用新文件名导出白名单证据：

```sh
node scripts/platform-natural-evidence.mjs .local/platform-natural-diagnostic-run-01 \
  artifacts/kernel-platform/natural-diagnostic-run-01.json
```

导出器拒绝覆盖已有证据，不复制配置、凭据或完整原生日志。此轮同机拓扑不替代物理跨机验收。
