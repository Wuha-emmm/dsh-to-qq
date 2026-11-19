"""Whole-song cover: separate the vocals, move them to her timbre, mix back.

    python cover.py --input song.mp3 --output out\cover.wav

Pipeline (all local, no network once the weights are on disk):

    song ──demucs/htdemucs──► vocals + instrumental
                                 │            │
                                 │            └──────────┐
                                 ▼                       │
                          FeiyuVoice-RVC                 │
                          (keeps melody/rhythm)          │
                                 │                       │
                                 ▼                       ▼
                              mix (vocal + instrumental) ──► cover.wav / .mp3

The RVC package and the demucs weight are verified against their sha256 lists
before anything is loaded, same as the service does per job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_ROOT = Path(r"E:\feiyu")
# htdemucs_ft ships as four .th files named <signature>-<sha256 prefix>.th; demucs
# checks that prefix itself, so a mirror is as good as the original host.
DEMUCS_SIGNATURE = "d12395a8"
DEMUCS_FILE = f"{DEMUCS_SIGNATURE}-e57c48e6.th"


def log(message: str) -> None:
    print(f"[cover] {message}", flush=True)


def sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def verify_rvc_package(package: Path) -> dict:
    for name, record in load_json(package / "files_sha256.json").items():
        path = (package / name).resolve()
        if not path.is_file() or sha256(path) != record["sha256"]:
            raise SystemExit(f"RVC 权重包校验失败：{name}")
    return load_json(package / "manifest.json")


def separate(root: Path, audio: Path, device: str, workdir: Path) -> tuple[Path, Path]:
    """Split the song into vocals and instrumental with demucs."""
    from demucs.api import Separator
    from demucs.audio import save_audio

    repo = root / "models" / "demucs"
    weight = repo / DEMUCS_FILE
    if not weight.is_file():
        raise SystemExit(f"缺 demucs 权重：{weight}（放在 {repo} 里，文件名必须是 <签名>-<sha前缀>.th）")

    log(f"separating {audio.name} on {device}")
    separator = Separator(model=DEMUCS_SIGNATURE, repo=repo, device=device, progress=False)
    _origin, stems = separator.separate_audio_file(str(audio))
    sample_rate = int(separator.samplerate)

    workdir.mkdir(parents=True, exist_ok=True)
    vocals = workdir / "vocals.wav"
    instrumental = workdir / "instrumental.wav"
    save_audio(stems["vocals"].cpu(), str(vocals), samplerate=sample_rate)
    backing = None
    for name, tensor in stems.items():
        if name == "vocals":
            continue
        backing = tensor.clone() if backing is None else backing + tensor
    save_audio(backing.cpu(), str(instrumental), samplerate=sample_rate)
    log(f"stems written ({sample_rate} Hz, sources={sorted(stems)})")
    return vocals, instrumental


def estimate_shift(vocals: Path) -> int:
    """How many semitones the vocal sits below a female register.

    RVC only moves the timbre: it keeps the f0 it is given. Feed it a male lead
    at 110 Hz and the female model has to sing an octave below where it lives,
    which is exactly where the thin, throaty sound comes from. One octave up is
    the safe fix; a female lead (>= 165 Hz median) is left alone.
    """
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(vocals), always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    if rate != 16_000:
        import librosa

        mono = librosa.resample(mono, orig_sr=rate, target_sr=16_000)
        rate = 16_000
    # 20 s from the loudest stretch beats sampling the whole song for speed and
    # for signal: intros are often quiet or spoken.
    window = 20 * rate
    if len(mono) > window:
        energy = np.array([np.sqrt((mono[i:i + window] ** 2).mean()) for i in range(0, len(mono) - window, window)])
        start = int(np.argmax(energy)) * window if len(energy) else 0
        mono = mono[start:start + window]
    import librosa

    f0 = librosa.yin(mono, fmin=60, fmax=500, sr=rate, frame_length=1024, hop_length=256)
    f0 = f0[np.isfinite(f0) & (f0 > 60)]
    if len(f0) == 0:
        return 0
    median = float(np.median(f0))
    # Measured on three real songs: male lead ~169 Hz, female lead ~327 Hz, and
    # an instrumental track drifts to ~236. 200 Hz splits the first two cleanly.
    shift = 12 if median < 200 else 0
    log(f"vocal f0 ~{median:.0f} Hz -> pitch {shift:+d} semitones")
    return shift


def shift_pitch(vocals: Path, semitones: int, workdir: Path) -> Path:
    """Transpose the vocal before RVC, keeping the tempo."""
    import librosa
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(vocals), always_2d=True)
    channels = [
        librosa.effects.pitch_shift(data[:, index].astype(np.float32), sr=rate, n_steps=semitones)
        for index in range(data.shape[1])
    ]
    shifted = np.stack(channels, axis=1)
    output = workdir / "vocals-shifted.wav"
    sf.write(str(output), shifted, rate, subtype="PCM_16")
    log(f"transposed vocal {semitones:+d} semitones -> {output.name}")
    return output


def convert(root: Path, vocals: Path, workdir: Path, device: str) -> Path:
    """Move the separated vocals to her timbre with the RVC package."""
    package = root / "models" / "FeiyuVoice-RVC"
    profile_path = root / "server" / "configs" / "runtime.rvc.cuda.local.json"
    if not profile_path.is_file():
        raise SystemExit(f"缺 RVC 运行时档案：{profile_path}")

    verify_rvc_package(package)
    server = str(root / "server")
    if server not in sys.path:
        sys.path.insert(0, server)
    os.environ.setdefault("FEIYU_DEVICE", device)

    from feiyu_runtime.rvc import main as rvc_main

    profile = load_json(profile_path)
    # rvc.py refuses an existing output directory and names its result rvc_native.wav.
    out = workdir / "rvc"
    if out.exists():
        import shutil

        shutil.rmtree(out)
    log("converting vocals")
    rvc_main(str(package), profile, ["--input", str(vocals), "--output-dir", str(out)])
    produced = out / "rvc_native.wav"
    if not produced.is_file():
        raise SystemExit(f"RVC 没有输出 wav：{out}")
    return produced


def mix(
    vocals: Path,
    instrumental: Path,
    output: Path,
    vocal_gain: float,
    instrumental_gain: float,
    reference: Path | None = None,
) -> Path:
    """Sum the converted vocal with the instrumental, both normalised to the same rate."""
    import numpy as np
    import soundfile as sf

    voice, voice_rate = sf.read(str(vocals), always_2d=True)
    music, music_rate = sf.read(str(instrumental), always_2d=True)
    rate = max(voice_rate, music_rate)

    def resample(data, source_rate: int):
        if source_rate == rate:
            return data
        import librosa

        channels = [
            librosa.resample(data[:, ch].astype(np.float32), orig_sr=source_rate, target_sr=rate)
            for ch in range(data.shape[1])
        ]
        return np.stack(channels, axis=1)

    voice = resample(voice, voice_rate)
    music = resample(music, music_rate)
    if voice.shape[1] == 1 and music.shape[1] == 2:
        voice = np.repeat(voice, 2, axis=1)
    if music.shape[1] == 1 and voice.shape[1] == 2:
        music = np.repeat(music, 2, axis=1)

    length = max(len(voice), len(music))

    def pad(data):
        if len(data) >= length:
            return data[:length]
        return np.pad(data, ((0, length - len(data)), (0, 0)))

    voice_padded = pad(voice)
    if reference is not None and reference.is_file():
        # RVC comes back several dB quieter than the source vocal; match it so she
        # is not buried under the backing track, but never by more than 12 dB.
        source, source_rate = sf.read(str(reference), always_2d=True)
        source = resample(source, source_rate).mean(axis=1)
        want = float(np.sqrt((source**2).mean()))
        have = float(np.sqrt((voice_padded.mean(axis=1) ** 2).mean()))
        if want > 0 and have > 0:
            gain = min(4.0, max(0.25, want / have))
            if abs(gain - 1.0) > 0.02:
                log(f"matching vocal level: x{gain:.2f} ({20 * np.log10(gain):+.1f} dB)")
                voice_padded = voice_padded * gain

    mixed = voice_padded * vocal_gain + pad(music) * instrumental_gain
    peak = float(np.max(np.abs(mixed))) or 1.0
    if peak > 0.95:
        mixed = mixed * (0.95 / peak)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), mixed, rate, subtype="PCM_16")
    log(f"mixed -> {output} ({length / rate:.1f}s @ {rate} Hz)")
    return output


def encode_mp3(wav: Path, mp3: Path, bitrate: int = 192) -> Path:
    import lameenc
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(wav), always_2d=True)
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16).tobytes()
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate)
    encoder.set_in_sample_rate(rate)
    encoder.set_channels(data.shape[1])
    encoder.set_quality(2)
    mp3.write_bytes(encoder.encode(pcm) + encoder.flush())
    log(f"encoded -> {mp3} ({bitrate} kbps)")
    return mp3


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Cover a song in her voice")
    parser.add_argument("--input", type=Path, required=True, help="source song (wav/flac/mp3)")
    parser.add_argument("--output", type=Path, help="final mix (default <workdir>/cover.wav)")
    parser.add_argument("--workdir", type=Path, help="where stems and intermediates go")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="installation root")
    parser.add_argument("--device", default="cuda:0")

    parser.add_argument("--vocal-gain", type=float, default=1.0)
    parser.add_argument("--instrumental-gain", type=float, default=1.0)
    parser.add_argument("--vocals-only", action="store_true", help="skip the mix")
    parser.add_argument("--mp3", action="store_true", help="also write an mp3 next to the wav")
    parser.add_argument("--stems", type=Path, help="reuse existing vocals/instrumental stems")
    parser.add_argument(
        "--pitch",
        default="auto",
        help="semitones to lift the vocal before RVC; 'auto' reads the f0 (male lead -> +12)",
    )
    args = parser.parse_args(argv)

    source = args.input.resolve()
    if not source.is_file():
        raise SystemExit(f"找不到歌曲：{source}")
    workdir = (args.workdir or (source.parent / f"{source.stem}-cover")).resolve()
    workdir.mkdir(parents=True, exist_ok=True)

    if args.stems is not None:
        vocals = args.stems / "vocals.wav"
        instrumental = args.stems / "instrumental.wav"
        if not vocals.is_file() or not instrumental.is_file():
            raise SystemExit(f"{args.stems} 里没有 vocals.wav / instrumental.wav")
    else:
        vocals, instrumental = separate(args.root, source, args.device, workdir)

    try:
        semitones = int(args.pitch) if str(args.pitch) != "auto" else estimate_shift(vocals)
    except ValueError:
        raise SystemExit(f"--pitch 只收整数或 auto：{args.pitch}")
    if semitones != 0:
        vocals = shift_pitch(vocals, semitones, workdir)

    converted = convert(args.root, vocals, workdir, args.device)
    if args.vocals_only:
        final = converted
    else:
        final = args.output or (workdir / "cover.wav")
        mix(converted, instrumental, final, args.vocal_gain, args.instrumental_gain, reference=vocals)

    if args.mp3:
        encode_mp3(final, final.with_suffix(".mp3"))
    print(json.dumps({"ok": True, "output": str(final), "workdir": str(workdir)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
