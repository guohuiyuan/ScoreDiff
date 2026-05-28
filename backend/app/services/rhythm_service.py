"""RhythmService: onset detection and DTW-based rhythm alignment using librosa."""
import numpy as np
import librosa
from pathlib import Path
from typing import Union


def detect_onsets(
    audio_path: Union[str, Path],
    sr: int = 22050,
    hop_length: int = 512,
) -> dict:
    """Detect note onsets in an audio file.

    Returns:
        dict with:
          - onset_times: array of onset times in seconds
          - onset_frames: array of onset frame indices
          - onset_strength: onset strength envelope
          - sr: sample rate used
    """
    y, sr_actual = librosa.load(str(audio_path), sr=sr)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr_actual, hop_length=hop_length)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr_actual,
        hop_length=hop_length,
        backtrack=True,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr_actual, hop_length=hop_length)

    return {
        "onset_times": onset_times,
        "onset_frames": onset_frames,
        "onset_strength": onset_env,
        "sr": sr_actual,
    }


def align_onsets_to_score(
    detected_onsets: np.ndarray,
    expected_onsets: np.ndarray,
    tolerance_ms: float = 200.0,
) -> list[dict]:
    """Align detected onsets to expected score onsets using greedy nearest-neighbor.

    Args:
        detected_onsets: array of detected onset times (seconds)
        expected_onsets: array of expected onset times from score (seconds)
        tolerance_ms: maximum allowed deviation in milliseconds

    Returns:
        list of alignment results per expected onset:
          - expected_time: expected onset time
          - detected_time: matched detected onset (or None)
          - onset_error_ms: timing error in ms (positive = late, negative = early)
          - status: 'matched' | 'early' | 'late' | 'missing'
    """
    tolerance_s = tolerance_ms / 1000.0
    used = set()
    results = []

    for exp_time in expected_onsets:
        best_idx = None
        best_dist = float("inf")

        for i, det_time in enumerate(detected_onsets):
            if i in used:
                continue
            dist = abs(det_time - exp_time)
            if dist < best_dist:
                best_dist = dist
                best_idx = i

        if best_idx is not None and best_dist <= tolerance_s:
            used.add(best_idx)
            det_time = float(detected_onsets[best_idx])
            error_ms = (det_time - exp_time) * 1000.0

            if abs(error_ms) <= 50:
                status = "matched"
            elif error_ms < 0:
                status = "early"
            else:
                status = "late"

            results.append({
                "expected_time": round(exp_time, 4),
                "detected_time": round(det_time, 4),
                "onset_error_ms": round(error_ms, 1),
                "status": status,
            })
        else:
            results.append({
                "expected_time": round(exp_time, 4),
                "detected_time": None,
                "onset_error_ms": None,
                "status": "missing",
            })

    return results


def dtw_align_performance(
    audio_path: Union[str, Path],
    reference_path: Union[str, Path],
    sr: int = 22050,
    hop_length: int = 512,
) -> dict:
    """Align a performance to a reference using DTW on chroma features.

    Args:
        audio_path: path to the performance audio
        reference_path: path to the reference audio (e.g., MIDI-rendered)
        sr: sample rate
        hop_length: hop length for feature extraction

    Returns:
        dict with:
          - wp: warping path (N x 2 array)
          - cost: total DTW cost
          - performance_times: time axis for performance
          - reference_times: time axis for reference
    """
    y_perf, _ = librosa.load(str(audio_path), sr=sr)
    y_ref, _ = librosa.load(str(reference_path), sr=sr)

    chroma_perf = librosa.feature.chroma_cqt(y=y_perf, sr=sr, hop_length=hop_length)
    chroma_ref = librosa.feature.chroma_cqt(y=y_ref, sr=sr, hop_length=hop_length)

    D, wp = librosa.sequence.dtw(chroma_perf, chroma_ref, metric="cosine")

    wp = np.array(wp)

    perf_times = librosa.frames_to_time(
        np.arange(chroma_perf.shape[1]), sr=sr, hop_length=hop_length
    )
    ref_times = librosa.frames_to_time(
        np.arange(chroma_ref.shape[1]), sr=sr, hop_length=hop_length
    )

    return {
        "wp": wp,
        "cost": float(D[-1, -1]),
        "performance_times": perf_times,
        "reference_times": ref_times,
    }


def analyze_performance_rhythm(
    audio_path: Union[str, Path],
    note_groups: list[dict],
) -> list[dict]:
    """Analyze rhythm/timing for all note groups in a performance.

    Uses onset detection + greedy alignment to score onsets.

    Args:
        audio_path: path to the recording
        note_groups: list of note_group dicts with start times

    Returns:
        list of rhythm analysis results per note group
    """
    onset_data = detect_onsets(str(audio_path))

    expected_onsets = np.array([
        ng["start"] for ng in note_groups if ng["type"].split(":")[0] != "rest"
    ])

    alignment = align_onsets_to_score(onset_data["onset_times"], expected_onsets)

    results = []
    align_idx = 0
    for ng in note_groups:
        if ng["type"].split(":")[0] == "rest":
            results.append({
                "note_group_id": ng.get("note_group_id", ""),
                "measure": ng["measure"],
                "beat": ng["beat"],
                "expected_time": ng["start"],
                "detected_time": None,
                "onset_error_ms": None,
                "status": "rest",
            })
            continue

        if align_idx < len(alignment):
            a = alignment[align_idx]
            results.append({
                "note_group_id": ng.get("note_group_id", ""),
                "measure": ng["measure"],
                "beat": ng["beat"],
                **a,
            })
            align_idx += 1
        else:
            results.append({
                "note_group_id": ng.get("note_group_id", ""),
                "measure": ng["measure"],
                "beat": ng["beat"],
                "expected_time": ng["start"],
                "detected_time": None,
                "onset_error_ms": None,
                "status": "missing",
            })

    return results
