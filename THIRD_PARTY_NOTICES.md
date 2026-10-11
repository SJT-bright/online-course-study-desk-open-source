# 第三方组件

本项目原创源码使用 MIT。第三方组件保留各自许可证与版权，不由本项目重新授权。

| 组件 | 用途 | 许可证与源码 |
| --- | --- | --- |
| Electron 44.7.0 | Windows 桌面窗口 | MIT；https://github.com/electron/electron 。发行包包含 Electron 与 Chromium 的许可证。 |
| Node.js 24.21.0 | 本地服务与 SQLite | MIT 及依赖声明；https://github.com/nodejs/node/tree/v24.21.0 。Windows 发行包 `resources/runtime/NODE-LICENSE.txt` 包含完整声明。 |
| sherpa-onnx-node 1.13.8 | 本机实时语音识别 | Apache-2.0；https://github.com/k2-fsa/sherpa-onnx 。依赖通过 npm 安装；完整许可见 `licenses/sherpa-onnx.txt`（Apache-2.0 通用条款也随文档预览许可一起提供）。 |
| JSZip 3.10.1 | 读取和导出文档 | MIT（选择其双许可证中的 MIT）；https://github.com/Stuk/jszip 。完整声明见 `licenses/jszip.txt`。 |
| docx-preview | DOCX 预览 | Apache-2.0；https://github.com/VolodymyrBaydalka/docxjs 。完整声明见 `licenses/docx-preview.txt`。 |
| Paraformer 双语模型 | 可选的本机实时转写模型 | Apache-2.0；https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en 。用户选择下载后才保存到用户目录。 |

yt-dlp、FFmpeg、whisper.cpp、Fun-ASR-Nano / Qwen3 和 VAD 属于可选工具或模型，未捆绑其可执行文件或权重。安装、下载和使用时适用各自上游许可证。Windows 可手动运行 `windows/install-optional-tools.ps1` 安装视频下载与格式转换工具。云语音、飞书与课程平台要求使用者自行配置账号和权限。
