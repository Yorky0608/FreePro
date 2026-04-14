"""Initialize the Freedom Program SQL schema.

- Works with SQLite today.
- Designed to be portable: point DATABASE_URL at Postgres/MySQL later.

Usage:
  python scripts/init_db.py
  DATABASE_URL=sqlite:///./freedom-program.sqlite3 python scripts/init_db.py

On Windows PowerShell:
  $env:DATABASE_URL = "sqlite:///./freedom-program.sqlite3"; python scripts/init_db.py
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from sqlalchemy import (
    BigInteger,
    Column,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    create_engine,
)


@dataclass(frozen=True)
class DbParts:
    """Parts needed to access the SQL database.

    For SQLite, only url is typically needed.
    For server databases (Postgres/MySQL), you can either:
      - set DATABASE_URL directly, or
      - fill in the parts and build a URL yourself.
    """

    url: str

    # Optional parts for non-SQLite deployments
    driver: str | None = None  # e.g., "postgresql+psycopg"
    host: str | None = None
    port: int | None = None
    database: str | None = None
    username: str | None = None
    password: str | None = None


# Single variable holding DB access configuration.
# For now, default to a local SQLite file.
DB: DbParts = DbParts(
    url=os.getenv("DATABASE_URL", "sqlite:///./freedom-program.sqlite3"),
    driver=os.getenv("DB_DRIVER"),
    host=os.getenv("DB_HOST"),
    port=int(os.getenv("DB_PORT")) if os.getenv("DB_PORT") else None,
    database=os.getenv("DB_NAME"),
    username=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
)


metadata = MetaData()

users = Table(
    "users",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("email", String(320), nullable=False, unique=True),
    Column("password_hash", String(255), nullable=False),
    Column("created_at_ms", BigInteger, nullable=False),
)

savings = Table(
    "savings",
    metadata,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("month_ms", BigInteger, primary_key=True),
    Column("dollars", Integer, nullable=False),
    Column("created_at_ms", BigInteger, nullable=False),
    Column("updated_at_ms", BigInteger, nullable=False),
)


def main() -> None:
    engine = create_engine(DB.url, future=True)
    metadata.create_all(engine)
    print(f"Initialized schema on: {DB.url}")


if __name__ == "__main__":
    main()
