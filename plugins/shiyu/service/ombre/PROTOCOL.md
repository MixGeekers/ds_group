# 识雨受控 Ombre stdio 协议 v1

固定上游 3.6.14 / `115d831d979bf67efc7150f976e2cb34c333c935`。本服务组合原生 BucketManager、Markdown、桶锁、派生索引；不导入 server，不启动 You/Them、decay、dream、dehydrator、GitHub、tunnel、hook、dashboard 或上游工具注册。只注册以下三个 MCP 工具。更新、删除、迁移、自主整理尚不支持。

## 命令与摘要

`shiyu_memory_create({command, commandDigest, body})`：

```json
{"schemaVersion":1,"kind":"create","operationId":"operation-1","backendId":"ombre-local","scope":"local-owner","targetRef":"target-1","bodyDigest":"<sha256 UTF8 body>","bodyBytes":12,"sourceRefs":[{"sourceId":"source-1","revision":1}]}
```

`command` 只允许上述精确字段。所有 ID 满足 `^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$`，operationId 另限 150 字符。sourceRefs 长度 1..32，sourceId 唯一且 ASCII 升序，revision 为 1..9007199254740991 整数（bool 不算）。body 为有效 Unicode，无孤立 surrogate，UTF8 长度 1..16384；要求原生清洗及 frontmatter 往返都不改变正文，服务拒绝而不偷偷 trim。bodyDigest/commandDigest 为小写 hex64。

commandDigest = SHA256(递归按 ASCII 键排序、无空白、UTF8 编码的 JSON)。Python `json.dumps(command, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)`，与 TS 同规则一致。正文独立参数，不进入 journal 或控制库。

## 统一字段与状态响应

`shiyu_memory_operation_status({operationId,scope})` 与 create 返回同一布局：

```json
{
  "schemaVersion":1,"backendId":"ombre-local","deploymentId":"deployment-1","scope":"local-owner",
  "operationId":"operation-1","state":"applied",
  "command":{},"commandDigest":"<hex64>","plannedNativeId":"shiyu_<hex32>",
  "nativeId":"shiyu_<hex32>","receipt":{},"reason":null
}
```

state 为 `absent | unknown | applied | rejected`。absent 的 command、commandDigest、plannedNativeId、nativeId、receipt 为 null。unknown 表示持久 intent 已存在，副作用尚不能证明；绝不表示可以重发。rejected 只用于已确认在任何原生创建前拒绝的 planned-ID 冲突。unknown/rejected 的 nativeId 与 receipt 为 null；plannedNativeId 保留。applied 的 receipt 精确字段为：

```json
{
  "schemaVersion":1,"receiptId":"receipt_<hex64>","operationId":"operation-1",
  "backendId":"ombre-local","deploymentId":"deployment-1","scope":"local-owner",
  "commandDigest":"<hex64>","nativeId":"shiyu_<hex32>","bodyDigest":"<hex64>","bodyBytes":12,
  "sourceRefs":[{"sourceId":"source-1","revision":1}],
  "componentVersion":"sha256:<native Markdown file hex64>","outcome":"applied",
  "bodyDurable":true,"indexState":"unknown","observedAt":"<UTC ISO8601>","reconciled":false
}
```

componentVersion 是当时原生文件内容指纹，**不是原生版本号或 CAS**。indexState 为 `disabled | unknown`：未装 embedding 时 disabled，启用时保守 unknown，不能用正文成功声称已索引。receipt 是历史观察；status 对 applied 会重新读取原生文件，发现缺失/内容/归属/文件指纹变化则返回 unknown、reason=`NATIVE_MISMATCH`、receipt=null，不改写历史 journal。status 不写或 ack；启动恢复仅补全 unknown 的证明，不重发 create。

## 独立精确读取

`shiyu_memory_get({nativeId,scope})`：

```json
{
  "schemaVersion":1,"backendId":"ombre-local","deploymentId":"deployment-1","scope":"local-owner",
  "state":"found","nativeId":"shiyu_<hex32>","command":{},"commandDigest":"<hex64>",
  "receipt":{},"body":"exact native content","bodyDigest":"<hex64>",
  "componentVersion":"sha256:<hex64>","reason":null
}
```

state 为 `found | not_found | mismatch`。只有属于该 deployment journal 的 applied ID 且重新读取核对通过才 found；不存在的 journal ID 返回 not_found，绝不退回语义搜索或任意 vault 读取。其余返回 mismatch。非 found 时 body/bodyDigest/componentVersion/receipt=null，command/commandDigest 可保留对应已知命令；reason 给固定错误码，不泄露路径/正文。

## 持久关联和恢复

受信启动参数绑定 backendId、scope、deploymentId 与独占数据根。这些字段只是路由/部署约束，授权来自调用方受信控制域，不接受 AI 正文授予能力。vault 进程锁排除本服务的并发实例；已有数据/数据库缺 metadata 或绑定不符立即失败，不自动认成新安装。

SQLite FULL journal 只记录命令 metadata、正文 hash/长度、预定随机 native ID、状态、回执，不存第二份正文。先持久 unknown intent，然后原生 create 普通 dynamic 桶，`test_data=false`、固定 `source_tool=shiyu_strict_create` 和 `grow_batch_id=commandDigest` 在同一次 Markdown 发布中关联命令。窄 BucketManager 子类只在 create 上下文阻止候选换号；保留原生桶锁、原子 no-overwrite 发布、路径索引、原生 embedding/outbox。

返回成功前 native get_including_archive 独立核对 ID、metadata.id、归属标记、正文 hash/长度、普通 dynamic/非 terminal 状态，然后 fsync 实际文件及父目录，再登记 applied。异常/取消/半截文件均保留 unknown。启动只按已记录 planned ID 重新核对，成功可补 receipt（reconciled=true），没找到仍 unknown；从不调用 create 补写。重复 operationId 必须同一 commandDigest/command，否则冲突；同命令只返回已存/实观测状态，绝不重发。

这里的 durability 指正常 OS/fsync 语义；不承诺恶意本机文件篡改、磁盘故障、未受控旧 Ombre 进程或硬件掉电绝对安全。独占根只能由本部署使用，不能同时交给上游完整服务。
