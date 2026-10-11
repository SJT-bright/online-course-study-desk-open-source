import fs from "node:fs";
import path from "node:path";

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".m4v", ".m4a", ".mp3", ".avi", ".flv", ".ts", ".mpg", ".wmv"]);

export function removeFeishuVideo(downloadDir, file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !VIDEO_EXTS.has(path.extname(file).toLowerCase())) {
    throw new Error("只能删除工作台下载的飞书视频");
  }
  const root = path.resolve(downloadDir);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("只能删除工作台下载的飞书视频");
  }
  const actual = fs.realpathSync(file);
  const actualRelative = path.relative(fs.realpathSync(root), actual);
  if (!actualRelative || actualRelative.startsWith(".." + path.sep) || actualRelative === ".." || path.isAbsolute(actualRelative)) {
    throw new Error("只能删除工作台下载的飞书视频");
  }
  if (!fs.lstatSync(file).isFile()) throw new Error("只能删除普通视频文件");
  fs.unlinkSync(file);
  return { ok: true };
}
