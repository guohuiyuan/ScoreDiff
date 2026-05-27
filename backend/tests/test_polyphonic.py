"""Test polyphonic (double-stop) detection with synthetic two-note chord."""
import numpy as np
import soundfile as sf
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.polyphonic_service import detect_polyphonic_notes, analyze_double_stop, analyze_performance_polyphonic

# Generate a synthetic double-stop: A4 (440Hz) + E5 (659Hz)
sr = 22050
duration = 1.0
t = np.linspace(0, duration, int(sr * duration), endpoint=False)
tone_a4 = 0.5 * np.sin(2 * np.pi * 440 * t)
tone_e5 = 0.5 * np.sin(2 * np.pi * 659.25 * t)
double_stop = tone_a4 + tone_e5

test_path = Path("data/test_double_stop.wav")
test_path.parent.mkdir(parents=True, exist_ok=True)
sf.write(str(test_path), double_stop, sr)

# Test polyphonic detection
poly_data = detect_polyphonic_notes(str(test_path))
n_frames = len(poly_data["times"])
print(f"Detected {n_frames} frames over {poly_data['times'][-1]:.2f}s")

# Check that we detect multiple notes in at least some frames
multi_note_frames = sum(1 for notes in poly_data["notes_per_frame"] if len(notes) >= 2)
print(f"Frames with 2+ notes: {multi_note_frames}/{n_frames} ({100*multi_note_frames/n_frames:.0f}%)")

# Test double-stop analysis
# A4 = MIDI 69, E5 = MIDI 76
analysis = analyze_double_stop(
    poly_data,
    start_time=0.1,
    end_time=0.9,
    target_pitches=[69, 76],
)
print(f"\nDouble-stop analysis:")
print(f"  detected_pitches: {analysis['detected_pitches']}")
print(f"  match_ratio: {analysis['match_ratio']}")
print(f"  status: {analysis['status']}")
for d in analysis["details"]:
    print(f"  target MIDI {d['target_midi']}: ratio={d['detected_ratio']}, found={d['found']}")

# Test full performance analysis
note_groups = [
    {"note_group_id": "ng_000", "measure": 1, "beat": 1.0, "start": 0.0, "end": 1.0,
     "target_pitches": [69, 76], "target_names": ["A4", "E5"], "type": "double_stop"},
]

results = analyze_performance_polyphonic(str(test_path), note_groups)
print(f"\nFull analysis result:")
r = results[0]
print(f"  {r['note_group_id']}: type={r['type']}, analysis={r['polyphonic_analysis']['status']}")

assert analysis["status"] in ("good", "partial"), f"Expected good/partial, got {analysis['status']}"
print("\n[OK] Double-stop detection working")

test_path.unlink()
print("\n=== POLYPHONIC SERVICE TEST PASSED ===")
