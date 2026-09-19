# 项目文档

以当前源码为事实基线，将最初设计中的候选方案与已实现能力分开记录。

| 文档 | 用途 |
| --- | --- |
| [安装指南](installation.md) | 加载扩展与更新 |
| [0.5.0 云同步使用](cloud-sync.md) | URL/key 配置、主动触发、冲突处理与恢复 |
| [0.5.0 验证记录](reviews/2026-09-19-v0.5.0-sync.md) | 当前客户端、本地 SQL 集成及安装包证据 |
| [快速使用与快捷键](interaction-guide.md) | 一键使用、分类、收藏、侧栏导航及键盘操作 |
| [ADR 0003](decisions/0003-one-click-interactions.md) | 一键交互设计与验收范围 |
| [0.3.0 交互验证](reviews/2026-09-18-v0.3.0-interactions.md) | 整卡使用、侧栏、快捷键与原生面板关闭的实际证据 |
| [ADR 0002](decisions/0002-compact-themes-hardening.md) | 精简、主题与可靠性方案 |
| [实施清单](implementation-checklist.md) | 责任、代码状态及验证要求 |
| [产品范围](product.md) | 用户需求、当前能力、未实现的设计 |
| [架构](architecture.md) | 真实目录、数据流和结构改进顺序 |
| [数据模型与交换格式](data-model.md) | IndexedDB、JSON、CSV、模板语法 |
| [本地优先同步提案](proposals/2026-09-19-local-first-sync.md) | Supabase 评估、同步协议、冲突和弱网验收设计 |
| [Supabase 初始化](supabase-setup.md) | 单用户可执行 SQL、同步接口及后台操作步骤 |
| [URL + key SQL 验证](reviews/2026-09-19-supabase-key-only.md) | 当前免登录方案、接口权限、增量协议与并发验证 |
| [固定库主历史验证](reviews/2026-09-19-supabase-single-owner.md) | 已被 URL + key 方案取代的 Auth 版记录 |
| [初版 SQL 历史验证](reviews/2026-09-19-supabase-sql.md) | 已被单用户方案取代的多用户初版记录 |
| [隐私说明](privacy.md) | 权限、存储、导出与删除行为 |
| [验证指南](testing.md) | 可运行检查、人工验收与证据要求 |
| [路线图](roadmap.md) | 数据可靠性、工程基础与同步能力 |
| [ADR 0001](decisions/0001-local-first.md) | 本地优先和无构建 MVP 的决策 |
| [来源记录](provenance.md) | 来源、许可和发布待办 |
| [2026-09-18 审查](reviews/2026-09-18-readiness.md) | 问题优先级、开源门槛与验证证据 |
| [0.2.0 验证记录](reviews/2026-09-18-v0.2.0-validation.md) | 修复结果、实际测试、性能与剩余发布决策 |

入口：[README](../README.md)、[贡献指南](../CONTRIBUTING.md)、[AGENTS](../AGENTS.md)、[安全问题处理](../SECURITY.md)。

功能变化更新产品文档；持久化变化更新数据契约；重要架构选择新增 ADR；审查及验证记录按日期保留。

[0.4.0 稳定交互方案](decisions/0004-stable-panel-and-mac-shortcuts.md) · [0.4.0 验证记录](reviews/2026-09-18-v0.4.0-stability.md)

[0.4.1 弹窗与快捷键修复](reviews/2026-09-18-v0.4.1-hotfix.md)

[0.4.2 侧栏快捷键开关](reviews/2026-09-18-v0.4.2-panel-toggle.md)

[0.4.3 真实快捷键调用链修复](reviews/2026-09-18-v0.4.3-command-gesture.md)

[0.5.0 云同步使用](cloud-sync.md) · [0.5.0 同步验证](reviews/2026-09-19-v0.5.0-sync.md)
