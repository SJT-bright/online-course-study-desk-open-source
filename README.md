# 网课学习工作台 · StudyDesk

本地优先的网课播放、时间戳笔记、课程整理、转写和复习工作台。**macOS 原生启动器和 Windows 桌面端全部开源**，共用学习界面与本地服务。

版本 **3.7.0** · [下载 Windows 安装包](https://github.com/SJT-bright/online-course-study-desk-open-source/releases/latest) · [Windows 说明](docs/windows.md) · [MIT 许可证](LICENSE)

## 功能

- 播放本地视频与课程链接，倍速、继续播放、时间戳笔记、章节目录与跨课程搜索。
- 管理课程、标签、学习状态、番茄钟与复习卡；编辑 DOCX、预览 PDF、导出和恢复学习数据。
- 笔记镜像到本机 SQLite，保留历史版本；课程、草稿、播放进度和录音保存在本机。
- 可选本机实时语音识别、Whisper 精转、B站下载与转写、飞书资料导入，以及本地学习资产库集成。
- 端口占用时自动选择空闲端口，复用本应用已有服务；保留其他程序。Windows 窗口使用固定应用地址，端口改变不会改变学习数据的存储地址。

课程平台的播放、登录、下载和嵌入支持取决于平台自身及账号权限。可选工具和模型需要另行安装或下载，基础课程与笔记功能无需云 API Key。

## Windows 用户

在 [Releases](https://github.com/SJT-bright/online-course-study-desk-open-source/releases) 下载 `StudyDesk-3.7.0-windows-x64.exe`，按向导安装。也提供 ZIP，解压后运行 `StudyDesk.exe`。支持 Windows 10 / 11 x64。安装包内含独立 Node.js 和本机语音引擎，无需另装 Node。

学习数据位于 `%APPDATA%/StudyDesk/`，更新或卸载不主动删除该目录。默认录音媒体目录为用户下载文件夹下的 `StudyDesk`。需要搬到另一台电脑时，请在课程库导出学习备份，另行复制视频与讲义。

系统声音转写使用屏幕音频共享，开始时选择屏幕；不需要 BlackHole。麦克风转写仍可直接选择输入设备。第三方平台真实登录、音频设备和识别质量不属于 CI 的自动验收范围。

## 从源码运行

需要 Node.js **24 LTS**、npm 和 Git。在 PowerShell 或终端执行：

```sh
git clone https://github.com/SJT-bright/online-course-study-desk-open-source.git
cd online-course-study-desk-open-source
npm ci
npm ci --prefix local-asr
npm start
```

`npm start` 在应用窗口打开工作台，本地服务只监听 `127.0.0.1`。请勿把 `node server.mjs` 当作公开网站部署；浏览器导航不会直接打开完整学习窗口。

## macOS 原生源码

`macos/StudyDesk.swift` 和 `macos/OriginStorage.swift` 提供 AppKit / WKWebView 启动器，处理端口切换时的学习数据备份迁移。Apple Silicon macOS 12+，安装 Xcode 命令行工具和 Node.js 24 后：

```sh
npm ci --prefix local-asr
bash tools/build-macos-launcher.sh
node tools/package-macos.mjs
open dist/StudyDesk.app
```

这会生成独立应用，不覆盖已安装的应用；原生应用的数据仍位于 `~/.study-desk/`。macOS 原生应用与 Electron 开发端的浏览器存储独立；迁移请使用学习备份功能。

## 开发与打包

```sh
npm test
npm run smoke:desktop
# 以下打包步骤在 Windows x64 执行
npm run prepare:windows
npm run build:windows
```

GitHub Actions 在 macOS 和 Windows 执行隔离回归与真实 Chromium 窗口测试，并验证 Windows 打包后的程序。推送 `v*` 标签后生成 NSIS 安装包、ZIP 与 SHA256 校验文件，只有测试通过才发布。

- `server.mjs`、`lib/`：共享本机服务与学习功能。
- `网课学习工作台.html`、`vendor/`：共享界面与文档预览。
- `macos/`：原生 macOS 窗口。
- `windows/`：Windows Electron 窗口和可选工具安装脚本。
- `tests/`：使用临时数据目录的回归验证。

不向仓库或发行包提交用户课程、笔记数据库、登录状态、云密钥或模型权重。许可证与依赖见 [第三方声明](THIRD_PARTY_NOTICES.md)。
