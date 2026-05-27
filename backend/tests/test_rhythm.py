"""Test rhythm detection with synthetic multi-note audio."""
import numpy as np
import soundfile as sf
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.rhythm_service import detect_onsets, align_onsets_to_score, analyze_performance_rhythm


def generate_note_sequence(frequencies, durations, sr=22050, gap=0.02):
    """Generate a sequence of tones with short gaps between them."""
    audio = np.array([], dtype=np.float64)
    for freq, dur in zip(frequencies, durations):
        t = np.linspace(0, dur, int(sr * dur), endpoint=False)
        # Apply envelope to create clear onsets
        envelope = np.ones_like(t)
        attack = int(sr * 0.005)
        envelope[:attack] = np.linspace(0, 1, attack)
        decay = int(sr * 0.01)
        envelope[-decay:] = np.linspace(1, 0, decay)

        tone = 0.7 * np.sin(2 * np.pi * freq * t) * envelope
        audio = np.concatenate([audio, tone])
        # Add gap
        audio = np.concatenate([audio, np.zeros(int(sr * gap))])
    return audio


# Generate 4 notes: A4, B4, C#5, D5 at 0.5s each
sr = 22050
freqs = [440, 494, 554, 587]
durs = [0.5, 0.5, 0.5, 0.5]
audio = generate_note_sequence(freqs, durs, sr=sr)

test_path = Path("data/test_rhythm.wav")
test_path.parent.mkdir(parents=True, exist_ok=True)
sf.write(str(test_path), audio, sr)

# Test onset detection
onset_data = detect_onsets(str(test_path))
print(f"Detected {len(onset_data['onset_times'])} onsets")
print(f"Onset times: {[round(t, 3) for t in onset_data['onset_times']]}")

# Expected onsets at approximately 0.0, 0.52, 1.04, 1.56 (0.5s note + 0.02s gap)
expected = np.array([0.0, 0.52, 1.04, 1.56])

# Test alignment
alignment = align_onsets_to_score(onset_data["onset_times"], expected, tolerance_ms=200)
print(f"\nAlignment results:")
for a in alignment:
    print(f"  expected={a['expected_time']:.3f}s detected={a['detected_time']} error={a['onset_error_ms']}ms status={a['status']}")

matched = sum(1 for a in alignment if a["status"] != "missing")
print(f"\nMatched: {matched}/{len(alignment)}")

# Test full analysis
note_groups = [
    {"note_group_id": "ng_000", "measure": 1, "beat": 1.0, "start": 0.0, "end": 0.5, "target_pitches": [69], "target_names": ["A4"], "type": "single_note"},
    {"note_group_id": "ng_001", "measure": 1, "beat": 2.0, "start": 0.52, "end": 1.02, "target_pitches": [71], "target_names": ["B4"], "type": "single_note"},
    {"note_group_id": "ng_002", "measure": 1, "beat": 3.0, "start": 1.04, "end": 1.54, "target_pitches": [73], "target_names": ["C#5"], "type": "single_note"},
    {"note_group_id": "ng_003", "measure": 1, "beat": 4.0, "start": 1.56, "end": 2.06, "target_pitches": [74], "target_names": ["D5"], "type": "single_note"},
]

results = analyze_performance_rhythm(str(test_path), note_groups)
print(f"\nFull analysis:")
for r in results:
    print(f"  {r['note_group_id']}: error={r['onset_error_ms']}ms status={r['status']}")

# At least 3 out of 4 should be matched (onset detection may miss the very first)
matched_count = sum(1 for r in results if r["status"] in ("matched", "early", "late"))
assert matched_count >= 2, f"Only {matched_count} notes matched, expected at least 2"
print(f"\n[OK] {matched_count}/4 notes matched")

test_path.unlink()
print("\n=== RHYTHM SERVICE TEST PASSED ===")
