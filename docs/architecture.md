# 架构

0.5.0 保持 Manifest V3 与原生 ES modules。根目录是可直接加载的扩展，无运行时构建和第三方依赖；Node 工具仅用于开发验证与打包。

| 模块 | 职责 |
| --- | --- |
| `manifest.json`、`background.js` | 权限、入口、侧栏行为与快捷键 |
| `manager.*`、`sidepanel.*` | 管理和快速使用界面 |
| `db.js` | IndexedDB 事务、版本冲突、导入计划、快照、变更通知 |
| `core/template.js`、`core/csv.js`、`core/validation.js` | 模板、交换格式与输入校验 |
| `core/settings.js` | 主题目录、设置兼容、按字段写入与变化订阅 |
| `core/sync.js`、`core/sync-model.js`、`core/sync-storage.js` | 连接配置、主动触发同步、协议校验、本地基线与冻结请求 |
| `ui/sync-settings.js` | 云同步设置、状态、冲突选择与备份导出 |
| `supabase/` | schema v3 初始化、权限与事务 RPC、SQL 验证 |
| `shared.js` | 通用工具与核心模块转导出 |
| `ui/dialog.js`、`ui/variables.js` | 共享弹窗与变量字段 |
| `ui/interactions.js`、`ui/navigation.js`、`ui/copy.js` | 整卡交互/快捷键、管理页导航与侧栏关闭、复制与使用记录的错误分离 |
| `themes.css` | 两个页面共用主题 token |
| `tests/`、`scripts/` | 回归、浏览器验证、测量和白名单打包 |

页面通过本地数据库读写实体。写事务内比较版本，实体、队列和 revision 一起提交，提交后通过 BroadcastChannel 通知其他页面；恢复焦点时重新读取。设置使用 chrome.storage.local 的按字段键，避免不同页面修改不同设置时互相覆盖。

JSON/CSV 先全量校验、生成导入预览；提交时检查数据 revision 未变化，再在一个事务中写入。导出在单一读事务内获取分组与提示词。设备标识迁入 meta，同事务序列化初始化；数据库名称和版本不变。

管理页分批追加卡片并限制预览文本，侧栏限制展示数量并提示总数。仍是内存搜索，不是虚拟列表或全文检索引擎。性能结论依赖 [验证](testing.md) 中的合成数据测量。

0.5.0 使用独立的云端基线与冻结请求执行同步，旧占位队列不作为同步日志；具体接口见 [Supabase 初始化](supabase-setup.md)。[ADR 0001](decisions/0001-local-first.md) 和 [ADR 0002](decisions/0002-compact-themes-hardening.md) 记录决策。

`core/panel-toggle.js` 根据原生 onOpened/onClosed 事件维护按窗口隔离的侧栏状态，并写入会话存储；命令查询状态后选择打开或关闭。成功结果补齐延迟事件窗口，但原生新事件优先，避免覆盖用户手动操作。


## 0.5.0 主动触发的云同步

- core/sync.js：连接配置、按用户手势申请精确项目域名权限、受 Web Lock 保护的单轮同步、超时和页面生命周期取消。后台入口不导入同步模块。
- core/sync-model.js：同步字段映射、响应与游标验证。
- core/sync-storage.js：持久化云端基线、冻结上传、事务应用事件、冲突备份；通过 db.js 的事务入口共用实体版本保护。
- ui/sync-settings.js：完整管理页的配置、立即同步和冲突处理。侧栏只在初始化完成后拉取一次。

保持数据库版本 1；新增内容仅为 meta 中的独立记录，不改已有实体结构。待上传通过本地实体与云端基线对比，不依赖会被裁剪的旧占位队列。网络等待始终位于 IndexedDB 事务外，响应应用时检查项目和本地 epoch。

批处理顺序为目录新增/更新、提示词、目录删除，先满足引用再传子项。每组提交后拉取自己的不可变事件，确认原请求并更新基线；新编辑不会被旧 ACK 清掉。遇到目录关系冲突会暂停并提供整组选择。
