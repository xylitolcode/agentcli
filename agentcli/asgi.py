"""ASGI 入口：WebSocket 走终端，其余全交给 Django。

Django 本身是 WSGI 语义，处理不了 WebSocket 升级请求，所以这里在 ASGI 层做一次
极薄的分派 —— 不为一个终端引入 Channels 和它那一套 channel layer。真正的连接
处理在 ``console.terminal.terminal_ws``。

启动用 uvicorn（``runserver`` 只在 WSGI 那半边跑，WebSocket 连不上）::

    .venv/bin/uvicorn agentcli.asgi:application --port 8010 --reload

For more information on this file, see
https://docs.djangoproject.com/en/6.1/howto/deployment/asgi/
"""

import asyncio
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentcli.settings")

# 先把 Django 建起来，之后 import 依赖 settings 的模块才是安全的
django_app = get_asgi_application()


async def application(scope, receive, send):
    """ASGI 三重态（http / websocket / lifespan）的总入口。"""
    if scope["type"] == "lifespan":
        await _lifespan(receive, send)
        return

    if scope["type"] == "websocket" and scope.get("path", "").startswith("/ws/"):
        path = scope["path"].rstrip("/")
        if path == "/ws/terminal":
            from console.terminal import terminal_ws

            await terminal_ws(scope, receive, send)
            return
        await send({"type": "websocket.close", "code": 4404})
        return

    await django_app(scope, receive, send)


async def _lifespan(receive, send):
    """Django 的 ASGI app 不接 lifespan，这里自己应答，免得启动时报 unsupported。

    启动时顺带把会话注册表的空闲回收任务挂上；关闭时把残留会话统一收尸。
    """
    from console import sessions

    loop = None
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            from asgiref.sync import sync_to_async

            loop = asyncio.get_running_loop()
            sessions.registry.start_sweeper(loop)
            # 首次启动把总目录下像项目的目录播种进台账（已有记录不动）。
            # ORM 不能在 ASGI 协程里直接查，必须包 sync_to_async —— 漏了这一层
            # 会让 startup 直接抛 SynchronousOnlyOperation，uvicorn 判定整个
            # lifespan 不受支持，回收扫描器跟着永远起不来。
            from console import projects

            await sync_to_async(projects.seed_from_disk, thread_sensitive=True)()
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            await _shutdown_sessions()
            await send({"type": "lifespan.shutdown.complete"})
            return


async def _shutdown_sessions() -> None:
    """服务关闭时回收所有残留 PTY 会话，避免留下孤儿进程。"""
    from console import sessions

    for session in sessions.registry.all():
        await session.shutdown()
