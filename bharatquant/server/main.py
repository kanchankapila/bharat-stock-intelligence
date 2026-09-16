"""BharatQuant Desk — API entry point. Run with:
    python -m uvicorn bharatquant.server.main:app --port 8811
from the repository root.
"""
from .app import app  # noqa: F401