"""控制台视图：页面入口 + 命令接口 + 目录树接口。"""

from __future__ import annotations

import json

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_POST

from . import agent, delegation, files, projects, sessions, terminal, vite


@ensure_csrf_cookie
def index(request):
    """渲染前端挂载页。

    页面本身几乎空的 —— 真正的界面在 `frontend/`，由 Vite 构建进 `static/dist/`。
    这里只负责注入启动数据和带 content hash 的资源路径。

    WebSocket 不走 CSRF，但 ``/api/command/`` 走，所以还是要种 csrftoken。
    """
    root = files.root()
    profiles = terminal.available_profiles()
    default = settings.CONSOLE_DEFAULT_PROFILE
    if profiles and not any(p["name"] == default for p in profiles):
        default = profiles[0]["name"]

    # 前端把 project id 当字符串在 URL 里传，这里统一成 str，免得上游给的是 int
    project_list = [{**item, "id": str(item["id"])} for item in projects.list_projects()]

    return render(
        request,
        "console/index.html",
        {
            "bootstrap": {
                "rootPath": str(root),
                "rootName": root.name,
                "profiles": profiles,
                "projects": project_list,
                "defaultProfile": default,
            },
            "vite": vite.entry_assets(),
        },
    )


def tree(request):
    """返回一层目录内容，右侧文件面板展开时按需调用。

    带 ``project`` 参数时边界收窄到该项目根；不带则在总项目目录下浏览。
    """
    rel = request.GET.get("path", "")
    project_id = request.GET.get("project", "") or None
    try:
        payload = files.list_dir(rel, project_id)
    except files.PathOutsideRoot:
        return JsonResponse({"ok": False, "error": "路径越界，拒绝访问"}, status=403)
    except files.PathNotFound:
        return JsonResponse({"ok": False, "error": "目录不存在或不可读"}, status=404)
    payload["ok"] = True
    return JsonResponse(payload)


def projects_list(request):
    """返回 Django 维护的项目清单（供前端选择入口）。"""
    return JsonResponse({"ok": True, "projects": projects.list_projects()})


def sessions_list(request):
    """返回当前进程内活跃会话快照（供多标签/父子面板展示）。

    会话是进程内单例，这个接口只反映本进程；多 worker 下需要换成共享存储。
    """
    items = []
    for s in sessions.registry.all():
        rt = s.runtime
        items.append({
            "sid": s.sid,
            "profile": rt.profile,
            "role": rt.role,
            "parent": rt.parent_sid or "",
            "label": rt.label,
            "depth": rt.depth,
            "delegation": rt.delegation_id,
            "cwd": rt.cwd,
            "eof": rt.eof,
            "pinned": rt.pinned,
            "watchers": len(rt.watchers),
            "busy": rt.is_busy(),
            "busy_kind": rt.busy_kind,
            "outsourcing": rt.outsourcing,
        })
    return JsonResponse({"ok": True, "sessions": items})


def delegations_list(request):
    """返回委派任务台账快照（供面板展示派发/回执状态）。"""
    items = delegation.all_tasks()
    parent = request.GET.get("parent", "")
    if parent:
        items = [t for t in items if t["parent_sid"] == parent]
    return JsonResponse({"ok": True, "delegations": items})


@require_POST
def command(request):
    """接收一条命令，交给执行层，返回结构化结果。

    走的是 ``agent.execute`` 那套「一问一答」契约，不经过 PTY。真终端在
    ``/ws/terminal`` 上，这个接口留着做降级和自动化调用。
    """
    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return JsonResponse(
            {"ok": False, "lines": [{"level": "error", "text": "请求体不是合法 JSON"}]},
            status=400,
        )

    raw = payload.get("command", "")
    if not isinstance(raw, str):
        return JsonResponse(
            {"ok": False, "lines": [{"level": "error", "text": "command 必须是字符串"}]},
            status=400,
        )

    if len(raw) > 4096:
        return JsonResponse(
            {"ok": False, "lines": [{"level": "error", "text": "命令过长（上限 4096 字符）"}]},
            status=400,
        )

    return JsonResponse(agent.execute(raw))
