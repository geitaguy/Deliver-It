"""
Deliver-It — Flask web application for managing Track-POD orders.

Track-POD is the source of truth. This app:
  • Fetches orders from Track-POD by date and surfaces them in a browser UI.
  • Highlights orders that originated in Track-POD and have not yet been
    viewed / actioned inside Deliver-It.
  • Allows creating and updating orders via the Track-POD API.
  • Provides suburb delivery-day lookup with operational override management.
"""

import os
from datetime import date, timedelta
from flask import Flask, jsonify, render_template, request, abort
from dotenv import load_dotenv

import db
import delivery_data
from track_pod import TrackPodClient, TrackPodError

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-me-in-production")

_EXCEL_FILENAME = "Delivery Days by Suburb Updated.xlsx"
_EXCEL_PATH = next(
    (
        p for p in [
            os.path.join(os.path.dirname(__file__), _EXCEL_FILENAME),
            os.path.join(os.path.dirname(__file__), "data", _EXCEL_FILENAME),
        ]
        if os.path.exists(p)
    ),
    os.path.join(os.path.dirname(__file__), "data", _EXCEL_FILENAME),
)


def _client() -> TrackPodClient:
    api_key = os.environ.get("TRACK_POD_API_KEY", "")
    if not api_key:
        abort(503, description="TRACK_POD_API_KEY is not configured.")
    return TrackPodClient(api_key)


with app.app_context():
    db.init_db()

    # Always import suburb data from Excel so the live spreadsheet stays in sync.
    n = db.import_suburbs_from_excel(_EXCEL_PATH)
    if n:
        app.logger.info("Suburb data: imported %d suburbs from %s.", n, _EXCEL_PATH)
    else:
        app.logger.warning(
            "Suburb data: no data imported — spreadsheet not found or empty. "
            "Expected: %s", _EXCEL_PATH
        )


# ---------------------------------------------------------------------------
# HTML page
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    return render_template("home.html")


@app.route("/app")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# JSON API — Orders
# ---------------------------------------------------------------------------

@app.route("/api/orders", methods=["GET"])
def list_orders():
    """
    Fetch orders from Track-POD for a date or date range, merge with local
    view-tracking metadata, and flag orders not yet viewed in Deliver-It.

    Query params (at least one date is recommended):
      date        YYYY-MM-DD  (single day; defaults to today if omitted)
      date_from   YYYY-MM-DD  (used together for a range)
      date_to     YYYY-MM-DD  (used together for a range)
    """
    client = _client()

    date_from = request.args.get("date_from")
    date_to   = request.args.get("date_to")
    single    = request.args.get("date")

    try:
        if date_from and date_to:
            orders = client.get_orders_for_range(date_from, date_to)
        elif date_from:
            orders = client.get_orders_by_date(date_from)
        elif date_to:
            orders = client.get_orders_by_date(date_to)
        elif single:
            orders = client.get_orders_by_date(single)
        else:
            orders = client.get_orders_by_date(date.today().isoformat())
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    order_numbers = [o.get("Number", "") for o in orders if o.get("Number")]
    db.mark_orders_seen(order_numbers)

    viewed = db.get_viewed_set()

    def _suppress_new(order: dict) -> bool:
        status = (order.get("Status") or "").lower()
        return any(s in status for s in ("deliver", "complet", "collect", "progress", "transit"))

    enriched = [
        {**o, "_new": o.get("Number", "") not in viewed and not _suppress_new(o)}
        for o in orders
    ]

    return jsonify(enriched)


@app.route("/api/orders/<path:order_number>", methods=["GET"])
def get_order(order_number: str):
    """Fetch a single order by Number and mark it as viewed."""
    client = _client()
    try:
        order = client.get_order(order_number)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    db.mark_order_viewed(order_number)
    meta = db.get_meta(order_number)

    return jsonify({**order, "_meta": meta})


@app.route("/api/orders", methods=["POST"])
def create_order():
    """
    Create a new order in Track-POD. POST /Order

    Required fields (enforced by Track-POD): Client, Address.
    """
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "Request body must be JSON."}), 400

    client = _client()
    try:
        result = client.create_order(payload)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    order_number = payload.get("Number") or _extract_number(result or {})
    if order_number:
        db.mark_orders_seen([order_number])
        db.mark_order_viewed(order_number)

    return jsonify(result or {"success": True}), 201


@app.route("/api/orders/<path:order_number>", methods=["PUT"])
def update_order(order_number: str):
    """
    Update an existing order. PUT /Order
    The Number field in the body identifies the order.
    """
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "Request body must be JSON."}), 400

    # Ensure the Number in the body matches the URL so the right record is updated
    payload["Number"] = order_number

    client = _client()
    try:
        result = client.update_order(payload)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    db.mark_order_viewed(order_number)
    return jsonify(result or {"success": True})


@app.route("/api/orders/<path:order_number>/viewed", methods=["POST"])
def mark_viewed(order_number: str):
    """Mark an order as viewed without fetching its full detail."""
    db.mark_order_viewed(order_number)
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# JSON API — Routes (Track-POD)
# ---------------------------------------------------------------------------

@app.route("/api/routes", methods=["GET"])
def list_routes():
    """List routes for a date. GET /api/routes?date=YYYY-MM-DD"""
    date_str = request.args.get("date", date.today().isoformat())
    client = _client()
    try:
        routes = client.get_routes_by_date(date_str)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    return jsonify(routes)


@app.route("/api/routes", methods=["POST"])
def create_route():
    """Create a new route in Track-POD."""
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "Request body must be JSON."}), 400
    client = _client()
    try:
        result = client.create_route(payload)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    return jsonify(result or {"success": True}), 201


@app.route("/api/routes/<path:route_code>", methods=["PUT"])
def update_route(route_code: str):
    """Update a route by its code."""
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "Request body must be JSON."}), 400
    client = _client()
    try:
        result = client.update_route(route_code, payload)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    return jsonify(result or {"success": True})


@app.route("/api/routes/<path:route_code>/orders/<path:order_number>", methods=["PUT"])
def assign_order_to_route(route_code: str, order_number: str):
    """Assign an existing unscheduled order to a route."""
    allow_transfer = request.args.get("allowTransfer", "false").lower() == "true"
    client = _client()
    try:
        client.add_order_to_route(route_code, order_number, allow_transfer)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# JSON API — Suburb delivery-day lookup
# ---------------------------------------------------------------------------

@app.route("/api/suburb-search")
def suburb_search():
    """
    Search for a suburb by name or postcode and return delivery day information
    with upcoming slots (override-aware).

    Query params:
      q   Suburb name or postcode (partial match, case-insensitive)
    """
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])

    today     = date.today()
    horizon   = (today + timedelta(days=180)).isoformat()
    suburbs   = db.search_suburbs(q)
    overrides = db.get_route_overrides(today.isoformat(), horizon)

    results = []
    for s in suburbs:
        delivery_days = {
            day for day in delivery_data.ROUTING_AREAS
            if s[day.lower()]
        }
        slots = delivery_data.upcoming_slots(
            delivery_days, n=4, from_date=today, overrides=overrides
        )
        days_sorted = sorted(
            delivery_days,
            key=lambda d: delivery_data.DAY_ORDER.index(d) if d in delivery_data.DAY_ORDER else 99,
        )
        # "Earliest available" = 2nd valid route from today
        earliest_idx = 1 if len(slots) >= 2 else (0 if slots else None)
        results.append(
            {
                "suburb":         s["suburb"],
                "postcode":       s["postcode"],
                "delivery_days":  days_sorted,
                "earliest_date":  slots[earliest_idx]["date"]  if earliest_idx is not None else None,
                "earliest_label": slots[earliest_idx]["label"] if earliest_idx is not None else None,
                "upcoming_slots": slots,
            }
        )

    return jsonify(results)


@app.route("/api/wa-holidays")
def wa_holidays():
    """
    Return WA public holidays as {date: name} for the current and next year.
    Accepts an optional ?year= query param to target a specific year.
    """
    try:
        year = int(request.args.get("year", 0))
        years = [year] if year else [date.today().year, date.today().year + 1]
    except ValueError:
        return jsonify({"error": "year must be an integer"}), 400
    return jsonify(delivery_data.wa_holidays_for_years(years))


@app.route("/api/calendar")
def calendar_data():
    """
    Return per-day delivery status for a given month.

    Query params: ?year=YYYY&month=M  (defaults to current month)

    Response: { "YYYY-MM-DD": { area, status, message, holiday } ... }
      area    — canonical routing area that runs that day, or null
      status  — "normal" | "full" | "limited" | "cancelled" | "rescheduled"
      message — override message or null
      holiday — true if it is a WA public holiday
    """
    import calendar as _cal
    try:
        today = date.today()
        year  = int(request.args.get("year",  today.year))
        month = int(request.args.get("month", today.month))
        if not (1 <= month <= 12):
            raise ValueError
    except ValueError:
        return jsonify({"error": "Invalid year or month"}), 400

    first_day = date(year, month, 1)
    last_day  = date(year, month, _cal.monthrange(year, month)[1])

    overrides = db.get_route_overrides(first_day.isoformat(), last_day.isoformat())
    override_by_key = {(ov["date"], ov["routing_area"]): ov for ov in overrides}

    days: dict[str, dict] = {}
    d = first_day
    while d <= last_day:
        d_str   = d.isoformat()
        area    = delivery_data.effective_routing_area(d)
        holiday = delivery_data.is_wa_holiday(d)
        status  = "normal"
        message = None

        if area:
            ov = override_by_key.get((d_str, area))
            if ov:
                status  = ov["status"]
                message = ov.get("message")

        days[d_str] = {
            "area":    area,
            "status":  status,
            "message": message,
            "holiday": holiday,
        }
        d += timedelta(days=1)

    return jsonify(days)


# ---------------------------------------------------------------------------
# JSON API — Route availability overrides
# ---------------------------------------------------------------------------

@app.route("/api/route-overrides", methods=["GET"])
def list_route_overrides():
    """
    List route overrides, optionally filtered to a date range.

    Query params:
      from   YYYY-MM-DD  (inclusive start)
      to     YYYY-MM-DD  (inclusive end)
    """
    from_date = request.args.get("from")
    to_date   = request.args.get("to")
    return jsonify(db.get_route_overrides(from_date, to_date))


@app.route("/api/route-overrides", methods=["POST"])
def create_route_override():
    """
    Create or update a route override for a specific (date, routing_area).

    Body JSON:
      date             YYYY-MM-DD   required
      routing_area     str          required — Monday/Tuesday/Thursday/Friday
      status           str          required — cancelled/full/rescheduled
      rescheduled_date YYYY-MM-DD   required when status=rescheduled
      message          str          optional custom message shown to staff
    """
    body = request.get_json(force=True, silent=True) or {}

    date_val         = (body.get("date")             or "").strip()
    routing_area     = (body.get("routing_area")     or "").strip()
    status           = (body.get("status")           or "").strip()
    rescheduled_date = (body.get("rescheduled_date") or "").strip() or None
    message          = (body.get("message")          or "").strip() or None

    if not date_val:
        return jsonify({"error": "date is required."}), 400
    if routing_area not in db.ROUTING_AREAS:
        return jsonify({"error": f"routing_area must be one of {sorted(db.ROUTING_AREAS)}."}), 400
    if status not in db.VALID_STATUSES:
        return jsonify({"error": f"status must be one of {sorted(db.VALID_STATUSES)}."}), 400
    if not message:
        return jsonify({"error": "message is required."}), 400
    if status == "rescheduled" and not rescheduled_date:
        return jsonify({"error": "rescheduled_date is required when status is 'rescheduled'."}), 400

    result = db.upsert_route_override(date_val, routing_area, status, rescheduled_date, message)
    return jsonify(result), 201


@app.route("/api/route-overrides/<int:override_id>", methods=["DELETE"])
def delete_route_override(override_id: int):
    """Remove a route override by its database ID."""
    if not db.delete_route_override(override_id):
        return jsonify({"error": "Override not found."}), 404
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_number(order: dict) -> str | None:
    return order.get("Number") or order.get("Id") or None


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(503)
def service_unavailable(exc):
    return jsonify({"error": str(exc.description)}), 503


@app.errorhandler(404)
def not_found(exc):
    return jsonify({"error": "Not found"}), 404


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", debug=os.environ.get("FLASK_DEBUG", "0") == "1", port=port)
