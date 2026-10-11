import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeFeishuVideo } from "../lib/feishu-downloads.mjs";

test("only removes a regular Feishu video inside the download directory", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "study-desk-feishu-"));
  try {
    const root = path.join(temp, "feishu");
    const course = path.join(root, "file-token");
    fs.mkdirSync(course, { recursive: true });
    const video = path.join(course, "lesson.mp4");
    const outside = path.join(temp, "keep.mp4");
    const note = path.join(course, "notes.txt");
    fs.writeFileSync(video, "video");
    fs.writeFileSync(outside, "outside");
    fs.writeFileSync(note, "notes");
    assert.throws(() => removeFeishuVideo(root, outside), /只能删除/);
    assert.throws(() => removeFeishuVideo(root, note), /只能删除/);
    const link = path.join(course, "outside.mp4");
    fs.symlinkSync(outside, link);
    assert.throws(() => removeFeishuVideo(root, link), /只能删除/);
    assert.deepEqual(removeFeishuVideo(root, video), { ok: true });
    assert.equal(fs.existsSync(video), false);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside");
    assert.equal(fs.readFileSync(note, "utf8"), "notes");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
