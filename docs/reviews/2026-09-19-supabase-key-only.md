# 个人项目 URL + key 同步 SQL 验证

日期：2026-09-19。当前 schema v3，同步协议 v1。取代[固定库主 Auth 方案](2026-09-19-supabase-single-owner.md)，旧验证记录保持原样。

## 决策与变更

保留增量同步，按用户指定参考项目的连接习惯，仅配置 Project URL + publishable/legacy anon key。移除 Auth 依赖、owner_id、库主绑定与用户会话；不额外创建同步令牌或登录系统。

只向 anon 授予 public.pv_sync_status/push/pull 的 EXECUTE；不授予直接表访问或私有函数执行。RLS 保持默认拒绝，RPC 以固定 search_path 的 SECURITY DEFINER 执行协议校验。authenticated 不授予 RPC 权限，客户端不发送用户 JWT。

该方案不验证个人身份。任何持有项目有效 publishable/anon key 的人都可以通过 RPC 读取所有当前数据和历史，并修改或软删除数据；同项目多个有效 key 共享 anon 权限。私人独立项目、本机保存配置、不开源配置是使用边界，不等于密码认证或端到端加密。

## 实际验证

运行 `bash scripts/test-supabase.sh`，使用 PostgreSQL 14.18 的独立临时实例与 Unix socket。测试环境只建 anon/authenticated/rpc_ungranted 角色，**没有 auth schema、users 表或 auth.uid() 函数**，安装和全部同步测试通过。

| 检查 | 结果 |
| --- | --- |
| 无 Auth 环境安装与执行 | PASS |
| anon 执行三个 RPC | PASS：合法读写成功，非法载荷被协议拒绝 |
| 未授权角色 / authenticated 调用 | PASS：数据库执行权限拒绝 |
| anon 直接读写表、修改游标、调用私有 helper | PASS：拒绝 |
| 重复上传与载荷变化 | PASS：回执重放，不同载荷复用 opId 拒绝 |
| 版本冲突与组内原子性 | PASS |
| 删除传播、循环引用、墓碑防复活 | PASS |
| 增量分页与固定水位 | PASS |
| 两连接并发提交 | PASS：不暴露未提交游标，完整返回序号 5、6 |
| 重复安装与旧 schema 标记 | PASS：保留数据 / 拒绝覆盖旧结构 |
| verify.sql | PASS：八项通过 |
| 静态检查 | PASS：npm run check（28 个运行资源、44 项 JS 语法、102 个文档链接）、bash -n、git diff --check |

没有修改现有扩展运行代码，没有连接或写入用户的云端项目。

## 未验证

- 本地角色权限测试不证明 Supabase 网关拒绝缺失/无效 key；需目标项目的 HTTPS 请求验证。
- Supabase 托管安装、HTTP 网关容量/超时与用户网络未验证。
- 插件配置、界面、主动触发、IndexedDB 应用和真实两设备端到端同步尚未实现。
- 当前脚本不是旧 schema v1/v2 的迁移工具；如已部署旧结构，需要单独迁移，不能直接降低其访问保护或清库。
