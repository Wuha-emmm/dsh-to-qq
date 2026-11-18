#!/usr/bin/env python
"""Resident CosyVoice3 ("FeiyuVoice") TTS worker for the dsh-to-qq plugin.

The upstream voice service spawns one Python process per job, which pays the
full model load cost (about 25-40 s on an RTX 5070) for every sentence. This
worker keeps the model resident and answers JSON lines on stdout instead, so a
sentence costs only the decoder time.

Protocol (one JSON object per line):

    {"op": "ready", "styles": [...], "style": "cute", "sample_rate": 24000,
     "load_ms": 8100, "prewarm_ms": 12000, "torch": "2.11.0+cu128"}
    {"op": "synth", "text": "...", "style": "cute", "output": "C:/x/out.wav"}
    {"ok": true, "op": "synth", "ms": 9800, "seconds": 4.2, "sample_rate": 24000}
    {"op": "ping"} -> {"ok": true, "op": "ping", "rss_mb": 5200, "gpu_mb": 4600}
    {"op": "exit"} -> {"ok": true, "op": "exit"}

Engine chatter is redirected to stderr so it can never corrupt the protocol.
"""

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path


def sha256(path):
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path):
    with open(path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def save_json(path, value):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


class TtsEngine:
    def __init__(self, package, profile, style, server):
        self.package = Path(package).resolve()
        self.profile_path = Path(profile).resolve()
        self.server = Path(server).resolve()
        self.style = style

        self.manifest = self.verify_package()
        self.profile = load_json(self.profile_path)
        sys.path.insert(0, str(self.server))
        from feiyu_runtime.common import prepare, validate_profile, verify_audio_library, verify_repo

        self.validate = validate_profile(self.profile)
        self.repo = verify_repo(self.profile)

        import numpy as np
        import torch

        self.np = np
        self.torch = torch
        self.info = prepare(torch, self.profile)
        verify_audio_library(self.profile)
        os.environ.update(
            HF_HUB_OFFLINE="1",
            TRANSFORMERS_OFFLINE="1",
            PYTHONDONTWRITEBYTECODE="1",
            OMP_NUM_THREADS="4",
        )
        os.chdir(self.repo)
        sys.path[:0] = [str(self.repo), str(self.repo / "third_party" / "Matcha-TTS")]

        from cosyvoice.cli.cosyvoice import AutoModel
        from cosyvoice.utils.common import set_all_random_seed

        self.set_all_random_seed = set_all_random_seed
        self.voice = AutoModel(
            model_dir=str(self.base_dir),
            fp16=False,
            load_trt=False,
            load_vllm=False,
        )
        self.states = {}
        self.load_style(style)

    # -- package inspection -------------------------------------------------
    def verify_package(self):
        files = load_json(self.package / "files_sha256.json")
        for name, record in files.items():
            path = (self.package / name).resolve()
            if not str(path).startswith(str(self.package)):
                raise ValueError("package path escapes root: " + name)
            if sha256(path) != record["sha256"]:
                raise ValueError("package integrity check failed: " + name)
        manifest = load_json(self.package / "manifest.json")
        if manifest["schema"] != "feiyu-voice-local-release-v1":
            raise ValueError("unsupported TTS package schema")
        return manifest

    @property
    def base_dir(self):
        return (self.package / self.manifest["base_model_dir"]).resolve()

    def style_config(self, style):
        styles = self.manifest["styles"]
        if style not in styles:
            raise ValueError("unknown style: %s (have %s)" % (style, ", ".join(styles)))
        return styles[style]

    # -- style handling -----------------------------------------------------
    def load_style(self, style):
        selected = self.style_config(style)
        checkpoint = (self.package / selected["llm_checkpoint"]).resolve()
        reference = (self.package / selected["reference_audio"]).resolve()
        if sha256(checkpoint) != selected["llm_sha256"]:
            raise ValueError("style checkpoint differs from manifest")
        if sha256(reference) != selected["reference_sha256"]:
            raise ValueError("style reference differs from manifest")
        import torch

        if checkpoint not in self.states:
            state = torch.load(checkpoint, map_location="cpu", weights_only=True)
            self.states[checkpoint] = state
        state = self.states[checkpoint]
        base = (self.base_dir / "llm.pt").resolve()
        if checkpoint == base:
            # The base checkpoint is already what AutoModel loaded.
            self.voice.model.llm.load_state_dict(state, strict=True)
        else:
            self.voice.model.llm.load_state_dict(state, strict=True)
        self.voice.model.llm.eval()
        self.reference = reference
        self.reference_text = selected["reference_text"]
        self.style = style

    # -- synthesis ----------------------------------------------------------
    def synth(self, text, output, style=None):
        import soundfile as sf

        if style and style != self.style:
            self.load_style(style)
        params = self.manifest["inference"]
        started = time.perf_counter()
        self.set_all_random_seed(params["seed"])
        with self.torch.inference_mode():
            chunks = [
                item["tts_speech"].detach().cpu().numpy()[0]
                for item in self.voice.inference_zero_shot(
                    text,
                    params["prompt_prefix"] + self.reference_text,
                    str(self.reference),
                    stream=False,
                    speed=params["speed"],
                    text_frontend=True,
                )
            ]
        if not chunks:
            raise ValueError("TTS returned no audio")
        audio = self.np.concatenate(chunks)
        if len(audio) == 0:
            raise ValueError("empty TTS output")
        peak = float(abs(audio).max())
        if not self.np.isfinite(audio).all() or peak <= 1e-4:
            raise ValueError("invalid TTS output: peak=%r finite=%r" % (peak, bool(self.np.isfinite(audio).all())))
        gain = min(1.0, 0.98 / peak)
        out = Path(output).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out), audio * gain, self.voice.sample_rate, subtype="PCM_16")
        seconds = len(audio) / self.voice.sample_rate
        return {
            "ms": round((time.perf_counter() - started) * 1000),
            "seconds": round(seconds, 3),
            "sample_rate": self.voice.sample_rate,
            "peak": round(peak, 4),
        }


def rss_mb():
    try:
        import psutil

        return round(psutil.Process().memory_info().rss / 1024 / 1024)
    except Exception:
        return None


def gpu_mb(torch):
    try:
        if torch.cuda.is_available():
            return round(torch.cuda.memory_reserved(0) / 1024 / 1024)
    except Exception:
        pass
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--style", default="cute")
    parser.add_argument("--server", default=os.environ.get("FEIYU_SERVER", ""))
    parser.add_argument("--no-prewarm", action="store_true")
    args = parser.parse_args()

    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    import io

    stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")

    def emit(payload):
        protocol.write(json.dumps(payload, ensure_ascii=False) + "\n")
        protocol.flush()

    started = time.perf_counter()
    try:
        engine = TtsEngine(args.package, args.profile, args.style, args.server)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "op": "ready", "error": type(exc).__name__ + ": " + str(exc)})
        traceback.print_exc()
        return 1
    load_ms = round((time.perf_counter() - started) * 1000)

    prewarm_ms = None
    if not args.no_prewarm:
        prewarm_started = time.perf_counter()
        try:
            engine.synth("你好呀，我是小肥鱼。", os.path.join(os.environ.get("TEMP", "."), "feiyu-tts-prewarm.wav"))
            prewarm_ms = round((time.perf_counter() - prewarm_started) * 1000)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            emit({"ok": False, "op": "ready", "error": "prewarm failed: " + str(exc)})
            return 1

    emit(
        {
            "op": "ready",
            "ok": True,
            "styles": list(engine.manifest["styles"]),
            "style": engine.style,
            "sample_rate": engine.voice.sample_rate,
            "load_ms": load_ms,
            "prewarm_ms": prewarm_ms,
            "torch": engine.torch.__version__,
            "device": engine.info.get("device"),
        }
    )

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            op = message.get("op")
            if op == "exit":
                emit({"ok": True, "op": "exit"})
                return 0
            if op == "ping":
                emit(
                    {
                        "ok": True,
                        "op": "ping",
                        "rss_mb": rss_mb(),
                        "gpu_mb": gpu_mb(engine.torch),
                        "style": engine.style,
                    }
                )
                continue
            if op == "synth":
                text = (message.get("text") or "").strip()
                output = message.get("output")
                if not text or not output:
                    raise ValueError("synth needs text and output")
                result = engine.synth(text, output, message.get("style"))
                emit(dict(result, ok=True, op="synth", style=engine.style))
                continue
            raise ValueError("unknown op: " + str(op))
        except BrokenPipeError:
            return 0
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            emit({"ok": False, "op": message.get("op") if isinstance(message, dict) else None,
                  "error": type(exc).__name__ + ": " + str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



