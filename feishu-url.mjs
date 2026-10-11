const FEISHU_HOST = /(^|\.)(feishu\.cn|larksuite\.com|lark\.cn)$/i;

const KIND_META = {
  minutes: { label: "妙记", canDownload: true, action: "minutes", downloadLabel: "下载妙记录像" },
  file: { label: "云空间文件", canDownload: true, action: "file", downloadLabel: "下载云空间文件" },
  docx: { label: "云文档", canDownload: true, action: "export-pdf", downloadLabel: "导出为 PDF" },
  doc: { label: "旧版文档", canDownload: true, action: "export-pdf", downloadLabel: "导出为 PDF" },
  wiki: { label: "知识库", canDownload: true, action: "export-pdf", downloadLabel: "导出为 PDF" },
  slides: { label: "幻灯片", canDownload: true, action: "export-pdf", downloadLabel: "导出为 PDF" },
  sheets: { label: "电子表格", canDownload: false, action: "web", downloadLabel: "" },
  bitable: { label: "多维表格", canDownload: false, action: "web", downloadLabel: "" },
  folder: { label: "文件夹", canDownload: false, action: "web", downloadLabel: "" },
  web: { label: "飞书页面", canDownload: false, action: "web", downloadLabel: "" },
};

export function isFeishuHost(hostname) {
  return FEISHU_HOST.test(String(hostname || "").toLowerCase());
}

export function extractFeishuUrl(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/https?:\/\/[^\s<>"'）)】]+/i);
  return match ? match[0].replace(/[),.;，。]+$/g, "") : raw;
}

export function parseFeishuUrl(input) {
  const extracted = extractFeishuUrl(input);
  let url;
  try { url = new URL(extracted); } catch { throw new Error("请粘贴完整的飞书链接，例如 https://xxx.feishu.cn/minutes/…"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("请使用不含账号密码的 http:// 或 https:// 飞书链接");
  }
  if (!isFeishuHost(url.hostname)) throw new Error("这不是飞书 / Lark 链接。请粘贴 feishu.cn 或 larksuite.com 地址");

  const path = url.pathname;
  const take = (re, kind) => {
    const m = path.match(re);
    return m ? decorate({ kind, token: m[1], url: url.href, host: url.hostname }) : null;
  };

  return take(/\/minutes\/([A-Za-z0-9]+)/i, "minutes")
    || take(/\/(?:drive\/)?file\/([A-Za-z0-9_-]+)/i, "file")
    || take(/\/docx\/([A-Za-z0-9]+)/i, "docx")
    || take(/\/wiki\/([A-Za-z0-9]+)/i, "wiki")
    || take(/\/doc\/([A-Za-z0-9]+)/i, "doc")
    || take(/\/slides\/([A-Za-z0-9]+)/i, "slides")
    || take(/\/sheets\/([A-Za-z0-9]+)/i, "sheets")
    || take(/\/base\/([A-Za-z0-9]+)/i, "bitable")
    || take(/\/drive\/folder\/([A-Za-z0-9_-]+)/i, "folder")
    || decorate({ kind: "web", token: "", url: url.href, host: url.hostname });
}

function decorate(info) {
  const meta = KIND_META[info.kind] || KIND_META.web;
  return { ...info, ...meta };
}

export { KIND_META };
