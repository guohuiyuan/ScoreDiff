"""RecordingService: recording upload validation and format management."""
import shutil
from pathlib import Path
from typing import Optional, Union

import librosa
import numpy as np
import soundfile as sf

from app.core.config import settings

ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".ogg", ".flac", ".webm", ".m4a", ".aac"}
TARGET_SAMPLE_RATE = 44100
LEADING_SILENCE_TOP_DB = 35
LEADING_SILENCE_PADDING_SECONDS = 0.03
MIN_TRIMMED_AUDIO_SECONDS = 0.2


class RecordingService:
    def __init__(self):
        self.recordings_dir = settings.data_dir / "recordings"
        self.recordings_dir.mkdir(parents=True, exist_ok=True)

    def validate_extension(self, filename: str) -> bool:
        suffix = Path(filename).suffix.lower()
        return suffix in ALLOWED_AUDIO_EXTENSIONS

    def save_upload(self, project_id: str, filename: str, file_obj) -> Path:
        dest = self.recordings_dir / f"{project_id}_{filename}"
        with open(dest, "wb") as f:
            shutil.copyfileobj(file_obj, f)
        return dest

    def trim_leading_silence(self, audio_path: Union[str, Path]) -> Path:
        path = Path(audio_path)
        if not path.exists():
            return path

        try:
            y, sr = librosa.load(str(path), sr=TARGET_SAMPLE_RATE, mono=True)
            if y.size == 0:
                return path

            intervals = librosa.effects.split(y, top_db=LEADING_SILENCE_TOP_DB)
            if len(intervals) == 0:
                return path

            start_sample = int(intervals[0][0])
            padding_samples = int(LEADING_SILENCE_PADDING_SECONDS * sr)
            trim_start = max(0, start_sample - padding_samples)
            trimmed = y[trim_start:]

            if trimmed.size < int(MIN_TRIMMED_AUDIO_SECONDS * sr):
                return path

            if trim_start == 0 and path.suffix.lower() == ".wav":
                return path

            trimmed_path = path.with_name(f"{path.stem}_trimmed.wav")
            sf.write(str(trimmed_path), trimmed.astype(np.float32), sr)
            return trimmed_path
        except Exception:
            converted = self.convert_to_wav(path)
            return converted or path

    def get_audio_info(self, audio_path: Union[str, Path]) -> Optional[dict]:
        path = Path(audio_path)
        if not path.exists():
            return None
        try:
            info = sf.info(str(path))
            return {
                "sample_rate": info.samplerate,
                "channels": info.channels,
                "duration_seconds": round(info.duration, 3),
                "frames": info.frames,
                "format": info.format,
                "subtype": info.subtype,
            }
        except Exception:
            return None

    def convert_to_wav(self, audio_path: Union[str, Path]) -> Optional[Path]:
        path = Path(audio_path)
        if not path.exists():
            return None
        if path.suffix.lower() == ".wav":
            return path
        wav_path = path.with_suffix(".wav")
        try:
            data, sr = sf.read(str(path))
            sf.write(str(wav_path), data, sr)
            return wav_path
        except Exception:
            return None

    def list_recordings(self, project_id: str) -> list[Path]:
        return sorted(
            p for p in self.recordings_dir.iterdir()
            if p.name.startswith(f"{project_id}_") and p.is_file()
        )
