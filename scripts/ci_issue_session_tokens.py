"""Issue two session tokens with order-service's real issuer, for the CI job
that checks assistant-service accepts them (ADR-0027, section 7).

    AUTH_TOKEN_SECRET=<secret> uv run --package order-service \
        python scripts/ci_issue_session_tokens.py <out_dir> <customer_id>

Writes ``valid.token`` (signed with AUTH_TOKEN_SECRET) and ``forged.token``
(signed with a random secret of its own, which must be refused). Nothing is
printed: neither the secret nor the tokens may reach the CI log.
"""

import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The script lives outside the service, so put the service's `app` package on the path.
sys.path.insert(0, str(ROOT / "services" / "order-service"))

from app.features.session.infrastructure.jwt_token_issuer import JwtTokenIssuer  # noqa: E402


def main() -> None:
    out_dir = Path(sys.argv[1])
    customer_id = sys.argv[2]
    out_dir.mkdir(parents=True, exist_ok=True)
    valid = JwtTokenIssuer(os.environ["AUTH_TOKEN_SECRET"]).issue(customer_id)
    forged = JwtTokenIssuer(secrets.token_urlsafe(32)).issue(customer_id)
    (out_dir / "valid.token").write_text(valid.access_token)
    (out_dir / "forged.token").write_text(forged.access_token)


if __name__ == "__main__":
    main()
