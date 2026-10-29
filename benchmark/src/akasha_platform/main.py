from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from akasha_benchmark.store import init_db

from .api import router
from .settings import Settings, load_settings
from .tasks import TaskRejected, TaskRunner


def _task_rejected(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=409)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or load_settings()
    resolved.validate_binding()

    app = FastAPI(title="Akasha-Benchmark 评测平台", version="0.2.0")
    app.state.settings = resolved

    init_db(resolved.db_path)
    app.state.runner = TaskRunner(resolved)

    recovered = app.state.runner.recover()
    app.state.startup = {
        "recovered_tasks": recovered,
    }

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.dev_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_exception_handler(TaskRejected, _task_rejected)
    app.include_router(router)
    return app


app = create_app()
