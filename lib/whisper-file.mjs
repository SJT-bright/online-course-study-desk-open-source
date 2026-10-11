/**
 * 免 Key 文件转写：本地 Whisper（whisper.cpp）
 * 复用豆包 API 路线的台账结构，识别结果带 SRT 时间戳 → lines[]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { toolPath } from './platform.mjs';
export function findWhisperBin() { return toolPath(['whisper-cli', 'whisper-cpp'], { envName: 'STUDYDESK_WHISPER' }); }
export function findFfmpeg() { return toolPath(['ffmpeg'], { envName: 'STUDYDESK_FFMPEG' }); }

/* SRT → 台账 lines[] */
export function srtToLines(srtText) {
  const lines = [];
  for (const block of srtText.replace(/\r/g, "").split(/\n\n+/)) {
    const ls = block.split("\n").filter(Boolean);
    const tm = ls.find(l => l.includes("-->"));
    if (!tm) continue;
    const [a, z] = tm.split("-->");
    const text = ls.filter(l => l !== tm && !/^\d+$/.test(l.trim())).join(" ").trim();
    if (!text) continue;
    const toMs = s => { const m = s.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4] : 0; };
    lines.push({ kind: "final", text, t0: toMs(a), t1: toMs(z), speaker: null, wall: Date.now() });
  }
  return lines;
}

/* 朴素繁→简映射：whisper base 模型中文常出繁体，转简体提升可读性 */
const T2S = { "學":"学","習":"习","們":"们","動":"动","態":"态","規":"规","劃":"划","們":"们","題":"题","疊":"叠","這":"这","裡":"里","後":"后","時":"时","間":"间","點":"点","說":"说","話":"话","聽":"听","讀":"读","寫":"写","見":"见","車":"车","馬":"马","鳥":"鸟","體":"体","氣":"气","電":"电","腦":"脑","網":"网","絡":"络","數":"数","據":"据","結":"结","構":"构","類":"类","種":"种","樣":"样","張":"张","員":"员","單":"单","幾":"几","個":"个","來":"来","對":"对","與":"与","為":"为","從":"从","會":"会","傳":"传","優":"优","壓":"压","縮":"缩","覽":"览","發":"发","當":"当","內":"内","兩":"两","雙":"双","藝":"艺","術":"术","歷":"历","史":"史","產":"产","應":"应","該":"该","國":"国","際":"际","錄":"录","製":"制","系":"系","統":"统","運":"运","維":"维","護":"护","實":"实","現":"现","級":"级","處":"处","理":"理","轉":"转","換":"换","邏":"逻","輯":"辑","編":"编","碼":"码","識":"识","別":"别","語":"语","音":"音","義":"义","務":"务","鏈":"链","接":"接","層":"层","傳":"传","輸":"输","儲":"储","存":"存","設":"设","備":"备","啟":"启","動":"动","關":"关","閉":"闭","選":"选","擇":"择","檢":"检","查":"查","錯":"错","誤":"误","訊":"讯","息":"息","護":"护","進":"进","階":"阶","段":"段","獲":"获","取":"取","資":"资","源":"源","標":"标","準":"准","確":"确","認":"认","頻":"频","譜":"谱","濾":"滤","波":"波","壓":"压","實":"实","驗":"验","證":"证","測":"测","試":"试","觀":"观","察":"察","記":"记","錄":"录","整":"整","理":"理","總":"总","結":"结","報":"报","告":"告","顯":"显","示":"示","輸":"输","出":"出","訂":"订","閱":"阅","戶":"户","錢":"钱","額":"额","費":"费","免":"免","計":"计","劃":"划","續":"续","約":"约","條":"条","款":"款","協":"协","議":"议","機":"机","會":"会","員":"员","資":"资","訊":"讯","安":"安","全":"全","隱":"隐","私":"私","權":"权","限":"限","設":"设","置":"置","應":"应","用":"用","程":"程","序":"序","內":"内","容":"容","戶":"户","體":"体","驗":"验","優":"优","化":"化","連":"连","接":"接","穩":"稳","定":"定","性":"性","能":"能","耗":"耗","電":"电","池":"池","續":"续","航":"航","時":"时","長":"长","短":"短","快":"快","慢":"慢","價":"价","格":"格","錢":"钱","幣":"币","種":"种","匯":"汇","率":"率","匯":"汇","豐":"丰","富":"富","貧":"贫","窮":"穷","難":"难","道":"道","輕":"轻","鬆":"松","簡":"简","單":"单","複":"复","雜":"杂","錯":"错","綜":"综","紅":"红","藍":"蓝","綠":"绿","黃":"黄","顏":"颜","色":"色","調":"调","淺":"浅","深":"深","濃":"浓","淡":"淡","溫":"温","度":"度","熱":"热","冷":"冷","涼":"凉","暖":"暖","濕":"湿","乾":"干","燥":"燥","風":"风","雨":"雨","雪":"雪","雲":"云","霧":"雾","霜":"霜","露":"露","冰":"冰","凍":"冻","融":"融","化":"化","蒸":"蒸","發":"发","凝":"凝","結":"结","晶":"晶","體":"体","液":"液","固":"固","態":"态","等":"等","離":"离","子":"子","原":"原","核":"核","能":"能","量":"量","力":"力","學":"学","科":"科","文":"文","字":"字","母":"母","父":"父","母":"母","兄":"兄","弟":"弟","姐":"姐","妹":"妹","親":"亲","戚":"戚","朋":"朋","友":"友","鄰":"邻","居":"居","家":"家","庭":"庭","校":"校","園":"园","師":"师","生":"生","教":"教","講":"讲","課":"课","本":"本","書":"书","籍":"籍","圖":"图","館":"馆","閱":"阅","讀":"读","寫":"写","作":"作","業":"业","練":"练","复":"复","考":"考","試":"试","成":"成","绩":"绩","分":"分","數":"数","及":"及","格":"格","不":"不","pass":"pass" };
export function tradToSimp(text) {
  return text.replace(/[\u3400-\u9FFF]/g, ch => T2S[ch] || ch);
}

/**
 * 用本地 Whisper 转写音频文件 → { lines, text, durationMs }
 * onProgress(phase) 可选
 */
export function whisperTranscribeFile(filePath, { modelDir, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findWhisperBin();
    if (!bin) return reject(Object.assign(new Error("未找到本地 Whisper 引擎。请安装 whisper.cpp 并设置 STUDYDESK_WHISPER"), { kind: "engine" }));
    const ff = findFfmpeg();
    if (!ff) return reject(Object.assign(new Error("未找到 ffmpeg。请安装 ffmpeg 并加入 PATH 或设置 STUDYDESK_FFMPEG"), { kind: "engine" }));
    const modelDir_ = modelDir || path.join(os.homedir(), "Downloads", "网课学习工作台", "tools", "models");
    let model = path.join(modelDir_, "ggml-base.bin");
    if (!fs.existsSync(model)) {
      const alt = "/Applications/网课学习工作台.app/Contents/Resources/app/tools/models/ggml-base.bin";
      if (fs.existsSync(alt)) model = alt;
      else return reject(Object.assign(new Error("Whisper 模型未下载（base，约 148MB）。请在直播面板点「下载模型」或从工作台源目录复制 ggml-base.bin"), { kind: "model" }));
    }
    const tmpWav = path.join(os.tmpdir(), "stt-whisper-" + Date.now() + ".wav");
    const tmpSrt = path.join(os.tmpdir(), "stt-whisper-" + Date.now());
    onProgress?.("转换音频格式…");
    const ffP = spawn(ff, ["-y", "-loglevel", "error", "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav]);
    ffP.on("close", c => {
      if (c !== 0) { try { fs.unlinkSync(tmpWav); } catch {} return reject(Object.assign(new Error("ffmpeg 解码失败（退出码 " + c + "），请确认是有效的音视频文件"), { kind: "decode" })); }
      onProgress?.("本地识别中（离线，不上传）…");
      const wP = spawn(bin, ["-m", model, "-f", tmpWav, "-l", "zh", "-osrt", "-of", tmpSrt, "-pp"], { env: { ...process.env } });
      let lastPhase = "";
      wP.stderr.setEncoding("utf8");
      wP.stderr.on("data", d => {
        for (const line of d.split("\n")) {
          const t = line.trim();
          if (/^\[\d{2}:\d{2}/.test(t)) { const p = "识别中 " + t.slice(0, 22) + "…"; if (p !== lastPhase) { lastPhase = p; onProgress?.(p); } }
        }
      });
      wP.on("error", e => reject(Object.assign(new Error("Whisper 启动失败：" + e.message), { kind: "engine" })));
      wP.on("close", code => {
        try { fs.unlinkSync(tmpWav); } catch {}
        const srtFile = tmpSrt + ".srt";
        if (code !== 0 || !fs.existsSync(srtFile)) return reject(Object.assign(new Error("Whisper 识别失败（退出码 " + code + "）"), { kind: "engine" }));
        const srt = fs.readFileSync(srtFile, "utf8");
        try { fs.unlinkSync(srtFile); } catch {}
        const lines = srtToLines(srt).map(l => ({ ...l, text: tradToSimp(l.text) }));
        if (!lines.length) return resolve({ lines: [], text: "", durationMs: 0 });
        const durationMs = lines[lines.length - 1].t1 || 0;
        resolve({ lines, text: lines.map(l => l.text).join("\n"), durationMs });
      });
    });
  });
}
