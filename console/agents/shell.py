"""系统壳适配器：bash 不产出结构化事件，字节直通终端。"""

from __future__ import annotations

from .base import Adapter, Event


class ShellAdapter(Adapter):
    name = "bash"
    kind = "shell"
    label = "Bash Shell"

    def parse_line(self, line: str) -> Event | None:
        # 壳的输出原样走 PTY，不做事件归一化
        return None
