"""PolyphonicService: double-stop / chord detection using librosa spectral analysis.

For V1 MVP, we use a lightweight approach based on harmonic peak detection
rather than a full neural polyphonic transcription model (Basic Pitch requires
TensorFlow/TFLite which adds heavy dependencies). This approach:
1. Computes CQT spectrogram
2. For each time window, finds prominent frequency peaks
3. Maps peaks to MIDI notes
4. Detects if multiple notes are sounding simultaneously (double stops)
"""
import numpy as np
import librosa
from pathlib import Path
from typing import Union


def detect_polyphonic_notes(
    audio_path: Union[str, Path],
    sr: int = 22050,
    hop_length: int = 512,
    n_peaks: int = 4,
    threshold_db: float = -40.0,
) -> dict:
    """Detect multiple simultaneous notes using CQT peak detection.

    Args:
        audio_path: path to audio file
        sr: sample rate
        hop_length: hop length for CQT
        n_peaks: max number of peaks to detect per frame
        threshold_db: minimum amplitude threshold in dB

    Returns:
        dict with:
          - times: array of time stamps
          - notes_per_frame: list of lists, each containing detected MIDI notes
          - amplitudes_per_frame: corresponding amplitudes
    """
    y, sr_actual = librosa.load(str(audio_path), sr=sr)

    C = np.abs(librosa.cqt(
        y,
        sr=sr_actual,
        hop_length=hop_length,
        fmin=librosa.note_to_hz("G3"),
        n_bins=60,
        bins_per_octave=12,
    ))

    C_db = librosa.amplitude_to_db(C, ref=np.max(C))

    times = librosa.frames_to_time(np.arange(C.shape[1]), sr=sr_actual, hop_length=hop_length)

    midi_base = librosa.note_to_midi("G3")

    notes_per_frame = []
    amplitudes_per_frame = []

    for frame_idx in range(C.shape[1]):
        frame_db = C_db[:, frame_idx]

        peak_indices = []
        for i in range(1, len(frame_db) - 1):
            if frame_db[i] > frame_db[i - 1] and frame_db[i] > frame_db[i + 1]:
                if frame_db[i] > threshold_db:
                    peak_indices.append(i)

        peak_indices.sort(key=lambda i: frame_db[i], reverse=True)
        peak_indices = peak_indices[:n_peaks]

        midi_notes = [midi_base + idx for idx in peak_indices]
        amps = [float(frame_db[idx]) for idx in peak_indices]

        notes_per_frame.append(midi_notes)
        amplitudes_per_frame.append(amps)

    return {
        "times": times,
        "notes_per_frame": notes_per_frame,
        "amplitudes_per_frame": amplitudes_per_frame,
        "sr": sr_actual,
    }


def analyze_double_stop(
    poly_data: dict,
    start_time: float,
    end_time: float,
    target_pitches: list[int],
    min_frames_ratio: float = 0.3,
) -> dict:
    """Analyze a double-stop (two simultaneous notes) within a time window.

    Args:
        poly_data: output from detect_polyphonic_notes
        start_time: window start
        end_time: window end
        target_pitches: expected MIDI note numbers (2 for double stop)
        min_frames_ratio: minimum fraction of frames where both notes must appear

    Returns:
        dict with:
          - detected_pitches: list of detected MIDI notes (most common in window)
          - match_ratio: fraction of frames where target notes were detected
          - status: 'good' | 'partial' | 'wrong_note' | 'missing'
          - details: per-note detection info
    """
    times = poly_data["times"]
    notes_per_frame = poly_data["notes_per_frame"]

    mask = (times >= start_time) & (times < end_time)
    frame_indices = np.where(mask)[0]

    if len(frame_indices) == 0:
        return {
            "detected_pitches": [],
            "match_ratio": 0.0,
            "status": "missing",
            "details": [],
        }

    note_counts: dict[int, int] = {}
    both_present_count = 0

    for fi in frame_indices:
        frame_notes = set(notes_per_frame[fi])
        for n in frame_notes:
            note_counts[n] = note_counts.get(n, 0) + 1

        if all(t in frame_notes or any(abs(t - fn) <= 1 for fn in frame_notes) for t in target_pitches):
            both_present_count += 1

    n_frames = len(frame_indices)
    match_ratio = both_present_count / n_frames

    top_notes = sorted(note_counts.keys(), key=lambda n: note_counts[n], reverse=True)
    detected_pitches = top_notes[:len(target_pitches)]

    details = []
    for target in target_pitches:
        count = 0
        for n, c in note_counts.items():
            if abs(n - target) <= 1:
                count = max(count, c)
        ratio = count / n_frames if n_frames > 0 else 0
        details.append({
            "target_midi": target,
            "detected_ratio": round(ratio, 3),
            "found": ratio >= min_frames_ratio,
        })

    if match_ratio >= 0.5:
        status = "good"
    elif match_ratio >= 0.2 or any(d["found"] for d in details):
        status = "partial"
    elif len(detected_pitches) > 0:
        status = "wrong_note"
    else:
        status = "missing"

    return {
        "detected_pitches": detected_pitches,
        "match_ratio": round(match_ratio, 3),
        "status": status,
        "details": details,
    }


def analyze_performance_polyphonic(
    audio_path: Union[str, Path],
    note_groups: list[dict],
) -> list[dict]:
    """Analyze polyphonic (double-stop) detection for relevant note groups.

    Only processes note_groups with type 'double_stop' or 'chord'.
    Single notes are skipped (handled by PitchService).

    Args:
        audio_path: path to the recording
        note_groups: list of note_group dicts

    Returns:
        list of analysis results for double-stop/chord note groups
    """
    poly_data = detect_polyphonic_notes(str(audio_path))

    results = []
    for ng in note_groups:
        if ng["type"] not in ("double_stop", "chord"):
            results.append({
                "note_group_id": ng.get("note_group_id", ""),
                "measure": ng["measure"],
                "beat": ng["beat"],
                "type": ng["type"],
                "polyphonic_analysis": None,
            })
            continue

        analysis = analyze_double_stop(
            poly_data,
            start_time=ng["start"],
            end_time=ng["end"],
            target_pitches=ng["target_pitches"],
        )

        results.append({
            "note_group_id": ng.get("note_group_id", ""),
            "measure": ng["measure"],
            "beat": ng["beat"],
            "type": ng["type"],
            "polyphonic_analysis": analysis,
        })

    return results
