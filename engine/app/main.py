"""Skaffo Engine — local FastAPI sidecar for the Electron app."""
from __future__ import annotations

import argparse
import sys
from contextlib import asynccontextmanager

import os
import secrets

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .core.config import settings
from .core.database import init_db
from .routers import api_design, generate, misc, projects, schema, schema_tools
from .services.seed import seed_if_empty


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    seed_if_empty()
    # Electron waits for this exact line before loading the UI.
    print(f"SKAFFO_ENGINE_READY port={settings.PORT}", flush=True)
    yield


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
    docs_url="/docs",
)

@app.middleware("http")
async def local_access(request: Request, call_next):
    """CORS alone does not prevent cross-origin writes or DNS rebinding."""
    host = request.headers.get("host", "").lower()
    allowed_hosts = {f"127.0.0.1:{settings.PORT}", f"localhost:{settings.PORT}"}
    # TestClient uses testserver; it is never accepted by an Electron sidecar.
    if not os.environ.get("SKAFFO_ENGINE_TOKEN"):
        allowed_hosts.add("testserver")
    if host not in allowed_hosts:
        return JSONResponse({"detail": "Invalid Host"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin not in settings.CORS_ORIGINS:
        return JSONResponse({"detail": "Invalid Origin"}, status_code=403)
    token = os.environ.get("SKAFFO_ENGINE_TOKEN")
    if token and not secrets.compare_digest(
        request.headers.get("x-skaffo-token", ""), token
    ):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Content-Type"],
)

app.include_router(misc.router)
app.include_router(projects.router)
app.include_router(schema.router)
app.include_router(api_design.router)
app.include_router(schema_tools.router)
app.include_router(generate.router)


def run() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(prog="skaffo-engine")
    parser.add_argument("--port", type=int, default=settings.PORT)
    parser.add_argument("--host", default=settings.HOST)
    args = parser.parse_args()

    settings.PORT = args.port
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    sys.exit(run())
