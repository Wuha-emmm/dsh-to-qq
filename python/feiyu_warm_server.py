"""Resident RVC worker for the dsh-to-qq plugin (warm mode).

The Feiyu release service starts a fresh engine process per job, which costs
about ten seconds a sentence on Windows: torch imports, the CUDA context and
the first convolutions are paid again every time. This worker pays that once
and then converts in roughly a tenth of a second.

It is intentionally small: JSON lines in and out on stdin/stdout, one job at a
time, no HTTP, no queue. The plugin owns the lifetime — killing the process is
what releases the GPU memory, which is exactly what the switch is for.

Protocol (one JSON object per line):

    -> {"id": 1, "op": "convert", "input": "...wav", "output": "...wav"}
    <- {"id": 1, "op": "convert", "ok": true, "ms": 143, "seconds": 2.34, "sample_rate": 40000}
    <- {"id": 1, "op": "convert", "ok": false, "error": "..."}
    -> {"id": 2, "op": "ping"}
    <- {"id": 2, "op": "ping", "ok": true, "rss_mb": 812, "gpu_mb": 1490}

Anything the engine prints goes to stderr; stdout carries the protocol only.
"""

import argparse
import hashlib
import json
import os
import random
import sys
import tempfile
import time
from pathlib import Path

READY_PREFIX = "ready"


def emit(stream, payload):
    stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
    stream.flush()


def sha256(path, chunk=8 * 1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_package(package):
    """Check the release is the one it claims to be, once, before loading."""
    manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
    model = manifest["model"]
    problems = []
    for key, field in (("pth", "pth_sha256"), ("index", "index_sha256")):
        path = package / model[key]
        if not path.is_file():
            problems.append(f"missing {path.name}")
        elif sha256(path) != model[field]:
            problems.append(f"{path.name} does not match the release manifest")
    if problems:
        raise SystemExit("; ".join(problems))
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True, help="install root (E:\\feiyu)")
    parser.add_argument("--package", type=Path, default=None, help="RVC release package")
    parser.add_argument("--repo", type=Path, default=None, help="Applio checkout")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--no-prewarm", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    package = (args.package or root / "models" / "FeiyuVoice-RVC").resolve()
    repo = (args.repo or root / "applio").resolve()

    # Keep stdout for the protocol: everything the engine prints, including
    # tqdm bars, goes to stderr from here on.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    started = time.time()
    manifest = verify_package(package)
    inference = manifest.get("inference", {})

    os.chdir(repo)
    sys.path.insert(0, str(repo))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("OMP_NUM_THREADS", "4")

    import numpy as np
    import soundfile as sf
    import torch
    from rvc.configs.config import Config
    from rvc.infer.infer import VoiceConverter

    if args.device == "auto":
        args.device = "cuda:0" if torch.cuda.is_available() else "cpu"

    config = Config()
    config.device = args.device
    converter = VoiceConverter(config)
    model_path = package / manifest["model"]["pth"]
    index_path = package / manifest["model"]["index"]
    converter.get_vc(str(model_path), int(manifest.get("speaker_id", 0)))

    def convert(input_path, output_path):
        seed = int(manifest.get("seed", 42))
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        before = time.time()
        converter.convert_audio(
            audio_input_path=str(input_path),
            audio_output_path=str(output_path),
            model_path=str(model_path),
            index_path=str(index_path),
            pitch=int(inference.get("pitch_shift", 0)),
            f0_method=str(inference.get("f0_method", "rmvpe")),
            index_rate=float(inference.get("index_rate", 0.3)),
            protect=float(inference.get("protect", 0.33)),
            volume_envelope=float(inference.get("volume_envelope", 1.0)),
            embedder_model="contentvec",
            export_format="WAV",
            sid=int(manifest.get("speaker_id", 0)),
        )
        return time.time() - before

    warm_ms = 0.0
    if not args.no_prewarm:
        # The first inference compiles and autotunes kernels; pay it here so the
        # first real sentence is as fast as the rest.
        with tempfile.TemporaryDirectory(prefix="feiyu-warm-") as folder:
            probe_in = Path(folder) / "probe.wav"
            probe_out = Path(folder) / "probe-out.wav"
            t = np.linspace(0, 0.6, int(24000 * 0.6), endpoint=False)
            sf.write(probe_in, 0.05 * np.sin(2 * np.pi * 220 * t), 24000)
            warm_ms = convert(probe_in, probe_out) * 1000
            if not probe_out.is_file():
                raise SystemExit("prewarm conversion produced no audio")

    emit(protocol, {
        "op": READY_PREFIX,
        "package": manifest.get("id"),
        "device": args.device,
        "sample_rate": int(manifest.get("sample_rate", 40000)),
        "load_ms": round((time.time() - started) * 1000),
        "prewarm_ms": round(warm_ms),
        "torch": str(torch.__version__),
    })

    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        identifier = message.get("id")
        op = message.get("op", "convert")
        if op == "exit":
            break
        if op == "ping":
            rss = 0
            try:
                import psutil
                rss = int(psutil.Process().memory_info().rss / (1024 * 1024))
            except Exception:
                pass
            gpu = 0
            if torch.cuda.is_available():
                gpu = int(torch.cuda.memory_reserved(0) / (1024 * 1024))
            emit(protocol, {"id": identifier, "op": "ping", "ok": True, "rss_mb": rss, "gpu_mb": gpu})
            continue
        try:
            spent = convert(Path(message["input"]), Path(message["output"]))
            info = sf.info(str(message["output"]))
            emit(protocol, {
                "id": identifier,
                "op": "convert",
                "ok": True,
                "ms": round(spent * 1000),
                "seconds": round(info.frames / info.samplerate, 3),
                "sample_rate": info.samplerate,
            })
        except Exception as error:  # noqa: BLE001 - report, do not die on one job
            emit(protocol, {"id": identifier, "op": "convert", "ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()
