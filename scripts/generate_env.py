"""Create the environment file for docker compose from a committed template.

Every empty ``*_PASS`` / ``*_PASSWORD`` value in the template gets a random
URL-safe secret (it also goes into the AMQP URL compose builds); every other
line is copied as is. The generated secrets are never printed.

    python scripts/generate_env.py                    # .env.example -> .env
    python scripts/generate_env.py --template deploy/env.production.example \\
        --output .env.production                      # production, on the VM

An existing output file is never overwritten unless ``--force`` is passed:
Postgres, Grafana and RabbitMQ keep the password their volume was first
created with, so new secrets also need ``docker compose down -v``.

Standard library only, so it runs with any Python 3 (CI uses the runner's).
"""

import argparse
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRET_KEY = re.compile(r"^[A-Z0-9_]*_PASS(WORD)?$")


def render(template: str) -> str:
    """Return the template with every empty secret value filled in."""
    lines = []
    for line in template.splitlines():
        key, sep, value = line.partition("=")
        is_assignment = sep and not line.lstrip().startswith("#")
        if is_assignment and SECRET_KEY.match(key.strip()) and not value.strip():
            line = f"{key.strip()}={secrets.token_urlsafe(24)}"
        lines.append(line)
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--template", type=Path, default=ROOT / ".env.example")
    parser.add_argument("--output", type=Path, default=ROOT / ".env")
    parser.add_argument(
        "--force", action="store_true", help="overwrite the output file if it exists"
    )
    args = parser.parse_args(argv)

    if args.output.exists() and not args.force:
        print(
            f"{args.output} already exists, not overwriting it. Use --force to replace it "
            "(then run `docker compose down -v` so the volumes take the new secrets).",
            file=sys.stderr,
        )
        return 1

    args.output.write_text(render(args.template.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"Wrote {args.output} with random secrets (not shown).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
