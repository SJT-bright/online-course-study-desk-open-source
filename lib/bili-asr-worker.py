"""Local Fun-ASR-Nano worker. One model load, timestamped results per minute."""
import contextlib
import gc
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def recognize(config):
    threads = 6
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ["OMP_NUM_THREADS"] = str(threads)
    os.environ["MKL_NUM_THREADS"] = str(threads)
    started = time.monotonic()
    emit({"type": "phase", "phase": "正在加载本地 Fun-ASR-Nano（Qwen3 底座）…"})
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from funasr import AutoModel
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        # Use the existing local installation and weights. No model download here.
        model = AutoModel(model=config["model"], vad_model=config["vad"],
                          vad_kwargs={"max_single_segment_time": 30000},
                          device="cpu", ncpu=threads, hub="ms",
                          trust_remote_code=True, disable_update=True,
                          disable_pbar=True, disable_log=True)
    audio = pathlib.Path(config["audio"])
    duration = float(config["durationSec"])
    lines = []
    out = pathlib.Path(config["result"])
    # Keep segment boundaries bounded while VAD finds sentence boundaries inside.
    with tempfile.TemporaryDirectory(prefix="study-bili-asr-") as temp:
        for offset in range(0, int(duration + 0.999), 60):
            length = min(60, duration - offset)
            part = pathlib.Path(temp) / "part.wav"
            subprocess.run([config["ffmpeg"], "-nostdin", "-hide_banner", "-loglevel", "error",
                            "-y", "-ss", str(offset), "-i", str(audio), "-t", str(length),
                            "-ac", "1", "-ar", "16000", str(part)], check=True)
            with contextlib.redirect_stdout(sys.stderr):
                results = model.generate(input=str(part), cache={}, batch_size=1, language="中文")
            item = results[0] if results else {}
            tokens = item.get("timestamps") or []
            chunk_lines = []
            text = ""
            t0 = None
            t1 = 0.0

            def flush():
                nonlocal text, t0, t1
                if text.strip() and t0 is not None:
                    chunk_lines.append({"kind": "final", "text": text.strip(),
                                        "t0": round((offset + t0) * 1000),
                                        "t1": round(min(duration, offset + t1) * 1000)})
                text, t0, t1 = "", None, 0.0

            for token in tokens:
                if not token.get("token"):
                    continue
                a = float(token.get("start_time") or 0)
                b = float(token.get("end_time") or a)
                if t0 is None:
                    t0 = a
                text += token["token"]
                t1 = max(t1, b)
                if any(stop in token["token"] for stop in "。！？!?；;") or t1 - t0 >= 20:
                    flush()
            flush()
            if not chunk_lines and str(item.get("text") or "").strip():
                chunk_lines.append({"kind": "final", "text": item["text"].strip(),
                                    "t0": offset * 1000, "t1": round((offset + length) * 1000),
                                    "timestampApproximate": True})
            lines.extend(chunk_lines)
            processed = min(duration, offset + length)
            payload = {"engine": "fun-asr-nano", "model": "Fun-ASR-Nano-2512 / Qwen3-0.6B",
                       "durationSec": duration, "processedSec": processed, "lines": lines,
                       "elapsedSec": round(time.monotonic() - started, 2),
                       "done": processed >= duration}
            tmp = out.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(out)
            emit({"type": "chunk", "processedSec": processed, "lines": chunk_lines,
                  "elapsedSec": payload["elapsedSec"]})
            gc.collect()
    if not lines:
        raise RuntimeError("音频已处理，但没有识别到语音")
    emit({"type": "done", "lines": len(lines), "durationSec": duration})


if __name__ == "__main__":
    try:
        recognize(json.loads(sys.stdin.readline()))
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        raise
