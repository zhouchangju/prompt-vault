# 验证指南

扩展无需构建。开发测试要求 Node.js 22+；使用合成数据及独立浏览器 profile，避免修改日常提示词库。

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:e2e
npm run test:shortcut:manual
npm run verify
npm run benchmark
npm run package
npm run build
npm run test:package
```

| 命令 | 证明范围 |
| --- | --- |
| check | JS 语法、运行资源与文档链接等静态契约 |
| test | Node 回归与 fake-indexeddb 数据行为；不等同真实浏览器 |
| test:e2e | 独立 Chromium 扩展页面、存储及交互回归 |
| test:shortcut:manual | 临时可见浏览器，向窗口发送实际快捷键三次，验证真实 onCommand 与打开/关闭/打开；不放入无人值守 CI |
| verify | check、test、test:e2e 串行执行 |
| benchmark | 100/1,000/10,000 合成提示词的浏览器启动、搜索及滚动测量 |
| package | 白名单资源归档；解压后仍需安装验证 |
| build | 将白名单资源生成到固定的 dist/prompt-vault/，直接加载无需解压 |
| test:package | 重新打包、临时目录解压，以独立 Chromium 验证创建/复制、所有主题及旧数据兼容 |

CI 配置复用验证入口，但当前没有远程执行证据。浏览器测试通过也不自动证明最低 Chrome 版本、所有操作系统、商店发布或全部人工体验通过。

本轮实际结果见 [0.2.0 验证记录](reviews/2026-09-18-v0.2.0-validation.md)。

2026-09-18 补充：`npm run build` 的固定目录 `dist/prompt-vault/` 已单独加载到 Chromium，创建/复制与响应式、全部主题、旧版数据库兼容三项用例通过。22 个白名单文件与源文件逐字节一致；目录被系统创建的 `.DS_Store` 不属于构建内容，不计入比较。

按 [实施清单](implementation-checklist.md) 核对异常导入零写入、预览过期、并发保存/删除、设备身份、旧数据迁移、广播与恢复、失败保留输入、弹窗键盘操作及主题/精简模式组合。补充人工检查工具栏打开侧栏、快捷键、下载、剪贴板与辅助技术实际体验。

新增验证记录应写明命令、环境、实际结果、证据位置和未验证范围。静态、模拟 DB、真实扩展、性能、人工决策分别报告；没有运行记 UNVERIFIED，执行失败记 FAIL。保留历史审查，不将其改写为修复后报告。
