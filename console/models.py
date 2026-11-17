"""控制台的配置模型 —— 让 Django admin 管得住运行时配置。

设计边界（重要）：

* **数据库是运行时真相源，settings 常量只是 fallback**。这样迁移前、管理命令、
  DB 未就绪等场景都能退回旧行为，不会因为表还没建起来就整站崩掉。
* **argv 白名单仍锁在 ``settings.CONSOLE_PROFILES``**。Profile 表只管「启用/展示名/
  顺序/默认」，不存命令 —— 否则后台就等于开了一个任意命令执行的口子。
* 单例配置（DelegateConfig / RuntimeLimit）用「固定主键 = 1」实现，admin 里只允许
  编辑那一条，不让新增/删除。比 django-solo 之类的外部依赖轻。
"""

from __future__ import annotations

from django.conf import settings
from django.core.exceptions import ValidationError
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


class Profile(models.Model):
    """一个 agent / shell 能力位的展示与开关。

    真正的 argv 在 ``settings.CONSOLE_PROFILES[name]``，这里只决定「要不要给前端看、
    叫什么、排第几、是不是默认」。name 必须是白名单里已有的键，否则拒绝保存 ——
    这样后台加不出白名单外的 profile，守住 RCE 边界。
    """

    name = models.CharField(
        "Profile 键",
        max_length=40,
        unique=True,
        help_text="必须是 settings.CONSOLE_PROFILES 里已有的键（bash/claude/codex/qwen…）",
    )
    label = models.CharField("展示名", max_length=60, blank=True, default="")
    enabled = models.BooleanField("启用", default=True)
    sort_order = models.PositiveIntegerField("排序", default=100)
    is_default = models.BooleanField(
        "设为默认",
        default=False,
        help_text="全表只能有一个默认；勾上并保存会自动取消其他项的默认标记",
    )

    class Meta:
        ordering = ["sort_order", "name"]
        verbose_name = "Agent 能力位"
        verbose_name_plural = "Agent 能力位"

    def __str__(self) -> str:
        return self.label or self.name

    def clean(self) -> None:
        whitelist = set(getattr(settings, "CONSOLE_PROFILES", {}))
        # stub 由环境变量条件注册，允许它在开启时入库，关闭时留着也不碍事
        if self.name not in whitelist and self.name != "stub":
            raise ValidationError({"name": f"不在 CONSOLE_PROFILES 白名单里：{self.name}"})

    def save(self, *args, **kwargs) -> None:
        self.full_clean()
        super().save(*args, **kwargs)
        # 默认项全局唯一：勾上自己就把别人撤掉
        if self.is_default:
            Profile.objects.exclude(pk=self.pk).filter(is_default=True).update(is_default=False)


class SingletonModel(models.Model):
    """固定主键 = 1 的单例基类。子类在 admin 里只允许编辑那一条。"""

    class Meta:
        abstract = True

    def save(self, *args, **kwargs) -> None:
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        """取单例；不存在就按模型默认值建一条。"""
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class DelegateConfig(SingletonModel):
    """外包（agent 互相委派）的运行时参数。"""

    timeout = models.FloatField(
        "超时（秒）", default=120.0, help_text="单个子任务最长等待时间"
    )
    max_chain = models.PositiveIntegerField(
        "最大链路层级", default=4, help_text="防止 A 外包给 B、B 又外包给 C 无限套娃"
    )
    output_limit = models.PositiveIntegerField(
        "回执长度上限（字节）", default=256 * 1024, help_text="子任务回执截断阈值"
    )
    prompt = models.TextField(
        "外包提示词",
        blank=True,
        default=(
            "你可以通过 MCP 工具 agentcli.delegate_task 把子任务外包给本机的另一个 agent。"
            "参数 target 是目标 agent（claude / codex / qwen / stub 之一），prompt 是完整、"
            "自包含的任务描述（对方看不到你的上下文）。工具会阻塞到对方跑完并返回回执。"
            "只在用户明确要求分工、或你判断另一个 agent 更适合这件活时使用；普通的读写、"
            "搜索不要动用它。用户可以在控制台关闭外包开关，关闭后调用会返回失败原因。"
        ),
        help_text="注入给交互 agent 的系统提示，告诉它工具存在与何时该用",
    )

    class Meta:
        verbose_name = "外包配置"
        verbose_name_plural = "外包配置"

    def __str__(self) -> str:
        return "外包配置（单例）"


class RuntimeLimit(SingletonModel):
    """运行时限额：防止大目录/大文件/长历史把响应撑爆。"""

    replay_limit = models.PositiveIntegerField(
        "回放缓冲上限（字节）", default=256 * 1024,
        help_text="重连时回放的最近输出量；超出丢最老的，完整回滚靠 xterm 自己",
    )
    tree_limit = models.PositiveIntegerField(
        "目录树单层上限", default=400, help_text="单层返回条目数上限"
    )
    file_limit = models.PositiveIntegerField(
        "单文件查看上限（字节）", default=512 * 1024, help_text="超过则截断，不拒绝"
    )

    class Meta:
        verbose_name = "运行时限额"
        verbose_name_plural = "运行时限额"

    def __str__(self) -> str:
        return "运行时限额（单例）"
