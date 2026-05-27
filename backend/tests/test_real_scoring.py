"""Test real scoring service with synthetic audio."""
import numpy as np
import soundfile as sf
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.real_scoring_service import generate_real_scoring

# Generate a synthetic 4-note sequence: A4, B4, C#5, D5
sr = 22050
note_dur = 0.5
gap = 0.02
freqs = [440, 494, 554, 587]

audio = np.array([], dtype=np.float64)
for freq in freqs:
    t = np.linspace(0, note_dur, int(sr * note_dur), endpoint=False)
    envelope = np.ones_like(t)
    attack = int(sr * 0.005)
    envelope[:attack] = np.linspace(0, 1, attack)
    decay = int(sr * 0.01)
    envelope[-decay:] = np.linspace(1, 0, decay)
    tone = 0.7 * np.sin(2 * np.pi * freq * t) * envelope
    audio = np.concatenate([audio, tone, np.zeros(int(sr * gap))])

test_path = Path("data/test_real_scoring.wav")
test_path.parent.mkdir(parents=True, exist_ok=True)
sf.write(str(test_path), audio, sr)

# Note groups matching the synthetic audio
note_groups = [
    {"note_group_id": "ng_000", "measure": 1, "beat": 1.0, "start": 0.0, "end": 0.5,
     "target_pitches": [69], "target_names": ["A4"], "type": "single_note"},
    {"note_group_id": "ng_001", "measure": 1, "beat": 2.0, "start": 0.52, "end": 1.02,
     "target_pitches": [71], "target_names": ["B4"], "type": "single_note"},
    {"note_group_id": "ng_002", "measure": 1, "beat": 3.0, "start": 1.04, "end": 1.54,
     "target_pitches": [73], "target_names": ["C#5"], "type": "single_note"},
    {"note_group_id": "ng_003", "measure": 1, "beat": 4.0, "start": 1.56, "end": 2.06,
     "target_pitches": [74], "target_names": ["D5"], "type": "single_note"},
]

# Run real scoring
result = generate_real_scoring(str(test_path), note_groups, "perf_test_001")

print("=== REAL SCORING RESULTS ===")
print(f"Total: {result['total_score']}")
print(f"Pitch: {result['pitch_score']}")
print(f"Rhythm: {result['rhythm_score']}")
print(f"Completeness: {result['completeness_score']}")
print(f"Stability: {result['stability_score']}")
print(f"\nNote results ({len(result['note_results'])} notes):")
for nr in result["note_results"]:
    print(f"  {nr['note_group_id']}: status={nr['status']}, pitch_err={nr['pitch_error_cents']}c, onset_err={nr['onset_error_ms']}ms")
    print(f"    feedback: {nr['feedback']}")

# Verify structure
assert "total_score" in result
assert "note_results" in result
assert len(result["note_results"]) == 4
for nr in result["note_results"]:
    assert "performance_id" in nr
    assert "note_group_id" in nr
    assert "target_json" in nr
    assert "detected_json" in nr
    assert "status" in nr
    assert "feedback" in nr

# Pitch should be reasonably accurate for pure tones
good_count = sum(1 for nr in result["note_results"] if nr["status"] in ("good", "acceptable"))
print(f"\n[OK] {good_count}/4 notes rated good/acceptable")
assert good_count >= 2, f"Expected at least 2 good notes, got {good_count}"

test_path.unlink()
print("\n=== REAL SCORING SERVICE TEST PASSED ===")
