# Windows 端

Windows 10 / 11 x64。源码、构建脚本和 GitHub Actions 都在同一公开仓库。

## 安装与数据

NSIS 安装器可选择安装目录；ZIP 可解压直接启动。安装包未使用付费代码签名证书，Windows 可能显示发行者未验证；可对照 Release 的 SHA256SUMS.txt 校验下载文件。

应用数据保存在 `%APPDATA%/StudyDesk/`：Chromium 学习数据、`home/.study-desk/notes.db`、转写记录、复习卡、设置和模型。安装目录更新不会替换用户目录。应用只监听本机回环地址，8790 被占用时自动换端口。窗口的 `studydesk://app/` 地址固定，课程、Blob 录音、草稿和播放记录不随端口改变。

首次使用本机实时转写时，在界面下载模型。麦克风需要系统权限；系统声音转写会提示选择屏幕，Windows 使用 loopback 音频。实体音频设备和第三方课程账号需在使用者电脑上验收。

## 可选依赖

B站下载需要 yt-dlp；合并视频与音频、文件转写需要 FFmpeg。可在 PowerShell 手动运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install-optional-tools.ps1
```

安装后重新打开应用。自定义位置可设置 `STUDYDESK_YTDLP`、`STUDYDESK_FFMPEG`、`STUDYDESK_WHISPER` 为对应 `.exe` 的完整路径，也可通过 `STUDYDESK_BIN` 指定工具目录。

B站自动本地转写可单独部署 Fun-ASR-Nano。使用 `STUDYDESK_NANO_HOME` 指向部署目录，默认查找 `venv/Scripts/python.exe`。也支持 `STUDYDESK_NANO_PYTHON`、`STUDYDESK_NANO_MODEL` 和 `STUDYDESK_NANO_VAD` 分别指定路径。没有这些依赖时，会说明缺失原因，不自动下载大型权重。

飞书导入需要自行安装并登录 lark-cli，可用 `STUDYDESK_LARK` 指定可执行文件。第三方工具的网页版会在应用内独立窗口打开；Office/WPS 文档使用 Windows 文件关联打开。本地资料库集成默认使用 8791，可用 `STUDYDESK_VAULT_PORT` 修改；基础复习使用随源码提供的本地规则，不依赖其他项目。

## 自动验证

CI 测试代码、隔离本地服务、端口冲突、命名管道、文件与笔记接口、界面加载、能力令牌隔离、持久化 localStorage / IndexedDB Blob，以及安装包内程序启动。自动验证结果不代表真实平台登录、实体麦克风或识别准确率验收。
