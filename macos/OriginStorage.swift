import AppKit
import WebKit

// baseURL gives this native-created blank document the saved WebKit origin.
// This can read its persisted storage even when an unrelated process owns its port.
final class OriginStorage: NSObject, WKNavigationDelegate {
    private let web: WKWebView
    private var completion: ((Result<Any, Error>) -> Void)?
    private let script: String
    private let arguments: [String: Any]
    private var executing = false

    init(url: URL, script: String, arguments: [String: Any] = [:], store: WKWebsiteDataStore = .default(), host: NSView, completion: @escaping (Result<Any, Error>) -> Void) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        self.web = WKWebView(frame: host.bounds, configuration: config)
        self.script = script
        self.arguments = arguments
        self.completion = completion
        super.init()
        web.autoresizingMask = [.width, .height]
        host.addSubview(web, positioned: .below, relativeTo: nil)
        web.navigationDelegate = self
        web.loadHTMLString("<!doctype html><meta charset='utf-8'><title>本地学习数据</title>", baseURL: url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.finish(.failure(NSError(domain: "StudyDeskStorage", code: 1, userInfo: [NSLocalizedDescriptionKey: "学习数据迁移超时，原数据已保留，请重试。"])))
        }
    }

    private func finish(_ result: Result<Any, Error>) {
        guard let done = completion else { return }
        completion = nil
        web.navigationDelegate = nil
        web.stopLoading()
        web.removeFromSuperview()
        done(result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !executing else { return }
        executing = true
        web.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { [weak self] result in
            self?.finish(result)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
}
