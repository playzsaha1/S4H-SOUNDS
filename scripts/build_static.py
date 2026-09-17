"""Publish only browser assets, not server source, fixtures or local data."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'public'
out.mkdir(exist_ok=True)
for name in ('index.html', 'styles.css', 'app.js', 'encoder-worker.js'):
    shutil.copyfile(root / name, out / name)
