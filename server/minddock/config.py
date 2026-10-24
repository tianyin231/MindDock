"""运行配置，从环境变量（前缀 MINDDOCK_）和 .env 读取。

这里只放部署层面的配置；QQ 机器人、AI、网盘、邮件等业务设置在面板里填写，见 settings_store。
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MINDDOCK_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    data_dir: Path = SERVER_ROOT / "data"
    tz: str = "Asia/Shanghai"

    panel_host: str = "127.0.0.1"
    panel_port: int = 8080
    # 前端构建产物目录；不存在时面板只提供接口
    web_dist_dir: Path = SERVER_ROOT.parent / "web" / "dist"

    # 面板设置中密钥字段的加密主密钥（base64 编码的 32 字节）。
    # 生产环境由 install.sh 生成并写入 .env；为空时在 data_dir 下自动生成，仅供开发使用。
    secret_key: str = ""
    # 本地开发走 http 时设为 false，否则浏览器不会回传登录 Cookie
    cookie_secure: bool = True
    public_url: str = ""

    openlist_url: str = "http://openlist:5244"
    openlist_admin_password: str = ""
    # 原件上传夸克后在本地保留的天数；磁盘可用空间低于 min_free_ratio 时提前清理最旧的
    staging_keep_days: int = 7
    min_free_ratio: float = 0.2

    # 由镜像构建时写入
    version: str = "dev"
    commit: str = ""

    @property
    def db_path(self) -> Path:
        return self.data_dir / "minddock.db"


@lru_cache
def get_settings() -> Settings:
    return Settings()
