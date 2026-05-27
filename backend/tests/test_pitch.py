"""Test pitch detection with synthetic A4 tone."""
import numpy as np
import soundfile as sf
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.pitch_service import detect_pitch_pyin, analyze_note_pitch

# Generate a synthetic A4 (440 Hz) tone
sr = 22050
duration = 2.0
t = np.linspace(0, duration, int(sr * duration), endpoint=False)
tone = 0.5 * np.sin(2 * np.pi * 440 * t)

test_path = Path("data/test_tone_a4.wav")
test_path.parent.mkdir(parents=True, exist_ok=True)
sf.write(str(test_path), tone, sr)

# Run pitch detection
result = detect_pitch_pyin(str(test_path))
n_frames = len(result["times"])
last_time = result["times"][-1]
print(f"Detected {n_frames} frames over {last_time:.2f}s")

voiced_freqs = result["frequencies"][result["voiced_flag"] & ~np.isnan(result["frequencies"])]
if len(voiced_freqs) > 0:
    median = float(np.median(voiced_freqs))
    print(f"Median frequency: {median:.1f} Hz (expected 440 Hz)")
    assert abs(median - 440) < 5, f"Pitch detection too far off: {median}"
    print("[OK] Pitch detection accurate")

# Test note analysis
analysis = analyze_note_pitch(result, start_time=0.2, end_time=1.8, target_midi=69)
print(f"Analysis: midi={analysis['detected_midi']}, error={analysis['pitch_error_cents']} cents, stability={analysis['stability_cents']} cents")
assert analysis["pitch_error_cents"] is not None
assert abs(analysis["pitch_error_cents"]) < 10
print("[OK] Note analysis accurate")

test_path.unlink()
print("\n=== PITCH SERVICE TEST PASSED ===")
