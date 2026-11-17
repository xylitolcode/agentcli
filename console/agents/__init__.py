"""非 TUI agent 适配层。

这里把「怎么拉起一个 agent、怎么解析它吐出来的结构化事件」从 PTY 会话层
剥出来。每个 agent 一个适配器：声明能力、给出非交互模式的 argv、把原始
输出解析成统一的事件流。

设计约定（统一事件契约）：适配器的 :meth:`Adapter.parse_line` 把一行
结构化输出（JSONL）翻译成下面这种通用事件，上层（目录树联动、审计、
任务面板）只认这一层，不感知各家 CLI 的字段差异::

    {"kind": "system" | "text" | "tool" | "result" | "error",
     "text": str,                 # 面向人读的摘要/正文
     "tool": str | None,          # 工具名：Read / Write / Bash ...
     "file": str | None,          # 涉及的项目内相对路径
     "action": "read" | "write" | "exec" | None,
     "raw": dict}                 # 原始事件，兜底留痕
"""

from __future__ import annotations

from .base import Adapter, Event
from .registry import get_adapter, list_adapters, shell_profile

__all__ = ["Adapter", "Event", "get_adapter", "list_adapters", "shell_profile"]
