"""DiffService: generate diff-style feedback from scoring results."""


STATUS_COLORS = {
    "good": "green",
    "acceptable": "yellow",
    "deviation": "yellow",
    "wrong_note": "red",
    "early": "blue",
    "late": "purple",
    "missing": "gray",
    "partial": "orange",
}


def generate_diff_report(scoring_result: dict) -> dict:
    """Generate a diff-style report from scoring results.

    Returns:
      - summary: overall scores
      - issues: list of problems sorted by severity
      - measure_scores: per-measure aggregated scores
      - color_map: note_group_id → color
    """
    note_results = scoring_result["note_results"]

    issues = []
    color_map = {}
    measure_scores: dict[int, list[float]] = {}

    for nr in note_results:
        ng_id = nr["note_group_id"]
        measure = nr["measure"]
        status = nr["status"]

        color_map[ng_id] = STATUS_COLORS.get(status, "green")

        if measure not in measure_scores:
            measure_scores[measure] = []

        if status == "good":
            measure_scores[measure].append(100)
        elif status == "acceptable":
            measure_scores[measure].append(75)
        elif status == "deviation":
            measure_scores[measure].append(50)
            issues.append({
                "measure": measure,
                "beat": nr["beat"],
                "severity": "warning",
                "feedback": nr["feedback"],
                "color": "yellow",
            })
        elif status == "wrong_note":
            measure_scores[measure].append(0)
            issues.append({
                "measure": measure,
                "beat": nr["beat"],
                "severity": "error",
                "feedback": nr["feedback"],
                "color": "red",
            })

        onset_ms = nr.get("onset_error_ms", 0)
        if onset_ms and abs(onset_ms) > 150:
            direction = "提前" if onset_ms < 0 else "延后"
            issues.append({
                "measure": measure,
                "beat": nr["beat"],
                "severity": "warning",
                "feedback": f"第 {measure} 小节第 {nr['beat']} 拍：进入{direction}约 {int(abs(onset_ms))}ms",
                "color": "blue" if onset_ms < 0 else "purple",
            })

    issues.sort(key=lambda x: (0 if x["severity"] == "error" else 1, x["measure"], x["beat"]))

    measure_avg = {m: round(sum(s) / len(s), 1) for m, s in measure_scores.items() if s}
    weak_measures = [m for m, avg in measure_avg.items() if avg < 60]

    return {
        "summary": {
            "total_score": scoring_result["total_score"],
            "pitch_score": scoring_result["pitch_score"],
            "rhythm_score": scoring_result["rhythm_score"],
            "completeness_score": scoring_result["completeness_score"],
            "stability_score": scoring_result["stability_score"],
        },
        "issues": issues,
        "measure_scores": measure_avg,
        "weak_measures": weak_measures,
        "color_map": color_map,
    }
