"""项目台账 —— Django 维护哪些目录属于可进入的项目。

进来的流程是「进系统 -> 在总项目目录里选一个项目 -> 进入项目内部」。
项目不依赖每次扫文件系统，以这张表为准；首次启动可以从总目录扫描播种，
之后增删改都走这里。
"""

from __future__ import annotations

from django.db import models


class Project(models.Model):
    """一个可进入的项目目录。

    ``path`` 存相对于 ``settings.CONSOLE_PROJECTS_ROOT`` 的 POSIX 相对路径；
    绝对路径由 ``files.project_path()`` 拼，便于总目录整体搬迁。
    """

    name = models.CharField("展示名", max_length=120)
    path = models.CharField("相对路径", max_length=255, unique=True)
    agent = models.CharField(
        "默认 profile",
        max_length=40,
        default="bash",
        help_text="进入项目后默认拉起的 agent / shell，对应 CONSOLE_PROFILES 的键",
    )
    enabled = models.BooleanField("启用", default=True)
    note = models.CharField("备注", max_length=255, blank=True, default="")
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "项目"
        verbose_name_plural = "项目"

    def __str__(self) -> str:
        return self.name
