"""
Suburb delivery-day data and scheduling logic.

Data source
-----------
An Excel spreadsheet at  data/Delivery Days by Suburb.xlsx
Expected columns (header row auto-detected):
    Suburb | Postcode | Monday | Tuesday | Thursday | Friday

Wednesday routing
-----------------
Wednesday is a flexible route — NOT a column in the spreadsheet:
  • Normal Wednesday   → delivers to Friday-area suburbs
  • Monday is a WA public holiday → that Wednesday delivers to Monday-area suburbs instead

Western Australia public holidays
----------------------------------
Hardcoded for 2025-2027. Update WA_HOLIDAYS annually as dates are gazetted.
"""

from __future__ import annotations

import os
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# WA Public Holidays
# ---------------------------------------------------------------------------

WA_HOLIDAYS: frozenset[date] = frozenset(
    {
        # 2025
        date(2025,  1,  1),  # New Year's Day
        date(2025,  1, 27),  # Australia Day (observed; 26 Jan is Sunday)
        date(2025,  4, 18),  # Good Friday
        date(2025,  4, 19),  # Easter Saturday
        date(2025,  4, 21),  # Easter Monday
        date(2025,  4, 25),  # Anzac Day
        date(2025,  6,  2),  # Western Australia Day
        date(2025,  9, 22),  # Queen's Birthday (WA — last Mon September)
        date(2025, 12, 25),  # Christmas Day
        date(2025, 12, 26),  # Boxing Day
        # 2026
        date(2026,  1,  1),  # New Year's Day
        date(2026,  1, 26),  # Australia Day
        date(2026,  4,  3),  # Good Friday
        date(2026,  4,  4),  # Easter Saturday
        date(2026,  4,  6),  # Easter Monday
        date(2026,  4, 25),  # Anzac Day
        date(2026,  6,  1),  # Western Australia Day
        date(2026,  9, 28),  # Queen's Birthday (WA — last Mon September)
        date(2026, 12, 25),  # Christmas Day
        date(2026, 12, 28),  # Boxing Day (observed; 26 Dec is Saturday)
        # 2027
        date(2027,  1,  1),  # New Year's Day
        date(2027,  1, 26),  # Australia Day
        date(2027,  3, 26),  # Good Friday
        date(2027,  3, 27),  # Easter Saturday
        date(2027,  3, 29),  # Easter Monday
        date(2027,  4, 26),  # Anzac Day (observed; 25 Apr is Sunday)
        date(2027,  6,  7),  # Western Australia Day
        date(2027,  9, 27),  # Queen's Birthday (WA — last Mon September)
        date(2027, 12, 27),  # Christmas Day (observed; 25 Dec is Saturday)
        date(2027, 12, 28),  # Boxing Day (observed; 26 Dec is Sunday)
    }
)

_DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]


def is_wa_holiday(d: date) -> bool:
    return d in WA_HOLIDAYS


def _week_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _valid_on(delivery_days: set[str], d: date) -> bool:
    """
    Return True if a suburb with the given delivery_days set gets delivery on d.

    Rules:
      - No deliveries on weekends.
      - No deliveries on WA public holidays.
      - Wednesday is flexible:
          • If that week's Monday is a WA holiday → Wednesday covers Monday-area suburbs.
          • Otherwise                             → Wednesday covers Friday-area suburbs.
      - All other days map directly to delivery_days.
    """
    if d.weekday() >= 5:        # Weekend
        return False
    if is_wa_holiday(d):        # Public holiday — normal route doesn't run
        return False

    day_name = _DAY_ORDER[d.weekday()]  # Mon=0 … Fri=4

    if day_name == "Wednesday":
        monday = _week_monday(d)
        if is_wa_holiday(monday):
            return "Monday" in delivery_days   # Wednesday replaces Monday
        return "Friday" in delivery_days       # Normal Wednesday = Friday area

    return day_name in delivery_days


def upcoming_slots(
    delivery_days: set[str],
    n: int = 4,
    from_date: date | None = None,
) -> list[dict]:
    """Return the next *n* valid delivery dates (starting tomorrow)."""
    if from_date is None:
        from_date = date.today()

    results: list[dict] = []
    d = from_date + timedelta(days=1)
    while len(results) < n and (d - from_date).days <= 180:
        if _valid_on(delivery_days, d):
            results.append(
                {
                    "date": d.isoformat(),
                    "label": d.strftime("%a %-d %b"),
                    "day": _DAY_ORDER[d.weekday()] if d.weekday() < 5 else "",
                }
            )
        d += timedelta(days=1)

    return results


# ---------------------------------------------------------------------------
# Suburb data
# ---------------------------------------------------------------------------

_suburbs: list[dict] = []


def _is_truthy(v: object) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return str(v).strip().lower() not in ("", "false", "no", "0", "n", "none")


def load(filepath: str | None = None) -> int:
    """
    Load suburb delivery data from the Excel spreadsheet.
    Returns the number of suburbs loaded (0 if file is missing or invalid).
    """
    global _suburbs
    _suburbs = []

    if filepath is None:
        filepath = os.path.join(
            os.path.dirname(__file__), "data", "Delivery Days by Suburb.xlsx"
        )

    if not os.path.exists(filepath):
        return 0

    try:
        import openpyxl
    except ImportError:
        return 0

    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    ws = wb.active

    suburb_col: int | None = None
    postcode_col: int | None = None
    day_cols: dict[str, int] = {}
    data_start_row = 2

    # Auto-detect header row (scan first 6 rows)
    for ri, row in enumerate(ws.iter_rows(max_row=6, values_only=True), 1):
        for ci, val in enumerate(row, 1):
            key = str(val or "").strip().title()
            if key in ("Suburb", "Suburb Name"):
                suburb_col = ci
            elif key in ("Postcode", "Post Code", "Zip"):
                postcode_col = ci
            elif key in _DAY_ORDER:
                day_cols[key] = ci
        if day_cols:
            data_start_row = ri + 1
            break

    if not day_cols:
        wb.close()
        return 0

    for row in ws.iter_rows(min_row=data_start_row, values_only=True):
        suburb   = str(row[suburb_col   - 1] or "").strip() if suburb_col   else ""
        postcode = str(row[postcode_col - 1] or "").strip() if postcode_col else ""
        if not suburb and not postcode:
            continue

        # Strip trailing ".0" that openpyxl adds to numeric postcodes stored as float
        if postcode.endswith(".0"):
            postcode = postcode[:-2]

        delivery_days = {
            day for day, col in day_cols.items()
            if _is_truthy(row[col - 1])
        }
        if delivery_days:
            _suburbs.append(
                {"suburb": suburb, "postcode": postcode, "delivery_days": delivery_days}
            )

    wb.close()
    return len(_suburbs)


def search(query: str, limit: int = 15) -> list[dict]:
    """
    Search suburbs by name or postcode (case-insensitive substring match).
    Returns a list of dicts ready to serialise to JSON.
    """
    q = query.strip().lower()
    if not q:
        return []

    today = date.today()
    results: list[dict] = []

    for s in _suburbs:
        if q not in s["suburb"].lower() and q not in s["postcode"]:
            continue

        slots = upcoming_slots(s["delivery_days"], n=4, from_date=today)

        days_sorted = sorted(
            s["delivery_days"],
            key=lambda d: _DAY_ORDER.index(d) if d in _DAY_ORDER else 99,
        )

        # "Earliest available" = 2nd valid route from today
        earliest_idx = 1 if len(slots) >= 2 else (0 if slots else None)

        results.append(
            {
                "suburb": s["suburb"],
                "postcode": s["postcode"],
                "delivery_days": days_sorted,
                "earliest_date": slots[earliest_idx]["date"]  if earliest_idx is not None else None,
                "earliest_label": slots[earliest_idx]["label"] if earliest_idx is not None else None,
                "upcoming_slots": slots,
            }
        )

        if len(results) >= limit:
            break

    return results
