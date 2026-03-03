"""
Deliver-It — Flask web application for managing Track-POD orders.

Track-POD is the source of truth.  This app:
  • Fetches orders from Track-POD and surfaces them in a browser UI.
  • Highlights orders that originated in Track-POD and have not yet been
    viewed / actioned inside Deliver-It.
  • Allows creating and updating orders via the Track-POD API.
"""

import os
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


# ---------------------------------------------------------------------------
# Initialise DB on first request
# ---------------------------------------------------------------------------

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
    Fetch orders from Track-POD, merge with local view-tracking metadata,
    and flag orders that have never been viewed inside Deliver-It.

    Query params (all optional):
      date_from   YYYY-MM-DD
      date_to     YYYY-MM-DD
      status      e.g. Unassigned / InProgress / Delivered
      page        integer (default 1)
      page_size   integer (default 50)
    """
    client = _client()

    try:
        orders = client.get_orders(
            date_from=request.args.get("date_from"),
            date_to=request.args.get("date_to"),
            status=request.args.get("status"),
            page=int(request.args.get("page", 1)),
            page_size=int(request.args.get("page_size", 50)),
        )
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    # Persist the fact that we saw these orders
    order_numbers = [_order_number(o) for o in orders if _order_number(o)]
    db.mark_orders_seen(order_numbers)

    viewed = db.get_viewed_set()

    enriched = []
    for order in orders:
        num = _order_number(order)
        enriched.append({
            **order,
            "_new": num not in viewed,  # True → originated in Track-POD, not yet actioned here
        })

    return jsonify(enriched)


@app.route("/api/orders/<order_number>", methods=["GET"])
def get_order(order_number: str):
    """Fetch a single order from Track-POD and mark it as viewed."""
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
    Create a new order in Track-POD.

    Expects a JSON body matching Track-POD's order creation schema.
    Required fields (minimum): OrderNumber, Address1, City, ContactName,
    DeliveryDate.
    """
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "Request body must be JSON."}), 400

    client = _client()
    try:
        result = client.create_order(payload)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    # If Track-POD echoes the created order, mark it viewed immediately
    # (we created it here, so it's not "new from Track-POD").
    order_number = payload.get("OrderNumber") or _order_number(result or {})
    if order_number:
        db.mark_orders_seen([order_number])
        db.mark_order_viewed(order_number)

    return jsonify(result or {"success": True}), 201


@app.route("/api/orders/<order_number>", methods=["PUT"])
def update_order(order_number: str):
    """Update an existing order in Track-POD."""
    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({"error": "Request body must be JSON."}), 400

    client = _client()
    try:
        result = client.update_order(order_number, payload)
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code

    db.mark_order_viewed(order_number)
    return jsonify(result or {"success": True})


@app.route("/api/orders/<order_number>/viewed", methods=["POST"])
def mark_viewed(order_number: str):
    """Mark an order as viewed/actioned without fetching its full detail."""
    db.mark_order_viewed(order_number)
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# JSON API — Drivers (supporting data for the order form)
# ---------------------------------------------------------------------------

@app.route("/api/drivers", methods=["GET"])
def list_drivers():
    client = _client()
    try:
        drivers = client.get_drivers()
    except TrackPodError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    return jsonify(drivers)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _order_number(order: dict) -> str | None:
    """Extract the order number regardless of Track-POD's casing."""
    for key in ("OrderNumber", "orderNumber", "order_number", "Number", "number"):
        if key in order:
            return str(order[key])
    return None


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
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1", port=port)
