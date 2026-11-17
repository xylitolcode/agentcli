import json
import os
import urllib.request
import http.cookiejar

BASE = "http://127.0.0.1:8010"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get(path):
    with opener.open(BASE + path, timeout=10) as r:
        return r.status, r.read()


def post_command(cmd):
    token = next((c.value for c in jar if c.name == "csrftoken"), "")
    body = json.dumps({"command": cmd}).encode()
    req = urllib.request.Request(
        BASE + "/api/command/",
        data=body,
        headers={"Content-Type": "application/json", "X-CSRFToken": token},
        method="POST",
    )
    try:
        with opener.open(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"ok": False, "lines": [{"text": raw[:80].decode(errors="replace")}]}


status, html = get("/")
print(f"GET /            -> {status}, {len(html)} bytes, title ok={'agentcli' in html.decode()}")

# 先访问一次拿 csrftoken cookie
get("/")
print("csrf cookie      ->", any(c.name == "csrftoken" for c in jar))

for cmd in ["help", "status", "echo hello world", "time", "ls -al", ""]:
    code, data = post_command(cmd)
    first = data["lines"][0]["text"] if data.get("lines") else ""
    print(f"POST {cmd!r:<20} -> {code} ok={data.get('ok')} lines={len(data.get('lines', []))} first={first[:48]}")

# 目录树接口
code, raw = get("/api/files/")
payload = json.loads(raw)
dirs = [e["name"] for e in payload.get("entries", []) if e["type"] == "dir"]
print(f"GET /api/files/     -> {code} root={payload.get('root', '')[-24:]} dirs={dirs[:4]}")

sub = payload["entries"][0]["path"] if payload.get("entries") else ""
code, raw = get("/api/files/?path=" + sub)
print(f"GET 子目录          -> {code} entries={len(json.loads(raw).get('entries', []))}")

# 越界防护
try:
    code, raw = get("/api/files/?path=../../etc/passwd")
    print(f"GET 越界路径        -> {code}（期望 403）")
except urllib.error.HTTPError as e:
    print(f"GET 越界路径        -> {e.code}（期望 403）")

