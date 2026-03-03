"""
Track-POD API client.

All requests are authenticated via the X-API-Key header.
Base URL: https://api.track-pod.com
"""

import requests
from typing import Optional

BASE_URL = "https://api.track-pod.com"


class TrackPodError(Exception):
    """Raised when the Track-POD API returns an error."""

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(f"Track-POD API error {status_code}: {message}")


class TrackPodClient:
    def __init__(self, api_key: str):
        self.session = requests.Session()
        self.session.headers.update({
            "X-API-Key": api_key,
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

    def get_orders(
        self,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        status: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> list:
        """
        Return a list of orders.

        date_from / date_to: ISO-8601 date strings, e.g. "2024-01-01"
        status: e.g. "Unassigned", "InProgress", "Delivered", ...
        """
        params: dict = {"page": page, "pageSize": page_size}
        if date_from:
            params["dateFrom"] = date_from
        if date_to:
            params["dateTo"] = date_to
        if status:
            params["status"] = status

        result = self._request("GET", "/order", params=params)
        # The API may return a list directly or wrap it in a key
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            for key in ("orders", "Orders", "data", "Data", "items", "Items"):
                if key in result:
                    return result[key]
        return result or []

    def get_order(self, order_number: str) -> dict:
        """Return a single order by its order number."""
        return self._request("GET", f"/order/{order_number}")

    def create_order(self, payload: dict) -> dict:
        """Create a new order. Returns the created order object."""
        return self._request("POST", "/order", json=[payload])

    def update_order(self, order_number: str, payload: dict) -> dict:
        """Update an existing order."""
        return self._request("PUT", f"/order/{order_number}", json=payload)

    def delete_order(self, order_number: str) -> None:
        """Delete an order (only allowed until Arrived status)."""
        self._request("DELETE", f"/order/{order_number}")

    # ------------------------------------------------------------------
    # Drivers (useful for assigning orders)
    # ------------------------------------------------------------------

    def get_drivers(self) -> list:
        """Return all drivers."""
        result = self._request("GET", "/driver")
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            for key in ("drivers", "Drivers", "data", "Data"):
                if key in result:
                    return result[key]
        return result or []
