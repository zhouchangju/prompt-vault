# 贡献指南

项目为本地 MVP，尚未确定开源许可证、公开仓库地址和维护承诺。正式接收外部贡献前，维护者应先明确这些条件。

## 开发

扩展运行无需安装依赖或构建。开发验证需 Node.js 22+，执行 `npm ci`、`npx playwright install chromium`，再运行 `npm run verify`。按 [README](README.md) 加载扩展；修改后在 `chrome://extensions/` 重新加载并重新打开相关页面。使用独立测试 profile 与合成提示词，避免损伤日常数据。

先查阅 [架构](docs/architecture.md)、[数据契约](docs/data-model.md)、[路线图](docs/roadmap.md)。每次变更解决一个明确问题，避免把框架迁移和业务修复混在一起。

## 变更要求

- 说明复现步骤、期望、实际结果及相关函数或模块。
- 数据、权限、网络行为改变时更新文档。
- 业务修复提供回归验证；Chrome API 需要扩展环境证据。
- 记录命令、环境、实际结果与未验证项，参照 [验证指南](docs/testing.md)。
- 示例用合成数据；排除用户导出、凭据、profile、日志和私人截图。
- 新依赖或素材记录来源、版本与许可证，保留必要署名。

敏感问题参照 [SECURITY](SECURITY.md)，不要公开上传真实提示词库。
