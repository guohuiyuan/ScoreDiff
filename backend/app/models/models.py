import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}"


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: str = Field(default_factory=lambda: _new_id("proj_"), primary_key=True)
    title: str
    instrument: str = "violin"
    source_type: Optional[str] = None
    status: str = "created"
    created_at: str = Field(default_factory=_utcnow)
    updated_at: str = Field(default_factory=_utcnow)


class ScoreFile(SQLModel, table=True):
    __tablename__ = "score_files"

    id: str = Field(default_factory=lambda: _new_id("file_"), primary_key=True)
    project_id: str
    file_type: str
    path: str
    page_count: int = 0
    created_at: str = Field(default_factory=_utcnow)


class NoteGroup(SQLModel, table=True):
    __tablename__ = "note_groups"

    id: str = Field(default_factory=lambda: _new_id("ng_"), primary_key=True)
    project_id: str
    measure: int
    beat: float
    start_time: float
    end_time: float
    target_pitches_json: str
    target_names_json: str
    note_type: str


class Performance(SQLModel, table=True):
    __tablename__ = "performances"

    id: str = Field(default_factory=lambda: _new_id("perf_"), primary_key=True)
    project_id: str
    audio_path: str
    title: Optional[str] = None
    notes: Optional[str] = None
    status: str = "uploaded"
    segment_start: Optional[float] = None
    segment_end: Optional[float] = None
    segment_duration: Optional[float] = None
    segment_note_count: Optional[int] = None
    total_score: Optional[float] = None
    pitch_score: Optional[float] = None
    rhythm_score: Optional[float] = None
    completeness_score: Optional[float] = None
    stability_score: Optional[float] = None
    created_at: str = Field(default_factory=_utcnow)
    updated_at: str = Field(default_factory=_utcnow)


class NoteResult(SQLModel, table=True):
    __tablename__ = "note_results"

    id: str = Field(default_factory=lambda: _new_id("nr_"), primary_key=True)
    performance_id: str
    note_group_id: str
    measure: int
    beat: float
    target_json: str
    detected_json: Optional[str] = None
    pitch_error_cents: Optional[float] = None
    onset_error_ms: Optional[float] = None
    duration_error_ms: Optional[float] = None
    status: str
    feedback: Optional[str] = None


class Task(SQLModel, table=True):
    __tablename__ = "tasks"

    id: str = Field(default_factory=lambda: _new_id("task_"), primary_key=True)
    project_id: Optional[str] = None
    task_type: str
    status: str = "pending"
    progress: float = 0.0
    message: Optional[str] = None
    result_json: Optional[str] = None
    error: Optional[str] = None
    created_at: str = Field(default_factory=_utcnow)
    updated_at: str = Field(default_factory=_utcnow)
