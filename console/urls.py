from django.urls import path

from . import views

app_name = "console"

urlpatterns = [
    path("", views.index, name="index"),
    path("api/projects/", views.projects_list, name="projects"),
    path("api/sessions/", views.sessions_list, name="sessions"),
    path("api/delegations/", views.delegations_list, name="delegations"),
    path("api/files/", views.tree, name="files"),
    path("api/file/", views.file_api, name="file"),
    path("api/git/", views.git_api, name="git"),
    path("api/diff/", views.diff_api, name="diff"),
    path("api/search/", views.search_api, name="search"),
    path("api/command/", views.command, name="command"),
    # MCP 工具 delegate_task 的回调（本机 agent 进程用，带进程内 token）
    path("api/delegate/", views.delegate_api, name="delegate"),
    # claude PostToolUse hook 的旁路上报（交互态补文件树标色）
    path("api/hook/", views.hook_api, name="hook"),
]
