"""原生交互 agent 的编排桥。

M1 起，主面板默认跑 CLI 的原生交互形态（claude/codex/qwen 的 TUI）。TUI 的
stdout 是 ANSI 画面，拿不到 JSONL 事件，所以「外包给另一个 agent」不能再靠
解析 ``tool_use Task``，改成给每个交互会话挂一个本地 MCP server：

* MCP server（``scripts/mcp_delegate.py``）只做协议转接，把 ``delegate_task``
  调用 POST 回本进程的 ``/api/delegate/``；
* 真正的建槽、忙锁、台账、回执仍在 ``delegation`` 里，跟 headless 子槽一致；
* MCP 工具的描述里写明「何时该外包」，agent 由此知道还有其他 agent 存在。

每个会话一套 token + parent sid，MCP 进程只代表这张会话说话。
"""

from __future__ import annotations

import json
import secrets
import sys
from pathlib import Path

# 只在进程内有效：MCP 子进程拿到的 token 与 HTTP 端点校验的是同一份。
TOKEN = secrets.token_urlsafe(24)

# 控制面自身地址。terminal 层收到 WS 连接时用 scope["server"] 回填真实端口；
# 子槽（headless）不挂 MCP，不依赖这个值。
BASE_URL = "http://127.0.0.1:8010"

# 交互会话的系统提示补充：告诉 agent 这个工具存在、什么时候该用。
DELEGATE_PROMPT = (
    "你可以通过 MCP 工具 agentcli.delegate_task 把子任务外包给本机的另一个 agent。"
    "参数 target 是目标 agent（claude / codex / qwen / stub 之一），prompt 是完整、"
    "自包含的任务描述（对方看不到你的上下文）。工具会阻塞到对方跑完并返回回执。"
    "只在用户明确要求分工、或你判断另一个 agent 更适合这件活时使用；普通的读写、"
    "搜索不要动用它。用户可以在控制台关闭外包开关，关闭后调用会返回失败原因。"
)


def _python() -> str:
    return sys.executable


def _script() -> str:
    return str(Path(__file__).resolve().parent.parent / "scripts" / "mcp_delegate.py")


def _server_spec(sid: str) -> dict:
    return {
        "command": _python(),
        "args": [_script(), "--parent-sid", sid],
        "env": {
            "AGENTCLI_URL": BASE_URL,
            "AGENTCLI_TOKEN": TOKEN,
        },
    }


def mcp_config(sid: str) -> str:
    """claude / qwen 的 ``--mcp-config`` 内联 JSON。"""
    return json.dumps({"mcpServers": {"agentcli": _server_spec(sid)}}, ensure_ascii=False)


def _hook_script() -> str:
    return str(Path(__file__).resolve().parent.parent / "scripts" / "hook_event.py")


def hook_settings(sid: str) -> str:
    """claude 的 ``--settings`` 内联 JSON：PostToolUse 旁路上报文件访问。

    交互 TUI 的 stdout 不是 JSONL，目录树拿不到标色。hook 在工具调用后跑一个
    极轻的本机 POST，只补事件，不影响 TUI 的渲染与权限流程。
    """
    command = (
        f"'{_python()}' '{_hook_script()}' "
        f"--sid {sid} --token {TOKEN} --url {BASE_URL}"
    )
    return json.dumps({
        "hooks": {
            "PostToolUse": [{
                "matcher": "Read|Write|Edit|MultiEdit|NotebookEdit",
                "hooks": [{"type": "command", "command": command, "timeout": 5}],
            }],
        },
    }, ensure_ascii=False)


def claude_flags(sid: str) -> list[str]:
    return [
        "--mcp-config", mcp_config(sid),
        # 外包是用户开过开关才生效的动作，别让它卡在工具许可弹窗里；其它工具
        # 仍走 claude 原生的权限确认。
        "--allowedTools", "mcp__agentcli__delegate_task",
        "--append-system-prompt", DELEGATE_PROMPT,
        "--settings", hook_settings(sid),
    ]


def qwen_flags(sid: str) -> list[str]:
    return [
        "--mcp-config", mcp_config(sid),
        "--allowed-tools", "mcp__agentcli__delegate_task",
        "--append-system-prompt", DELEGATE_PROMPT,
    ]


def codex_flags(sid: str) -> list[str]:
    """codex 没有 --mcp-config，用 -c 覆盖 mcp_servers 表（TOML 值）。"""
    spec = _server_spec(sid)
    args = json.dumps(spec["args"], ensure_ascii=False)
    env = "{" + ",".join(f'{k}="{v}"' for k, v in spec["env"].items()) + "}"
    return [
        "-c", f'mcp_servers.agentcli.command="{spec["command"]}"',
        "-c", f"mcp_servers.agentcli.args={args}",
        "-c", f"mcp_servers.agentcli.env={env}",
    ]
