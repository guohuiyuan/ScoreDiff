import asyncio
import json
import shutil
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
    ScoreConvertResponse,
    ScoreFileResponse,
    ScoreResponse,
    ScoreUpdateRequest,
    TaskResponse,
)
from app.services.audio_conversion_service import (
    AudioConversionError,
    convert_audio_to_midi,
    convert_midi_to_mp3,
)
from app.services.diff_service import generate_diff_report
from app.services.omr_service import OMRService
from app.services.playback_service import generate_playback_timeline
from app.services.recording_service import RecordingService
from app.services.score_parser import (
    convert_midi_to_musicxml,
    export_note_groups_to_musicxml,
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

ALLOWED_SCORE_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".musicxml", ".xml", ".mid", ".midi", ".mp3"}


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


def _latest_score_file(files, file_types: set[str]):
    candidates = [f for f in files if f.file_type in file_types]
    if not candidates:
        return None
    return max(candidates, key=lambda f: f.created_at)


@router.post("/projects", response_model=ProjectResponse)
async def create_project(body: ProjectCreate, session: AsyncSession = Depends(get_session)):
    svc = ProjectService(session)
    project = await svc.create(title=body.title, instrument=body.instrument)
    return ProjectResponse(
        id=project.id,
        title=project.title,
        instrument=project.instrument,
        source_type=project.source_type,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(session: AsyncSession = Depends(get_session)):
    svc = ProjectService(session)
    projects = await svc.list_all()
    return [
        ProjectResponse(
            id=p.id,
            title=p.title,
            instrument=p.instrument,
            source_type=p.source_type,
            status=p.status,
            created_at=p.created_at,
            updated_at=p.updated_at,
        )
        for p in projects
    ]


@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: str, session: AsyncSession = Depends(get_session)):
    svc = ProjectService(session)
    project = await svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectResponse(
        id=project.id,
        title=project.title,
        instrument=project.instrument,
        source_type=project.source_type,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.post("/projects/{project_id}/score-file", response_model=ScoreFileResponse)
async def upload_score_file(project_id: str, file: UploadFile, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    safe_filename = Path(file.filename or "score").name
    suffix = Path(safe_filename).suffix.lower()
    if suffix not in ALLOWED_SCORE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    upload_dir = settings.data_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / f"{project_id}_{safe_filename}"
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
        raise HTTPException(status_code=404, detail="Project not found")

    file_svc = FileService(session)
    files = await file_svc.get_by_project(project_id)
    image_file = next(
        (f for f in files if f.file_type in ("pdf", "png", "jpg", "jpeg", "webp")), None
    )
    if not image_file:
        raise HTTPException(status_code=400, detail="No image/PDF file found for this project")

    omr_svc = OMRService()
    result = omr_svc.convert_image_to_musicxml(image_file.path, project_id)

    if result["status"] == "success":
        await proj_svc.update_status(project_id, "omr_complete")

    return result


@router.get("/projects/{project_id}/score", response_model=ScoreResponse)
async def get_score(project_id: str, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    score_svc = ScoreService(session)
    groups = await score_svc.get_note_groups(project_id)

    urls = _score_urls(project_id)

    return ScoreResponse(
        project_id=project_id,
        musicxml_url=urls["musicxml"],
        midi_url=urls["midi"],
        mp3_url=urls["mp3"],
        note_groups=[NoteGroupOut(**g) for g in groups],
    )


@router.put("/projects/{project_id}/score", response_model=ScoreResponse)
async def update_score(project_id: str, body: ScoreUpdateRequest, session: AsyncSession = Depends(get_session)):
    """Persist edited note_groups and regenerate MusicXML/MIDI."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    note_groups = [normalize_note_group(g.model_dump()) for g in body.note_groups]
    if not note_groups:
        raise HTTPException(status_code=400, detail="Score must contain at least one note or rest")

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

    if paths["mp3"].exists():
        try:
            convert_midi_to_mp3(paths["midi"], paths["mp3"])
        except AudioConversionError:
            paths["mp3"].unlink(missing_ok=True)

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
        note_groups=[NoteGroupOut(**g) for g in groups],
    )


@router.post("/projects/{project_id}/convert", response_model=ScoreConvertResponse)
async def convert_score_media(
    project_id: str,
    target: str = Query(pattern="^(midi|mp3)$"),
    session: AsyncSession = Depends(get_session),
):
    """Convert project score media between MIDI and MP3."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    paths = _score_paths(project_id)
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)

    file_svc = FileService(session)
    files = await file_svc.get_by_project(project_id)
    source = "existing"

    try:
        if target == "midi":
            if not paths["midi"].exists():
                musicxml_file = _latest_score_file(files, {"musicxml", "xml"})
                midi_file = _latest_score_file(files, {"mid", "midi"})
                mp3_file = _latest_score_file(files, {"mp3"})

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
                elif mp3_file:
                    convert_audio_to_midi(mp3_file.path, paths["midi"])
                    convert_midi_to_musicxml(paths["midi"], paths["musicxml"])
                    groups = [normalize_note_group(g) for g in parse_midi_to_note_groups(paths["midi"])]
                    await ScoreService(session).save_note_groups(project_id, groups)
                    source = "mp3"
                else:
                    raise HTTPException(status_code=400, detail="No convertible MusicXML, MIDI, or MP3 file found")
            else:
                source = "midi"
        else:
            if not paths["midi"].exists():
                if paths["musicxml"].exists():
                    generate_midi_from_musicxml(paths["musicxml"], paths["midi"])
                    source = "musicxml"
                else:
                    midi_file = _latest_score_file(files, {"mid", "midi"})
                    musicxml_file = _latest_score_file(files, {"musicxml", "xml"})
                    mp3_file = _latest_score_file(files, {"mp3"})
                    if midi_file:
                        shutil.copy2(midi_file.path, paths["midi"])
                        source = "midi"
                    elif musicxml_file:
                        generate_midi_from_musicxml(musicxml_file.path, paths["midi"])
                        shutil.copy2(musicxml_file.path, paths["musicxml"])
                        source = "musicxml"
                    elif mp3_file:
                        convert_audio_to_midi(mp3_file.path, paths["midi"])
                        convert_midi_to_musicxml(paths["midi"], paths["musicxml"])
                        source = "mp3"
                    else:
                        raise HTTPException(status_code=400, detail="No convertible MusicXML, MIDI, or MP3 file found")
            convert_midi_to_mp3(paths["midi"], paths["mp3"])
    except AudioConversionError as exc:
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
        raise HTTPException(status_code=404, detail="Project not found")

    rec_svc = RecordingService()
    filename = file.filename or "recording.wav"
    if not rec_svc.validate_extension(filename):
        raise HTTPException(status_code=400, detail=f"Unsupported audio format: {Path(filename).suffix}")

    dest = rec_svc.save_upload(project_id, filename, file.file)

    perf_svc = PerformanceService(session)
    perf = await perf_svc.create(project_id=project_id, audio_path=str(dest))
    return PerformanceResponse(performance_id=perf.id, status="uploaded")


@router.get("/projects/{project_id}/recordings")
async def list_recordings(project_id: str, session: AsyncSession = Depends(get_session)):
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

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
        raise HTTPException(status_code=404, detail="Performance not found")

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
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(task_id=task.id, status=task.status, progress=task.progress, message=task.message)


@router.post("/projects/{project_id}/parse-score")
async def parse_score(project_id: str, session: AsyncSession = Depends(get_session)):
    """Parse uploaded MusicXML, MIDI, or MP3 into note_groups."""
    proj_svc = ProjectService(session)
    project = await proj_svc.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    file_svc = FileService(session)
    files = await file_svc.get_by_project(project_id)

    source_file = _latest_score_file(files, {"musicxml", "xml", "mid", "midi", "mp3"})
    paths = _score_paths(project_id)
    musicxml_dest = paths["musicxml"]
    midi_path = paths["midi"]
    musicxml_dest.parent.mkdir(parents=True, exist_ok=True)
    midi_path.parent.mkdir(parents=True, exist_ok=True)

    generated_musicxml = musicxml_dest if musicxml_dest.exists() else None
    if not source_file and not generated_musicxml:
        raise HTTPException(status_code=400, detail="No MusicXML, MIDI, or MP3 file found for this project")

    try:
        if source_file and source_file.file_type in ("musicxml", "xml"):
            note_groups = parse_musicxml_to_note_groups(source_file.path)
            generate_midi_from_musicxml(source_file.path, midi_path)
            shutil.copy2(source_file.path, musicxml_dest)
            source = "musicxml"
        elif source_file and source_file.file_type in ("mid", "midi"):
            note_groups = parse_midi_to_note_groups(source_file.path)
            convert_midi_to_musicxml(source_file.path, musicxml_dest)
            shutil.copy2(source_file.path, midi_path)
            source = "midi"
        elif source_file and source_file.file_type == "mp3":
            convert_audio_to_midi(source_file.path, midi_path)
            note_groups = parse_midi_to_note_groups(midi_path)
            convert_midi_to_musicxml(midi_path, musicxml_dest)
            source = "mp3"
        else:
            note_groups = parse_musicxml_to_note_groups(generated_musicxml)
            generate_midi_from_musicxml(generated_musicxml, midi_path)
            source = "omr"
    except AudioConversionError as exc:
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
        raise HTTPException(status_code=404, detail="No note_groups found. Parse score first.")
    timeline = generate_playback_timeline(groups, bpm=bpm)
    return timeline


@router.post("/performances/{performance_id}/analyze")
async def analyze_performance(performance_id: str, mode: str = "mock", session: AsyncSession = Depends(get_session)):
    """Run scoring analysis on a performance. mode='mock' or 'real'."""
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="Performance not found")

    score_svc = ScoreService(session)
    note_groups = await score_svc.get_note_groups(perf.project_id)
    if not note_groups:
        raise HTTPException(status_code=400, detail="No note_groups found for this project")

    if mode == "real":
        scoring = generate_real_scoring(perf.audio_path, note_groups, performance_id)
    else:
        scoring = generate_mock_scoring(note_groups, performance_id)

    perf.total_score = scoring["total_score"]
    perf.pitch_score = scoring["pitch_score"]
    perf.rhythm_score = scoring["rhythm_score"]
    perf.completeness_score = scoring["completeness_score"]
    perf.stability_score = scoring["stability_score"]
    perf.status = "analyzed"

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

    await session.commit()

    return {"status": "analyzed", "total_score": scoring["total_score"], "mode": mode}


@router.post("/performances/{performance_id}/analyze-async")
async def analyze_performance_async(
    performance_id: str,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
):
    """Start async analysis — returns a task_id for progress polling."""
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="Performance not found")

    task_svc = TaskService(session)
    task = await task_svc.create(task_type="analyze", project_id=perf.project_id)

    background_tasks.add_task(_run_analysis_task, task.id, performance_id, perf.project_id)

    return {"task_id": task.id, "status": "pending"}


async def _run_analysis_task(task_id: str, performance_id: str, project_id: str):
    """Background task that simulates progress updates via redis."""
    from app.db.session import async_session_factory

    steps = [
        (0.1, "加载音频..."),
        (0.3, "音高检测中..."),
        (0.5, "节奏对齐中..."),
        (0.7, "生成评分..."),
        (0.9, "生成 Diff 报告..."),
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
            await task_svc.update(task_id, status="failed", progress=1.0, error="Missing data")
            await redis_client.hset(f"task:{task_id}", mapping={"progress": "1.0", "message": "失败"})
            return

        scoring = generate_mock_scoring(note_groups, performance_id)

        perf.total_score = scoring["total_score"]
        perf.pitch_score = scoring["pitch_score"]
        perf.rhythm_score = scoring["rhythm_score"]
        perf.completeness_score = scoring["completeness_score"]
        perf.stability_score = scoring["stability_score"]
        perf.status = "analyzed"

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
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(task_id=task.id, status=task.status, progress=task.progress, message=task.message)


@router.get("/performances/{performance_id}/diff")
async def get_performance_diff(performance_id: str, session: AsyncSession = Depends(get_session)):
    """Get diff-style report for a performance."""
    perf_svc = PerformanceService(session)
    perf = await perf_svc.get(performance_id)
    if not perf:
        raise HTTPException(status_code=404, detail="Performance not found")

    results = await perf_svc.get_results(performance_id)
    if not results:
        raise HTTPException(status_code=400, detail="No analysis results. Run analyze first.")

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
    return diff_report
