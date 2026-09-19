# 单用户 Supabase SQL 验证

日期：2026-09-19。当前 schema v2，同步协议 v1；取代[多用户初版](2026-09-19-supabase-sql.md)，初版记录保持原样。

## 变更

- 每位使用者自行创建 Supabase 项目，一个项目只服务一个库主及其多台设备。
- entities、sync_changes、sync_receipts 移除 user_id、跨用户主键与过滤条件。
- schema_info 合入唯一 sync_state 行，应用表从五张减为四张。
- 取消逐用户 RLS 策略，直接表访问全部拒绝；三个 RPC 都验证固定 owner_id。
- 安装需要 Auth 中恰好一个用户；安装后库主固定，其他账号调用被拒绝，重复安装不重新绑定。
- 保留版本冲突、墓碑、幂等回执、原子组与增量游标，继续支持个人多设备并发。
- 不自动覆盖旧版 schema；发现旧 schema_info 标记即停止，保留已有数据。

## 实际执行

`bash scripts/test-supabase.sh` 在 PostgreSQL 14.18 临时实例中通过；Auth 为最小模拟，Unix socket 独立，禁用 TCP，退出后清除临时实例。

| 场景 | 结果 |
| --- | --- |
| 零个 / 多个初始 Auth 用户 | PASS：安装拒绝，不产生半成品 |
| 唯一用户安装及合法 RPC | PASS |
| 匿名、未登录、第二个已登录账号 | PASS：RPC 拒绝 |
| 库主及其他账号直接读写表 / 调私有 helper | PASS：权限拒绝 |
| 第二个账号试图修改 owner_id | PASS：权限拒绝 |
| 重复安装时已有第二个 Auth 用户 | PASS：原库主和游标不变 |
| 直接删除库主 Auth 用户 | PASS：RESTRICT 阻止，不级联丢失数据 |
| ACK 丢失重放、opId 载荷变化 | PASS：原回执重放 / 不同载荷拒绝 |
| 陈旧版本、关联组、无效引用及目录循环 | PASS：冲突或错误时全组不写入 |
| 删除目录 / 提示词及复活尝试 | PASS：副作用原子，正文保留，旧 ID 不能复活 |
| 分页、固定水位、两连接并发提交 | PASS：游标按提交顺序前进，完整返回变更组 |
| 非法字段、类型、重复 ID、容量边界 | PASS |
| 旧版安装标记 | PASS：安全拒绝，现有测试数据游标仍为 6 |
| verify.sql | PASS：八项全部通过，包括单库主和无租户字段 |
| npm run check | PASS：28 个运行资源、44 项 JS 语法、100 个文档链接 |
| Shell 语法 / diff 格式 | PASS：bash -n 与 git diff --check |

改造后曾先运行未更新的旧测试入口，因缺少预先创建的 Auth 用户而按新规则拒绝安装；更新测试准备步骤后，上述完整验证通过。

## 未验证

没有连接或修改用户 Supabase 项目。托管 Auth、HTTP/JWT、网关限制、真实网络及扩展端同步仍未验证；客户端功能未实现。

当前 setup.sql 是新安装脚本，不是已部署多用户 schema 的数据迁移。若旧版已实际部署，需要另按其中的数据生成迁移，不能用清库替代。
