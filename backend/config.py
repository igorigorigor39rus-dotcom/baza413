"""Настройки читаются из окружения или локального .env; секреты не попадают в Git."""
from dataclasses import dataclass
from pathlib import Path
import os

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')


@dataclass(frozen=True)
class Settings:
    bot_token: str = ''
    demo_mode: bool = False
    data_dir: Path = ROOT / 'data'

    @property
    def database(self) -> Path:
        # Демо физически отделено от реальных профилей, территорий и фотографий.
        return self.data_dir / ('demo.sqlite3' if self.demo_mode else 'app.sqlite3')

    @property
    def photos(self) -> Path:
        return self.data_dir / ('demo-photos' if self.demo_mode else 'photos')

    @classmethod
    def from_env(cls):
        return cls(
            bot_token=os.getenv('TELEGRAM_BOT_TOKEN', ''),
            demo_mode=os.getenv('DEMO_MODE', 'false').lower() == 'true',
            data_dir=Path(os.getenv('DATA_DIR', str(ROOT / 'data'))).resolve(),
        )
