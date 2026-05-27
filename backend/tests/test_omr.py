"""Test OMR service with a synthetic score image."""
import numpy as np
import cv2
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.omr_service import OMRService


def create_test_score_image(output_path: Path):
    """Create a simple synthetic score image with staff lines."""
    img = np.ones((400, 800), dtype=np.uint8) * 255

    # Draw 5 staff lines
    y_start = 100
    spacing = 15
    for i in range(5):
        y = y_start + i * spacing
        cv2.line(img, (50, y), (750, y), 0, 1)

    # Draw a second staff group
    y_start2 = 250
    for i in range(5):
        y = y_start2 + i * spacing
        cv2.line(img, (50, y), (750, y), 0, 1)

    # Draw some note heads (filled circles)
    cv2.circle(img, (200, y_start + 2 * spacing), 6, 0, -1)
    cv2.circle(img, (350, y_start + spacing), 6, 0, -1)
    cv2.circle(img, (500, y_start + 3 * spacing), 6, 0, -1)

    cv2.imwrite(str(output_path), img)
    return output_path


# Create test image
test_path = Path("data/test_score_image.png")
test_path.parent.mkdir(parents=True, exist_ok=True)
create_test_score_image(test_path)

# Test OMR service
omr = OMRService()
print(f"HOMR available: {omr.has_homr}")
print(f"Audiveris available: {omr.has_audiveris}")

# Test preprocessing
binary = omr.preprocess_image(str(test_path))
print(f"Preprocessed image shape: {binary.shape}")
assert binary.shape == (400, 800)
print("[OK] Image preprocessing")

# Test staff line detection
staves = omr.detect_staff_lines(binary)
print(f"Detected {len(staves)} staff groups")
for i, staff in enumerate(staves):
    print(f"  Staff {i+1}: lines at y={staff}")
assert len(staves) >= 1, "Should detect at least 1 staff group"
print("[OK] Staff line detection")

# Test full conversion (will return preprocessed since no Audiveris)
result = omr.convert_image_to_musicxml(str(test_path), "test_project")
print(f"\nConversion result:")
print(f"  status: {result['status']}")
print(f"  method: {result['method']}")
print(f"  staves_detected: {result.get('staves_detected', 'N/A')}")
print(f"  message: {result['message']}")

assert result["status"] in ("success", "preprocessed")
if result["status"] == "preprocessed":
    assert "available_engines" in result
print("[OK] OMR conversion pipeline")

test_path.unlink()
print("\n=== OMR SERVICE TEST PASSED ===")
