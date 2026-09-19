# Supabase SQL 本地验证

日期：2026-09-19。对象：[setup.sql](../../supabase/setup.sql)、[verify.sql](../../supabase/verify.sql)。

## 已实现边界

云端 schema、用户隔离、只读状态/增量拉取、事务上传和幂等回执已形成可执行 SQL。安装不含后台任务、实时订阅、项目地址或密钥；没有修改现有扩展运行代码。

使用独立 `prompt_vault` schema 和三个 public.pv_sync_* RPC；只影响本方案拥有的对象。不改 Supabase Auth 表结构、不初始化真实用户、不操作其他应用的表。

## 实际执行

运行 `bash scripts/test-supabase.sh`，在本机 PostgreSQL 14.18 的独立临时数据库中验证，Auth 使用测试专用 users 表及 auth.uid() 最小替身。禁用 TCP，只用独立临时 Unix socket；执行后停止并删除临时实例。

| 检查 | 结果与证据 |
| --- | --- |
| 首次安装与完整函数编译 | PASS；psql ON_ERROR_STOP 执行成功 |
| 原子组新建、同组引用次序 | PASS；先提交引用子项再提交父目录仍可原子创建 |
| ACK 丢失重试 | PASS；同 opId 同请求返回完全相同回执，变更日志不增加 |
| opId 被更换载荷复用 | PASS；拒绝，不覆盖原回执 |
| 版本冲突 | PASS；同组其他新增也不写入，游标不推进，冲突回执可重放 |
| 删除目录 | PASS；移出提示词与子目录，保留已修改正文，副作用属于同一组 |
| 删除提示词与复活尝试 | PASS；保留墓碑，同 ID 复活返回冲突 |
| 无效目录、目录循环 | PASS；事务回滚实体与游标 |
| 分页与固定水位 | PASS；原子组不拆页，后续写入不混进固定 highWater |
| 空库读取 | PASS；status/pull 不创建 sync_state |
| 匿名、缺失登录身份 | PASS；三个 RPC 拒绝匿名，无 JWT 的认证角色调用也拒绝 |
| 两个账号的 RLS/RPC | PASS；实体、回执、历史隔离；同 ID/opId 可各自使用；跨账号目录引用拒绝 |
| 绕开 RPC 直接写入与调用私有函数 | PASS；数据库权限拒绝 |
| 非法字段、类型、重复实体、游标、容量边界 | PASS；错误输入拒绝，不能混入本机计数或伪造所有者 |
| 原脚本重复执行 | PASS；已有用户游标保留，表/日志/回执没有清空语句 |
| 两连接并发 | PASS；A 持有未提交写入时读取仍停在旧水位，B 等待后提交，增量结果依次为 5、6 |
| verify.sql | PASS；六项检查均为 PASS |
| npm run check | PASS；28 个本地运行资源、44 个 JS 语法检查、98 个文档链接 |
| Shell 语法及 diff 格式 | PASS；bash -n scripts/test-supabase.sh 与 git diff --check |

对事务组、SECURITY DEFINER、空 search_path、每个用户过滤条件、RLS 与直接写入权限做了本轮源码自查。没有独立子代理审查证据。

## 尚未验证

- Supabase 托管实例上的实际安装、Auth 邮箱登录/JWT、Data API 暴露配置和 HTTP RPC。
- 新版 PostgreSQL、Supabase 网关请求大小、超时、套餐容量和用户实际网络延迟。
- 最大允许载荷下的性能与内存；目前仅验证相关拒绝边界，未做容量压测。
- 插件配置界面、登录、主动触发、IndexedDB 消费、跨页面并发和真实两设备联调；客户端尚未实现。

本次不构成同步功能的端到端完成证明。SQL Editor 执行步骤与协议约束见 [初始化指南](../supabase-setup.md)。
