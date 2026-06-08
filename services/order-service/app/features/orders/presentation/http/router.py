from app.core.router.router import get_versioned_router

# SCAFFOLD: the versioned orders router is wired into the app already.
# Phase 1 adds POST /orders (create order + publish OrderCreated).
router = get_versioned_router("v1")
