"""读 Vite 的构建清单，把带 hash 的资源名交给模板。

为什么要有这层：Vite 给产物文件名带 content hash（`main-a1b2c3.js`），模板不能
写死。manifest.json 是它给出的映射表，这里只负责查表 + 带 mtime 的缓存。

改了前端记得 `npm run build`，不然页面还用旧产物。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from django.conf import settings

MANIFEST_RELATIVE = Path("dist") / ".vite" / "manifest.json"


def dist_dir() -> Path:
    return Path(settings.STATICFILES_DIRS[0])


def manifest_path() -> Path:
    return dist_dir() / MANIFEST_RELATIVE


@lru_cache(maxsize=4)
def _read_manifest(mtime: float) -> dict:
    """mtime 参与缓存键 —— 重新构建后文件变了，缓存自然失效。"""
    del mtime
    try:
        return json.loads(manifest_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _manifest() -> dict:
    path = manifest_path()
    if not path.exists():
        return {}
    return _read_manifest(path.stat().st_mtime)


def entry_assets() -> dict[str, object]:
    """返回 {'js': 'dist/assets/main-xxx.js', 'css': [...]}，没构建过则 js 为 None。"""
    manifest = _manifest()
    entry = next((item for item in manifest.values() if item.get("isEntry")), None)
    if not entry:
        return {"js": None, "css": []}

    return {
        "js": f"dist/{entry['file']}",
        "css": [f"dist/{href}" for href in entry.get("css", [])],
    }
