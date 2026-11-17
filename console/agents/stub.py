"""测试桩适配器：解析 `scripts/stub_agent.py` 的 stream-json。

只在桩测里用，不接真实模型；事件形态故意对齐 claude，好让总线的解析路径
（_parse_agent_stream / delegation._collect_reply）走同一套代码。
"""

from __future__ import annotations

from typing import Any

from .base import Adapter, Event


class StubAdapter(Adapter):
    name = "stub"
    kind = "agent"
    label = "测试桩"
    # 桩只模拟 headless：没有 TUI，桩测要覆盖的是 JSONL 那条链路。
    interactive = False

    def build_argv(
        self,
        base_argv: list[str],
        prompt: str | None = None,
        *,
        mode: str = "headless",
        sid: str = "",
        agent_sid: str = "",
        resume: str = "",
    ) -> list[str]:
        argv = list(base_argv)
        if prompt:
            argv.append(prompt)
        return argv

    def parse_events(self, raw: dict[str, Any]) -> list[Event]:
        etype = raw.get("type")

        if etype == "result":
            return [Event(kind="result", text=str(raw.get("result") or ""), raw=raw)]

        if etype == "system":
            return [Event(kind="system", text="测试桩已接入", raw=raw)]

        if etype == "assistant":
            events: list[Event] = []
            for block in (raw.get("message") or {}).get("content") or []:
                block_type = block.get("type")
                if block_type == "text":
                    events.append(Event(
                        kind="text", text=str(block.get("text") or ""), raw=raw,
                    ))
                elif block_type == "tool_use":
                    tool = str(block.get("name") or "")
                    inp = block.get("input") or {}
                    target = inp.get("subagent_type") or inp.get("agent")
                    events.append(Event(
                        kind="tool",
                        tool=tool,
                        action=self._action_for_tool(tool),
                        target=str(target) if target else None,
                        text=str(inp.get("prompt") or inp.get("description") or ""),
                        raw=raw,
                    ))
            return events

        return []

    def parse_event(self, raw: dict[str, Any]) -> Event | None:
        events = self.parse_events(raw)
        return events[0] if events else None
