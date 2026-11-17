"""Agent 命令执行层。

这一层是网页终端和「真正能干活的 agent」之间的唯一接缝。当前只实现一个
演示运行器：不 fork 子进程、不碰文件系统、不发起网络请求，只把「命令 ->
结构化输出」这条链路跑通。

以后接真实能力（本地 shell、容器、MCP server、LLM 工具调用）时，只需要
替换 `execute()` 的实现，视图与前端都不用动。返回值结构：

    {"ok": bool, "lines": [{"level": "info|ok|warn|error|out", "text": str}]}
"""

from __future__ import annotations

import shlex
from datetime import datetime

# 内置命令表：name -> (简述, 用法)
BUILTINS = {
    "help": "列出所有可用命令",
    "status": "查看当前会话与运行器状态",
    "echo": "原样回显参数",
    "time": "打印服务器当前时间",
    "clear": "清空终端（前端处理）",
}


def _line(text: str, level: str = "out") -> dict[str, str]:
    return {"level": level, "text": text}


def _cmd_help(_: list[str]) -> list[dict[str, str]]:
    lines = [_line("当前可用命令：", "info")]
    width = max(len(name) for name in BUILTINS)
    for name, desc in BUILTINS.items():
        lines.append(_line(f"  {name.ljust(width)}  {desc}"))
    lines.append(_line(""))
    lines.append(_line("真实命令执行层尚未接入，输入其它命令只会得到占位提示。", "warn"))
    return lines


def _cmd_status(_: list[str]) -> list[dict[str, str]]:
    return [
        _line("runner    : demo (no subprocess)", "ok"),
        _line("sandbox   : enabled — 演示模式不执行真实命令"),
        _line(f"builtins  : {len(BUILTINS)}"),
        _line(f"server    : {datetime.now():%Y-%m-%d %H:%M:%S %Z}".strip()),
    ]


def _cmd_echo(args: list[str]) -> list[dict[str, str]]:
    return [_line(" ".join(args) if args else "", "out")]


def _cmd_time(_: list[str]) -> list[dict[str, str]]:
    now = datetime.now().astimezone()
    return [_line(now.strftime("%Y-%m-%d %H:%M:%S %z"))]


HANDLERS = {
    "help": _cmd_help,
    "status": _cmd_status,
    "echo": _cmd_echo,
    "time": _cmd_time,
}


def execute(raw: str) -> dict:
    """执行一条命令并返回结构化输出。"""
    raw = (raw or "").strip()
    if not raw:
        return {"ok": False, "lines": [_line("空命令", "warn")]}

    try:
        argv = shlex.split(raw)
    except ValueError as exc:
        return {"ok": False, "lines": [_line(f"解析失败：{exc}", "error")]}

    name, args = argv[0], argv[1:]

    handler = HANDLERS.get(name)
    if handler is None:
        return {
            "ok": False,
            "lines": [
                _line(f"command not found: {name}", "error"),
                _line("输入 help 查看已接入的命令。", "info"),
            ],
        }

    try:
        return {"ok": True, "lines": handler(args)}
    except Exception as exc:  # 演示运行器兜底，避免把栈信息透给前端
        return {"ok": False, "lines": [_line(f"执行异常：{exc}", "error")]}
