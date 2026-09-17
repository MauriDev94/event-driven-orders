"""Smoke test: verify that the WSL Python venv can talk to the Docker daemon
via testcontainers and spin up a Postgres container.

Run from WSL:
    cd event-driven-orders
    source .wsl-venv/bin/activate
    cd services/order-service
    python .wsl-smoke-test.py
"""

from testcontainers.postgres import PostgresContainer


def main() -> None:
    print("Starting Postgres container via testcontainers...")
    with PostgresContainer("postgres:16-alpine") as pg:
        url = pg.get_connection_url()
        print(f"  Raw URL: {url}")

        # testcontainers returns SQLAlchemy-style URLs like
        # postgresql+psycopg2://user:pass@host:port/db. psycopg2.connect
        # needs the plain postgresql:// form.
        psycopg2_url = url.replace("postgresql+psycopg2://", "postgresql://")
        print(f"  psycopg2 URL: {psycopg2_url}")

        import psycopg2

        conn = psycopg2.connect(psycopg2_url)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                result = cur.fetchone()
                print(f"  SELECT 1 -> {result[0]}")
        finally:
            conn.close()

    print("Container stopped. Smoke test passed.")


if __name__ == "__main__":
    main()
