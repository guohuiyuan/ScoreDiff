"""OMR Service: Image/PDF → MusicXML conversion.

For V1 MVP, we implement a lightweight OMR pipeline:
1. Image preprocessing (grayscale, threshold, deskew)
2. Staff line detection
3. Note head detection using template matching / contour analysis
4. Export to MusicXML

Since full OMR is extremely complex, this service provides:
- A working API endpoint that accepts image/PDF uploads
- Image preprocessing utilities
- Integration point for external OMR tools (HOMR, Audiveris CLI)
- Fallback: if no OMR engine is available, returns an error with instructions

For production use, install HOMR and let this service call `homr <image>` or
`uvx homr <image>` to produce MusicXML.
"""
import subprocess
import shutil
import tempfile
import os
from pathlib import Path
from typing import Optional, Union

import cv2
import numpy as np
from PIL import Image

from app.core.config import settings


class OMRService:
    def __init__(self):
        self.output_dir = settings.data_dir / "scores" / "musicxml"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._homr_path = shutil.which("homr")
        self._uvx_path = shutil.which("uvx") if os.getenv("SCOREDIFF_ENABLE_UVX_HOMR") == "1" else None
        self._audiveris_path = shutil.which("audiveris")

    @property
    def has_homr(self) -> bool:
        return self._homr_path is not None or self._uvx_path is not None

    @property
    def has_audiveris(self) -> bool:
        return self._audiveris_path is not None

    def preprocess_image(self, image_path: Union[str, Path]) -> np.ndarray:
        """Preprocess a score image for OMR.

        Steps: grayscale → denoise → adaptive threshold → deskew
        """
        img = cv2.imread(str(image_path))
        if img is None:
            raise ValueError(f"Cannot read image: {image_path}")

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        denoised = cv2.fastNlMeansDenoising(gray, h=10)

        binary = cv2.adaptiveThreshold(
            denoised, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            15, 10,
        )

        binary = self._deskew(binary)

        return binary

    def _deskew(self, binary: np.ndarray) -> np.ndarray:
        """Correct skew in a binary image using Hough line detection."""
        lines = cv2.HoughLinesP(
            binary, 1, np.pi / 180,
            threshold=100, minLineLength=100, maxLineGap=10,
        )
        if lines is None:
            return binary

        angles = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            if abs(x2 - x1) > 50:
                angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
                if abs(angle) < 5:
                    angles.append(angle)

        if not angles:
            return binary

        median_angle = float(np.median(angles))
        if abs(median_angle) < 0.1:
            return binary

        h, w = binary.shape
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, median_angle, 1.0)
        rotated = cv2.warpAffine(binary, M, (w, h), flags=cv2.INTER_CUBIC, borderValue=0)
        return rotated

    def detect_staff_lines(self, binary: np.ndarray) -> list[list[int]]:
        """Detect horizontal staff lines in a preprocessed binary image.

        Returns list of staff groups, each containing y-coordinates of 5 lines.
        """
        horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 1))
        horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel)

        row_sums = np.sum(horizontal, axis=1)
        threshold = np.max(row_sums) * 0.3

        line_rows = np.where(row_sums > threshold)[0]
        if len(line_rows) == 0:
            return []

        groups = []
        current_group = [line_rows[0]]
        for i in range(1, len(line_rows)):
            if line_rows[i] - line_rows[i - 1] <= 3:
                current_group.append(line_rows[i])
            else:
                groups.append(int(np.mean(current_group)))
                current_group = [line_rows[i]]
        groups.append(int(np.mean(current_group)))

        staves = []
        for i in range(0, len(groups) - 4, 5):
            staff = groups[i:i + 5]
            spacing = [staff[j + 1] - staff[j] for j in range(4)]
            avg_spacing = np.mean(spacing)
            if all(abs(s - avg_spacing) < avg_spacing * 0.5 for s in spacing):
                staves.append(staff)

        return staves

    def convert_with_homr(
        self, image_path: Union[str, Path], output_path: Union[str, Path]
    ) -> Optional[Path]:
        """Convert image to MusicXML using HOMR CLI or uvx HOMR."""
        if not self.has_homr:
            return None

        image_path = Path(image_path)
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_input = Path(tmpdir) / image_path.name
            shutil.copy2(image_path, tmp_input)

            if self._homr_path:
                cmd = [self._homr_path, str(tmp_input)]
            else:
                cmd = [self._uvx_path, "homr", str(tmp_input)]

            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if result.returncode != 0:
                    return None

                candidates = (
                    list(Path(tmpdir).rglob("*.musicxml"))
                    + list(Path(tmpdir).rglob("*.xml"))
                    + list(Path(tmpdir).rglob("*.mxl"))
                )
                if candidates:
                    shutil.copy2(candidates[0], output_path)
                    return output_path
            except (subprocess.TimeoutExpired, FileNotFoundError):
                return None

        return None

    def convert_with_audiveris(
        self, image_path: Union[str, Path], output_path: Union[str, Path]
    ) -> Optional[Path]:
        """Convert image to MusicXML using Audiveris CLI (if available)."""
        if not self.has_audiveris:
            return None

        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                result = subprocess.run(
                    [self._audiveris_path, "-batch", "-export", "-output", tmpdir, str(image_path)],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if result.returncode != 0:
                    return None

                mxl_files = list(Path(tmpdir).rglob("*.mxl")) + list(Path(tmpdir).rglob("*.musicxml"))
                if mxl_files:
                    shutil.copy2(mxl_files[0], output_path)
                    return Path(output_path)
            except (subprocess.TimeoutExpired, FileNotFoundError):
                return None

        return None

    def convert_image_to_musicxml(
        self, image_path: Union[str, Path], project_id: str
    ) -> dict:
        """Main entry point: convert an image/PDF to MusicXML.

        Tries HOMR first, then Audiveris, then falls back to preprocessing.

        Returns:
            dict with status, musicxml_path (if successful), message
        """
        image_path = Path(image_path)
        output_path = self.output_dir / f"{project_id}.musicxml"
        homr_input = self.pdf_to_images(image_path)[0] if image_path.suffix.lower() == ".pdf" else image_path

        if self.has_homr:
            result = self.convert_with_homr(homr_input, output_path)
            if result:
                return {
                    "status": "success",
                    "musicxml_path": str(output_path),
                    "message": "Converted via HOMR",
                    "method": "homr",
                }

        if self.has_audiveris:
            result = self.convert_with_audiveris(image_path, output_path)
            if result:
                return {
                    "status": "success",
                    "musicxml_path": str(output_path),
                    "message": "Converted via Audiveris",
                    "method": "audiveris",
                }

        binary = self.preprocess_image(str(homr_input))
        staves = self.detect_staff_lines(binary)

        preprocessed_path = settings.data_dir / "scores" / "preprocessed" / f"{project_id}.png"
        preprocessed_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(preprocessed_path), binary)

        return {
            "status": "preprocessed",
            "preprocessed_path": str(preprocessed_path),
            "staves_detected": len(staves),
            "staff_positions": staves,
            "message": (
                f"图片已预处理，检测到 {len(staves)} 个五线谱组。"
                "完整 OMR 转换需要安装 HOMR/Audiveris 或手动上传 MusicXML。"
            ),
            "method": "preprocessing_only",
            "available_engines": {
                "homr": self.has_homr,
                "audiveris": self.has_audiveris,
            },
        }

    def pdf_to_images(self, pdf_path: Union[str, Path]) -> list[Path]:
        """Convert PDF pages to images for OMR processing."""
        pdf_path = Path(pdf_path)
        output_dir = settings.data_dir / "scores" / "pages"
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            from PIL import Image as PILImage
            images = []
            img = PILImage.open(str(pdf_path))
            for i in range(getattr(img, 'n_frames', 1)):
                try:
                    img.seek(i)
                    page_path = output_dir / f"{pdf_path.stem}_page_{i+1}.png"
                    img.save(str(page_path))
                    images.append(page_path)
                except EOFError:
                    break
            return images
        except Exception:
            return [pdf_path]
