from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "ScoreDiff"
    data_dir: Path = Path(__file__).resolve().parent.parent.parent / "data"
    database_url: str = ""

    def model_post_init(self, __context):
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'scorediff.db'}"
        self.data_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
