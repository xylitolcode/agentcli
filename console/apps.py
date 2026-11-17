from django.apps import AppConfig


class ConsoleConfig(AppConfig):
    name = 'console'
    # 面包屑与仪表盘分组用它：默认的 "Console" 在中文界面里像日志前缀
    verbose_name = 'Agent 控制台'
