"""ScoringService: mock scoring for V0."""
import json
import random

from app.models.models import NoteResult


def generate_mock_scoring(note_groups: list[dict], performance_id: str) -> dict:
    """Generate mock scoring results for a performance.

    Returns:
      - scores: total, pitch, rhythm, completeness, stability
      - note_results: list of NoteResult-compatible dicts
    """
    note_results = []
    pitch_errors = []
    onset_errors = []

    for ng in note_groups:
        if ng["type"] == "rest":
            continue

        pitch_err = random.gauss(0, 20)
        onset_err = random.gauss(0, 80)
        duration_err = random.gauss(0, 50)

        abs_pitch = abs(pitch_err)
        if abs_pitch < 15:
            status = "good"
            feedback = f"{ng['target_names'][0]} 音准良好" if ng["target_names"] else ""
        elif abs_pitch < 30:
            status = "acceptable"
            direction = "偏高" if pitch_err > 0 else "偏低"
            feedback = f"{ng['target_names'][0]} {direction}约 {int(abs_pitch)} 音分" if ng["target_names"] else ""
        elif abs_pitch < 50:
            status = "deviation"
            direction = "偏高" if pitch_err > 0 else "偏低"
            feedback = f"{ng['target_names'][0]} 明显{direction}约 {int(abs_pitch)} 音分" if ng["target_names"] else ""
        else:
            status = "wrong_note"
            feedback = f"{ng['target_names'][0]} 错音" if ng["target_names"] else ""

        pitch_errors.append(abs_pitch)
        onset_errors.append(abs(onset_err))

        detected_names = ng["target_names"] if status != "wrong_note" else []

        note_results.append({
            "performance_id": performance_id,
            "note_group_id": ng.get("note_group_id", ""),
            "measure": ng["measure"],
            "beat": ng["beat"],
            "target_json": json.dumps(ng["target_names"]),
            "detected_json": json.dumps(detected_names),
            "pitch_error_cents": round(pitch_err, 1),
            "onset_error_ms": round(onset_err, 1),
            "duration_error_ms": round(duration_err, 1),
            "status": status,
            "feedback": feedback,
        })

    avg_pitch_err = sum(pitch_errors) / len(pitch_errors) if pitch_errors else 0
    avg_onset_err = sum(onset_errors) / len(onset_errors) if onset_errors else 0

    pitch_score = max(0, 100 - avg_pitch_err * 1.5)
    rhythm_score = max(0, 100 - avg_onset_err * 0.3)
    completeness = sum(1 for r in note_results if r["status"] != "wrong_note") / len(note_results) * 100 if note_results else 100
    stability = max(0, 100 - random.uniform(5, 20))
    total = (pitch_score * 0.4 + rhythm_score * 0.3 + completeness * 0.2 + stability * 0.1)

    return {
        "total_score": round(total, 1),
        "pitch_score": round(pitch_score, 1),
        "rhythm_score": round(rhythm_score, 1),
        "completeness_score": round(completeness, 1),
        "stability_score": round(stability, 1),
        "note_results": note_results,
    }
