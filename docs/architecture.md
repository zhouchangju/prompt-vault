# 架构

0.4.0 保持 Manifest V3 与原生 ES modules。根目录是可直接加载的扩展，无运行时构建和第三方依赖；Node 工具仅用于开发验证与打包。

| 模块 | 职责 |
| --- | --- |
| `manifest.json`、`background.js` | 权限、入口、侧栏行为与快捷键 |
| `manager.*`、`sidepanel.*` | 管理和快速使用界面 |
| `db.js` | IndexedDB 事务、版本冲突、导入计划、快照、变更通知 |
| `core/template.js`、`core/csv.js`、`core/validation.js` | 模板、交换格式与输入校验 |
| `core/settings.js` | 主题目录、设置兼容、按字段写入与变化订阅 |
| `shared.js` | 通用工具与核心模块转导出 |
| `ui/dialog.js`、`ui/variables.js` | 共享弹窗与变量字段 |
| `ui/interactions.js`、`ui/navigation.js`、`ui/copy.js` | 整卡交互/快捷键、管理页导航与侧栏关闭、复制与使用记录的错误分离 |
| `themes.css` | 两个页面共用主题 token |
| `tests/`、`scripts/` | 回归、浏览器验证、测量和白名单打包 |

页面通过本地数据库读写实体。写事务内比较版本，实体、队列和 revision 一起提交，提交后通过 BroadcastChannel 通知其他页面；恢复焦点时重新读取。设置使用 chrome.storage.local 的按字段键，避免不同页面修改不同设置时互相覆盖。

JSON/CSV 先全量校验、生成导入预览；提交时检查数据 revision 未变化，再在一个事务中写入。导出在单一读事务内获取分组与提示词。设备标识迁入 meta，同事务序列化初始化；数据库名称和版本不变。

管理页分批追加卡片并限制预览文本，侧栏限制展示数量并提示总数。仍是内存搜索，不是虚拟列表或全文检索引擎。性能结论依赖 [验证](testing.md) 中的合成数据测量。

后续同步必须另行设计协议，不能把本地队列直接接上服务器便宣称完成。[ADR 0001](decisions/0001-local-first.md) 和 [ADR 0002](decisions/0002-compact-themes-hardening.md) 记录决策。

`core/panel-toggle.js` 根据原生 onOpened/onClosed 事件维护按窗口隔离的侧栏状态，并写入会话存储；命令查询状态后选择打开或关闭。成功结果补齐延迟事件窗口，但原生新事件优先，避免覆盖用户手动操作。
