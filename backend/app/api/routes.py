import asyncio
import json
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.redis import redis_client
from app.db.session import get_session
from app.models.models import NoteResult as NoteResultModel
from app.schemas.schemas import (
    NoteGroupOut,
    NoteResultOut,
    PerformanceResponse,
    PerformanceResultResponse,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    ScoreConvertResponse,
    ScoreFileResponse,
    ScoreResponse,
    ScoreUpdateRequest,
    TaskResponse,
)
from app.services.diff_service import generate_diff_report
from app.services.omr_service import OMRService
from app.services.playback_service import generate_playback_timeline
from app.services.pitch_service import build_pitch_comparison_chart
from app.services.recording_service import RecordingService
from app.services.rhythm_service import detect_onsets
from app.services.score_parser import (
    convert_midi_to_musicxml,
    export_note_groups_to_musicxml,
    extract_musicxml_metadata,
    generate_midi_from_musicxml,
    normalize_note_group,
    parse_midi_to_note_groups,
    parse_musicxml_to_note_groups,
)
from app.services.scoring_service import generate_mock_scoring
from app.services.real_scoring_service import generate_real_scoring
from app.services.services import (
    FileService,
    PerformanceService,
    ProjectService,
    ScoreService,
    TaskService,
)

router = APIRouter(prefix="/api")

ALLOWED_SCORE_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".musicxml", ".xml", ".mid", ".midi"}
ALLOWED_INSTRUMENTS = {"violin", "piano", "flute", "guitar", "cello", "clarinet"}
BASE_SCORE_BPM = 120.0
AUTO_BPM_ONSET_COUNT = 12
AUTO_BPM_MIN_MATCH_RATIO = 0.55


def _score_paths(project_id: str) -> dict[str, Path]:
    return {
        "musicxml": settings.data_dir / "scores" / "musicxml" / f"{project_id}.musicxml",
        "midi": settings.data_dir / "scores" / "midi" / f"{project_id}.mid",
        "mp3": settings.data_dir / "scores" / "audio" / f"{project_id}.mp3",
    }


def _file_url(path: Path) -> str:
    rel = path.relative_to(settings.data_dir).as_posix()
    return f"/files/{rel}"


def _score_urls(project_id: str) -> dict[str, str | None]:
    paths = _score_paths(project_id)
    return {key: _file_url(path) if path.exists() else None for key, path in paths.items()}


def _score_metadata(project_id: str) -> dict:
    return extract_musicxml_metadata(_score_paths(project_id)["musicxml"])


def _delete_project_files(project_id: str) -> None:
    data_dir = settings.data_dir.resolve()
    exact_paths = [
        *_score_paths(project_id).values(),
        settings.data_dir / "scores" / "preprocessed" / f"{project_id}.png",
    ]
    directories = [
        settings.data_dir / "uploads",
        settings.data_dir / "recordings",
        settings.data_dir / "scores" / "pages",
        settings.data_dir / "scores" / "preprocessed",
    ]

    candidates: list[Path] = []
    candidates.extend(exact_paths)
    for directory in directories:
        if not directory.exists():
            continue
        candidates.extend(
            path
            for path in directory.iterdir()
            if path.is_file() and (path.name.startswith(f"{project_id}_") or path.stem == project_id)
        )

    for path in candidates:
        try:
            resolved = path.resolve()
        except FileNotFoundError:
            continue
        if resolved == data_dir or data_dir not in resolved.parents:
            continue
        if resolved.is_file():
            try:
                resolved.unlink(missing_ok=True)
            except OSError:
                continue


def _latest_score_file(files, file_types: set[str]):
    candidates = [f for f in files if f.file_type in file_types]
    if not candidates:
        return None
    return max(candidates, key=lambda f: f.created_at)


def _project_response(project) -> ProjectResponse:
    return ProjectResponse(
        id=project.id,
        title=project.title,
        instrument=project.instrument,
        source_type=project.source_type,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _max_score_end(note_groups: list[dict]) -> float:
    return max((float(group.get("end") or 0) for group in note_groups), default=0.0)


def _segment_note_groups(
    note_groups: list[dict],
    segment_start: float | None = None,
    segment_end: float | None = None,
) -> tuple[list[dict], dict]:
    full_end = _max_score_end(note_groups)
    start = max(0.0, float(segment_start or 0.0))
    end = float(segment_end) if segment_end is not None else full_end
    end = min(max(end, start), full_end) if full_end > 0 else max(end, start)
    if end <= start:
        raise HTTPException(status_code=400, detail="Comparison segment must have a positive duration")

    selected: list[dict] = []
    for group in note_groups:
        group_start = float(group.get("start") or 0.0)
        group_end = float(group.get("end") or group_start)
        if group_end <= start or group_start >= end:
            continue

        clipped_start = max(group_start, start)
        clipped_end = min(group_end, end)
        if clipped_end <= clipped_start:
            continue

        rebased = dict(group)
        rebased["start"] = round(clipped_start - start, 4)
        rebased["end"] = round(clipped_end - start, 4)
        selected.append(rebased)

    if not selected:
        raise HTTPException(status_code=400, detail="Selected comparison segment does not contain any score notes")

    return selected, {
        "start": round(start, 4),
        "end": round(end, 4),
        "duration": round(end - start, 4),
        "note_count": len([g for g in selected if g.get("type", "").split(":")[0] != "rest"]),
    }


def _time_scale_for_bpm(bpm: float | None) -> float:
    safe_bpm = min(240.0, max(40.0, float(bpm or BASE_SCORE_BPM)))
    return BASE_SCORE_BPM / safe_bpm


def _scale_note_group_times(note_groups: list[dict], scale: float) -> list[dict]:
    scaled: list[dict] = []
    for group in note_groups:
        next_group = dict(group)
        next_group["start"] = round(float(group.get("start") or 0.0) * scale, 4)
        next_group["end"] = round(float(group.get("end") or 0.0) * scale, 4)
        scaled.append(next_group)
    return scaled


def _analysis_note_groups(
    note_groups: list[dict],
    segment_start: float | None = None,
    segment_end: float | None = None,
    bpm: float | None = None,
) -> tuple[list[dict], dict]:
    selected, segment = _segment_note_groups(note_groups, segment_start, segment_end)
    scale = _time_scale_for_bpm(bpm)
    segment["duration"] = round(segment["duration"] * scale, 4)
    segment["bpm"] = round(BASE_SCORE_BPM / scale, 3)
    return _scale_note_group_times(selected, scale), segment


def _score_onsets_for_auto_bpm(note_groups: list[dict]) -> list[float]:
    onsets: list[float] = []
    for group in note_groups:
        if group.get("type", "").split(":")[0] == "rest":
            continue

        start = float(group.get("start") or 0.0)
        if onsets and abs(onsets[-1] - start) < 0.03:
            continue

        onsets.append(start)
        if len(onsets) >= AUTO_BPM_ONSET_COUNT:
            break
    return onsets


def _match_onset_grid(expected: list[float], detected: list[float], tolerance: float) -> tuple[int, float]:
    if not expected or not detected:
        return 0, tolerance

    scan_index = 0
    distances: list[float] = []
    for target in expected:
        while scan_index < len(detected) and detected[scan_index] < target - tolerance:
            scan_index += 1

        best_index: int | None = None
        best_distance = tolerance
        for index in range(scan_index, min(scan_index + 4, len(detected))):
            distance = abs(detected[index] - target)
            if distance <= best_distance:
                best_index = index
                best_distance = distance

        if best_index is not None:
            distances.append(best_distance)
            scan_index = best_index + 1

    if not distances:
        return 0, tolerance
    return len(distances), sum(distances) / len(distances)


def _estimate_bpm_from_first_onsets(
    note_groups: list[dict],
    audio_path: str | Path,
    fallback_bpm: float | None = None,
) -> float:
    fallback = min(240.0, max(40.0, float(fallback_bpm or BASE_SCORE_BPM)))
    score_onsets = _score_onsets_for_auto_bpm(note_groups)
    if len(score_onsets) < 3:
        return fallback

    try:
        detected_onsets = [float(time) for time in detect_onsets(audio_path)["onset_times"]]
    except Exception:
        return fallback

    if len(detected_onsets) < 3:
        return fallback

    base_score_onsets = [time - score_onsets[0] for time in score_onsets]
    best_bpm = fallback
    best_matches = 0
    best_error = 999.0
    best_ratio = 0.0

    for candidate_bpm in range(40, 241):
        scale = _time_scale_for_bpm(candidate_bpm)
        expected = [time * scale for time in base_score_onsets]
        positive_steps = [
            expected[index] - expected[index - 1]
            for index in range(1, len(expected))
            if expected[index] > expected[index - 1]
        ]
        base_step = sorted(positive_steps)[len(positive_steps) // 2] if positive_steps else 0.5
        tolerance = min(0.35, max(0.12, base_step * 0.35))

        for anchor_index in range(min(3, len(detected_onsets))):
            offset = detected_onsets[anchor_index] - expected[0]
            shifted = [time - offset for time in detected_onsets[anchor_index:]]
            matches, mean_error = _match_onset_grid(expected, shifted, tolerance)
            ratio = matches / len(expected)
            if ratio > best_ratio or (ratio == best_ratio and mean_error < best_error):
                best_bpm = float(candidate_bpm)
                best_matches = matches
                best_error = mean_error
                best_ratio = ratio

    min_matches = max(3, int(len(base_score_onsets) * AUTO_BPM_MIN_MATCH_RATIO))
    if best_matches < min_matches:
        return fallback

    return best_bpm


def _real_analysis_note_groups(
    note_groups: list[dict],
    audio_path: str | Path,
    segment_start: float | None = None,
    segment_end: float | None = None,
    bpm: float | None = None,
) -> tuple[list[dict], dict]:
    selected, segment = _segment_note_groups(note_groups, segment_start, segment_end)
    selected, segment = _drop_leading_score_rests_for_audio_alignment(selected, segment)
    estimated_bpm = _estimate_bpm_from_first_onsets(selected, audio_path, bpm)
    scale = _time_scale_for_bpm(estimated_bpm)
    segment["duration"] = round(segment["duration"] * scale, 4)
    segment["bpm"] = round(BASE_SCORE_BPM / scale, 3)
    scaled = _scale_note_group_times(selected, scale)
    return _clip_analysis_to_audio_duration(scaled, segment, audio_path)


def _clip_analysis_to_audio_duration(
    note_groups: list[dict],
    segment: dict,
    audio_path: str | Path,
) -> tuple[list[dict], dict]:
    audio_info = RecordingService().get_audio_info(audio_path)
    audio_duration = float(audio_info["duration_seconds"]) if audio_info else 0.0
    segment_duration = float(segment.get("duration") or 0.0)
    if audio_duration <= 0 or segment_duration <= 0 or audio_duration >= segment_duration - 0.05:
        return note_groups, segment

    clipped: list[dict] = []
    for group in note_groups:
        group_start = float(group.get("start") or 0.0)
        group_end = float(group.get("end") or group_start)
        if group_start >= audio_duration or group_end <= 0:
            continue

        next_group = dict(group)
        next_group["start"] = round(max(0.0, group_start), 4)
        next_group["end"] = round(min(group_end, audio_duration), 4)
        if next_group["end"] > next_group["start"]:
            clipped.append(next_group)

    if not clipped:
        return note_groups, segment

    bpm = float(segment.get("bpm") or BASE_SCORE_BPM)
    scale = _time_scale_for_bpm(bpm)
    next_segment = dict(segment)
    next_segment["duration"] = round(audio_duration, 4)
    next_segment["end"] = round(float(segment["start"]) + audio_duration / scale, 4)
    next_segment["note_count"] = len([g for g in clipped if g.get("type", "").split(":")[0] != "rest"])
    return clipped, next_segment


def _drop_leading_score_rests_for_audio_alignment(
    note_groups: list[dict],
    segment: dict,
) -> tuple[list[dict], dict]:
    first_note_start = min(
        (
            float(group.get("start") or 0.0)
            for group in note_groups
            if group.get("type", "").split(":")[0] != "rest"
        ),
        default=0.0,
    )
    if first_note_start <= 0.05:
        return note_groups, segment

    adjusted: list[dict] = []
    for group in note_groups:
        group_start = float(group.get("start") or 0.0)
        group_end = float(group.get("end") or group_start)
        if group_end <= first_note_start:
            continue

        next_group = dict(group)
        next_group["start"] = round(max(0.0, group_start - first_note_start), 4)
        next_group["end"] = round(group_end - first_note_start, 4)
        adjusted.append(next_group)

    if not adjusted:
        return note_groups, segment

    bpm = float(segment.get("bpm") or BASE_SCORE_BPM)
    scale = _time_scale_for_bpm(bpm)
    next_segment = dict(segment)
    next_segment["start"] = round(float(segment["start"]) + first_note_start / scale, 4)
    next_segment["duration"] = round(max(0.0, float(segment.get("duration") or 0.0) - first_note_start), 4)
    next_segment["note_count"] = len([g for g in adjusted if g.get("type", "").split(":")[0] != "rest"])
    return adjusted, next_segment


def _selected_original_groups(note_groups: list[dict], result_ids: set[str]) -> list[dict]:
    return [group for group in note_groups if group.get("note_group_id") in result_ids]


def _infer_segment_from_groups(groups: list[dict]) -> dict:
    if not groups:
        return {"start": 0.0, "end": 0.0, "duration": 0.0, "note_count": 0}
    start = min(float(group.get("start") or 0.0) for group in groups)
    end = max(float(group.get("end") or start) for group in groups)
    return {
        "start": round(start, 4),
        "end": round(end, 4),
        "duration": round(max(0.0, end - start), 4),
        "note_count": len([g for g in groups if g.get("type", "").split(":")[0] != "rest"]),
    }


async def _save_scoring_results(
    session: AsyncSession,
    perf_svc: PerformanceService,
    perf,
    performance_id: str,
    scoring: dict,
    segment: dict,
) -> None:
    await perf_svc.clear_results(performance_id)

    perf.total_score = scoring["total_score"]
    perf.pitch_score = scoring["pitch_score"]
    perf.rhythm_score = scoring["rhythm_score"]
    perf.completeness_score = scoring["completeness_score"]
    perf.stability_score = scoring["stability_score"]
    perf.status = "analyzed"
    perf.segment_start = segment["start"]
    perf.segment_end = segment["end"]
    perf.segment_duration = segment["duration"]
    perf.segment_note_count = segment["note_count"]

    for nr_data in scoring["note_results"]:
        nr = NoteResultModel(
            performance_id=performance_id,
            note_group_id=nr_data["note_group_id"],
            measure=nr_data["measure"],
            beat=nr_data["beat"],
            target_json=nr_data["target_json"],
            detected_json=nr_data["detected_json"],
            pitch_error_cents=nr_data["pitch_error_cents"],
            onset_error_ms=nr_data["onset_error_ms"],
            duration_error_ms=nr_data["duration_error_ms"],
            status=nr_data["status"],
            feedback=nr_data["feedback"],
        )
        session.add(nr)


@router.post("/projects", response_model=ProjectResponse)
async def create_project(body: ProjectCreate, session: AsyncSession = Depends(get_session)):
    if body.instrument not in ALLOWED_INSTRUMENTS:
        raise HTTPException(status_code=400, detail="不支持的乐器音色")
    svc = ProjectService(session)
    project = await svc.create(title=body.title, instrument=body.instrument)
    return _project_response(project)


@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(session: AsyncSession = Depends(get_session)):
    svc = ProjectService(session)
    projects = await svc.list_all()
    return [_project_response(p) for p in projects]


@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: str, session: AsyncSession = Depends(get_session)):
    svc = ProjectService(session)
    project = await svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    return _project_response(project)


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(project_id: str, body: ProjectUpdate, session: AsyncSession = Depends(get_session)):
    if body.instrument is not None and body.instrument not in ALLOWED_INSTRUMENTS:
        raise HTTPException(status_code=400, detail="不支持的乐器音色")

    svc = ProjectService(session)
    project = await svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    if body.instrument is not None and body.instrument != project.instrument:
        project = await svc.update_instrument(project_id, body.instrument)
        score_svc = ScoreService(session)
        note_groups = await score_svc.get_note_groups(project_id)
        if note_groups and project:
            paths = _score_paths(project_id)
            export_note_groups_to_musicxml(
                note_groups,
                paths["musicxml"],
                title=project.title,
                instrument_name=project.instrument,
            )
            generate_midi_from_musicxml(paths["musicxml"], paths["midi"])

    return _project_response(project)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, session: AsyncSession = Depends(get_session)):
    svc = ProjectService(session)
    deleted = await svc.delete(project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="项目不存在")
    _delete_project_files(project_id)
    return {"status": "deleted"}


@router.post("/projects/{project_id}/score-file", response_model=ScoreFileResponse)
async def upload_score_file(project_id: str, file: UploadFile, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    safe_filename = Path(file.filename or "score").name
    suffix = Path(safe_filename).suffix.lower()
    if suffix not in ALLOWED_SCORE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {suffix}")

    upload_dir = settings.data_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / f"{project_id}_{uuid.uuid4().hex[:8]}_{safe_filename}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    file_type = suffix.lstrip(".")
    file_svc = FileService(session)
    sf = await file_svc.create_score_file(project_id=project_id, file_type=file_type, path=str(dest))

    await proj_svc.update_status(project_id, "file_uploaded")

    return ScoreFileResponse(file_id=sf.id, status="uploaded")


@router.post("/projects/{project_id}/ocr")
async def run_omr(project_id: str, session: AsyncSession = Depends(get_session)):
    """Run OMR on uploaded image/PDF to produce MusicXML."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    file_svc = FileService(session)
    files = await file_svc.get_by_project(project_id)
    image_files = sorted(
        (f for f in files if f.file_type in ("pdf", "png", "jpg", "jpeg", "webp")),
        key=lambda f: f.created_at,
    )
    if not image_files:
        raise HTTPException(status_code=400, detail="当前项目没有图片或 PDF 文件")

    omr_svc = OMRService()
    result = omr_svc.convert_sources_to_musicxml([f.path for f in image_files], project_id)

    if result["status"] == "success":
        await proj_svc.update_status(project_id, "omr_complete")

    return result


@router.get("/projects/{project_id}/score", response_model=ScoreResponse)
async def get_score(project_id: str, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    score_svc = ScoreService(session)
    groups = await score_svc.get_note_groups(project_id)

    urls = _score_urls(project_id)

    return ScoreResponse(
        project_id=project_id,
        musicxml_url=urls["musicxml"],
        midi_url=urls["midi"],
        mp3_url=urls["mp3"],
        metadata=_score_metadata(project_id),
        note_groups=[NoteGroupOut(**g) for g in groups],
    )


@router.put("/projects/{project_id}/score", response_model=ScoreResponse)
async def update_score(project_id: str, body: ScoreUpdateRequest, session: AsyncSession = Depends(get_session)):
    """Persist edited note_groups and regenerate MusicXML/MIDI."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    note_groups = [normalize_note_group(g.model_dump()) for g in body.note_groups]
    if not note_groups:
        raise HTTPException(status_code=400, detail="乐谱至少需要包含一个音符或休止符")

    score_svc = ScoreService(session)
    await score_svc.save_note_groups(project_id, note_groups)

    paths = _score_paths(project_id)
    export_note_groups_to_musicxml(
        note_groups,
        paths["musicxml"],
        title=project.title,
        instrument_name=project.instrument,
    )
    generate_midi_from_musicxml(paths["musicxml"], paths["midi"])

    project.source_type = "edited"
    project.status = "score_edited"
    await session.commit()

    urls = _score_urls(project_id)
    groups = await score_svc.get_note_groups(project_id)
    return ScoreResponse(
        project_id=project_id,
        musicxml_url=urls["musicxml"],
        midi_url=urls["midi"],
        mp3_url=urls["mp3"],
        metadata=_score_metadata(project_id),
        note_groups=[NoteGroupOut(**g) for g in groups],
    )


@router.post("/projects/{project_id}/convert", response_model=ScoreConvertResponse)
async def convert_score_media(
    project_id: str,
    target: str = Query(pattern="^(midi|musicxml)$"),
    session: AsyncSession = Depends(get_session),
):
    """Convert project score to MIDI (from MusicXML)."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    paths = _score_paths(project_id)
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)

    file_svc = FileService(session)
    files = await file_svc.get_by_project(project_id)
    musicxml_file = _latest_score_file(files, {"musicxml", "xml"})
    midi_file = _latest_score_file(files, {"mid", "midi"})
    source = "existing"

    try:
        if target == "musicxml":
            if paths["musicxml"].exists():
                source = "musicxml"
            elif musicxml_file:
                shutil.copy2(musicxml_file.path, paths["musicxml"])
                source = "musicxml"
            elif paths["midi"].exists():
                convert_midi_to_musicxml(paths["midi"], paths["musicxml"])
                source = "midi"
            elif midi_file:
                convert_midi_to_musicxml(midi_file.path, paths["musicxml"])
                shutil.copy2(midi_file.path, paths["midi"])
                source = "midi"
            else:
                note_groups = await ScoreService(session).get_note_groups(project_id)
                if not note_groups:
                    raise HTTPException(status_code=400, detail="当前项目没有可导出的乐谱")
                export_note_groups_to_musicxml(
                    note_groups,
                    paths["musicxml"],
                    title=project.title,
                    instrument_name=project.instrument,
                )
                source = "edited"
        elif not paths["midi"].exists():
            if midi_file:
                shutil.copy2(midi_file.path, paths["midi"])
                source = "midi"
            elif paths["musicxml"].exists():
                generate_midi_from_musicxml(paths["musicxml"], paths["midi"])
                source = "musicxml"
            elif musicxml_file:
                generate_midi_from_musicxml(musicxml_file.path, paths["midi"])
                shutil.copy2(musicxml_file.path, paths["musicxml"])
                source = "musicxml"
            else:
                note_groups = await ScoreService(session).get_note_groups(project_id)
                if not note_groups:
                    raise HTTPException(status_code=400, detail="当前项目没有可转换的 MusicXML 或 MIDI 文件")
                export_note_groups_to_musicxml(
                    note_groups,
                    paths["musicxml"],
                    title=project.title,
                    instrument_name=project.instrument,
                )
                generate_midi_from_musicxml(paths["musicxml"], paths["midi"])
                source = "edited"
        else:
            source = "midi"
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    urls = _score_urls(project_id)
    return ScoreConvertResponse(
        status="ok",
        source=source,
        target=target,
        musicxml_url=urls["musicxml"],
        midi_url=urls["midi"],
        mp3_url=urls["mp3"],
    )


@router.post("/projects/{project_id}/performances", response_model=PerformanceResponse)
async def upload_performance(project_id: str, file: UploadFile, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    rec_svc = RecordingService()
    filename = file.filename or "recording.wav"
    if not rec_svc.validate_extension(filename):
        raise HTTPException(status_code=400, detail=f"不支持的音频格式: {Path(filename).suffix}")

    dest = rec_svc.trim_leading_silence(rec_svc.save_upload(project_id, filename, file.file))

    perf_svc = PerformanceService(session)
    perf = await perf_svc.create(project_id=project_id, audio_path=str(dest))
    return PerformanceResponse(performance_id=perf.id, status="uploaded")


@router.get("/projects/{project_id}/recordings")
async def list_recordings(project_id: str, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    rec_svc = RecordingService()
    recordings = rec_svc.list_recordings(project_id)
    results = []
    for r in recordings:
        info = rec_svc.get_audio_info(r)
        results.append({
            "filename": r.name,
            "path": str(r),
            "info": info,
        })
    return {"recordings": results}


@router.get("/performances/{performance_id}/result", response_model=PerformanceResultResponse)
async def get_performance_result(performance_id: str, session: AsyncSession = Depends(get_session)):
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="录音不存在")

    results = await perf_svc.get_results(performance_id)
    note_results = [
        NoteResultOut(
            note_group_id=r.note_group_id,
            measure=r.measure,
            beat=r.beat,
            target=json.loads(r.target_json),
            detected=json.loads(r.detected_json) if r.detected_json else None,
            pitch_error_cents=r.pitch_error_cents,
            onset_error_ms=r.onset_error_ms,
            status=r.status,
            feedback=r.feedback,
        )
        for r in results
    ]

    return PerformanceResultResponse(
        total_score=perf.total_score,
        pitch_score=perf.pitch_score,
        rhythm_score=perf.rhythm_score,
        completeness_score=perf.completeness_score,
        stability_score=perf.stability_score,
        note_results=note_results,
    )


@router.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, session: AsyncSession = Depends(get_session)):
    task_svc = TaskService(session)
    task = await task_svc.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return TaskResponse(task_id=task.id, status=task.status, progress=task.progress, message=task.message)


@router.post("/projects/{project_id}/parse-score")
async def parse_score(project_id: str, session: AsyncSession = Depends(get_session)):
    """Parse uploaded MusicXML or MIDI into note_groups."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    file_svc = FileService(session)
    files = await file_svc.get_by_project(project_id)

    source_file = _latest_score_file(files, {"musicxml", "xml", "mid", "midi"})
    paths = _score_paths(project_id)
    musicxml_dest = paths["musicxml"]
    midi_path = paths["midi"]
    musicxml_dest.parent.mkdir(parents=True, exist_ok=True)
    midi_path.parent.mkdir(parents=True, exist_ok=True)

    generated_musicxml = musicxml_dest if musicxml_dest.exists() else None
    if not source_file and not generated_musicxml:
        raise HTTPException(status_code=400, detail="当前项目没有 MusicXML 或 MIDI 文件")

    try:
        if generated_musicxml and project.status == "omr_complete":
            note_groups = parse_musicxml_to_note_groups(generated_musicxml)
            generate_midi_from_musicxml(generated_musicxml, midi_path)
            source = "omr"
        elif source_file and source_file.file_type in ("musicxml", "xml"):
            note_groups = parse_musicxml_to_note_groups(source_file.path)
            generate_midi_from_musicxml(source_file.path, midi_path)
            shutil.copy2(source_file.path, musicxml_dest)
            source = "musicxml"
        elif source_file and source_file.file_type in ("mid", "midi"):
            note_groups = parse_midi_to_note_groups(source_file.path)
            convert_midi_to_musicxml(source_file.path, musicxml_dest)
            shutil.copy2(source_file.path, midi_path)
            source = "midi"
        elif generated_musicxml:
            note_groups = parse_musicxml_to_note_groups(generated_musicxml)
            generate_midi_from_musicxml(generated_musicxml, midi_path)
            source = "omr"
        else:
            raise HTTPException(status_code=400, detail="当前项目没有可解析的乐谱文件")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    note_groups = [normalize_note_group(g) for g in note_groups]

    score_svc = ScoreService(session)
    await score_svc.save_note_groups(project_id, note_groups)

    project.source_type = source
    project.status = "score_parsed"
    await session.commit()

    return {"status": "ok", "note_groups_count": len(note_groups), "source": source}


@router.get("/projects/{project_id}/playback-timeline")
async def get_playback_timeline(project_id: str, bpm: float = 120.0, session: AsyncSession = Depends(get_session)):
    """Get playback timeline for the frontend player."""
    score_svc = ScoreService(session)
    groups = await score_svc.get_note_groups(project_id)
    if not groups:
        raise HTTPException(status_code=404, detail="未找到乐谱音符，请先解析乐谱")
    timeline = generate_playback_timeline(groups, bpm=bpm)
    return timeline


@router.post("/performances/{performance_id}/analyze")
async def analyze_performance(
    performance_id: str,
    mode: str = Query("mock", pattern="^(mock|real)$"),
    segment_start: float | None = Query(None, ge=0),
    segment_end: float | None = Query(None, ge=0),
    bpm: float = Query(BASE_SCORE_BPM, ge=40, le=240),
    session: AsyncSession = Depends(get_session),
):
    """Run scoring analysis on a performance. mode='mock' or 'real'."""
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="录音不存在")

    score_svc = ScoreService(session)
    note_groups = await score_svc.get_note_groups(perf.project_id)
    if not note_groups:
        raise HTTPException(status_code=400, detail="当前项目没有可分析的乐谱音符")

    if mode == "real":
        selected_groups, segment = _real_analysis_note_groups(note_groups, perf.audio_path, segment_start, segment_end, bpm)
        scoring = generate_real_scoring(perf.audio_path, selected_groups, performance_id)
    else:
        selected_groups, segment = _analysis_note_groups(note_groups, segment_start, segment_end, bpm)
        scoring = generate_mock_scoring(selected_groups, performance_id)

    await _save_scoring_results(session, perf_svc, perf, performance_id, scoring, segment)
    await session.commit()

    return {"status": "analyzed", "total_score": scoring["total_score"], "mode": mode, "segment": segment}


@router.post("/performances/{performance_id}/analyze-async")
async def analyze_performance_async(
    performance_id: str,
    background_tasks: BackgroundTasks,
    mode: str = Query("mock", pattern="^(mock|real)$"),
    segment_start: float | None = Query(None, ge=0),
    segment_end: float | None = Query(None, ge=0),
    bpm: float = Query(BASE_SCORE_BPM, ge=40, le=240),
    session: AsyncSession = Depends(get_session),
):
    """Start async analysis — returns a task_id for progress polling."""
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="录音不存在")

    task_svc = TaskService(session)
    task = await task_svc.create(task_type="analyze", project_id=perf.project_id)

    background_tasks.add_task(_run_analysis_task, task.id, performance_id, perf.project_id, mode, segment_start, segment_end, bpm)

    return {"task_id": task.id, "status": "pending"}


async def _run_analysis_task(
    task_id: str,
    performance_id: str,
    project_id: str,
    mode: str = "mock",
    segment_start: float | None = None,
    segment_end: float | None = None,
    bpm: float | None = None,
):
    """Background task that simulates progress updates via redis."""
    from app.db.session import async_session_factory

    steps = [
        (0.1, "加载音频..."),
        (0.3, "音高检测中..."),
        (0.5, "节奏对齐中..."),
        (0.7, "生成评分..."),
        (0.9, "生成差异报告..."),
    ]

    for progress, message in steps:
        await redis_client.hset(f"task:{task_id}", mapping={"progress": str(progress), "message": message})
        await asyncio.sleep(0.3)

    async with async_session_factory() as session:
        task_svc = TaskService(session)
        score_svc = ScoreService(session)
        perf_svc = PerformanceService(session)

        note_groups = await score_svc.get_note_groups(project_id)
        perf = await perf_svc.get(performance_id)

        if not note_groups or not perf:
            await task_svc.update(task_id, status="failed", progress=1.0, error="缺少分析数据")
            await redis_client.hset(f"task:{task_id}", mapping={"progress": "1.0", "message": "失败"})
            return

        try:
            if mode == "real":
                selected_groups, segment = _real_analysis_note_groups(note_groups, perf.audio_path, segment_start, segment_end, bpm)
                scoring = generate_real_scoring(perf.audio_path, selected_groups, performance_id)
            else:
                selected_groups, segment = _analysis_note_groups(note_groups, segment_start, segment_end, bpm)
                scoring = generate_mock_scoring(selected_groups, performance_id)
        except Exception as exc:
            await task_svc.update(task_id, status="failed", progress=1.0, error=str(exc))
            await redis_client.hset(f"task:{task_id}", mapping={"progress": "1.0", "message": "分析失败"})
            return

        await _save_scoring_results(session, perf_svc, perf, performance_id, scoring, segment)

        await task_svc.update(task_id, status="completed", progress=1.0, message="分析完成")
        await session.commit()

    await redis_client.hset(f"task:{task_id}", mapping={"progress": "1.0", "message": "分析完成"})


@router.get("/tasks/{task_id}/progress")
async def get_task_progress(task_id: str, session: AsyncSession = Depends(get_session)):
    """Get real-time task progress from redis cache."""
    cached = await redis_client.hgetall(f"task:{task_id}")
    if cached:
        task_svc = TaskService(session)
        task = await task_svc.get(task_id)
        status = task.status if task else "unknown"
        return {
            "task_id": task_id,
            "status": status,
            "progress": float(cached.get("progress", 0)),
            "message": cached.get("message", ""),
        }

    task_svc = TaskService(session)
    task = await task_svc.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return TaskResponse(task_id=task.id, status=task.status, progress=task.progress, message=task.message)


@router.get("/performances/{performance_id}/diff")
async def get_performance_diff(performance_id: str, session: AsyncSession = Depends(get_session)):
    """Get diff-style report for a performance."""
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="录音不存在")

    results = await perf_svc.get_results(performance_id)
    if not results:
        raise HTTPException(status_code=400, detail="没有分析结果，请先分析录音")

    score_svc = ScoreService(session)
    note_groups = await score_svc.get_note_groups(perf.project_id)
    result_ids = {result.note_group_id for result in results}
    selected_groups = _selected_original_groups(note_groups, result_ids)
    segment = {
        "start": round(float(perf.segment_start), 4),
        "end": round(float(perf.segment_end), 4),
        "duration": round(float(perf.segment_duration), 4),
        "note_count": int(perf.segment_note_count or 0),
    } if perf.segment_start is not None and perf.segment_end is not None else _infer_segment_from_groups(selected_groups)

    chart_groups = selected_groups
    chart_start = segment["start"]
    chart_end = segment["end"]
    if perf.segment_start is not None and perf.segment_end is not None:
        clipped_groups, original_segment = _segment_note_groups(note_groups, perf.segment_start, perf.segment_end)
        original_duration = max(0.001, float(original_segment["duration"]))
        chart_scale = max(0.001, float(segment["duration"])) / original_duration
        segment["bpm"] = round(BASE_SCORE_BPM / chart_scale, 3)
        chart_groups = _scale_note_group_times(clipped_groups, chart_scale)
        chart_start = 0.0
        chart_end = float(segment["duration"])

    scoring_result = {
        "total_score": perf.total_score,
        "pitch_score": perf.pitch_score,
        "rhythm_score": perf.rhythm_score,
        "completeness_score": perf.completeness_score,
        "stability_score": perf.stability_score,
        "note_results": [
            {
                "note_group_id": r.note_group_id,
                "measure": r.measure,
                "beat": r.beat,
                "pitch_error_cents": r.pitch_error_cents,
                "onset_error_ms": r.onset_error_ms,
                "status": r.status,
                "feedback": r.feedback,
            }
            for r in results
        ],
    }

    diff_report = generate_diff_report(scoring_result)
    diff_report["segment"] = segment
    diff_report["pitch_chart"] = build_pitch_comparison_chart(
        perf.audio_path,
        chart_groups,
        chart_start,
        chart_end,
    )
    return diff_report
