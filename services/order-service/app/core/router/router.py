from fastapi import APIRouter


def get_versioned_router(version: str) -> APIRouter:
    """Build a router prefixed with the API version segment."""
    return APIRouter(prefix=f"/{version}")
