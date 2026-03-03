"""
Local SQLite database for tracking which orders have been seen/actioned
in this application.  Track-POD is the source of truth for all order
data; this database only stores metadata that is local to Deliver-It.
"""

import sqlite3
import os
from contextlib import contextmanager

DB_PATH = os.environ.get("DATABASE_PATH", "deliver_it.db")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create tables if they don't exist."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS order_meta (
                order_number TEXT PRIMARY KEY,
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                first_viewed_at TEXT,
                notes TEXT
            )
        """)


def mark_orders_seen(order_numbers: list[str]):
    """Record that we fetched these orders from Track-POD."""
    with get_db() as conn:
        conn.executemany(
            """
            INSERT INTO order_meta (order_number, first_seen_at)
            VALUES (?, datetime('now'))
            ON CONFLICT(order_number) DO NOTHING
            """,
            [(n,) for n in order_numbers],
        )


def mark_order_viewed(order_number: str):
    """Record that the user opened / acknowledged this order in the UI."""
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO order_meta (order_number, first_seen_at, first_viewed_at)
            VALUES (?, datetime('now'), datetime('now'))
            ON CONFLICT(order_number) DO UPDATE
              SET first_viewed_at = COALESCE(first_viewed_at, datetime('now'))
            """,
            (order_number,),
        )


def get_viewed_set() -> set[str]:
    """Return order numbers that have been viewed in this app."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT order_number FROM order_meta WHERE first_viewed_at IS NOT NULL"
        ).fetchall()
    return {row["order_number"] for row in rows}


def get_meta(order_number: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM order_meta WHERE order_number = ?", (order_number,)
        ).fetchone()
    return dict(row) if row else None
