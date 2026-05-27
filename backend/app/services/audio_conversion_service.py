"""Audio/MIDI conversion helpers for ScoreDiff."""
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Union

import numpy as np
import pretty_midi
import soundfile as sf


class AudioConversionError(RuntimeError):
    pass


def _require_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AudioConversionError("ffmpeg is required for MP3 conversion")
    return ffmpeg


def _note_frequency(midi_pitch: int) -> float:
    return 440.0 * (2 ** ((midi_pitch - 69) / 12))


def convert_midi_to_mp3(
    midi_path: Union[str, Path],
    output_path: Union[str, Path],
    sample_rate: int = 44100,
) -> Path:
    """Render a MIDI file to MP3 using a lightweight built-in sine synthesizer."""
    midi_path = Path(midi_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not midi_path.exists():
        raise AudioConversionError(f"MIDI file not found: {midi_path}")

    midi = pretty_midi.PrettyMIDI(str(midi_path))
    duration = max(1.0, midi.get_end_time() + 0.5)
    audio = np.zeros(int(duration * sample_rate), dtype=np.float32)

    for inst in midi.instruments:
        if inst.is_drum:
            continue
        for midi_note in inst.notes:
            start = max(0, int(midi_note.start * sample_rate))
            end = min(len(audio), int(midi_note.end * sample_rate))
            if end <= start:
                continue

            t = np.arange(end - start, dtype=np.float32) / sample_rate
            freq = _note_frequency(midi_note.pitch)
            velocity = max(0.1, midi_note.velocity / 127.0)
            wave = (
                np.sin(2 * np.pi * freq * t)
                + 0.28 * np.sin(2 * np.pi * freq * 2 * t)
                + 0.12 * np.sin(2 * np.pi * freq * 3 * t)
            ).astype(np.float32)

            env = np.ones_like(wave)
            attack = min(int(0.015 * sample_rate), len(env) // 4)
            release = min(int(0.05 * sample_rate), len(env) // 3)
            if attack > 0:
                env[:attack] = np.linspace(0, 1, attack, dtype=np.float32)
            if release > 0:
                env[-release:] = np.linspace(1, 0, release, dtype=np.float32)

            audio[start:end] += wave * env * velocity * 0.22

    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if peak > 0:
        audio = audio / peak * 0.85

    ffmpeg = _require_ffmpeg()
    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = Path(tmpdir) / "render.wav"
        sf.write(str(wav_path), audio, sample_rate)
        result = subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav_path), "-codec:a", "libmp3lame", "-q:a", "3", str(output_path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise AudioConversionError(result.stderr.strip() or "ffmpeg failed to encode MP3")

    return output_path
