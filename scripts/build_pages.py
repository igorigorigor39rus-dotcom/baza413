"""Собирает только публичные файлы в docs/ для GitHub Pages, без секретов и БД."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent


def build():
    source, target = ROOT / 'web', ROOT / 'docs'
    if target.exists():
        shutil.rmtree(target)  # docs — только генерируемая копия web, не документация
    shutil.copytree(source, target)
    (target / '.nojekyll').touch()
    assert '/static/' not in (target / 'index.html').read_text()
    assert not any(p.name.startswith('.env') for p in target.rglob('*'))
    print('GitHub Pages: docs/ собран из web/. Секреты и база не включены.')


if __name__ == '__main__': build()
