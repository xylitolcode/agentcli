"""低 token 能力探针：分别跑 claude / codex / qwen 的单轮任务，落 JSONL 样本。

两套探针：

  * 默认（旧）：单文件读+改，回归用；
  * `--suite broad`：一轮打全类型 —— 读文件、整文件写、编辑、执行命令、
    列目录/检索、联网检索/抓取、子代理委派、记忆/目标等，用来摸清各 agent
    哪些工具调得动、哪些被拒。

成本控制（跑的是真实额度）：工作区只有几行小文件；prompt 短、单轮、不要求
长篇总结；每个 agent 独立子进程，跑完即退；样本只留原始 JSONL。

用法（WSL 内，项目根目录）：
  .venv/bin/python scripts/probe_agents.py                 # 单文件读改（回归）
  .venv/bin/python scripts/probe_agents.py claude          # 只跑指定一个
  .venv/bin/python scripts/probe_agents.py --suite broad   # 全类型一轮
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DIR = ROOT / ".event-sample"
BROAD_DIR = SAMPLE_DIR / "probe2"
TEST_FILE = SAMPLE_DIR / "sample.txt"

# 每个 agent 一套：命令、env 覆盖、超时。prompt 走 stdin，避免命令行长度/转义问题。
PROBES = {
    "claude": {
        "argv": [
            "claude", "-p", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "acceptEdits",
        ],
        "env": {},
        "timeout": 90,
        "prompt": "读一下 .event-sample/sample.txt，把第二行改成 beta-2，再回我两个字：完成。",
    },
    "codex": {
        "argv": [
            "codex", "exec", "--json", "--skip-git-repo-check",
            "--sandbox", "workspace-write",
        ],
        "env": {},  # key 由适配器同源逻辑从 auth.json 注入，这里手动复刻
        "timeout": 90,
        "prompt": "读 .event-sample/sample.txt，把第二行 beta 改成 beta-2，回两个字：完成。",
    },
    "qwen": {
        "argv": [
            "qwen", "-p", "-o", "stream-json",
            "--approval-mode", "auto-edit",
        ],
        "env": {},
        "timeout": 90,
        "prompt": "读 .event-sample/sample.txt，把第二行 beta 改成 beta-2，回两个字：完成。",
    },
}

# 全类型一轮：覆盖读/写/编辑/命令/检索/联网/委派/记忆。联网若渠道不支持，
# 探针照样记录「调没调对应工具、返回什么错误」，不强行等结果。
BROAD_PROMPT = (
    "这是能力测试，请按顺序用最少的动作完成，最后只回“完成”：\n"
    "1. 读 .event-sample/probe2/note.txt；\n"
    "2. 在 .event-sample/probe2/ 下新建 out.txt，写入一行 “probe-ok”；\n"
    "3. 把 note.txt 里的 alpha-100 改成 alpha-200；\n"
    "4. 列一下 .event-sample/probe2/ 目录里有哪些文件；\n"
    "5. 用联网检索查一下 “Python” 这个词；如果没有联网工具就跳过；\n"
    "6. 不要创建子代理，不要写记忆；只做上面 1-4 和能做的 5。"
)


def _codex_key() -> str:
    auth = Path.home() / ".codex" / "auth.json"
    try:
        return str(json.loads(auth.read_text()).get("OPENAI_API_KEY") or "")
    except (OSError, json.JSONDecodeError):
        return ""


def _tool_signature(obj: dict) -> str:
    """从一条 JSONL 里粗提工具调用指纹：工具名 + 目标。"""
    t = obj.get("type") or obj.get("kind") or ""
    item = obj.get("item") if isinstance(obj.get("item"), dict) else None
    if item and item.get("type") == "command_execution":
        return f"shell:{str(item.get('command') or '')[:80]}"
    if t == "assistant":
        for b in (obj.get("message") or {}).get("content") or []:
            if b.get("type") == "tool_use":
                name = b.get("name")
                inp = b.get("input") or {}
                if name == "tool_call":
                    name = inp.get("name") or "tool_call"
                target = inp.get("file_path") or inp.get("path") or inp.get("query") or ""
                return f"{name}:{str(target)[:60]}"
    return ""


def run_one(name: str, spec: dict, broad: bool) -> dict:
    env = os.environ.copy()
    env.update(spec["env"])
    if name == "codex":
        key = _codex_key()
        if key:
            env["OPENAI_API_KEY"] = key

    prompt = BROAD_PROMPT if broad else spec["prompt"]
    out_name = f"{name}-broad.jsonl" if broad else f"{name}-events.jsonl"
    sample_path = (BROAD_DIR if broad else SAMPLE_DIR) / out_name

    started = time.monotonic()
    proc = subprocess.run(
        spec["argv"],
        input=prompt,
        env=env,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=spec["timeout"],
    )
    elapsed = time.monotonic() - started

    out = proc.stdout or ""
    err = proc.stderr or ""
    sample_path.write_text(out, encoding="utf-8")

    tools: list[str] = []
    errors: list[str] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        sig = _tool_signature(obj)
        if sig:
            tools.append(sig)
        etype = obj.get("type") or obj.get("kind") or ""
        if "error" in etype:
            errors.append(str(obj.get("message") or obj)[:120])

    summary = {
        "agent": name,
        "suite": "broad" if broad else "basic",
        "exit": proc.returncode,
        "elapsed_s": round(elapsed, 1),
        "stdout_lines": len(out.splitlines()),
        "tools": tools,
        "errors": errors[:3],
        "stderr_tail": err.strip().splitlines()[-1] if err.strip() else "",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main() -> None:
    SAMPLE_DIR.mkdir(exist_ok=True)
    BROAD_DIR.mkdir(exist_ok=True)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    broad = "--suite" in sys.argv and "broad" in sys.argv
    targets = args or list(PROBES)
    for name in targets:
        if name not in PROBES:
            print(f"跳过未知 agent：{name}")
            continue
        print(f"\n===== {name} ({'broad' if broad else 'basic'}) =====")
        try:
            run_one(name, PROBES[name], broad)
        except subprocess.TimeoutExpired:
            print(json.dumps({"agent": name, "timeout": True}, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001 —— 探针要把异常落出来
            print(json.dumps({"agent": name, "exception": str(exc)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
