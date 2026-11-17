"""Codex CLI 适配器：`codex exec ... --json`（JSONL 事件）。

`codex exec` 是非交互子命令；`--json` 把事件以 JSONL 打到 stdout。
具体事件字段以本机 0.169.0 实测为准，解析层先做宽松兜底：能提取出
消息文本和命令/文件就归一化，其余原样留在 ``raw``。

鉴权：本机走 cc-switch 反代（base_url 在 ``~/.codex/config.toml``），
但 codex 启动期只查 ``OPENAI_API_KEY`` 环境变量、不回读 ``auth.json``。
所以这里从 ``~/.codex/auth.json`` 取出 key 注入子进程 env；读不到就
留空，让 codex 自己报缺 key。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .base import Adapter, Event


def _load_auth_key() -> str:
    auth = Path.home() / ".codex" / "auth.json"
    try:
        data = json.loads(auth.read_text())
    except (OSError, json.JSONDecodeError):
        return ""
    return str(data.get("OPENAI_API_KEY") or "")


class CodexAdapter(Adapter):
    name = "codex"
    kind = "agent"
    label = "Codex CLI"

    def build_argv(
        self,
        base_argv: list[str],
        prompt: str | None = None,
        *,
        mode: str = "headless",
        sid: str = "",
    ) -> list[str]:
        if mode == "interactive":
            # codex 不带子命令就是 TUI；MCP 用 -c 覆盖 mcp_servers 表。
            argv = list(base_argv)
            if sid:
                from .. import bridge
                argv += bridge.codex_flags(sid)
            if prompt:
                argv.append(prompt)
            return argv

        # base_argv[0] 是 `codex`，非交互入口是 `codex exec`
        argv = [base_argv[0], "exec"]
        # workspace-write：沙箱内允许写工作区文件，shell 命令在沙箱内执行，
        # 不弹人工确认；比 danger-full-access 收敛。
        argv += ["--json", "--skip-git-repo-check",
                 "--sandbox", "workspace-write"]
        if prompt:
            argv.append(prompt)
        return argv

    def env(self) -> dict[str, str]:
        key = _load_auth_key()
        return {"OPENAI_API_KEY": key} if key else {}

    def parse_event(self, raw: dict[str, Any]) -> Event | None:
        etype = raw.get("type") or raw.get("kind") or ""

        if etype in ("error", "Error", "turn.failed"):
            msg = raw.get("message") or (raw.get("error") or {}).get("message") or raw
            return Event(kind="error", text=str(msg), raw=raw)

        # codex 0.169.0：工具调用挂在 item.completed / item.started 的
        # item.type=command_execution；命令在 item.command，输出在
        # aggregated_output。读/写归类按命令里的重定向与编辑命令粗判。
        item = raw.get("item") if isinstance(raw.get("item"), dict) else None
        if item and item.get("type") == "command_execution":
            command = str(item.get("command") or "")
            action = _action_from_command(command)
            return Event(
                kind="tool",
                tool="shell",
                file=_file_from_command(command),
                action=action,
                text=command,
                raw=raw,
            )

        if item and item.get("type") == "agent_message":
            return Event(kind="text", text=str(item.get("text") or ""), raw=raw)

        if etype == "turn.completed":
            usage = item or raw.get("usage") or {}
            return Event(kind="result", text="", raw=raw)

        return None


# 命令里出现这些编辑/写入动词，判为 write；纯查看命令判为 read。
_WRITE_RE = re.compile(
    r"\b(perl|sed|awk|tee|cp|mv|touch|chmod|chown|rm|mkdir|install)\b|>\s*[^\s]|-i\b", re.I)
_READ_RE = re.compile(r"\b(nl|head|tail|grep|rg|ls|find|wc|diff|file|stat)\b", re.I)
# 从命令里抓路径参数：引号内或裸 token；先剥掉引导 shell 的解释器段。
_PATH_RE = re.compile(r"(?<![\w-])([./~][^\s\"']+|/[^\s\"']+)")


def _strip_shell(command: str) -> str:
    # command 形如 `/bin/zsh -c '...'` 或 `bash -c "..."`，工具归类与文件路径
    # 都落在被执行的那段脚本里，把引导段剥掉再判。
    m = re.search(r"-c\s+(['\"])(.*)\1\s*$", command)
    if m:
        return m.group(2)
    return command


def _action_from_command(command: str) -> str | None:
    body = _strip_shell(command)
    if _WRITE_RE.search(body):
        return "write"
    if _READ_RE.search(body):
        return "read"
    return "exec"


def _file_from_command(command: str) -> str | None:
    body = _strip_shell(command)
    for token in _PATH_RE.findall(body):
        token = token.strip("\"'")
        if token and not token.startswith("-"):
            return token
    return None
