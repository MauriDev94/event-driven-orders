"""Create the environment file for docker compose from a committed template.

Every empty ``*_PASS`` / ``*_PASSWORD`` value in the template gets a random
URL-safe secret (it also goes into the AMQP URL compose builds); every other
line is copied as is. The generated secrets are never printed.

    python scripts/generate_env.py                    # .env.example -> .env
    python scripts/generate_env.py --template deploy/env.production.example \\
        --output .env.production                      # production, on the VM

An existing output file keeps every value it has: the run only appends the
template keys it is missing (a new service's database, say), with fresh
secrets where they are empty. ``--force`` rewrites the whole file instead, and
then needs ``docker compose down -v``: Postgres, Grafana and RabbitMQ keep the
password their volume was first created with.

Standard library only, so it runs with any Python 3 (CI uses the runner's).
"""

import argparse
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRET_KEY = re.compile(r"^[A-Z0-9_]*_PASS(WORD)?$")


def _key(line: str) -> str | None:
    """Return the variable an assignment line sets, or None for other lines."""
    if line.lstrip().startswith("#"):
        return None
    key, sep, _ = line.partition("=")
    return key.strip() if sep and key.strip() else None


def render(template: str) -> str:
    """Return the template with every empty secret value filled in."""
    lines = []
    for line in template.splitlines():
        key = _key(line)
        if key is not None and SECRET_KEY.match(key) and not line.partition("=")[2].strip():
            line = f"{key}={secrets.token_urlsafe(24)}"
        lines.append(line)
    return "\n".join(lines) + "\n"


def missing_lines(template: str, existing: str) -> list[str]:
    """Return the rendered template assignments whose key `existing` lacks."""
    present = {key for line in existing.splitlines() if (key := _key(line)) is not None}
    return [
        line
        for line in render(template).splitlines()
        if (key := _key(line)) is not None and key not in present
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--template", type=Path, default=ROOT / ".env.example")
    parser.add_argument("--output", type=Path, default=ROOT / ".env")
    parser.add_argument(
        "--force",
        action="store_true",
        help="rewrite the output file from scratch, new secrets included",
    )
    args = parser.parse_args(argv)
    template = args.template.read_text(encoding="utf-8")

    if not args.output.exists() or args.force:
        args.output.write_text(render(template), encoding="utf-8")
        print(f"Wrote {args.output} with random secrets (not shown).")
        return 0

    existing = args.output.read_text(encoding="utf-8")
    added = missing_lines(template, existing)
    if not added:
        print(f"{args.output} already has every key of {args.template.name}; left as is.")
        return 0

    separator = "" if existing.endswith("\n") or not existing else "\n"
    block = f"\n# Added by scripts/generate_env.py from {args.template.name}\n"
    args.output.write_text(existing + separator + block + "\n".join(added) + "\n", encoding="utf-8")
    names = ", ".join(_key(line) or "" for line in added)
    print(f"Appended to {args.output} (values not shown): {names}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
