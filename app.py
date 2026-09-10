"""
app.py — Top-level ASGI entrypoint referencing main:app.
Compatible with Vercel FastAPI runtime and standard ASGI servers.
"""
from main import app

__all__ = ["app"]
