# Supabase 数据库初始化与同步接口

适用：个人独立项目 schema v3，同步协议 v1。每位使用者自行创建 Supabase 项目，只填写 URL 和 publishable/anon key，不使用 Auth 登录。0.5.0 已提供客户端，配置步骤见 [云同步使用指南](cloud-sync.md)；执行 SQL 本身只准备云端，不上传现有提示词。

## 在 Supabase 后台执行

1. 创建一个专用于自己 Prompt Vault 的 Supabase 项目。
2. 打开 **SQL Editor → New query**，完整复制 [setup.sql](../supabase/setup.sql)，以默认 postgres 角色执行。没有需要替换的地址、密钥或用户 ID，不需要创建 Auth 用户。
3. 执行 [verify.sql](../supabase/verify.sql)，预期八项全部 PASS。
4. 从项目 Connect / API Keys 获取 **Project URL** 和 **Publishable key**；已有项目可用 legacy anon key。在插件「设置 → 云同步」只填写这两项。

Data API 需启用，暴露默认 public schema 即可；不要把 prompt_vault 加入 exposed schemas。所有客户端业务请求走 public.pv_sync_* RPC，不直接查询表。不需要 Storage bucket、Edge Function、Realtime 或定时任务。

同版本脚本可重复执行，保留数据。旧 schema v1（多用户）和 v2（固定 Auth 库主）会被拒绝，不会自动清库或取消既有访问保护；若已经部署旧版，需要单独的数据和权限迁移。

## 访问边界

本方案沿用参考项目“URL + API key、无需登录”的连接方式，但仅向 anon 角色开放三个同步 RPC，所有表直接访问及私有函数都拒绝。RPC 仍执行版本检查、输入校验和事务提交。

**任何持有该项目有效 publishable/anon key 的人，都可以通过 RPC 读取完整提示词及其历史，并进行新增、修改和软删除。** 这里没有库主身份验证；项目只有一个人的数据，是部署约定，不是数据库识别出了这个人。其他人在拿到相同配置后会拥有相同能力，来源 deviceId 也不构成身份凭证。

Publishable/anon key 在 Supabase 的设计中是可公开的应用标识。本方案主动把同步能力授予该 key 对应的 anon 角色，因此应保持这个项目独立、配置仅在自己的浏览器本地保存，不能把同一个 key 放到公开网站、示例仓库或发布包。**同一项目的其他有效 publishable/anon key 也会获得相同 anon 权限**；单独新建一个 key 不会产生独立数据库权限范围。泄露时撤销泄露的 key、更新设备配置；已读走的数据无法撤回。[官方 API keys](https://supabase.com/docs/guides/getting-started/api-keys)

不填写 sb_secret/service_role key 或数据库密码；这些属于更高权限凭证。本方案不是 Supabase Auth 的等价身份保护，也没有端到端加密。

## 数据库结构

| 表 | 内容 |
| --- | --- |
| `prompt_vault.entities` | 提示词与目录的当前状态、服务端版本及删除标记 |
| `prompt_vault.sync_state` | 固定一行：安装版本与全库同步游标，同时作为写事务锁 |
| `prompt_vault.sync_changes` | 不可变变更组，供其他设备按游标拉取 |
| `prompt_vault.sync_receipts` | 操作 ID、请求摘要和确认结果，处理断响应后的重复上传 |

没有用户表、库主绑定、登录会话或令牌刷新，业务数据里没有 user_id、owner_id、tenant_id。版本冲突、删除标记和幂等回执解决个人多设备同步问题，继续保留。

相比概念提案中的 prompts/folders 两张实体表，本实现将两者放在 `entities`，通过 `entity_type` 区分。它们共享 ID、版本、墓碑和同步协议；具体字段通过严格校验的 JSONB 保存，减少两套相同的同步逻辑。主键简化为 `(entity_type, id)`，目录引用在整个私人库中校验。

实体 ID 使用 **text**，保留现有 UUID 以及导入示例中的 `work`、`prompt-1` 等 ID，不要求转换成 UUID。幂等操作 ID 为 UUID。

所有表启用 RLS 默认拒绝，并撤销客户端直接读写表的权限。仅 anon 角色获准调用三个公开 RPC；这些 SECURITY DEFINER 函数固定空 search_path、完整限定表名，并在事务内操作私人 schema。没有 auth.uid() 检查。authenticated 角色不授予 RPC 执行权限，客户端不发送用户登录 JWT。[Supabase 函数权限](https://supabase.com/docs/guides/database/functions)

## 同步字段

提示词完整 `data`：

```json
{
  "title": "技术方案检查",
  "content": "请检查 {{topic}} 的技术方案",
  "description": "合成示例",
  "folderId": "work",
  "tags": ["开发"],
  "favorite": false,
  "sortOrder": 0,
  "createdAt": 1789776000000
}
```

目录完整 `data`：

```json
{
  "name": "工作",
  "parentId": null,
  "sortOrder": 0,
  "createdAt": 1789776000000
}
```

这些字段全部必填；空描述使用 `""`，无目录/父级使用 `null`。更新传完整 `data`，不是部分 patch；未知字段拒绝。`createdAt` 为客户端保留的创建时间，服务端另记录 `serverUpdatedAt`；设备时钟不参与冲突比较。

不上传 `version`、`deviceId`、`updatedAt`、`useCount`、`lastUsedAt`、界面设置、连接 URL、key。设备 ID 在整个上传请求的 `deviceId` 字段传一次，供变更来源识别。

当前云端边界：

- ID 和目录引用最多 512 个 UTF-8 字节；deviceId 最多 128 字节。
- 单文本最多 2,000,000 个 PostgreSQL 字符；tags 最多 1,000 项。
- sortOrder、createdAt 在 0 到 JavaScript 最大安全整数之间；createdAt 必须为整数毫秒。
- 单次原子上传 1–500 个显式变更；服务器按 JSONB 文本计算的请求和变更组各不超过 16 MiB。
- 拉取每页最多 50 个完整变更组，按约 20 MiB 字节预算停止；每组不可拆分。

服务端同步限制比本地导入更严格；遇到超长 ID、极大排序值或超限批次，必须在客户端预检并明确报告，不能截断字段或把失败项标记成功。批量导入可以按引用依赖拆分独立组；超大的关联操作当前会原子拒绝，暂未实现分片暂存。Supabase 网关/套餐可能另有请求大小或超时限制，需在目标实例联调。

## RPC 1：状态与连接测试

`POST /rest/v1/rpc/pv_sync_status`，请求体 `{}`。通过 HTTPS 请求，header 为 `apikey: <用户填写的 publishable/anon key>` 与 `Content-Type: application/json`。不发送用户 access token，不把 sb_publishable key 放入 Bearer Authorization。其余两个 RPC 使用相同请求头。

```json
{
  "protocolVersion": 1,
  "schemaVersion": 3,
  "deploymentMode": "personal-project-key",
  "cursor": "0",
  "maxChangesPerPush": 500,
  "maxRequestBytes": 16777216,
  "maxEventBytes": 16777216
}
```

这是只读函数，不修改同步状态或上传内容。SQL Editor 可以直接执行 `select public.pv_sync_status();` 查看协议状态；验证真实 API key、URL 和网关可达性仍需发起 HTTP 请求，后台 SQL 执行不能替代。

## RPC 2：原子上传

`POST /rest/v1/rpc/pv_sync_push`。请求体中的 `p_request` 是一个原子事务组，所有变更一起成功或一起冲突：

```json
{
  "p_request": {
    "protocolVersion": 1,
    "opId": "68ddebb1-0333-4409-8ecb-45b6070b16ad",
    "deviceId": "设备本地生成的稳定标识",
    "changes": [
      {
        "entityType": "folder",
        "id": "work",
        "baseVersion": "0",
        "deleted": false,
        "data": {"name": "工作", "parentId": null, "sortOrder": 0, "createdAt": 1789776000000}
      },
      {
        "entityType": "prompt",
        "id": "example-prompt",
        "baseVersion": "0",
        "deleted": false,
        "data": {
          "title": "技术方案检查", "content": "请检查 {{topic}} 的技术方案",
          "description": "合成示例", "folderId": "work", "tags": ["开发"],
          "favorite": false, "sortOrder": 0, "createdAt": 1789776000000
        }
      }
    ]
  }
}
```

opId 对每个新事务组生成新 UUID。超时或关闭页面导致结果不确定时，下次手动同步重发**完全相同**的请求（包括 opId、deviceId 和数组顺序）。服务端返回第一次的结果；相同 opId 携带不同载荷会报错。冲突结果也有回执，解决冲突后使用新 opId。

`baseVersion: "0"` 表示新建；更新和删除必须使用最近已知的 `serverVersion`，不能使用本地 IndexedDB 的 version。所有版本/游标使用十进制字符串，避免 bigint 在 JavaScript 中丢精度。

成功示例：

```json
{
  "status": "applied",
  "opId": "68ddebb1-0333-4409-8ecb-45b6070b16ad",
  "cursor": "1",
  "versions": [
    {"entityType": "folder", "id": "work", "serverVersion": "1"},
    {"entityType": "prompt", "id": "example-prompt", "serverVersion": "1"}
  ]
}
```

一个组内全部实体共享该次提交的版本号；某个实体的版本可能跳号，这是正常现象。`versions` 也可能包含删除目录引发的隐式变更。客户端只能确认本次发送的实体与本地 generation，不能因此清除发送期间新产生的修改，也不能把 ACK 的 cursor 当成已经拉取的游标。规范状态通过后续 pull 获取。

冲突返回 `status: "conflict"` 和 `conflicts` 数组，每项包含 entityType、id、current；current 为当前服务端实体，不存在时为 null。本次事务组中任何一个实体冲突，其他实体也不会写入。HTTP 成功不等于数据应用成功，客户端必须检查 status。

删除请求仍含五个变更字段：`entityType`、`id`、`baseVersion`、`deleted: true`、`data: null`。服务端保留原正文及墓碑。删除目录会在同一事务中把其当前存活提示词与子目录移出，所有影响一起写入变更组；已经修改的正文不被旧客户端内容覆盖。若请求显式携带对已删除目录的引用，则整个请求拒绝，客户端应先解决关系再发新请求。

不允许覆盖墓碑复活原 ID；恢复内容需创建新 ID。清空本机不调用云端全清，本协议没有“清空所有设备”接口。

## RPC 3：增量拉取

`POST /rest/v1/rpc/pv_sync_pull`：

```json
{"p_cursor": "0", "p_limit": 20, "p_until": null}
```

响应包含 `events`、`nextCursor`、`highWater`、`hasMore`。event 包含 cursor、opId、deviceId、changes；每个 change 含 entityType、id、data、serverVersion、deletedAt（毫秒或 null）和 serverUpdatedAt（服务端时间）。

首次从 `"0"` 开始；有后续页时传回 `nextCursor`，并把本轮第一次返回的 highWater 填入 p_until。本轮就只处理开始时已提交的变更，不会因另一设备持续写入而永远拉不完。之后新的一轮再用 p_until=null。

全库唯一同步状态行上的事务锁保证游标分配和提交顺序一致。pull 使用同一数据库语句的稳定快照读取，不会读到未提交事件。客户端应按事件顺序在 IndexedDB 事务中一起应用整个 changes 和 cursor，不能先推进游标再写数据。远端变更遇到本地未上传修改时保存冲突，不直接覆盖。

读取不修改同步状态、不写实体、不上传本地内容。页面打开仅触发一次有界 pull；立即同步才执行 push + pull；数据库中不存在主动唤醒客户端的程序。

## 运维与隐私边界

- 保留 sync_changes、sync_receipts 和墓碑，不做自动过期删除。随意清理会破坏旧设备恢复和重试幂等；回收机制需要单独的快照/游标过期协议。
- 云端存正文与变更历史，当前不是端到端加密。软删除仍可在数据库和历史中找到内容。
- 只通过 RPC 写入。管理员直接改表或在 Table Editor 编辑正文会绕过同步协议，其他设备可能看不到，不能作为正常编辑入口。
- 同步日志可能保存多版正文，磁盘占用高于当前实体体积。同步不替代独立备份。
- API 配置仅在浏览器本地保存；key 作为请求头发送到指定项目，不进入数据导出、同步正文或日志。

## 验证

本地隔离测试：

```sh
bash scripts/test-supabase.sh
```

脚本要求本机 PostgreSQL 的 initdb、pg_ctl、psql；创建临时目录与专用 Unix socket，禁用 TCP 监听，结束后停止并清除该临时实例，不连接已有数据库。本地测试仅创建模拟 API 角色，不创建 Auth schema/users/functions，以验证没有 Auth 依赖。不可在 Supabase 执行 bootstrap.sql 或 protocol.sql。

已执行范围与未验证项见 [URL + key 方案验证记录](reviews/2026-09-19-supabase-key-only.md)。Supabase API key 网关和扩展端联调仍需要目标项目证据；本地 SQL 通过不能替代这些检查。
