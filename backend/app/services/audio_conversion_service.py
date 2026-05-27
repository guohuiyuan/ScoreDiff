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


def convert_audio_to_midi(
    audio_path: Union[str, Path],
    output_path: Union[str, Path],
    sample_rate: int = 22050,
) -> Path:
    """Convert monophonic audio such as MP3 into MIDI via pitch tracking."""
    import librosa

    audio_path = Path(audio_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not audio_path.exists():
        raise AudioConversionError(f"Audio file not found: {audio_path}")

    y, sr = librosa.load(str(audio_path), sr=sample_rate, mono=True)
    if y.size == 0:
        raise AudioConversionError("Audio file is empty")

    hop_length = 512
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        sr=sr,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        frame_length=2048,
        hop_length=hop_length,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)

    midi = pretty_midi.PrettyMIDI(initial_tempo=120)
    instrument = pretty_midi.Instrument(program=40, name="Violin")

    active_pitch: int | None = None
    active_start = 0.0
    min_duration = 0.08

    def close_note(end_time: float):
        nonlocal active_pitch, active_start
        if active_pitch is None:
            return
        if end_time - active_start >= min_duration:
            instrument.notes.append(
                pretty_midi.Note(
                    velocity=92,
                    pitch=active_pitch,
                    start=max(0.0, active_start),
                    end=max(active_start + min_duration, end_time),
                )
            )
        active_pitch = None

    for i, freq in enumerate(f0):
        confidence = 0.0 if voiced_probs is None else float(voiced_probs[i])
        is_voiced = bool(voiced_flag[i]) and not np.isnan(freq) and confidence >= 0.2
        current_time = float(times[i])
        current_pitch = int(round(librosa.hz_to_midi(freq))) if is_voiced else None

        if current_pitch == active_pitch:
            continue

        close_note(current_time)
        if current_pitch is not None:
            active_pitch = current_pitch
            active_start = current_time

    total_duration = len(y) / sr
    close_note(float(total_duration))

    if not instrument.notes:
        raise AudioConversionError("No pitched notes were detected in the audio")

    midi.instruments.append(instrument)
    midi.write(str(output_path))
    return output_path
