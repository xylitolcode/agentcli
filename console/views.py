"""控制台视图：页面入口 + 命令接口 + 目录树接口。"""

from __future__ import annotations

import json

from asgiref.sync import sync_to_async
from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_POST

from . import agent, bridge, delegation, files, projects, sessions, terminal, vite


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
            "kind": rt.kind,
            "mode": rt.mode,
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


@csrf_exempt
async def delegate_api(request):
    """MCP 工具 ``delegate_task`` 的回调端点（只给本机 agent 进程用）。

    交互式 agent 的 stdout 是 ANSI，底座拿不到 ``tool_use Task``，所以外包由
    agent 主动调 MCP 工具；MCP server 再把调用 POST 回这里，在进程内走同一条
    ``delegation.dispatch``（建槽、忙锁、台账、回执）。
    """
    if request.method != "POST":
        return JsonResponse({"ok": False, "error": "只接受 POST"}, status=405)
    if request.headers.get("X-Agentcli-Token", "") != bridge.TOKEN:
        return JsonResponse({"ok": False, "error": "token 不匹配"}, status=403)

    try:
        payload = json.loads(await sync_to_async(lambda: request.body or b"{}")())
    except json.JSONDecodeError:
        return JsonResponse({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    sid = str(payload.get("sid") or "")
    prompt = str(payload.get("prompt") or "").strip()
    target = str(payload.get("target") or "").strip() or None
    if not sid or not prompt:
        return JsonResponse({"ok": False, "error": "sid / prompt 不能为空"}, status=400)
    if len(prompt) > terminal.PROMPT_LIMIT:
        return JsonResponse({"ok": False, "error": "任务描述过长"}, status=400)

    parent = await sessions.registry.get(sid)
    if parent is None:
        return JsonResponse({"ok": False, "error": "父会话已回收"}, status=404)
    if not parent.runtime.outsourcing:
        return JsonResponse(
            {"ok": False, "error": "外包模式未开启：请用户在控制台打开后再调用"},
            status=403,
        )

    task = await delegation.dispatch(
        parent,
        {"tool": "Task", "target": target, "text": prompt, "raw": {}},
        profile=parent.runtime.profile,
        cwd=parent.runtime.cwd,
    )
    if task is None:
        return JsonResponse({"ok": False, "error": "目标不是可用的 agent"}, status=400)

    try:
        timeout = int(payload.get("timeout") or delegation.DELEGATE_TIMEOUT)
    except (TypeError, ValueError):
        timeout = delegation.DELEGATE_TIMEOUT
    timeout = max(5, min(timeout, 300))
    await delegation.wait_task(task, timeout=timeout)
    if task.status != "done":
        return JsonResponse(
            {"ok": False, "error": task.error or f"任务未收口（{task.status}）",
             "delegation_id": task.id, "child_sid": task.child_sid},
            status=502,
        )
    return JsonResponse({
        "ok": True,
        "delegation_id": task.id,
        "child_sid": task.child_sid,
        "profile": task.profile,
        "reply": task.reply,
    })


# 工具名 -> (取路径的字段, 动作)。claude 的 hook 输入里 Read/Write/Edit 都有
# file_path；NotebookEdit 用 notebook_path。
_HOOK_TOOLS = {
    "Read": ("file_path", "read"),
    "Write": ("file_path", "write"),
    "Edit": ("file_path", "write"),
    "MultiEdit": ("file_path", "write"),
    "NotebookEdit": ("notebook_path", "write"),
}


@csrf_exempt
async def hook_api(request):
    """claude PostToolUse hook 的旁路上报端点。

    交互 TUI 没有 JSONL，目录树标色只能靠 hook。这里只记文件访问并推
    ``agent-event``，不参与权限、不阻塞 agent；hook 脚本失败也不会影响会话。
    """
    if request.method != "POST":
        return JsonResponse({"ok": False, "error": "只接受 POST"}, status=405)
    if request.headers.get("X-Agentcli-Token", "") != bridge.TOKEN:
        return JsonResponse({"ok": False, "error": "token 不匹配"}, status=403)

    try:
        payload = json.loads(await sync_to_async(lambda: request.body or b"{}")())
    except json.JSONDecodeError:
        return JsonResponse({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    sid = str(payload.get("sid") or "")
    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input") or {}
    parent = await sessions.registry.get(sid)
    if parent is None:
        return JsonResponse({"ok": False, "error": "会话已回收"}, status=404)

    field, action = _HOOK_TOOLS.get(tool, ("", ""))
    path = str(tool_input.get(field) or "") if field else ""
    if not path:
        return JsonResponse({"ok": True, "ignored": tool})

    rel = terminal._rel_to_cwd(path, parent.runtime.cwd)
    parent.runtime.record_file(rel, action)
    event = {"kind": "tool", "tool": tool, "file": rel, "action": action}
    for watcher in list(parent.runtime.watchers):
        if hasattr(watcher, "on_event"):
            watcher.on_event(event)
    return JsonResponse({"ok": True, "file": rel, "action": action})

