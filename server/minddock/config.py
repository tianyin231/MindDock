"""运行配置，从环境变量和 .env 读取。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    data_dir: Path = SERVER_ROOT / "data"
    tz: str = "Asia/Shanghai"

    panel_host: str = "127.0.0.1"
    panel_port: int = 8080
    # 前端构建产物目录；不存在时面板只提供接口
    web_dist_dir: Path = SERVER_ROOT.parent / "web" / "dist"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "minddock.db"


@lru_cache
def get_settings() -> Settings:
    return Settings()
