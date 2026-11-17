"""只读文件接口回归：正常读取、越界拒绝、二进制标记、大文件截断。

不启服务，直接用 Django test client；项目 id 取第一个真实项目。
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

from console import config, files, projects  # noqa: E402

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


resp = client.get("/api/file/", {"project": pid, "path": "README.md"})
body = resp.json()
check("README 正常读取", resp.status_code == 200 and body["ok"] and "agentcli" in body["content"],
      f"{resp.status_code} {body.get('size')}B")

resp = client.get("/api/file/", {"project": pid, "path": "../etc/passwd"})
check("越界路径 403", resp.status_code == 403, str(resp.status_code))

resp = client.get("/api/file/", {"project": pid, "path": "frontend"})
check("目录不按文件返回 404", resp.status_code == 404, str(resp.status_code))

resp = client.get("/api/file/", {"project": pid, "path": "no-such-file.txt"})
check("缺失文件 404", resp.status_code == 404, str(resp.status_code))

resp = client.get("/api/file/", {"project": pid})
check("空 path 400", resp.status_code == 400, str(resp.status_code))

resp = client.get("/api/file/", {"project": pid, "path": ".git/index"})
body = resp.json()
check("二进制标记", resp.status_code == 200 and body["binary"] and not body["content"],
      f"binary={body.get('binary')}")

# 限额走数据库：临时改小，测完恢复原值
limit_row = config.runtime_limit()
original_limit = limit_row.file_limit
try:
    limit_row.file_limit = 1024
    limit_row.save()
    body = files.read_text("README.md", pid)
finally:
    limit_row.file_limit = original_limit
    limit_row.save()
check("大文件截断", body["truncated"] and len(body["content"]) <= 1024 and body["size"] > 1024,
      f"{body['size']}B -> {len(body['content'])}B")

print("\n全部通过" if not failures else f"\n{len(failures)} 项失败")
raise SystemExit(1 if failures else 0)
