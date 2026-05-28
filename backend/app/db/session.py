from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from sqlmodel import SQLModel

from app.core.config import settings

db_url = settings.database_url.replace("sqlite:///", "sqlite+aiosqlite:///")
engine = create_async_engine(db_url, echo=False)
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@asynccontextmanager
async def async_session_factory():
    async with async_session() as session:
        yield session


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        if engine.url.get_backend_name().startswith("sqlite"):
            rows = await conn.execute(text("PRAGMA table_info(performances)"))
            existing = {row[1] for row in rows}
            columns = {
                "segment_start": "FLOAT",
                "segment_end": "FLOAT",
                "segment_duration": "FLOAT",
                "segment_note_count": "INTEGER",
            }
            for name, column_type in columns.items():
                if name not in existing:
                    await conn.execute(text(f"ALTER TABLE performances ADD COLUMN {name} {column_type}"))


async def get_session() -> AsyncSession:
    async with async_session() as session:
        yield session
