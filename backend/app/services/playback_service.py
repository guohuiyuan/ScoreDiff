"""PlaybackService: generate playback timeline from note_groups."""


def generate_playback_timeline(note_groups: list[dict], bpm: float = 120.0) -> dict:
    """Generate a playback timeline for the frontend.

    Returns a structure with:
      - bpm
      - total_duration (seconds)
      - events: list of {time, duration, note_group_id, pitches, names, type}
    """
    events = []
    for i, ng in enumerate(note_groups):
        events.append({
            "time": ng["start"],
            "duration": ng["end"] - ng["start"],
            "note_group_id": ng.get("note_group_id", f"ng_{i:03d}"),
            "pitches": ng["target_pitches"],
            "names": ng["target_names"],
            "type": ng["type"],
        })

    total_duration = max((e["time"] + e["duration"] for e in events), default=0.0)

    return {
        "bpm": bpm,
        "total_duration": round(total_duration, 4),
        "events": events,
    }
