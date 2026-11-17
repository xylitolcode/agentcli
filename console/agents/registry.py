"""适配器注册表：profile 名 -> Adapter 实例。

profile 白名单仍由 ``settings.CONSOLE_PROFILES`` 管（能不能拉起进程）；
这里只负责把 profile 映射到对应的解析适配器。未登记的 profile 回退到
空适配器（直通、不解析）。
"""

from __future__ import annotations

from django.conf import settings

from .base import Adapter, Event
from .claude import ClaudeAdapter
from .codex import CodexAdapter
from .qwen import QwenAdapter
from .shell import ShellAdapter
from .stub import StubAdapter

_REGISTRY: dict[str, Adapter] = {}


def _build() -> dict[str, Adapter]:
    adapters: dict[str, Adapter] = {
        "bash": ShellAdapter(),
        "claude": ClaudeAdapter(),
        "codex": CodexAdapter(),
        "qwen": QwenAdapter(),
        "stub": StubAdapter(),
    }
    return adapters


def _ensure() -> None:
    if not _REGISTRY:
        _REGISTRY.update(_build())


def get_adapter(profile: str) -> Adapter:
    _ensure()
    return _REGISTRY.get(profile, Adapter())


def shell_profile() -> str:
    return settings.CONSOLE_SHELL_PROFILE


def list_adapters() -> list[dict[str, str]]:
    """给前端的能力清单：分类 + 标签。"""
    _ensure()
    out: list[dict[str, str]] = []
    for name in settings.CONSOLE_PROFILES:
        adapter = _REGISTRY.get(name)
        out.append(
            {
                "name": name,
                "kind": adapter.kind if adapter else "shell",
                "label": adapter.label if adapter else name,
            }
        )
    return out
