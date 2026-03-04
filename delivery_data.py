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
Hardcoded for 2025-2027. Update WA_HOLIDAYS annually as dates are gazetted.
"""

from __future__ import annotations

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

_DAY_ORDER   = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
ROUTING_AREAS = ["Monday", "Tuesday", "Thursday", "Friday"]   # canonical areas (no Wednesday)


def is_wa_holiday(d: date) -> bool:
    return d in WA_HOLIDAYS


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
