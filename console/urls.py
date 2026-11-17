from django.urls import path

from . import views

app_name = "console"

urlpatterns = [
    path("", views.index, name="index"),
    path("api/projects/", views.projects_list, name="projects"),
    path("api/sessions/", views.sessions_list, name="sessions"),
    path("api/delegations/", views.delegations_list, name="delegations"),
    path("api/files/", views.tree, name="files"),
    path("api/command/", views.command, name="command"),
]
