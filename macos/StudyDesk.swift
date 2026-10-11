import AppKit
import Darwin
import Foundation
import WebKit

// The learning window is this app. Nothing here launches a browser.
final class StudyDeskDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    private var mainWindow: NSWindow!
    private var mainWeb: WKWebView!
    private var pages: [NSWindow] = []
    private var overlay: NSView?
    private var statusLabel: NSTextField?
    private var detailLabel: NSTextField?
    private var retryButton: NSButton?
    private var busy = false
    private var socketFD: Int32 = -1
    private var deskURL = URL(string: "http://127.0.0.1:8790/")!
    private var storageJob: OriginStorage?
    private var pendingOrigin: URL?
    private var originFile: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".study-desk/ui-origin.json") }
    private let logDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/StudyDesk", isDirectory: true)
    private var appRoot: URL { Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true) }
    private var socketPath: String { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".study-desk/ui.sock").path }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        let window = makeWindow(configuration: makeConfiguration(), title: "网课学习工作台", external: false)
        mainWindow = window.0
        mainWeb = window.1
        showOverlay(status: "正在启动…", detail: "正在准备本地学习环境，课程与笔记会保持原样。", retry: false)
        log("native launcher started pid=\(ProcessInfo.processInfo.processIdentifier)")
        startControlSocket()
        start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMain()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if socketFD >= 0 { Darwin.close(socketFD); socketFD = -1 }
        Darwin.unlink(socketPath)
        log("native launcher quit; shared service preserved")
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window !== mainWindow else { return }
        DispatchQueue.main.async { self.pages.removeAll { $0 === window } }
    }

    private func makeMenu() {
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu(title: "网课学习工作台")
        appMenu.addItem(withTitle: "打开学习窗口", action: #selector(showMain), keyEquivalent: "o").target = self
        appMenu.addItem(withTitle: "查看启动日志", action: #selector(showLogs), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出网课学习工作台", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        menu.addItem(item)
        NSApp.mainMenu = menu
    }

    private func makeConfiguration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        return config
    }

    private func makeWindow(configuration: WKWebViewConfiguration, title: String, external: Bool) -> (NSWindow, WKWebView) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.minSize = NSSize(width: 960, height: 640)
        window.isReleasedWhenClosed = false
        window.delegate = self
        if external { pages.append(window) }
        window.setFrameAutosaveName(external ? "StudyDeskPage" : "StudyDeskMain")
        if let screen = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            let size = NSSize(width: min(1440, screen.width * 0.88), height: min(960, screen.height * 0.88))
            window.setContentSize(size)
        }
        window.center()
        let web = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = external
        window.contentView?.addSubview(web)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return (window, web)
    }

    private func showOverlay(status: String, detail: String, retry: Bool) {
        overlay?.removeFromSuperview()
        let box = NSView(frame: mainWindow.contentView!.bounds)
        box.autoresizingMask = [.width, .height]
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let title = NSTextField(labelWithString: "网课学习工作台")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.frame = NSRect(x: 36, y: box.bounds.midY + 18, width: box.bounds.width - 72, height: 30)
        title.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        box.addSubview(title)
        let statusField = NSTextField(labelWithString: status)
        statusField.font = .systemFont(ofSize: 14, weight: .medium)
        statusField.textColor = retry ? .systemRed : .labelColor
        statusField.frame = NSRect(x: 36, y: box.bounds.midY - 8, width: box.bounds.width - 72, height: 22)
        statusField.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        box.addSubview(statusField)
        let detailField = NSTextField(wrappingLabelWithString: detail)
        detailField.font = .systemFont(ofSize: 13)
        detailField.textColor = .secondaryLabelColor
        detailField.frame = NSRect(x: 36, y: box.bounds.midY - 78, width: min(520, box.bounds.width - 72), height: 64)
        detailField.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        box.addSubview(detailField)
        let button = NSButton(title: retry ? "重试启动" : "正在启动…", target: self, action: #selector(start))
        button.bezelStyle = .rounded
        button.keyEquivalent = "\r"
        button.isEnabled = retry
        button.frame = NSRect(x: 36, y: box.bounds.midY - 124, width: 140, height: 32)
        button.autoresizingMask = [.maxXMargin, .minYMargin, .maxYMargin]
        box.addSubview(button)
        mainWindow.contentView?.addSubview(box)
        overlay = box
        statusLabel = statusField
        detailLabel = detailField
        retryButton = button
    }

    private func hideOverlay() {
        overlay?.removeFromSuperview()
        overlay = nil
    }

    @objc private func showMain() {
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if mainWeb.url == nil && !busy { start() }
    }

    @objc private func showLogs() {
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logDirectory)
    }

    private func log(_ message: String) {
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let file = logDirectory.appendingPathComponent("launcher.log")
        let data = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
        if !FileManager.default.fileExists(atPath: file.path) { try? data.write(to: file) }
        else if let handle = try? FileHandle(forWritingTo: file) { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
    }

    private func failure(_ message: String) {
        log("launch failed: \(message)")
        DispatchQueue.main.async {
            self.busy = false
            self.showOverlay(status: "暂时无法打开学习窗口", detail: message, retry: true)
            self.mainWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func nodeExecutable() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" }
        return ([Bundle.main.resourceURL!.appendingPathComponent("runtime/node").path, home + "/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"] + paths).first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @objc private func start() {
        if busy { return }
        busy = true
        DispatchQueue.main.async {
            self.showOverlay(status: "正在准备学习窗口…", detail: "正在准备本地学习环境，课程与笔记会保持原样。", retry: false)
        }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let node = self.nodeExecutable() else {
                self.failure("未找到 Node.js。请安装 Node.js 22.5 或更新版本，再点重试。")
                return
            }
            let helper = self.appRoot.appendingPathComponent("lib/desktop-start.mjs")
            guard FileManager.default.fileExists(atPath: helper.path) else {
                self.failure("应用启动文件不完整，请重新更新网课学习工作台。")
                return
            }
            do {
                self.log("service check node=\(node) root=\(self.appRoot.path)")
                let service = Process()
                service.executableURL = URL(fileURLWithPath: node)
                service.arguments = [helper.path]
                service.currentDirectoryURL = self.appRoot
                var env = ProcessInfo.processInfo.environment
                for key in Array(env.keys) where key.hasPrefix("STUDYDESK_") { env.removeValue(forKey: key) }
                env["STUDYDESK_PORT"] = "8790"
                service.environment = env
                let output = Pipe()
                service.standardOutput = output
                service.standardError = output
                try service.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                service.waitUntilExit()
                let text = String(data: data, encoding: .utf8) ?? ""
                guard service.terminationStatus == 0 else {
                    let line = text.split(separator: "\n").last.map(String.init) ?? ""
                    let json = line.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    self.failure(json?["error"] as? String ?? "本地服务没有正常启动，请查看启动日志后重试。")
                    return
                }
                let line = text.split(separator: "\n").last.map(String.init) ?? ""
                guard let jsonData = line.data(using: .utf8),
                      let result = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                      result["ok"] as? Bool == true,
                      let rawURL = result["url"] as? String, let url = URL(string: rawURL),
                      url.scheme == "http", url.host == "127.0.0.1", url.path == "/",
                      let port = url.port, (1024...65535).contains(port) else {
                    self.failure("本地服务返回的启动地址无效，请查看日志后重试。")
                    return
                }
                self.log("service ready at \(url.absoluteString); reused=\(result["reused"] ?? false)")
                DispatchQueue.main.async {
                    self.prepareOrigin(url)
                }
            } catch {
                self.failure("启动失败：\(error.localizedDescription)")
            }
        }
    }

    private func prepareOrigin(_ url: URL) {
        var previous = URL(string: "http://127.0.0.1:8790/")!
        if let data = try? Data(contentsOf: originFile),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let raw = object["url"] as? String, let saved = URL(string: raw),
           saved.scheme == "http", saved.host == "127.0.0.1", saved.path == "/",
           let port = saved.port, (1024...65535).contains(port) { previous = saved }
        if previous == url { loadDesk(url); return }
        showOverlay(status: "正在恢复课程与笔记…", detail: "本机端口已调整，正在保留学习记录与设置。", retry: false)
        do {
            let script = try String(contentsOf: appRoot.appendingPathComponent("lib/origin-storage.js"), encoding: .utf8)
            storageJob = OriginStorage(url: previous, script: script, host: mainWindow.contentView!) { captured in
                do {
                    let source = try captured.get()
                    self.storageJob = OriginStorage(url: url, script: script, host: self.mainWindow.contentView!) { destination in
                        do {
                            let before = try destination.get()
                            let dir = self.originFile.deletingLastPathComponent().appendingPathComponent("origin-backups")
                            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                            let file = dir.appendingPathComponent("\(UUID().uuidString).json")
                            let data = try JSONSerialization.data(withJSONObject: ["source": source, "destination": before])
                            try data.write(to: file, options: .atomic)
                            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                            self.storageJob = OriginStorage(url: url, script: script, arguments: ["snapshot": source], host: self.mainWindow.contentView!) { restored in
                                do {
                                    _ = try restored.get()
                                    // Commit before navigating: a failed page load must not copy stale data again.
                                    try self.rememberOrigin(url)
                                    self.storageJob = nil
                                    self.log("learning data migrated \(previous.absoluteString) -> \(url.absoluteString); backup=\(file.path)")
                                    self.loadDesk(url)
                                } catch { self.failure("学习数据恢复未完成：\(error.localizedDescription)") }
                            }
                        } catch { self.failure("学习数据备份未完成：\(error.localizedDescription)") }
                    }
                } catch { self.failure("读取原学习数据失败：\(error.localizedDescription)") }
            }
        } catch { failure("学习数据迁移文件无法读取：\(error.localizedDescription)") }
    }

    private func rememberOrigin(_ url: URL) throws {
        try FileManager.default.createDirectory(at: originFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["url": url.absoluteString]).write(to: originFile, options: .atomic)
    }

    private func loadDesk(_ url: URL) {
        deskURL = url
        pendingOrigin = url
        guard let request = deskRequest() else { failure("本地应用凭证还没准备好，请点重试。"); return }
        mainWeb.load(request)
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func deskRequest() -> URLRequest? {
        let tokenURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".study-desk/shell.token")
        guard let token = try? String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else { return nil }
        var request = URLRequest(url: deskURL)
        request.setValue(token, forHTTPHeaderField: "X-StudyDesk-Shell")
        return request
    }

    private func openPage(_ url: URL) {
        let window = makeWindow(configuration: makeConfiguration(), title: "网课学习工作台", external: true)
        window.1.load(URLRequest(url: url))
        log("opened local window \(url.absoluteString)")
    }

    private func startControlSocket() {
        let dir = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        Darwin.unlink(socketPath)
        DispatchQueue.global(qos: .utility).async {
            let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { self.log("control socket failed to open"); return }
            var addr = sockaddr_un()
            memset(&addr, 0, MemoryLayout<sockaddr_un>.size)
            addr.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(self.socketPath.utf8)
            guard bytes.count < 104 else { Darwin.close(fd); self.log("control socket path too long"); return }
            withUnsafeMutablePointer(to: &addr.sun_path) { pointer in
                pointer.withMemoryRebound(to: UInt8.self, capacity: 104) { destination in
                    for (index, byte) in bytes.enumerated() { destination[index] = byte }
                }
            }
            let bound = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0, Darwin.listen(fd, 8) == 0 else {
                Darwin.close(fd)
                self.log("control socket bind failed errno=\(errno)")
                return
            }
            Darwin.chmod(self.socketPath, 0o600)
            self.socketFD = fd
            self.log("control socket ready")
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 { break }
                var buffer = [UInt8](repeating: 0, count: 8192)
                let count = Darwin.read(client, &buffer, buffer.count)
                Darwin.close(client)
                guard count > 0, let object = try? JSONSerialization.jsonObject(with: Data(buffer.prefix(count))) as? [String: Any] else { continue }
                if object["reload"] as? Bool == true {
                    DispatchQueue.main.async { self.mainWeb.reload() }
                    continue
                }
                guard let raw = object["url"] as? String, let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { continue }
                DispatchQueue.main.async { self.openPage(url) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === mainWeb {
            if let url = pendingOrigin {
                do { try rememberOrigin(url); pendingOrigin = nil }
                catch { failure("学习窗口已载入，但无法保存启动地址：\(error.localizedDescription)"); return }
            }
            busy = false
            hideOverlay()
            log("learning window loaded")
        }
        if let title = webView.title, !title.isEmpty { webView.window?.title = title }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if webView === mainWeb { failure("学习窗口没有载入：\(error.localizedDescription)") }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        if webView === mainWeb { failure("学习窗口没有载入：\(error.localizedDescription)") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        var destination = downloads.appendingPathComponent(suggestedFilename.isEmpty ? "下载文件" : suggestedFilename)
        if FileManager.default.fileExists(atPath: destination.path) {
            let stem = destination.deletingPathExtension().lastPathComponent
            let ext = destination.pathExtension
            destination = downloads.appendingPathComponent(ext.isEmpty ? "\(stem)-\(Int(Date().timeIntervalSince1970))" : "\(stem)-\(Int(Date().timeIntervalSince1970)).\(ext)")
        }
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        log("download finished")
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let window = makeWindow(configuration: configuration, title: "网课学习工作台", external: true)
        log("opened local window from page")
        return window.1
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host
        if host == "127.0.0.1" || host == "localhost" { decisionHandler(.grant) }
        else { decisionHandler(.prompt) }
    }
}

@main
struct StudyDeskApplication {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = StudyDeskDelegate()
        application.delegate = delegate
        application.run()
    }
}
