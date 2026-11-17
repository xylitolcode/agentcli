"""Django admin —— 项目台账 + 运行时配置的编辑入口。

单例配置（外包 / 限额）用固定主键 = 1 实现，这里禁止新增删除，只留编辑。
Profile 的名字来自 settings 白名单，表单会校验，后台加不出任意命令。
"""

from __future__ import annotations

from django.contrib import admin, messages
from django.http import HttpResponseRedirect
from django.urls import reverse

from .models import DelegateConfig, Profile, Project, RuntimeLimit

# 列表页标题默认是「选择 X 来修改」，读起来像在挑商品；换成纯名词。
LIST_TEMPLATE = "admin/console/change_list.html"


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["name", "path", "agent", "enabled", "note"]
    list_filter = ["enabled", "agent"]
    search_fields = ["name", "path", "note"]
    ordering = ["name"]
    change_list_template = LIST_TEMPLATE


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ["name", "label", "enabled", "sort_order", "is_default"]
    list_editable = ["enabled", "sort_order"]
    list_filter = ["enabled", "is_default"]
    ordering = ["sort_order", "name"]
    fields = ["name", "label", "enabled", "sort_order", "is_default"]
    change_list_template = LIST_TEMPLATE


class SingletonAdmin(admin.ModelAdmin):
    """单例模型：只允许改现存的 pk=1，不给加也不给删。"""

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def changelist_view(self, request, extra_context=None):
        """单例没有「列表」这回事：点进来直接落到那一条的编辑页，少一次点击。"""
        obj = self.model.objects.order_by("pk").first()
        if obj is None:
            # 没种子数据时不能 redirect 回自己，否则就是 302 死循环
            messages.error(
                request,
                f"{self.model._meta.verbose_name}还没有记录，先跑一次迁移里的 seed。",
            )
            return HttpResponseRedirect(reverse("admin:index"))
        opts = self.model._meta
        return HttpResponseRedirect(
            reverse(f"admin:{opts.app_label}_{opts.model_name}_change", args=[obj.pk])
        )


@admin.register(DelegateConfig)
class DelegateConfigAdmin(SingletonAdmin):
    list_display = ["timeout", "max_chain", "output_limit"]
    fieldsets = [
        ("执行边界", {"fields": ["timeout", "max_chain", "output_limit"]}),
        ("提示词", {"fields": ["prompt"], "classes": ["wide"]}),
    ]


@admin.register(RuntimeLimit)
class RuntimeLimitAdmin(SingletonAdmin):
    list_display = ["replay_limit", "tree_limit", "file_limit"]
    fields = ["replay_limit", "tree_limit", "file_limit"]


admin.site.site_header = "agentcli 控制台"
admin.site.site_title = "agentcli"
admin.site.index_title = "配置管理"
