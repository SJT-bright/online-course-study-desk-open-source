macOS 原生启动器、Windows 桌面端和共享学习核心全部开源（MIT）。

Windows 10 / 11 x64：EXE 为可选择安装目录的安装器，ZIP 解压后运行 StudyDesk.exe。内含 Node.js 24 与本机实时语音引擎；模型首次使用时下载。yt-dlp、FFmpeg、Whisper 与飞书 CLI 是可选依赖，说明见 docs/windows.md。

修复中文目录导致的端口误报；其他程序占用端口时自动选择空闲端口。Windows 使用固定应用地址保存课程、草稿与录音。数据位于用户目录，更新与卸载不主动删除学习数据。

发行包未购买 Windows 代码签名证书。下载后可对照 SHA256SUMS.txt 校验。CI 覆盖 macOS / Windows 源码测试、Windows 打包程序启动与存储；真实课程平台账号及音频设备需要本机验证。
