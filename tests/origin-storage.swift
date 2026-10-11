import AppKit
import WebKit

@available(macOS 14.0, *)
@main
struct OriginStorageTest {
    static var job: OriginStorage?
    static let storeID = UUID()
    static var store: WKWebsiteDataStore!
    static let original = URL(string: "http://127.0.0.1:60001/")!
    static let fallback = URL(string: "http://127.0.0.1:60002/")!
    static var snapshot: Any?
    static var script = ""
    static var steps: [() -> Void] = []
    static var window: NSWindow!

    static func run(_ url: URL, _ code: String, _ arguments: [String: Any] = [:], _ check: @escaping (Any) throws -> Void = { _ in }) {
        job = OriginStorage(url: url, script: code, arguments: arguments, store: store, host: window.contentView!) { result in
            do { try check(result.get()); next() }
            catch { fputs("origin-storage failed: \(error)\n", stderr); exit(1) }
        }
    }
    static func next() {
        if steps.isEmpty {
            job = nil
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                store = nil
                print("origin-storage passed: courses, notes, drafts, blobs, files, settings, return-port and deleted rows")
                NSApp.terminate(nil)
            }
            return
        }
        steps.removeFirst()()
    }
    static func require(_ condition: Bool) throws {
        if !condition { throw NSError(domain: "OriginStorageTest", code: 1) }
    }
    static func main() throws {
        script = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        store = WKWebsiteDataStore(forIdentifier: storeID)
        fputs("isolated WebKit store: \(storeID.uuidString)\n", stderr)
        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 640, height: 480), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "学习数据迁移测试（隔离数据）"
        window.orderFront(nil)
        steps = [
            { run(original, """
                const r=indexedDB.open('study-desk',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');
                const db=await new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
                const tx=db.transaction('kv','readwrite'),s=tx.objectStore('kv');
                s.put({name:'中文课程'},'course:one'); s.put({html:'<p>保留笔记</p>'},'note:one');
                s.put({html:'草稿'},'docdraft:one');
                s.put(new Blob(['录音内容'],{type:'text/plain'}),'audio');
                s.put(new File(['原始文件'],'课件.txt',{type:'text/plain',lastModified:123}),'file');
                s.put({array:new Uint16Array([42,65535]),date:new Date('2026-10-11T00:00:00Z'),unknown:undefined,n:Infinity},'types');
                await new Promise((ok,no)=>{tx.oncomplete=ok;tx.onabort=()=>no(tx.error)});db.close();
                localStorage.setItem('studydesk-dark','1');localStorage.setItem('custom','中文设置'); return true;
                """) },
            { run(original, script) { snapshot = $0; try require(($0 as? [String: Any])?["origin"] as? String == "http://127.0.0.1:60001") } },
            { run(fallback, """
                const r=indexedDB.open('study-desk',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');
                const db=await new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});const tx=db.transaction('kv','readwrite');
                tx.objectStore('kv').put('stale','obsolete');await new Promise(ok=>tx.oncomplete=ok);db.close();
                localStorage.setItem('obsolete','old');return true;
                """) },
            { run(fallback, script, ["snapshot": snapshot!]) },
            { run(fallback, """
                const r=indexedDB.open('study-desk',1);const db=await new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
                const get=k=>new Promise(ok=>{const q=db.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>ok(q.result)});
                const types=await get('types'), file=await get('file');
                const ok=(await get('course:one')).name==='中文课程' && (await get('note:one')).html==='<p>保留笔记</p>'
                  && (await get('docdraft:one')).html==='草稿' && await (await get('audio')).text()==='录音内容'
                  && await file.text()==='原始文件' && file.name==='课件.txt' && file.lastModified===123
                  && types.array instanceof Uint16Array && types.array[1]===65535 && types.date instanceof Date
                  && types.unknown===undefined && types.n===Infinity && await get('obsolete')===undefined
                  && localStorage.getItem('custom')==='中文设置' && localStorage.getItem('obsolete')===null;
                const tx=db.transaction('kv','readwrite');tx.objectStore('kv').delete('note:one');
                tx.objectStore('kv').put({name:'更新后的课程'},'course:one');await new Promise(ok=>tx.oncomplete=ok);db.close(); return ok;
                """) { try require($0 as? Bool == true) } },
            { run(fallback, script) { snapshot = $0 } },
            { run(original, script, ["snapshot": snapshot!]) },
            { run(original, """
                const r=indexedDB.open('study-desk',1);const db=await new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
                const get=k=>new Promise(ok=>{const q=db.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>ok(q.result)});
                const ok=await get('note:one')===undefined && (await get('course:one')).name==='更新后的课程';db.close();return ok;
                """) { try require($0 as? Bool == true) } },
        ]
        next()
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { fputs("origin-storage timed out\n", stderr); exit(1) }
        app.run()
    }
}
