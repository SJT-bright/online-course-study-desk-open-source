/** True when this request may receive the local app pages. Browser navigations need the app shell. */
export function appDocumentAllowed(headers, token) {
  const expected = String(token || "");
  if (!expected) return false;
  if (headers["x-studydesk-shell"] === expected) return true;
  const cookie = String(headers.cookie || "");
  if (cookie.split(";").some((part) => part.trim() === `sd_shell=${expected}`)) return true;
  const mode = headers["sec-fetch-mode"];
  const dest = headers["sec-fetch-dest"];
  if (mode === "navigate" || dest === "document" || dest === "iframe") return false;
  return true;
}

export const APP_ONLY_HTML = `<!doctype html><meta charset="utf-8"><title>网课学习工作台</title><p>请打开本地应用「网课学习工作台」。</p>`;
