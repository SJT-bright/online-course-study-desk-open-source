import assert from "node:assert/strict";
import { extractFeishuUrl, isFeishuHost, parseFeishuUrl } from "../feishu-url.mjs";
import test from "node:test";

test("accepts Feishu and Lark hosts", () => {
  assert.equal(isFeishuHost("acme.feishu.cn"), true);
  assert.equal(isFeishuHost("acme.larksuite.com"), true);
  assert.equal(isFeishuHost("bilibili.com"), false);
});

test("extracts a URL from share text", () => {
  const text = "课堂录像 https://team.feishu.cn/minutes/obcnabcdefghijklmnopabcd 【标题】";
  assert.equal(extractFeishuUrl(text), "https://team.feishu.cn/minutes/obcnabcdefghijklmnopabcd");
});

test("parses minutes, files, docs and wiki", () => {
  assert.equal(parseFeishuUrl("https://x.feishu.cn/minutes/obcn1234567890abcdef1234?from=share").kind, "minutes");
  assert.equal(parseFeishuUrl("https://x.feishu.cn/file/boxcnFILETOKEN").kind, "file");
  assert.equal(parseFeishuUrl("https://x.feishu.cn/drive/file/boxcnFILETOKEN").kind, "file");
  assert.equal(parseFeishuUrl("https://x.feishu.cn/docx/doxcnDOC").kind, "docx");
  assert.equal(parseFeishuUrl("https://x.feishu.cn/wiki/wikcnNODE").kind, "wiki");
  assert.equal(parseFeishuUrl("https://x.larksuite.com/slides/sldcnSLIDE").kind, "slides");
  assert.equal(parseFeishuUrl("https://x.feishu.cn/minutes/obcn1234567890abcdef1234").canDownload, true);
  assert.equal(parseFeishuUrl("https://x.feishu.cn/sheets/shtcnSHEET").canDownload, false);
});

test("rejects non-Feishu and credentialed URLs", () => {
  assert.throws(() => parseFeishuUrl("https://www.bilibili.com/video/BV1xx"), /不是飞书/);
  assert.throws(() => parseFeishuUrl("javascript:alert(1)"), /http:\/\/ 或 https:\/\//);
  assert.throws(() => parseFeishuUrl("不是链接"), /完整的飞书链接/);
  assert.throws(() => parseFeishuUrl("https://user:pass@x.feishu.cn/docx/abc"), /账号密码/);
});
