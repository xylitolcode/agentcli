"""Git 只读接口回归：仓库识别、分支/提交、状态解析、非仓库降级。

不启服务，直接用 Django test client；只执行只读 git 命令。
"""

import os
import sys
from pathlib import Path

import django

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentcli.settings")
django.setup()

from django.test import Client  # noqa: E402

from console import gitview, projects  # noqa: E402

client = Client(HTTP_HOST="127.0.0.1")
project = next((p for p in projects.list_projects() if p["exists"]), None)
if project is None:
    raise SystemExit("没有可用的项目目录")
pid = project["id"]
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(("PASS  " if condition else "FAIL  ") + name + (f"  <- {detail}" if detail else ""))
    if not condition:
        failures.append(name)


resp = client.get("/api/git/", {"project": pid})
body = resp.json()
check("仓库识别", resp.status_code == 200 and body["ok"] and body["repo"],
      f"{resp.status_code} repo={body.get('repo')}")
check("分支与 HEAD", bool(body.get("branch")) and bool(body.get("head")),
      f"{body.get('branch')} {body.get('head')}")
check("最近提交", len(body.get("commits", [])) > 0, f"{len(body.get('commits', []))} 条")
check("工作区状态含 gitview.py",
      any(item["path"] == "console/gitview.py" for item in body.get("files", [])),
      f"{len(body.get('files', []))} 项")

resp = client.get("/api/git/")
body = resp.json()
check("非仓库降级", resp.status_code == 200 and body["ok"] and not body["repo"],
      f"repo={body.get('repo')}")

resp = client.post("/api/git/", {"project": pid})
check("拒绝写方法", resp.status_code == 405, str(resp.status_code))

files, truncated = gitview._parse_status("R  new/path\x00old/path\x00 M a.py\x00?? b.txt\x00")
check("重命名解析", files[0]["from"] == "old/path" and files[0]["kind"] == "renamed",
      str(files[0]))
check("状态分类", [f["kind"] for f in files] == ["renamed", "modified", "untracked"] and not truncated,
      str([f["kind"] for f in files]))

print("\n全部通过" if not failures else f"\n{len(failures)} 项失败")
raise SystemExit(1 if failures else 0)
