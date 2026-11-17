"""Qwen Code 适配器：`qwen ... -o stream-json`。

与 Claude Code 同源分支，stream-json 事件结构相近：system / assistant /
user(tool_result) / result。解析复用宽松策略，字段对不上时原样留在 raw。
"""

from __future__ import annotations

from typing import Any

from .base import Adapter, Event


class QwenAdapter(Adapter):
    name = "qwen"
    kind = "agent"
    label = "Qwen Code"

    def build_argv(
        self,
        base_argv: list[str],
        prompt: str | None = None,
        *,
        mode: str = "headless",
        sid: str = "",
        agent_sid: str = "",
        resume: str = "",
        delegate_prompt: str = "",
    ) -> list[str]:
        if mode == "interactive":
            # 原生 TUI；带初始任务要用 -i，位置参数是 one-shot。
            argv = list(base_argv)
            if sid:
                from .. import bridge
                argv += bridge.qwen_flags(sid, delegate_prompt=delegate_prompt)
            if prompt:
                argv += ["-i", prompt]
            return argv

        argv = list(base_argv)
        # auto-edit：非交互下自动放行文件编辑，shell 命令仍按分类策略走。
        argv += ["-o", "stream-json", "--approval-mode", "auto-edit"]
        if prompt:
            argv += ["-p", prompt]
        return argv

    def parse_events(self, raw: dict[str, Any]) -> list[Event]:
        etype = raw.get("type")

        if etype == "assistant":
            message = raw.get("message") or {}
            events: list[Event] = []
            for block in message.get("content") or []:
                if block.get("type") == "text":
                    events.append(Event(kind="text", text=str(block.get("text") or ""), raw=raw))
                elif block.get("type") == "tool_use":
                    tool = str(block.get("name") or "")
                    tool_input = block.get("input") or {}
                    # tool_call 桥接：真实工具名在 input.name，参数在 input.arguments
                    if tool == "tool_call":
                        tool = str(tool_input.get("name") or tool)
                        tool_input = tool_input.get("arguments") or {}
                    file_path = tool_input.get("file_path") or tool_input.get("path")
                    # glob 用 pattern，grep/tool_search 用 query；归到读类目标记
                    if not file_path:
                        file_path = tool_input.get("pattern") or tool_input.get("query")
                    target = tool_input.get("agent") or tool_input.get("name") or tool_input.get("recipient")
                    events.append(Event(
                        kind="tool",
                        tool=tool,
                        file=_rel(file_path),
                        action=self._action_for_tool(tool),
                        target=str(target) if target else None,
                        raw=raw,
                    ))
            return events

        if etype == "result":
            return [Event(kind="result", text=str(raw.get("result") or ""), raw=raw)]

        return []

    def parse_event(self, raw: dict[str, Any]) -> Event | None:
        events = self.parse_events(raw)
        return events[0] if events else None


def _rel(path: Any) -> str | None:
    if not path:
        return None
    return str(path)
