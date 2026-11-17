#!/usr/bin/env python3
"""测试桩 agent：不调模型、不联网，按 prompt 吐出与真实 CLI 同形的 stream-json。

给 ``scripts/check_delegation.py`` 用 —— 委派链路的验证不该烧真实额度。
prompt 就是行为脚本（最后一个 argv）：

    leaf:<x>   直接回 result（默认分支，任何不认识的 prompt 也走这里）
    slow:<x>   睡 2.5s 再回 result，用来制造「会话忙」的窗口
    chain:<x>  先抛一个 Task 给下级（prompt = leaf:<x>），等回执再收口
    seq:<x>    抛 Task → 等 1.3s（下级已跑完）→ 再抛 Task，验证同一张槽复用
    busy:<x>   抛一个慢任务，0.15s 后再抛一个，验证忙锁拒绝

输出形态对齐 claude：system/init、assistant.message.content(text|tool_use)、result。
"""

from __future__ import annotations

import json
import os
import sys
import time


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def text(body: str) -> None:
    emit({
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "text", "text": body}]},
    })


def tool(name: str, payload: dict) -> None:
    emit({
        "type": "assistant",
        "message": {"role": "assistant", "content": [{
            "type": "tool_use", "name": name, "input": payload,
        }]},
    })


def main() -> int:
    prompt = sys.argv[-1] if len(sys.argv) > 1 else ""
    emit({"type": "system", "subtype": "init", "cwd": os.getcwd()})

    if prompt.startswith("chain:"):
        rest = prompt[len("chain:"):]
        depth, arg = 0, rest
        if rest[:1].isdigit() and ":" in rest:
            head, arg = rest.split(":", 1)
            depth = int(head)
        text("桩：先把活包给下级")
        tool("Task", {
            "subagent_type": "stub", "description": "下级任务",
            # depth 还有余量就继续往下包，否则落到叶子
            "prompt": (f"chain:{depth - 1}:{arg}" if depth > 0 else "leaf:" + arg),
        })
        time.sleep(0.8)
        text("桩：等下级回执")
        emit({"type": "result", "result": "chain-root:" + arg})
        return 0

    if prompt.startswith("seq:"):
        arg = prompt[len("seq:"):]
        tool("Task", {"subagent_type": "stub", "description": "第一件",
                      "prompt": "leaf:first-" + arg})
        time.sleep(1.3)
        tool("Task", {"subagent_type": "stub", "description": "第二件",
                      "prompt": "leaf:second-" + arg})
        time.sleep(0.4)
        emit({"type": "result", "result": "seq-root:" + arg})
        return 0

    if prompt.startswith("busy:"):
        arg = prompt[len("busy:"):]
        tool("Task", {"subagent_type": "stub", "description": "慢任务",
                      "prompt": "slow:" + arg})
        time.sleep(0.15)
        tool("Task", {"subagent_type": "stub", "description": "紧接着的第二件",
                      "prompt": "leaf:" + arg})
        time.sleep(2.6)
        emit({"type": "result", "result": "busy-root:" + arg})
        return 0

    if prompt.startswith("claude:"):
        # 真·跨 agent：把活派给本机 claude（会消耗少量真实额度，只在人工验收时用）
        arg = prompt[len("claude:"):]
        text("桩：把活派给 claude")
        tool("Task", {
            "subagent_type": "claude", "description": "跨 agent 验收",
            "prompt": arg,
        })
        time.sleep(4.0)
        emit({"type": "result", "result": "dispatched-to-claude"})
        return 0

    if prompt.startswith("slow:"):
        time.sleep(2.5)
        emit({"type": "result", "result": "leaf-ok:" + prompt[len("slow:"):]})
        return 0

    body = prompt[len("leaf:"):] if prompt.startswith("leaf:") else prompt
    text("桩：收到 " + body)
    emit({"type": "result", "result": "leaf-ok:" + body})
    return 0


if __name__ == "__main__":
    sys.exit(main())
