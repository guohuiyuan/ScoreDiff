"""PitchService: real pitch detection using librosa pyin."""
import numpy as np
import librosa
from pathlib import Path
from typing import Union


def detect_pitch_pyin(
    audio_path: Union[str, Path],
    sr: int = 22050,
    fmin: float = 196.0,
    fmax: float = 2093.0,
) -> dict:
    """Detect pitch using librosa's pyin algorithm.

    Args:
        audio_path: path to audio file (wav preferred)
        sr: sample rate for analysis
        fmin: minimum frequency (G3 for violin)
        fmax: maximum frequency (C7 for violin)

    Returns:
        dict with:
          - times: array of time stamps (seconds)
          - frequencies: array of detected frequencies (Hz), NaN for unvoiced
          - voiced_flag: boolean array
          - confidence: voicing probability
    """
    y, sr_actual = librosa.load(str(audio_path), sr=sr)

    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        sr=sr_actual,
        fmin=fmin,
        fmax=fmax,
        frame_length=2048,
        hop_length=512,
    )

    times = librosa.times_like(f0, sr=sr_actual, hop_length=512)

    return {
        "times": times,
        "frequencies": f0,
        "voiced_flag": voiced_flag,
        "confidence": voiced_probs,
        "sr": sr_actual,
    }


def hz_to_midi(freq: float) -> float:
    """Convert frequency in Hz to MIDI note number."""
    if freq <= 0 or np.isnan(freq):
        return np.nan
    return 69 + 12 * np.log2(freq / 440.0)


def midi_to_cents_error(detected_midi: float, target_midi: int) -> float:
    """Calculate pitch error in cents between detected and target MIDI notes."""
    if np.isnan(detected_midi):
        return np.nan
    return (detected_midi - target_midi) * 100


def analyze_note_pitch(
    pitch_data: dict,
    start_time: float,
    end_time: float,
    target_midi: int,
) -> dict:
    """Analyze pitch accuracy for a single note within a time window.

    Returns:
        dict with:
          - detected_freq_hz: median frequency in the window
          - detected_midi: MIDI note number (float)
          - pitch_error_cents: error in cents from target
          - stability_cents: std deviation of pitch in cents
          - voiced_ratio: fraction of frames that are voiced
    """
    times = pitch_data["times"]
    freqs = pitch_data["frequencies"]
    voiced = pitch_data["voiced_flag"]

    mask = (times >= start_time) & (times < end_time)
    window_freqs = freqs[mask]
    window_voiced = voiced[mask]

    if len(window_freqs) == 0:
        return {
            "detected_freq_hz": None,
            "detected_midi": None,
            "pitch_error_cents": None,
            "stability_cents": None,
            "voiced_ratio": 0.0,
        }

    voiced_freqs = window_freqs[window_voiced & ~np.isnan(window_freqs)]
    voiced_ratio = len(voiced_freqs) / len(window_freqs) if len(window_freqs) > 0 else 0.0

    if len(voiced_freqs) == 0:
        return {
            "detected_freq_hz": None,
            "detected_midi": None,
            "pitch_error_cents": None,
            "stability_cents": None,
            "voiced_ratio": voiced_ratio,
        }

    median_freq = float(np.median(voiced_freqs))
    detected_midi = hz_to_midi(median_freq)
    pitch_error = midi_to_cents_error(detected_midi, target_midi)

    midi_values = np.array([hz_to_midi(f) for f in voiced_freqs])
    valid_midi = midi_values[~np.isnan(midi_values)]
    stability = float(np.std(valid_midi) * 100) if len(valid_midi) > 1 else 0.0

    return {
        "detected_freq_hz": round(median_freq, 2),
        "detected_midi": round(detected_midi, 2),
        "pitch_error_cents": round(pitch_error, 1),
        "stability_cents": round(stability, 1),
        "voiced_ratio": round(voiced_ratio, 3),
    }


def analyze_performance_pitch(
    audio_path: Union[str, Path],
    note_groups: list[dict],
) -> list[dict]:
    """Analyze pitch for all note groups in a performance.

    Args:
        audio_path: path to the recording
        note_groups: list of note_group dicts with start, end, target_pitches

    Returns:
        list of pitch analysis results per note group
    """
    pitch_data = detect_pitch_pyin(str(audio_path))

    results = []
    for ng in note_groups:
        if ng["type"] == "rest" or not ng["target_pitches"]:
            results.append({
                "note_group_id": ng.get("note_group_id", ""),
                "measure": ng["measure"],
                "beat": ng["beat"],
                "detected_freq_hz": None,
                "detected_midi": None,
                "pitch_error_cents": None,
                "stability_cents": None,
                "voiced_ratio": 0.0,
                "status": "rest",
            })
            continue

        target_midi = ng["target_pitches"][0]
        analysis = analyze_note_pitch(
            pitch_data,
            start_time=ng["start"],
            end_time=ng["end"],
            target_midi=target_midi,
        )

        if analysis["pitch_error_cents"] is None:
            status = "missing"
        elif abs(analysis["pitch_error_cents"]) < 15:
            status = "good"
        elif abs(analysis["pitch_error_cents"]) < 30:
            status = "acceptable"
        elif abs(analysis["pitch_error_cents"]) < 50:
            status = "deviation"
        else:
            status = "wrong_note"

        results.append({
            "note_group_id": ng.get("note_group_id", ""),
            "measure": ng["measure"],
            "beat": ng["beat"],
            **analysis,
            "status": status,
        })

    return results
