"""
URL configuration for agentcli project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.1/topics/http/urls/
"""

from django.contrib import admin
from django.contrib.staticfiles.urls import staticfiles_urlpatterns
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('console.urls')),
]

# 服务是用 uvicorn 直接跑 ASGI 的，没有 runserver 那层 StaticFilesHandler，
# 静态资源得从 URLconf 走。只用 staticfiles 这一条：它走 finders，既覆盖
# STATICFILES_DIRS，也覆盖各 app（含 admin）包内部的静态文件。仅 DEBUG 生效。
urlpatterns += staticfiles_urlpatterns()
