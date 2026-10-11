const VIDEO_NAME = /\.(mp4|mkv|mov|webm|m4v|avi|flv|ts|mpg|wmv)(?:$|[?#])/i;

export function findDocumentVideo(document) {
  const content = String(document?.content || "");
  const references = document?.reference_map || {};
  const sources = [];
  for (const match of content.matchAll(/<source\b([^>]*)\/?\s*>/gi)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[attr[1]] = attr[3];
    const ref = attrs.ref || attrs.id || "";
    const linked = references.source?.[ref] || references.file?.[ref] || {};
    const token = attrs.token || attrs["file-token"] || linked.token || linked.file_token;
    if (!/^[A-Za-z0-9_-]+$/.test(String(token || ""))) continue;
    const name = attrs.name || linked.name || linked.file_name || "";
    const mime = attrs.mime || attrs["content-type"] || linked.mime || linked.mime_type || "";
    sources.push({ token, name, video: VIDEO_NAME.test(name) || /^video\//i.test(mime) });
  }
  const videos = sources.filter(source => source.video);
  const candidates = videos.length ? videos : sources.length === 1 ? sources : [];
  if (candidates.length > 1) throw new Error("文档里有多个视频，请在飞书中复制要学习的那个视频文件链接");
  return candidates[0] || null;
}
