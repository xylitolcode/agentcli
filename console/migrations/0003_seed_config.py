"""播种 Profile 与单例配置。

迁移后 admin 里就有可编辑的行，不用手敲 profile 键。
排序沿用代码里的自然顺序：bash 打头，三个 agent 随后；默认 bash。
"""

from django.db import migrations

PROFILES = [
    ("bash", "Bash 终端", 10, True),
    ("claude", "Claude", 20, False),
    ("codex", "Codex", 30, False),
    ("qwen", "Qwen", 40, False),
]


def seed(apps, schema_editor):
    Profile = apps.get_model("console", "Profile")
    DelegateConfig = apps.get_model("console", "DelegateConfig")
    RuntimeLimit = apps.get_model("console", "RuntimeLimit")

    for name, label, order, is_default in PROFILES:
        Profile.objects.update_or_create(
            name=name,
            defaults={"label": label, "sort_order": order, "is_default": is_default},
        )
    DelegateConfig.objects.get_or_create(pk=1)
    RuntimeLimit.objects.get_or_create(pk=1)


def unseed(apps, schema_editor):
    Profile = apps.get_model("console", "Profile")
    DelegateConfig = apps.get_model("console", "DelegateConfig")
    RuntimeLimit = apps.get_model("console", "RuntimeLimit")
    Profile.objects.filter(name__in=[p[0] for p in PROFILES]).delete()
    DelegateConfig.objects.filter(pk=1).delete()
    RuntimeLimit.objects.filter(pk=1).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("console", "0002_delegateconfig_profile_runtimelimit"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
