"""
Deliver-It — Flask web application for managing Track-POD orders.

Track-POD is the source of truth. This app:
  • Fetches orders from Track-POD by date and surfaces them in a browser UI.
  • Highlights orders that originated in Track-POD and have not yet been
    viewed / actioned inside Deliver-It.
  • Allows creating and updating orders via the Track-POD API.
"""

import os
from datetime import date
from flask import Flask, jsonify, render_template, request, abort
from dotenv import load_dotenv

import db
from track_pod import TrackPodClient, TrackPodError

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-me-in-production")


def _client() -> TrackPodClient:
    api_key = os.environ.get("TRACK_POD_API_KEY", "")
    if not api_key:
        abort(503, description="TRACK_POD_API_KEY is not configured.")
    return TrackPodClient(api_key)


with app.app_context():
    db.init_db()


# ---------------------------------------------------------------------------
# HTML page
# ---------------------------------------------------------------------------

@app.route("/")
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
    enriched = [{**o, "_new": o.get("Number", "") not in viewed} for o in orders]

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
