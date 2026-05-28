from typing import Optional

from pydantic import BaseModel


class ProjectCreate(BaseModel):
    title: str
    instrument: str = "violin"


class ProjectUpdate(BaseModel):
    instrument: Optional[str] = None


class ProjectResponse(BaseModel):
    id: str
    title: str
    instrument: str
    source_type: Optional[str]
    status: str
    created_at: str
    updated_at: str


class TaskResponse(BaseModel):
    task_id: str
    status: str
    progress: float
    message: Optional[str]


class ScoreFileResponse(BaseModel):
    file_id: str
    status: str


class ScoreConvertResponse(BaseModel):
    status: str
    source: str
    target: str
    musicxml_url: Optional[str] = None
    midi_url: Optional[str] = None
    mp3_url: Optional[str] = None


class PerformanceCreate(BaseModel):
    pass


class PerformanceResponse(BaseModel):
    performance_id: str
    status: str


class NoteGroupOut(BaseModel):
    note_group_id: str
    measure: int
    beat: float
    start: float
    end: float
    target_pitches: list[int]
    target_names: list[str]
    type: str


class NoteGroupIn(BaseModel):
    note_group_id: Optional[str] = None
    measure: int
    beat: float
    start: float
    end: float
    target_pitches: list[int]
    target_names: list[str] = []
    type: str = "single_note"


class ScoreMetadataOut(BaseModel):
    key_fifths: int = 0
    key_mode: str = "major"
    time_signature: str = "4/4"
    tempo: float = 120.0


class ScoreUpdateRequest(BaseModel):
    note_groups: list[NoteGroupIn]


class ScoreResponse(BaseModel):
    project_id: str
    musicxml_url: Optional[str]
    midi_url: Optional[str]
    mp3_url: Optional[str] = None
    metadata: ScoreMetadataOut = ScoreMetadataOut()
    note_groups: list[NoteGroupOut]


class NoteResultOut(BaseModel):
    note_group_id: str
    measure: int
    beat: float
    target: list[str]
    detected: Optional[list[str]]
    pitch_error_cents: Optional[float]
    onset_error_ms: Optional[float]
    status: str
    feedback: Optional[str]


class PerformanceResultResponse(BaseModel):
    total_score: Optional[float]
    pitch_score: Optional[float]
    rhythm_score: Optional[float]
    completeness_score: Optional[float]
    stability_score: Optional[float]
    note_results: list[NoteResultOut]
