import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import NoteGroup, NoteResult, Performance, Project, ScoreFile, Task


class ProjectService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, title: str, instrument: str = "violin") -> Project:
        project = Project(title=title, instrument=instrument)
        self.session.add(project)
        await self.session.commit()
        await self.session.refresh(project)
        return project

    async def list_all(self) -> list[Project]:
        result = await self.session.execute(select(Project).order_by(Project.created_at.desc()))
        return list(result.scalars().all())

    async def get(self, project_id: str) -> Optional[Project]:
        return await self.session.get(Project, project_id)

    async def delete(self, project_id: str) -> bool:
        project = await self.get(project_id)
        if not project:
            return False

        result = await self.session.execute(select(Performance.id).where(Performance.project_id == project_id))
        performance_ids = list(result.scalars().all())
        if performance_ids:
            await self.session.execute(delete(NoteResult).where(NoteResult.performance_id.in_(performance_ids)))

        await self.session.execute(delete(Performance).where(Performance.project_id == project_id))
        await self.session.execute(delete(NoteGroup).where(NoteGroup.project_id == project_id))
        await self.session.execute(delete(ScoreFile).where(ScoreFile.project_id == project_id))
        await self.session.execute(delete(Task).where(Task.project_id == project_id))
        await self.session.delete(project)
        await self.session.commit()
        return True

    async def update_status(self, project_id: str, status: str):
        project = await self.get(project_id)
        if project:
            project.status = status
            project.updated_at = datetime.now(timezone.utc).isoformat()
            await self.session.commit()

    async def update_instrument(self, project_id: str, instrument: str) -> Optional[Project]:
        project = await self.get(project_id)
        if not project:
            return None
        project.instrument = instrument
        project.updated_at = datetime.now(timezone.utc).isoformat()
        await self.session.commit()
        await self.session.refresh(project)
        return project


class FileService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create_score_file(self, project_id: str, file_type: str, path: str, page_count: int = 0) -> ScoreFile:
        sf = ScoreFile(project_id=project_id, file_type=file_type, path=path, page_count=page_count)
        self.session.add(sf)
        await self.session.commit()
        await self.session.refresh(sf)
        return sf

    async def get_by_project(self, project_id: str) -> list[ScoreFile]:
        result = await self.session.execute(select(ScoreFile).where(ScoreFile.project_id == project_id))
        return list(result.scalars().all())


class TaskService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, task_type: str, project_id: Optional[str] = None) -> Task:
        task = Task(task_type=task_type, project_id=project_id)
        self.session.add(task)
        await self.session.commit()
        await self.session.refresh(task)
        return task

    async def get(self, task_id: str) -> Optional[Task]:
        return await self.session.get(Task, task_id)

    async def update(self, task_id: str, **kwargs):
        task = await self.get(task_id)
        if not task:
            return
        for k, v in kwargs.items():
            setattr(task, k, v)
        task.updated_at = datetime.now(timezone.utc).isoformat()
        await self.session.commit()


class ScoreService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_note_groups(self, project_id: str) -> list[dict]:
        result = await self.session.execute(select(NoteGroup).where(NoteGroup.project_id == project_id).order_by(NoteGroup.start_time))
        groups = result.scalars().all()
        return [
            {
                "note_group_id": g.id,
                "measure": g.measure,
                "beat": g.beat,
                "start": g.start_time,
                "end": g.end_time,
                "target_pitches": json.loads(g.target_pitches_json),
                "target_names": json.loads(g.target_names_json),
                "type": g.note_type,
            }
            for g in groups
        ]

    async def save_note_groups(self, project_id: str, groups: list[dict]):
        await self.session.execute(delete(NoteGroup).where(NoteGroup.project_id == project_id))
        for g in groups:
            ng = NoteGroup(
                project_id=project_id,
                measure=g["measure"],
                beat=g["beat"],
                start_time=g["start"],
                end_time=g["end"],
                target_pitches_json=json.dumps(g["target_pitches"]),
                target_names_json=json.dumps(g["target_names"]),
                note_type=g["type"],
            )
            self.session.add(ng)
        await self.session.commit()


class PerformanceService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, project_id: str, audio_path: str) -> Performance:
        perf = Performance(project_id=project_id, audio_path=audio_path)
        self.session.add(perf)
        await self.session.commit()
        await self.session.refresh(perf)
        return perf

    async def get(self, performance_id: str) -> Optional[Performance]:
        return await self.session.get(Performance, performance_id)

    async def get_results(self, performance_id: str) -> list[NoteResult]:
        result = await self.session.execute(
            select(NoteResult).where(NoteResult.performance_id == performance_id).order_by(NoteResult.measure, NoteResult.beat)
        )
        return list(result.scalars().all())
