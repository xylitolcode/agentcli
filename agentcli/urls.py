"""
URL configuration for agentcli project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.1/topics/http/urls/
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('console.urls')),
]

# 服务是用 uvicorn 直接跑 ASGI 的，没有 runserver 那层 StaticFilesHandler，
# 静态资源（xterm.js 之类）得从 URLconf 走。仅 DEBUG 下生效。
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0])
