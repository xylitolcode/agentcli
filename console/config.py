"""配置读取层 —— 业务代码统一从这里取运行时配置。

数据库是运行时真相源；表不存在 / DB 未就绪 / 记录缺失时退回 settings 常量或模型默认值。
这样 ``manage.py migrate``、管理命令、迁移前环境都不会炸。

**同步 / 异步两套接口**：Django 不允许在 async 上下文里直接查 ORM。会话与委派
大多跑在事件循环里，所以提供 ``*_async()`` 版本（内部用 sync_to_async 线程执行查询），
异步调用方必须 ``await``。同步调用方用不带后缀的版本。

不要在模块 import 期调用（结果会固化），要在每次请求/任务里现取。
将来若加缓存，只改这一层。
"""

from __future__ import annotations

from asgiref.sync import sync_to_async
from django.conf import settings
from django.db.utils import DatabaseError

from .models import DelegateConfig, Profile, RuntimeLimit

# 与 settings / 模型默认值对齐的兜底；DB 不可用时用这些
_DEFAULTS = {
    "timeout": 120.0,
    "max_chain": 4,
    "output_limit": 256 * 1024,
    "tree_limit": 400,
    "file_limit": 512 * 1024,
    "replay_limit": 256 * 1024,
}


def _fallback_delegate() -> DelegateConfig:
    return DelegateConfig(
        pk=1,
        timeout=float(getattr(settings, "CONSOLE_DELEGATE_TIMEOUT", _DEFAULTS["timeout"])),
        max_chain=int(getattr(settings, "CONSOLE_DELEGATE_MAX_CHAIN", _DEFAULTS["max_chain"])),
        output_limit=int(
            getattr(settings, "CONSOLE_DELEGATE_OUTPUT_LIMIT", _DEFAULTS["output_limit"])
        ),
        prompt=getattr(settings, "CONSOLE_DELEGATE_PROMPT", "")
        or DelegateConfig._meta.get_field("prompt").default,
    )


def _fallback_runtime() -> RuntimeLimit:
    return RuntimeLimit(
        pk=1,
        tree_limit=int(getattr(settings, "CONSOLE_TREE_LIMIT", _DEFAULTS["tree_limit"])),
        file_limit=int(getattr(settings, "CONSOLE_FILE_LIMIT", _DEFAULTS["file_limit"])),
        replay_limit=_DEFAULTS["replay_limit"],
    )


def _safe(fn):
    """DB 不可用时吞掉异常，调用方走 fallback。"""
    try:
        return fn()
    except DatabaseError:
        return None


# ---- 同步接口（HTTP 视图、管理命令、普通函数） ----

def delegate_config() -> DelegateConfig:
    return _safe(lambda: DelegateConfig.objects.filter(pk=1).first()) or _fallback_delegate()


def runtime_limit() -> RuntimeLimit:
    return _safe(lambda: RuntimeLimit.objects.filter(pk=1).first()) or _fallback_runtime()


def profile_rows() -> list[Profile]:
    rows = _safe(lambda: list(Profile.objects.all()))
    return rows or []


def active_profiles() -> dict[str, Profile]:
    """启用的 profile 行。要区分「没这行」和「被禁用」请用 profile_rows()。"""
    return {p.name: p for p in profile_rows() if p.enabled}


def default_profile() -> str:
    rows = profile_rows()
    for p in rows:
        if p.is_default and p.enabled:
            return p.name
    fallback = getattr(settings, "CONSOLE_DEFAULT_PROFILE", "bash")
    enabled = {p.name for p in rows if p.enabled}
    if enabled and fallback not in enabled:
        return next(iter(sorted(enabled)))
    return fallback


# ---- 异步接口（事件循环里的会话 / 委派） ----

async def delegate_config_async() -> DelegateConfig:
    obj = await sync_to_async(lambda: DelegateConfig.objects.filter(pk=1).first())()
    return obj or _fallback_delegate()


async def runtime_limit_async() -> RuntimeLimit:
    obj = await sync_to_async(lambda: RuntimeLimit.objects.filter(pk=1).first())()
    return obj or _fallback_runtime()
