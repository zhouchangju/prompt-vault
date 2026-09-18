# 数据模型与交换格式

适用版本：0.4.0。IndexedDB 名称 `prompt-vault-db`，版本仍为 `1`，沿用原库和已有记录，不通过清库升级。

## 存储与并发

| Store | 主键 | 内容 |
| --- | --- | --- |
| prompts | id | 提示词；folderId、updatedAt、deletedAt 索引 |
| folders | id | 分组；updatedAt、deletedAt 索引 |
| syncQueue | id | 按实体合并的最新意图；createdAt 索引 |
| meta | key | deviceId、revision、coalescedQueue、syncNeedsFullRescan |

设备标识在事务内初始化，优先迁移旧 chrome.storage.local.deviceId，之后以 meta 为准。revision 是变更基线，同时提供实体版本下限，防止清空/导入后版本倒退造成过期写入被接受。coalescedQueue 标记旧队列已合并；syncNeedsFullRescan 表示未来同步不能仅依赖现存队列。

实体变更、版本检查、队列及 revision 在同一个写事务内提交，随后通知其他页面。更新或删除已有实体必须使用读取时的版本；冲突拒绝写入。使用记录本地更新，不增加实体版本或加入队列，但会触发变更通知。

设置读取兼容旧 `settings` 对象，新写入使用 `preference.theme`、`preference.cardDensity`、`preference.viewMode` 独立键。主题未知值回退 system；展示模式为 cards/compact，密度为 comfortable/compact。

## 实体

Prompt 包含 id、title、content、description、folderId、tags、favorite、sortOrder、createdAt、updatedAt、lastUsedAt、useCount、version、deviceId、deletedAt。文本为字符串，tags 为字符串数组；时间为毫秒数，未使用/未删除为 null；folderId 为字符串或 null。

Folder 包含 id、name、parentId、sortOrder、createdAt、updatedAt、version、deviceId、deletedAt。parentId 是数据字段，界面仍只有单层分组。导入校验父级引用与循环关系。

0.4.0 的文件夹排序提交完整存活 ID/版本列表，在单一事务校验并重排 sortOrder，同时更新实体版本、队列及变更基线。新建分组追加末尾；旧排序值无法安全递增时，在事务内按原顺序规范化后追加。侧栏的累计 useCount 仍持久化，但用于排序的分数在面板会话内冻结，收藏优先状态可实时调整。

队列记录 id、entityType、entityId、operation、createdAt。每实体保留最新意图；旧队列在写入时合并。最多 10,000 条，超限裁剪旧意图并设置 syncNeedsFullRescan。没有消费者、服务端确认、重试或全量重扫实现，不能视为同步日志或完整灾备记录。

## JSON

[示例文件](../examples/sample-prompts.json) 使用 `schemaVersion: 1`，顶层包含 prompts、folders，可带 app 和 exportedAt。

- 单一只读事务导出存活提示词与分组。不导出墓碑、队列、meta 或设置；实体中的设备与使用信息仍可能包含在导出中。
- 全量校验 schema、类型、必填 ID、重复 ID、字段长度、记录数、分组引用和循环。最多 100,000 个实体，单文本上限 2,000,000 个字符。
- 界面读取文件前限制大小为 32 MB；外来 version 上限为 1,000,000,000,000。外来版本不推进本地并发时钟，导入重新分配本地版本，避免极端输入阻断后续写入。
- 预览显示新增与覆盖数量，保存基线 revision；确认前若数据变化则拒绝，需重新预览。
- 同 ID 经确认后覆盖；实体与队列单事务提交，失败回滚。导入更新本地设备与版本，不是按来源版本做分布式冲突合并。
- 默认合并导入；底层 replace 模式不由常规 UI 暴露，仍保留版本安全元数据并标记需全量重扫。

## CSV

必需列 title、content；可选 description、tags、folder、favorite。支持 UTF-8 BOM、引号转义与引号内换行；拒绝未闭合引号、重复表头、行列数不匹配等异常。

空标题/正文为错误，favorite 只接受空值、true、false。按规范化文件夹名称匹配或新建；整个文件经校验及预览后单事务导入，重复导入新增提示词。CSV 不保留 ID、版本和使用历史。

默认电子表格安全导出保护公式前缀，可能改变原文本；原始导出保留文本且有明确风险提示。需要无损迁移时使用 JSON。

## 变量

| 语法 | 类型 |
| --- | --- |
| `{{name}}`、`{{name|默认值}}` | 文本，默认多行输入 |
| `{{tone::list-happy;sad}}` | 下拉，默认首项 |
| `{{count::number-0}}` | 数字输入 |
| `{{bio::largeText}}` | 多行文本 |
| `{{name::text-default}}` | 文本与默认值 |

变量从正文推导，不执行代码。同名变量以首次定义为准。仅替换原始模板的 token，填写值中的 token 保持字面内容。

## 删除与兼容

软删除保留墓碑；删除分组将存活提示词移出分组。清空操作删除 prompts、folders、syncQueue，保留 meta 与 chrome.storage.local 设置，推进版本下限并标记需全量重扫。

后续 DB/schema 升级需要旧数据迁移测试。同步身份、冲突、副本、墓碑回收和清空传播另行设计。
