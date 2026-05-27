"""OMR Service: Image/PDF → MusicXML conversion.

Uses HOMR (via uvx or direct CLI) for optical music recognition.
Falls back to Audiveris, then to basic image preprocessing.
"""
import copy
import subprocess
import shutil
import tempfile
import os
from pathlib import Path
from typing import Optional, Union

import cv2
import numpy as np
from music21 import converter, metadata, stream

from app.core.config import settings


class OMRService:
    def __init__(self):
        self.output_dir = settings.data_dir / "scores" / "musicxml"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._homr_path = shutil.which("homr")
        self._uvx_path = shutil.which("uvx")
        self._audiveris_path = shutil.which("audiveris")

    @property
    def has_homr(self) -> bool:
        return self._homr_path is not None or self._uvx_path is not None

    @property
    def has_audiveris(self) -> bool:
        return self._audiveris_path is not None

    def pdf_to_images(self, pdf_path: Union[str, Path]) -> list[Path]:
        """Convert PDF pages to PNG images using pymupdf."""
        import fitz

        pdf_path = Path(pdf_path)
        output_dir = settings.data_dir / "scores" / "pages"
        output_dir.mkdir(parents=True, exist_ok=True)

        doc = fitz.open(str(pdf_path))
        images = []
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=300)
            page_path = output_dir / f"{pdf_path.stem}_page_{i+1}.png"
            pix.save(str(page_path))
            images.append(page_path)
        doc.close()
        return images

    def preprocess_image(self, image_path: Union[str, Path]) -> np.ndarray:
        """Preprocess a score image for OMR."""
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
        """Detect horizontal staff lines in a preprocessed binary image."""
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

    def _write_musicxml_candidate(self, candidate: Path, output_path: Path) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if candidate.suffix.lower() == ".mxl":
            score = converter.parse(str(candidate))
            score.write("musicxml", fp=str(output_path))
        else:
            shutil.copy2(candidate, output_path)
        return output_path

    def _merge_musicxml_files(self, musicxml_paths: list[Path], output_path: Path) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if len(musicxml_paths) == 1:
            shutil.copy2(musicxml_paths[0], output_path)
            return output_path

        merged = stream.Score()
        merged.metadata = metadata.Metadata()
        merged.metadata.title = "ScoreDiff OMR"
        merged_part = stream.Part()
        next_measure_number = 1

        for musicxml_path in musicxml_paths:
            score = converter.parse(str(musicxml_path))
            parts = list(score.parts)
            source_part = parts[0] if parts else score
            if not merged_part.partName and getattr(source_part, "partName", None):
                merged_part.partName = source_part.partName

            measures = list(source_part.getElementsByClass(stream.Measure))
            if not measures:
                flat_items = list(source_part.flatten().notesAndRests)
                if flat_items:
                    measure = stream.Measure(number=next_measure_number)
                    for item in flat_items:
                        measure.append(copy.deepcopy(item))
                    merged_part.append(measure)
                    next_measure_number += 1
                continue

            for measure in measures:
                merged_measure = copy.deepcopy(measure)
                merged_measure.number = next_measure_number
                merged_part.append(merged_measure)
                next_measure_number += 1

        if next_measure_number == 1:
            raise ValueError("没有可合并的小节")

        merged.append(merged_part)
        merged.write("musicxml", fp=str(output_path))
        return output_path

    def _expand_sources_to_images(self, source_paths: list[Union[str, Path]]) -> list[Path]:
        images: list[Path] = []
        for source_path in source_paths:
            source = Path(source_path)
            if source.suffix.lower() == ".pdf":
                images.extend(self.pdf_to_images(source))
            else:
                images.append(source)
        return images

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
                    timeout=300,
                )
                if result.returncode != 0:
                    return None

                candidates = (
                    list(Path(tmpdir).rglob("*.musicxml"))
                    + list(Path(tmpdir).rglob("*.xml"))
                    + list(Path(tmpdir).rglob("*.mxl"))
                )
                if not candidates:
                    src_dir = image_path.parent
                    candidates = (
                        list(src_dir.rglob(f"{image_path.stem}*.musicxml"))
                        + list(src_dir.rglob(f"{image_path.stem}*.xml"))
                    )
                if candidates:
                    return self._write_musicxml_candidate(candidates[0], output_path)
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
                    return self._write_musicxml_candidate(mxl_files[0], Path(output_path))
            except (subprocess.TimeoutExpired, FileNotFoundError):
                return None

        return None

    def convert_sources_to_musicxml(
        self, source_paths: list[Union[str, Path]], project_id: str
    ) -> dict:
        """Main entry point: convert images/PDFs to one MusicXML file."""
        output_path = self.output_dir / f"{project_id}.musicxml"
        homr_inputs = self._expand_sources_to_images(source_paths)

        if not homr_inputs:
            return {"status": "error", "message": "没有可识别的图片或 PDF 页面"}

        converted: list[Optional[Path]] = [None] * len(homr_inputs)
        methods: list[Optional[str]] = [None] * len(homr_inputs)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            if self.has_homr:
                for index, homr_input in enumerate(homr_inputs):
                    result = self.convert_with_homr(
                        homr_input,
                        tmpdir_path / f"{project_id}_page_{index + 1}.musicxml",
                    )
                    if result:
                        converted[index] = result
                        methods[index] = "homr"

            if self.has_audiveris:
                for index, homr_input in enumerate(homr_inputs):
                    if converted[index]:
                        continue
                    result = self.convert_with_audiveris(
                        homr_input,
                        tmpdir_path / f"{project_id}_page_{index + 1}.musicxml",
                    )
                    if result:
                        converted[index] = result
                        methods[index] = "audiveris"

            successful = [path for path in converted if path is not None]
            if successful:
                self._merge_musicxml_files(successful, output_path)
                converted_count = len(successful)
                total_count = len(homr_inputs)
                method_names = sorted({method for method in methods if method})
                return {
                    "status": "success",
                    "musicxml_path": str(output_path),
                    "message": f"已识别并合并 {converted_count}/{total_count} 页",
                    "method": "+".join(method_names),
                    "pages_total": total_count,
                    "pages_converted": converted_count,
                }

        staves: list[list[int]] = []
        preprocessed_paths: list[str] = []
        preprocessed_dir = settings.data_dir / "scores" / "preprocessed"
        preprocessed_dir.mkdir(parents=True, exist_ok=True)

        for index, homr_input in enumerate(homr_inputs):
            binary = self.preprocess_image(str(homr_input))
            detected = self.detect_staff_lines(binary)
            staves.extend(detected)

            preprocessed_path = preprocessed_dir / f"{project_id}_{index + 1}.png"
            cv2.imwrite(str(preprocessed_path), binary)
            preprocessed_paths.append(str(preprocessed_path))

        return {
            "status": "preprocessed",
            "preprocessed_path": preprocessed_paths[0] if preprocessed_paths else None,
            "preprocessed_paths": preprocessed_paths,
            "staves_detected": len(staves),
            "staff_positions": staves,
            "message": (
                f"已预处理 {len(homr_inputs)} 页，检测到 {len(staves)} 个五线谱组。"
                "完整 OMR 转换需要安装 HOMR/Audiveris 或手动上传 MusicXML。"
            ),
            "method": "preprocessing_only",
            "available_engines": {
                "homr": self.has_homr,
                "audiveris": self.has_audiveris,
            },
        }

    def convert_image_to_musicxml(
        self, image_path: Union[str, Path], project_id: str
    ) -> dict:
        """Main entry point: convert an image/PDF to MusicXML."""
        return self.convert_sources_to_musicxml([image_path], project_id)
