"""Rules every identifier that enters the system must follow.

Customer and product ids are plain identifiers, never free text. They flow
into varchar(36) columns, into every event, into the recipient address that
notification-service builds (``<customer_id>@example.com``) and, through
assistant-service's read model, into what the LLM reads. Rejecting anything
else at the edge keeps prompt-injection text out of the model's context and
turns an oversized id into a 422 (or a 401, for a token) instead of a
database error.

Neutral on purpose: the orders HTTP schemas and the session token verifier
both apply them, and neither feature may import the other.
"""

ID_MAX_LENGTH = 36
ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
