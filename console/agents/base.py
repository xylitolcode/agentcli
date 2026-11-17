"""适配器基类与统一事件结构。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Event:
    """归一化后的一条 agent 事件。"""

    kind: str
    text: str = ""
    tool: str | None = None
    file: str | None = None
    action: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    # 委派事件：目标 agent / 子代理名、任务描述、回执线索
    target: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "text": self.text,
            "tool": self.tool,
            "file": self.file,
            "action": self.action,
            "target": self.target,
            "raw": self.raw,
        }


class Adapter:
    """单个 agent 的适配器契约。

    子类至少声明 :attr:`name`、:attr:`kind`，并实现 :meth:`build_argv` 与
    :meth:`parse_line`。shell（bash）走默认实现，不产出结构化事件。
    """

    name: str = ""
    kind: str = "shell"  # shell | agent
    label: str = ""

    # 工具名 -> 文件动作归类。解析器按这里映射「读过 / 改过 / 执行过」。
    # 同时兼容 Claude Code 的 PascalCase 与 Qwen Code 的 snake_case。
    READ_TOOLS: set[str] = {
        "Read", "read_file", "Grep", "grep_search", "Glob", "glob",
        "WebFetch", "web_fetch", "WebSearch", "web_search",
        "ToolSearch", "tool_search", "ListAgents", "list_agents",
    }
    WRITE_TOOLS: set[str] = {
        "Write", "write_file", "Edit", "edit", "NotebookEdit", "notebook_edit",
    }
    EXEC_TOOLS: set[str] = {
        "Bash", "Shell", "Exec", "run_shell_command", "ShellCommand",
    }
    # 委派/子代理类工具：主 agent 把任务派给另一个代理。
    DELEGATE_TOOLS: set[str] = {
        "Task", "task", "agent", "Agent", "SendMessage", "send_message",
        "ListAgents", "list_agents", "TaskStop", "task_stop",
    }

    def build_argv(self, base_argv: list[str], prompt: str | None = None) -> list[str]:
        """非交互模式的启动参数。base_argv 是 settings 里登记的可执行路径。"""
        return list(base_argv)

    def env(self) -> dict[str, str]:
        """子进程需要额外注入的环境变量（鉴权/反代覆盖等）。默认空。

        注意：注入的是明文鉴权，所以整套服务只能绑 127.0.0.1，不能上公网。
        """
        return {}

    def parse_line(self, line: str) -> Event | None:
        """把一行输出解析成事件；无法识别就返回 None。

        大多数 agent 走 JSONL，默认实现尝试按 JSON 解；纯文本 shell 覆写
        成直通。需要一条 JSONL 吐出多事件的子类覆写 :meth:`parse_events`。
        """
        raw = self._load_json(line)
        if raw is None:
            return None
        events = self.parse_events(raw)
        return events[0] if events else None

    def parse_events(self, raw: dict[str, Any]) -> list[Event]:
        """把一个已解好的 JSON 对象拆成多条事件；默认单条。"""
        ev = self.parse_event(raw)
        return [ev] if ev else []

    def parse_event(self, raw: dict[str, Any]) -> Event | None:
        """解析已经解好的 JSON 对象。子类覆写。"""
        return Event(kind="system", text="", raw=raw)

    # ---- 公共工具 ----

    @staticmethod
    def _load_json(line: str) -> dict[str, Any] | None:
        line = line.strip()
        if not line:
            return None
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    def _action_for_tool(self, tool: str | None) -> str | None:
        if tool in self.READ_TOOLS:
            return "read"
        if tool in self.WRITE_TOOLS:
            return "write"
        if tool in self.EXEC_TOOLS:
            return "exec"
        if tool in self.DELEGATE_TOOLS:
            return "delegate"
        return None

    def _is_delegate(self, tool: str | None) -> bool:
        return tool in self.DELEGATE_TOOLS
