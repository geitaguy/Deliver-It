"""
Track-POD API client.

Authentication: X-API-KEY header.
Base URL: https://api.track-pod.com
Rate limits: 20 req/s, 400 req/min.
"""

import requests
from datetime import date, timedelta
from typing import Optional

BASE_URL = "https://api.track-pod.com"


class TrackPodError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(f"Track-POD API error {status_code}: {message}")


class TrackPodClient:
    def __init__(self, api_key: str):
        self.session = requests.Session()
        self.session.headers.update({
            "X-API-KEY": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    def _request(self, method: str, path: str, **kwargs):
        url = f"{BASE_URL}{path}"
        response = self.session.request(method, url, **kwargs)
        if not response.ok:
            try:
                detail = response.json()
            except Exception:
                detail = response.text or response.reason
            raise TrackPodError(response.status_code, str(detail))
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    def get_orders_by_date(self, order_date: str) -> list:
        """
        Return all orders for a given date (yyyy-MM-dd).
        Uses GET /Order/Date/{date}.
        """
        result = self._request("GET", f"/Order/Date/{order_date}")
        return result if isinstance(result, list) else []

    def get_orders_for_range(self, date_from: str, date_to: str) -> list:
        """
        Fetch orders across a date range by iterating daily (max 31 days).
        date_from / date_to: 'yyyy-MM-dd'
        """
        start = date.fromisoformat(date_from)
        end   = date.fromisoformat(date_to)
        if (end - start).days > 30:
            end = start + timedelta(days=30)

        orders = []
        seen = set()
        current = start
        while current <= end:
            day_orders = self.get_orders_by_date(current.isoformat())
            for o in day_orders:
                num = o.get("Number") or o.get("Id") or ""
                if num not in seen:
                    seen.add(num)
                    orders.append(o)
            current += timedelta(days=1)
        return orders

    def get_order(self, number: str) -> dict:
        """Return a single order by its Number. GET /Order/Number/{number}"""
        return self._request("GET", f"/Order/Number/{number}")

    def create_order(self, payload: dict) -> dict:
        """
        Create a new unscheduled order. POST /Order
        Required fields: Client, Address.
        """
        return self._request("POST", "/Order", json=payload)

    def update_order(self, payload: dict) -> dict:
        """
        Update an existing order. PUT /Order
        The order is identified by Number (or Id) inside the payload.
        """
        return self._request("PUT", "/Order", json=payload)

    def delete_order(self, number: str) -> None:
        """Delete an order by Number. DELETE /Order/Number/{number}"""
        self._request("DELETE", f"/Order/Number/{number}")
