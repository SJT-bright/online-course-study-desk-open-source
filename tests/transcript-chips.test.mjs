import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../网课学习工作台.html", import.meta.url)), "utf8");
const start = html.indexOf("function sttSec(");
const end = html.indexOf("/* 转写结果存入当前笔记 */");
const outlineStart = html.indexOf("function sttBuildOutline(");
const outlineEnd = html.indexOf("$stt(\"sttDetailOutline\")");
assert.ok(start > 0 && end > start && outlineStart > end && outlineEnd > outlineStart, "转写时间函数还在页面里");
const pad = n => String(n).padStart(2, "0");
function fmt(t) {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function sttEsc(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fns = new Function("fmt", "sttEsc", `${html.slice(start, end)}\n${html.slice(outlineStart, outlineEnd)}\nreturn { sttSec, sttChipHtml, sttBuildOutline };`);
const { sttSec, sttChipHtml, sttBuildOutline } = fns(fmt, sttEsc);

assert.equal(sttSec(1500), 1.5);
assert.equal(sttSec(0), 0);
assert.equal(sttSec(-5), 0);
const chip = sttChipHtml(1500);
assert.match(chip, /class="ts"/);
assert.match(chip, /data-t="1\.5"/);
assert.match(chip, /contenteditable="false"/);
assert.match(chip, />00:01</);
assert.equal(sttChipHtml(125000), `<span class="ts" data-t="125" contenteditable="false">02:05</span>`);

const lines = [];
for (let i = 0; i < 120; i++) lines.push({ t0: i * 10000, t1: i * 10000 + 9000, text: `第${i}句` });
const outline = sttBuildOutline({ title: "连续课<script>", startedAt: 1, lines }, 5);
assert.ok(outline);
const heads = outline.match(/<h3>/g) || [];
assert.ok(heads.length >= 3 && heads.length <= 5, `20 分钟连续讲述按 5 分钟应分成约 4 段，实际 ${heads.length}`);
assert.match(outline, /data-t="0"/);
assert.match(outline, /data-t="300"/);
assert.match(outline, /&lt;script&gt;/);
assert.equal(sttBuildOutline({ title: "短", startedAt: 1, lines: lines.slice(0, 3) }, 5), null);

assert.match(html, /data-mark="miss"/);
assert.match(html, /id="crossSearch"/);
assert.match(html, /id="reviewModal"/);
assert.match(html, /\/api\/vault\/due/);
assert.match(html, /\/api\/vault\/grade/);
assert.match(html, /it\.t != null && it\.t !== ""/);

console.log("transcript chips ok", heads.length);
