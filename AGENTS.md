# 项目规则

本地优先的 macOS / Windows 学习工作台。修改共享核心时验证两端。

- Node.js 24 LTS；`npm test` 与 `npm run smoke:desktop` 使用隔离数据。
- 不访问真实用户的 `.study-desk`、浏览器学习数据、课程登录或资料库做测试。
- 不提交密钥、数据库、课程媒体、模型权重、运行日志或本地状态。
- Windows 发版由 `.github/workflows/build.yml` 构建并验证打包后的程序；保持用户目录稳定。
- 改动依赖时同步 lockfile 与第三方许可证。
- macOS 原生源码在 `macos/`，Windows 窗口在 `windows/`，核心在 `lib/` 和 `server.mjs`。
