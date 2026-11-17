"""Claude Code 适配器：`claude -p ... --output-format stream-json --verbose`。

实测事件形态（2.1.325）：

* ``type=system``   初始化 / 思考 token 等元信息；
* ``type=assistant`` message.content 里可能是 thinking / text / tool_use；
* ``type=user``    content 里是 tool_result，tool_use_result 带文件路径；
* ``type=result``  一轮结束，``result`` 是最终回答。

工具调用挂在 assistant 消息的 content 块上，``name`` 是工具名，
``input`` 带 ``file_path``；工具结果在 user 消息里回传。
"""

from __future__ import annotations

from typing import Any

from .base import Adapter, Event


class ClaudeAdapter(Adapter):
    name = "claude"
    kind = "agent"
    label = "Claude Code"

    def build_argv(
        self,
        base_argv: list[str],
        prompt: str | None = None,
        *,
        mode: str = "headless",
        sid: str = "",
    ) -> list[str]:
        if mode == "interactive":
            # 原生 TUI：多轮、上下文、权限确认都由 claude 自己管。只补一个
            # 本地 MCP server，让它可以主动把任务外包给别的 agent。
            argv = list(base_argv)
            if sid:
                from .. import bridge
                argv += bridge.claude_flags(sid)
            if prompt:
                argv.append(prompt)
            return argv

        argv = list(base_argv)
        # acceptEdits：非交互下自动放行文件编辑，不弹权限确认；读命令仍按策略走。
        argv += ["-p", "--output-format", "stream-json", "--verbose",
                 "--permission-mode", "acceptEdits"]
        if prompt:
            argv.append(prompt)
        return argv

    def parse_event(self, raw: dict[str, Any]) -> Event | None:
        etype = raw.get("type")

        if etype == "result":
            return Event(
                kind="result",
                text=str(raw.get("result") or ""),
                raw=raw,
            )

        if etype == "assistant":
            message = raw.get("message") or {}
            for block in message.get("content") or []:
                block_type = block.get("type")
                if block_type == "text":
                    return Event(kind="text", text=str(block.get("text") or ""), raw=raw)
                if block_type == "tool_use":
                    tool = str(block.get("name") or "")
                    tool_input = block.get("input") or {}
                    file_path = tool_input.get("file_path") or tool_input.get("path")
                    target = tool_input.get("subagent_type") or tool_input.get("agent")
                    return Event(
                        kind="tool",
                        tool=tool,
                        file=file_path,
                        action=self._action_for_tool(tool),
                        target=str(target) if target else None,
                        text=_tool_summary(tool, tool_input),
                        raw=raw,
                    )
            return None

        if etype == "user":
            message = raw.get("message") or {}
            for block in message.get("content") or []:
                if block.get("type") == "tool_result":
                    result = block.get("tool_use_result") or {}
                    file_meta = result.get("file") or {}
                    return Event(
                        kind="tool",
                        file=_rel(file_meta.get("filePath")),
                        action="read",
                        text=str(block.get("content") or "")[:200],
                        raw=raw,
                    )
            return None

        if etype == "system":
            subtype = raw.get("subtype")
            if subtype == "init":
                return Event(kind="system", text="已接入 Claude Code", raw=raw)
            return None

        return None


def _rel(path: Any) -> str | None:
    if not path:
        return None
    return str(path)


def _tool_summary(tool: str, tool_input: dict[str, Any]) -> str:
    target = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("command") or ""
    return f"{tool} {target}".strip()
