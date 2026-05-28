"""RealScoringService: real scoring using PitchService + RhythmService + PolyphonicService."""
import json
from pathlib import Path
from typing import Union

from app.services.pitch_service import analyze_performance_pitch
from app.services.rhythm_service import analyze_performance_rhythm
from app.services.polyphonic_service import analyze_performance_polyphonic


def generate_real_scoring(
    audio_path: Union[str, Path],
    note_groups: list[dict],
    performance_id: str,
) -> dict:
    """Generate real scoring results by combining pitch, rhythm, and polyphonic analysis.

    Args:
        audio_path: path to the performance audio file
        note_groups: list of note_group dicts from the score
        performance_id: ID of the performance record

    Returns:
        Same structure as generate_mock_scoring:
          - scores: total, pitch, rhythm, completeness, stability
          - note_results: list of NoteResult-compatible dicts
    """
    pitch_results = analyze_performance_pitch(str(audio_path), note_groups)
    rhythm_results = analyze_performance_rhythm(str(audio_path), note_groups)
    poly_results = analyze_performance_polyphonic(str(audio_path), note_groups)

    note_results = []
    pitch_errors = []
    onset_errors = []
    stability_values = []

    for i, ng in enumerate(note_groups):
        if ng["type"].split(":")[0] == "rest":
            continue

        pitch_r = pitch_results[i] if i < len(pitch_results) else {}
        rhythm_r = rhythm_results[i] if i < len(rhythm_results) else {}
        poly_r = poly_results[i] if i < len(poly_results) else {}

        pitch_err_cents = pitch_r.get("pitch_error_cents")
        onset_err_ms = rhythm_r.get("onset_error_ms")
        stability_cents = pitch_r.get("stability_cents", 0)

        status = _determine_status(ng, pitch_r, rhythm_r, poly_r)
        feedback = _generate_feedback(ng, pitch_r, rhythm_r, poly_r, status)

        detected_names = _get_detected_names(ng, pitch_r, poly_r)

        if pitch_err_cents is not None:
            pitch_errors.append(abs(pitch_err_cents))
        if onset_err_ms is not None:
            onset_errors.append(abs(onset_err_ms))
        if stability_cents is not None:
            stability_values.append(stability_cents)

        note_results.append({
            "performance_id": performance_id,
            "note_group_id": ng.get("note_group_id", ""),
            "measure": ng["measure"],
            "beat": ng["beat"],
            "target_json": json.dumps(ng["target_names"]),
            "detected_json": json.dumps(detected_names),
            "pitch_error_cents": round(pitch_err_cents, 1) if pitch_err_cents is not None else None,
            "onset_error_ms": round(onset_err_ms, 1) if onset_err_ms is not None else None,
            "duration_error_ms": None,
            "status": status,
            "feedback": feedback,
        })

    pitch_score = _calc_pitch_score(pitch_errors)
    rhythm_score = _calc_rhythm_score(onset_errors)
    completeness_score = _calc_completeness_score(note_results)
    stability_score = _calc_stability_score(stability_values)
    total_score = (
        pitch_score * 0.4
        + rhythm_score * 0.3
        + completeness_score * 0.2
        + stability_score * 0.1
    )

    return {
        "total_score": round(total_score, 1),
        "pitch_score": round(pitch_score, 1),
        "rhythm_score": round(rhythm_score, 1),
        "completeness_score": round(completeness_score, 1),
        "stability_score": round(stability_score, 1),
        "note_results": note_results,
    }


def _determine_status(ng: dict, pitch_r: dict, rhythm_r: dict, poly_r: dict) -> str:
    """Determine the overall status for a note group."""
    if ng["type"].split(":")[0] in ("double_stop", "chord"):
        poly_analysis = poly_r.get("polyphonic_analysis")
        if poly_analysis:
            return poly_analysis["status"]

    pitch_status = pitch_r.get("status", "missing")
    rhythm_status = rhythm_r.get("status", "missing")

    if pitch_status == "missing" and rhythm_status == "missing":
        return "missing"
    if pitch_status == "wrong_note":
        return "wrong_note"
    if pitch_status == "deviation":
        return "deviation"

    if rhythm_status in ("early", "late"):
        onset_ms = rhythm_r.get("onset_error_ms")
        if onset_ms and abs(onset_ms) > 100:
            return rhythm_status

    return pitch_status


def _generate_feedback(ng: dict, pitch_r: dict, rhythm_r: dict, poly_r: dict, status: str) -> str:
    """Generate human-readable feedback for a note group."""
    name = ng["target_names"][0] if ng["target_names"] else "音符"

    if status == "missing":
        return f"{name} 未检测到"

    parts = []

    if ng["type"].split(":")[0] in ("double_stop", "chord"):
        poly_analysis = poly_r.get("polyphonic_analysis")
        if poly_analysis:
            ratio = poly_analysis.get("match_ratio", 0)
            if ratio >= 0.5:
                parts.append(f"双音识别良好 ({int(ratio*100)}%)")
            elif ratio > 0:
                parts.append(f"双音部分识别 ({int(ratio*100)}%)")
            else:
                parts.append("双音未识别")

    pitch_err = pitch_r.get("pitch_error_cents")
    if pitch_err is not None:
        abs_err = abs(pitch_err)
        if abs_err < 15:
            parts.append("音准良好")
        else:
            direction = "偏高" if pitch_err > 0 else "偏低"
            parts.append(f"{direction}{int(abs_err)}音分")

    onset_err = rhythm_r.get("onset_error_ms")
    if onset_err is not None and abs(onset_err) > 50:
        direction = "提前" if onset_err < 0 else "延后"
        parts.append(f"{direction}{int(abs(onset_err))}ms")

    if not parts:
        return f"{name} 良好"

    return f"{name}: {', '.join(parts)}"


def _get_detected_names(ng: dict, pitch_r: dict, poly_r: dict) -> list[str]:
    """Get detected note names."""
    if ng["type"].split(":")[0] in ("double_stop", "chord"):
        poly_analysis = poly_r.get("polyphonic_analysis")
        if poly_analysis and poly_analysis.get("detected_pitches"):
            import librosa
            return [librosa.midi_to_note(m) for m in poly_analysis["detected_pitches"]]

    detected_midi = pitch_r.get("detected_midi")
    if detected_midi is not None:
        import librosa
        return [librosa.midi_to_note(int(round(detected_midi)))]

    return []


def _calc_pitch_score(pitch_errors: list[float]) -> float:
    if not pitch_errors:
        return 100.0
    avg = sum(pitch_errors) / len(pitch_errors)
    return max(0, 100 - avg * 1.5)


def _calc_rhythm_score(onset_errors: list[float]) -> float:
    if not onset_errors:
        return 100.0
    avg = sum(onset_errors) / len(onset_errors)
    return max(0, 100 - avg * 0.3)


def _calc_completeness_score(note_results: list[dict]) -> float:
    if not note_results:
        return 100.0
    detected = sum(1 for r in note_results if r["status"] not in ("missing", "wrong_note"))
    return (detected / len(note_results)) * 100


def _calc_stability_score(stability_values: list[float]) -> float:
    if not stability_values:
        return 100.0
    avg_stability = sum(stability_values) / len(stability_values)
    return max(0, 100 - avg_stability * 0.5)
