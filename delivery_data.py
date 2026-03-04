"""
Suburb delivery scheduling logic.

Wednesday routing
-----------------
Wednesday is a flexible route — NOT stored in the suburb table:
  • Normal Wednesday   → delivers to Friday-area suburbs.
  • Monday is a WA public holiday → that Wednesday delivers to Monday-area suburbs instead.

The four canonical routing areas are: Monday, Tuesday, Thursday, Friday.

Western Australia public holidays
----------------------------------
Sourced from the `holidays` package (AU/WA).  One correction is applied:
WA officially observes Easter Saturday, but the package includes Easter Sunday
instead — so Easter Sunday is dropped and Easter Saturday (Good Friday + 1) is
added.  All other dates (Labour Day, King's Birthday, observed days, etc.) are
generated automatically and stay up-to-date without manual maintenance.
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

import holidays as _holidays_pkg

# ---------------------------------------------------------------------------
# WA Public Holidays
# ---------------------------------------------------------------------------

@lru_cache(maxsize=16)
def _wa_holidays_for_year(year: int) -> frozenset[date]:
    """
    Return WA public holidays for *year* as a frozenset of dates.

    The `holidays` package includes Easter Sunday for WA, which is incorrect —
    WA observes Easter Saturday instead.  We swap them here.
    """
    raw = _holidays_pkg.country_holidays("AU", subdiv="WA", years=year)
    result: set[date] = set(raw.keys())

    # Replace Easter Sunday with Easter Saturday
    easter_sundays = {d for d, name in raw.items() if name == "Easter Sunday"}
    result -= easter_sundays
    result |= {d + timedelta(days=-1) for d in easter_sundays}  # Saturday = Sunday - 1

    return frozenset(result)


def is_wa_holiday(d: date) -> bool:
    return d in _wa_holidays_for_year(d.year)


def wa_holidays_for_years(years: list[int]) -> dict[str, str]:
    """Return {ISO-date: name} for the requested years, with the Easter fix applied."""
    result: dict[str, str] = {}
    for year in years:
        raw = _holidays_pkg.country_holidays("AU", subdiv="WA", years=year)
        for d, name in raw.items():
            if name == "Easter Sunday":
                result[(d + timedelta(days=-1)).isoformat()] = "Easter Saturday"
            else:
                result[d.isoformat()] = name
    return result


DAY_ORDER     = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
ROUTING_AREAS = ["Monday", "Tuesday", "Thursday", "Friday"]   # canonical areas (no Wednesday)


def _week_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def effective_routing_area(d: date) -> str | None:
    """
    Return the canonical routing area (Monday/Tuesday/Thursday/Friday) that
    runs on date *d*.  Returns None for weekends and public holidays.
    Wednesday resolves to Friday's area normally, or Monday's area when that
    week's Monday is a WA public holiday.
    """
    if d.weekday() >= 5 or is_wa_holiday(d):
        return None
    day_name = _DAY_ORDER[d.weekday()]
    if day_name == "Wednesday":
        monday = _week_monday(d)
        return "Monday" if is_wa_holiday(monday) else "Friday"
    return day_name


def _valid_on(delivery_days: set[str], d: date) -> bool:
    """
    Return True if a suburb whose delivery_days set matches the routing area
    that runs on date *d* (WA holidays and weekends excluded).
    """
    area = effective_routing_area(d)
    return area is not None and area in delivery_days


# ---------------------------------------------------------------------------
# Upcoming slot calculation (override-aware)
# ---------------------------------------------------------------------------

def upcoming_slots(
    delivery_days: set[str],
    n: int = 4,
    from_date: date | None = None,
    overrides: list[dict] | None = None,
) -> list[dict]:
    """
    Return the next *n* valid delivery dates for a suburb, starting tomorrow.

    Each returned slot dict has at minimum:
        date            YYYY-MM-DD
        label           "Mon 9 Mar"
        day             canonical routing area name

    Overrides can add:
        full            True            (no more orders accepted)
        rescheduled_from  YYYY-MM-DD    (this slot replaces a rescheduled date)
        message         str             (custom staff message)

    Overrides with status='cancelled' or 'rescheduled' cause that date to be
    skipped.  Rescheduled overrides inject the rescheduled_date as a new slot
    (provided the suburb's delivery_days match the rescheduled routing_area).
    """
    if from_date is None:
        from_date = date.today()

    # Index overrides for O(1) lookup
    override_by_key: dict[tuple[str, str], dict] = {}
    reschedule_targets: dict[str, list[dict]] = {}
    for ov in (overrides or []):
        override_by_key[(ov["date"], ov["routing_area"])] = ov
        if ov["status"] == "rescheduled" and ov.get("rescheduled_date"):
            reschedule_targets.setdefault(ov["rescheduled_date"], []).append(ov)

    results: list[dict] = []
    d = from_date + timedelta(days=1)
    while len(results) < n and (d - from_date).days <= 180:
        slot = _slot_for_date(d, delivery_days, override_by_key, reschedule_targets)
        if slot:
            results.append(slot)
        d += timedelta(days=1)

    return results


def _slot_for_date(
    d: date,
    delivery_days: set[str],
    override_by_key: dict[tuple[str, str], dict],
    reschedule_targets: dict[str, list[dict]],
) -> dict | None:
    d_str = d.isoformat()
    label = d.strftime("%a %-d %b")

    if _valid_on(delivery_days, d):
        eff = effective_routing_area(d)
        ov  = override_by_key.get((d_str, eff))

        if ov is None:
            return {"date": d_str, "label": label, "day": eff}

        if ov["status"] == "full":
            return {
                "date": d_str, "label": label, "day": eff,
                "full": True, "message": ov.get("message") or "",
            }

        if ov["status"] == "limited":
            return {
                "date": d_str, "label": label, "day": eff,
                "limited": True, "message": ov.get("message") or "",
            }

        # status is 'cancelled' or 'rescheduled' — skip this date.
        return None

    # Not a normal delivery day — check if a rescheduled route lands here.
    for ov in reschedule_targets.get(d_str, []):
        if ov["routing_area"] in delivery_days:
            return {
                "date": d_str, "label": label, "day": ov["routing_area"],
                "rescheduled_from": ov["date"],
                "message": ov.get("message") or "",
            }

    return None
