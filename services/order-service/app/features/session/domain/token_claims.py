"""Fixed values of the session token (ADR-0027).

The issuer (this service) and every verifier share them. assistant-service
mirrors ISSUER, AUDIENCE, TOKEN_TYPE and ALGORITHM by hand, so a change here
needs the same change there.
"""

ISSUER = "order-service"
AUDIENCE = "event-driven-orders"
TOKEN_TYPE = "session"
ALGORITHM = "HS256"
TOKEN_TTL_SECONDS = 7 * 24 * 3600
# Clock skew tolerated when checking ``exp`` and ``iat``.
LEEWAY_SECONDS = 30
