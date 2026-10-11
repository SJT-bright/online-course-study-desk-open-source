import assert from "node:assert/strict";
import test from "node:test";
import { findDocumentVideo } from "../lib/feishu-doc-video.mjs";

test("finds one embedded video alongside other document attachments", () => {
  const document = {
    content: '<source ref="a"/><source ref="b"/>',
    reference_map: { source: {
      a: { file_token: "fileA", name: "slides.pdf" },
      b: { file_token: "fileB", name: "lesson.mp4" },
    } },
  };
  assert.deepEqual(findDocumentVideo(document), { token: "fileB", name: "lesson.mp4", video: true });
  assert.equal(findDocumentVideo({ content: "<p>只有文字</p>" }), null);
  assert.throws(() => findDocumentVideo({ content: '<source token="one" name="a.mp4"/><source token="two" name="b.mp4"/>' }), /多个视频/);
});
