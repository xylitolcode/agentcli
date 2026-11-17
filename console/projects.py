"""项目台账的播种与查询。

项目清单以 ``Project`` 表为准。首次启动（或表里还没有记录）时，扫描
``CONSOLE_PROJECTS_ROOT`` 下的一级目录，把像项目的目录登记进去；之后增删
走 Django admin / 后续接口，不每次重扫覆盖手工改动。
"""

from __future__ import annotations

import logging
from pathlib import Path

from django.conf import settings

from .models import Project

logger = logging.getLogger(__name__)

# 识别一个目录像不像项目：命中任一标记文件/目录即算。
PROJECT_MARKERS = {
    ".git",
    "manage.py",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "README.md",
}


def projects_root() -> Path:
    return Path(settings.CONSOLE_PROJECTS_ROOT).resolve()


def project_path(project: Project) -> Path:
    """项目相对路径 -> 总目录下的绝对路径（不做越界校验，校验在 files 层）。"""
    return (projects_root() / project.path).resolve()


def project_path_dict(project: dict) -> Path:
    """快照 dict 版本的 project_path。"""
    return (projects_root() / project["path"]).resolve()


def seed_from_disk() -> int:
    """把总目录下尚未登记的项目目录补进台账。返回新增条数。

    已存在的记录不动（保留手工改过的 agent / note）。
    """
    root = projects_root()
    if not root.is_dir():
        logger.warning("项目总目录不存在：%s", root)
        return 0

    existing = {p.path for p in Project.objects.all()}
    added = 0
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if not _looks_like_project(entry):
            continue
        rel = entry.name
        if rel in existing:
            continue
        Project.objects.create(
            name=entry.name,
            path=rel,
            agent=settings.CONSOLE_SHELL_PROFILE,
            note="扫描播种",
        )
        added += 1
        logger.info("播种项目：%s", rel)
    return added


def _looks_like_project(path: Path) -> bool:
    try:
        return any((path / marker).exists() for marker in PROJECT_MARKERS)
    except OSError:
        return False


def get_project(project_id: str | int):
    """按 id 取启用项目，取不到返回 None。"""
    try:
        return Project.objects.get(pk=project_id, enabled=True)
    except (Project.DoesNotExist, ValueError, TypeError):
        return None


def _project_dict(project) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "path": project.path,
        "agent": project.agent,
    }


async def get_project_async(project_id: str | int) -> dict | None:
    """WS 协程里取项目：ORM 查询丢到同步线程，返回纯内存 dict。"""
    from asgiref.sync import sync_to_async

    project = await sync_to_async(get_project)(project_id)
    return _project_dict(project) if project else None


def list_projects() -> list[dict]:
    """给前端的项目清单。"""
    items = []
    for p in Project.objects.filter(enabled=True).order_by("name"):
        items.append(
            {
                "id": p.id,
                "name": p.name,
                "path": p.path,
                "agent": p.agent,
                "note": p.note,
                "exists": project_path(p).is_dir(),
            }
        )
    return items
