"""Собирает только публичные файлы в docs/ для GitHub Pages, без секретов и БД."""
from pathlib import Path
import shutil
import re

ROOT = Path(__file__).resolve().parent.parent


def build():
    source, target = ROOT / 'web', ROOT / 'docs'
    if target.exists():
        shutil.rmtree(target)  # docs — только генерируемая копия web, не документация
    shutil.copytree(source, target)
    # Новые JS-модули не должны смешиваться со старым кешем Telegram WebView.
    version=(ROOT/'VERSION').read_text().strip() if (ROOT/'VERSION').exists() else '0.2.0'
    if not re.fullmatch(r'\d+\.\d+\.\d+',version):
        raise ValueError('Некорректный VERSION')
    for path in [target/'index.html',*target.glob('*.mjs'),*target.glob('*.js')]:
        text=path.read_text()
        text=re.sub(r'''(["'])(\./[^"'\n?]+\.(?:m?js|css|svg))\1''',lambda m:f'{m[1]}{m[2]}?v={version}{m[1]}',text)
        path.write_text(text)
    (target / '.nojekyll').touch()
    assert '/static/' not in (target / 'index.html').read_text()
    assert not any(p.name.startswith('.env') for p in target.rglob('*'))
    print('GitHub Pages: docs/ собран из web/. Секреты и база не включены.')


if __name__ == '__main__': build()
