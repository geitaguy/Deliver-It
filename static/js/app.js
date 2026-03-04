/* ============================================================
   Deliver-It — frontend application
   Track-POD field reference:
     Number, Client, Address, Date, TimeSlotFrom, TimeSlotTo,
     ContactName, Phone, Email, Note, Weight, Volume, Pallets,
     Status, StatusId, RouteDate, DriverName, GoodsList[]
       └─ GoodsName, Quantity, GoodsUnit, Note
   ============================================================ */

(function () {
  "use strict";

  // ----------------------------------------------------------------
  // State
  // ----------------------------------------------------------------

  const today = new Date().toISOString().slice(0, 10);

  const state = {
    orders:       [],
    routes:       [],
    loading:      false,
    statusFilter: "all",
    query:        { mode: "day", date: today, date_from: today, date_to: today },
    panel:        { mode: null, order: null, route: null },
  };

  // ----------------------------------------------------------------
  // DOM helpers
  // ----------------------------------------------------------------

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  // ----------------------------------------------------------------
  // Toast
  // ----------------------------------------------------------------

  function toast(message, type = "info") {
    const el = document.createElement("div");
    el.className = `toast-msg ${type}`;
    el.textContent = message;
    $("#toast").appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ----------------------------------------------------------------
  // API helpers
  // ----------------------------------------------------------------

  async function apiFetch(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  }

  // ----------------------------------------------------------------
  // Load orders
  // ----------------------------------------------------------------

  async function loadOrders() {
    state.loading = true;
    renderOrderList();

    const params = new URLSearchParams();
    const q = state.query;
    let routeDate;
    if (q.mode === "range") {
      params.set("date_from", q.date_from);
      params.set("date_to",   q.date_to);
      routeDate = q.date_from;
    } else {
      params.set("date", q.date);
      routeDate = q.date;
    }

    try {
      const [ordersResult, routesResult] = await Promise.allSettled([
        apiFetch(`/api/orders?${params}`),
        apiFetch(`/api/routes?date=${routeDate}`),
      ]);
      state.orders = ordersResult.status === "fulfilled" ? ordersResult.value : [];
      state.routes = routesResult.status === "fulfilled" ? routesResult.value : [];
      if (ordersResult.status === "rejected") toast(ordersResult.reason.message, "error");
    } finally {
      state.loading = false;
      renderOrderList();
      updateNewCount();
      updateDateLabel();
    }
  }

  function updateNewCount() {
    const count = state.orders.filter(o => o._new).length;
    const badge = $("#new-count-badge");
    const label = $("#new-count-label");
    if (count > 0) {
      label.textContent = `${count} new`;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }

  function updateDateLabel() {
    const el = $("#orders-date-label");
    const q = state.query;
    if (q.mode === "range") {
      el.textContent = `${q.date_from} – ${q.date_to}`;
    } else {
      el.textContent = q.date === today ? "(today)" : `(${q.date})`;
    }
  }

  // ----------------------------------------------------------------
  // Render order table
  // ----------------------------------------------------------------

  function statusCategory(status = "") {
    const s = status.toLowerCase();
    if (s.includes("deliver") || s.includes("complet") || s.includes("collect")) return "completed";
    if (s.includes("progress") || s.includes("transit") || s.includes("route") || s.includes("assign")) return "progress";
    if (s.includes("fail") || s.includes("cancel") || s.includes("reject") || s.includes("not")) return "failed";
    return "unassigned";
  }

  function statusBadgeClass(status = "") {
    const cat = statusCategory(status);
    if (cat === "completed") return "badge-delivered";
    if (cat === "progress")  return "badge-progress";
    if (cat === "failed")    return "badge-failed";
    return "badge-status";
  }

  function routeNameForDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const days   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
  }

  function routeStatusBadgeClass(status = "") {
    switch (status) {
      case "Ready":      return "badge-route-ready";
      case "Loaded":     return "badge-route-loaded";
      case "InProgress": return "badge-route-progress";
      case "Closed":     return "badge-route-closed";
      default:           return "badge-route-draft";
    }
  }

  function orderRowHTML(o, stopLabel = "") {
    const num    = o.Number || o.Id || "—";
    const client = o.Client || "—";
    const addr   = o.Address || "—";
    const dt     = formatDate(o.Date || o.RouteDate || "");
    const status = o.Status || "Unassigned";
    const isNew  = o._new;

    const rowClass = [
      isNew                    ? "is-new"           : "",
      stopLabel === "current"  ? "is-current-stop"  : "",
      stopLabel === "next"     ? "is-next-stop"      : "",
    ].filter(Boolean).join(" ");

    const stopBadge = stopLabel === "current"
      ? '<span class="badge badge-current-stop">▶ Now</span>'
      : stopLabel === "next"
        ? '<span class="badge badge-next-stop">Next</span>'
        : "";

    const lastCell = [
      isNew ? '<span class="badge badge-new"><span class="dot-new"></span>New</span>' : "",
      stopBadge,
    ].filter(Boolean).join(" ");

    return `<tr class="${rowClass}" data-order="${escAttr(num)}" tabindex="0">
      <td>${isNew ? '<span class="dot-new" title="Not yet viewed in Deliver-It"></span>' : ""}</td>
      <td><strong>${escHtml(num)}</strong></td>
      <td>${escHtml(client)}</td>
      <td>${escHtml(addr)}</td>
      <td>${escHtml(dt)}</td>
      <td><span class="badge ${statusBadgeClass(status)}">${escHtml(status)}</span></td>
      <td>${lastCell}</td>
    </tr>`;
  }

  function stopLabels(orders) {
    // For an InProgress route: find the current stop (first non-done order by SeqNumber)
    // and the next stop (second non-done order). Returns a Map of order key → label.
    const sorted = [...orders].sort((a, b) => (a.SeqNumber ?? 9999) - (b.SeqNumber ?? 9999));
    const pending = sorted.filter(o => {
      const cat = statusCategory(o.Status || "");
      return cat !== "completed" && cat !== "failed";
    });
    const map = new Map();
    if (pending[0]) map.set(pending[0].Number || pending[0].Id, "current");
    if (pending[1]) map.set(pending[1].Number || pending[1].Id, "next");
    return map;
  }

  function groupByRoute(orders) {
    const groups     = {};
    const unassigned = [];
    for (const o of orders) {
      const rn = o.RouteNumber || null;
      if (rn) {
        if (!groups[rn]) groups[rn] = [];
        groups[rn].push(o);
      } else {
        unassigned.push(o);
      }
    }
    return { groups, unassigned };
  }

  function routeSectionHeaderHTML(code, route, count) {
    const status = route ? (route.Status || "") : "";
    const driver = route ? (route.DriverName || "") : "";
    const meta   = [driver, `${count} order${count !== 1 ? "s" : ""}`].filter(Boolean).join(" · ");
    const badge  = status
      ? `<span class="badge ${routeStatusBadgeClass(status)}">${escHtml(status)}</span>`
      : "";
    return `<tr class="route-section-hdr">
      <td colspan="7">
        <div class="route-section-inner">
          <span class="route-section-name">${escHtml(code)}</span>
          ${badge}
          <span class="route-section-meta">${escHtml(meta)}</span>
          <button class="btn btn-ghost btn-sm route-view-btn" data-route-code="${escAttr(code)}"
                  style="margin-left:auto;font-size:.72rem">View</button>
        </div>
      </td>
    </tr>`;
  }

  function unassignedSectionHeaderHTML(count) {
    return `<tr class="route-section-hdr unassigned">
      <td colspan="7">
        <div class="route-section-inner">
          <span class="route-section-name" style="color:var(--text-muted)">Unassigned</span>
          <span class="route-section-meta">${count} order${count !== 1 ? "s" : ""}</span>
        </div>
      </td>
    </tr>`;
  }

  function renderOrderList() {
    const tbody = $("#orders-tbody");
    const empty = $("#orders-empty");

    if (state.loading) {
      tbody.innerHTML = `<tr><td colspan="7">
        <div class="state-msg">
          <div class="spinner"></div>
          <div>Loading orders from Track-POD…</div>
        </div></td></tr>`;
      empty.style.display = "none";
      return;
    }

    if (!state.orders.length) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    const visible = state.statusFilter === "all"
      ? state.orders
      : state.orders.filter(o => statusCategory(o.Status || "") === state.statusFilter);

    if (!visible.length) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";

    const { groups, unassigned } = groupByRoute(visible);
    const routeCodes = Object.keys(groups).sort();

    // Build Code → route object lookup from fetched routes
    const routeMap = {};
    for (const r of state.routes) {
      if (r.Code) routeMap[r.Code] = r;
    }

    let html = "";
    for (const code of routeCodes) {
      const route   = routeMap[code] || null;
      const orders  = groups[code];
      html += routeSectionHeaderHTML(code, route, orders.length);
      if (route && route.Status === "InProgress") {
        const labels = stopLabels(orders);
        html += orders.map(o => orderRowHTML(o, labels.get(o.Number || o.Id) || "")).join("");
      } else {
        html += orders.map(o => orderRowHTML(o)).join("");
      }
    }
    if (unassigned.length) {
      if (routeCodes.length > 0) html += unassignedSectionHeaderHTML(unassigned.length);
      html += unassigned.map(orderRowHTML).join("");
    }

    tbody.innerHTML = html;

    $$("tbody tr[data-order]").forEach(row => {
      row.addEventListener("click", () => openOrderDetail(row.dataset.order));
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") openOrderDetail(row.dataset.order);
      });
    });

    $$("tbody .route-view-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const code = btn.dataset.routeCode;
        openPanel("route-view", null, routeMap[code] || { Code: code });
      });
    });
  }

  // ----------------------------------------------------------------
  // Order detail panel
  // ----------------------------------------------------------------

  async function openOrderDetail(orderNumber) {
    openPanel("loading");
    try {
      const order = await apiFetch(`/api/orders/${encodeURIComponent(orderNumber)}`);
      clearNewFromRow(orderNumber);
      openPanel("view", order);
    } catch (err) {
      toast(err.message, "error");
      closePanel();
    }
  }

  function clearNewFromRow(orderNumber) {
    const row = $(`tr[data-order="${CSS.escape(orderNumber)}"]`);
    if (row) {
      row.classList.remove("is-new");
      $$(".dot-new, .badge-new", row).forEach(el => el.remove());
    }
    const idx = state.orders.findIndex(o => (o.Number || o.Id) === orderNumber);
    if (idx !== -1) state.orders[idx]._new = false;
    updateNewCount();
  }

  function openPanel(mode, order = null, route = null) {
    state.panel = { mode, order, route };
    renderPanel();
    $("#overlay").classList.add("open");
  }

  function closePanel() {
    state.panel = { mode: null, order: null, route: null };
    $("#overlay").classList.remove("open");
  }

  function renderPanel() {
    const { mode, order, route } = state.panel;
    const header = $("#panel-header");
    const body   = $("#panel-body");
    const footer = $("#panel-footer");

    if (mode === "loading") {
      header.innerHTML = `<h2>Loading…</h2>
        <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;
      body.innerHTML = `<div class="state-msg"><div class="spinner"></div><div>Fetching order…</div></div>`;
      footer.innerHTML = "";
    } else if (mode === "create") {
      renderCreateForm(header, body, footer);
    } else if (mode === "view") {
      renderViewPanel(order, header, body, footer);
    } else if (mode === "edit") {
      renderEditForm(order, header, body, footer);
    } else if (mode === "route-view") {
      renderRouteViewPanel(route, header, body, footer);
    } else if (mode === "route-create") {
      renderRouteCreateForm(header, body, footer);
    } else if (mode === "route-edit") {
      renderRouteEditForm(route, header, body, footer);
    }

    // Wire close buttons (any .close-panel-btn)
    $$(".close-panel-btn").forEach(btn => btn.addEventListener("click", closePanel));
  }

  // ---- View (read-only) ----

  function renderViewPanel(order, header, body, footer) {
    const num = order.Number || order.Id || "—";

    header.innerHTML = `
      <div>
        <h2>Order ${escHtml(num)}</h2>
        ${order._new ? '<span class="badge badge-new" style="margin-top:.25rem"><span class="dot-new"></span>New from Track-POD</span>' : ""}
      </div>
      <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;

    body.innerHTML = `
      <div class="section-title">Delivery Details</div>
      <div class="detail-grid">
        ${detailField("Order Number",   num)}
        ${detailField("Status",         order.Status)}
        ${detailField("Order Date",     formatDate(order.Date))}
        ${detailField("Route Date",     formatDate(order.RouteDate))}
        ${detailField("Time Window",    timeWindow(order))}
        ${detailField("Driver",         order.DriverName)}
        ${detailField("Route",          order.RouteNumber)}
        ${detailField("Priority",       order.Priority)}
      </div>

      <div class="section-title" style="margin-top:1rem">Client & Contact</div>
      <div class="detail-grid">
        ${detailField("Client",         order.Client)}
        ${detailField("Contact Name",   order.ContactName)}
        ${detailField("Phone",          order.Phone)}
        ${detailField("Email",          order.Email)}
      </div>

      <div class="section-title" style="margin-top:1rem">Address</div>
      <div class="detail-grid">
        ${detailField("Address",        order.Address, true)}
        ${detailField("Depot",          order.Depot)}
        ${detailField("Shipper",        order.Shipper)}
      </div>

      <div class="section-title" style="margin-top:1rem">Load</div>
      <div class="detail-grid">
        ${detailField("Weight",         order.Weight != null ? order.Weight : null)}
        ${detailField("Volume",         order.Volume != null ? order.Volume : null)}
        ${detailField("Pallets",        order.Pallets != null ? order.Pallets : null)}
        ${detailField("COD",            order.COD != null ? `${order.COD}` : null)}
      </div>

      ${order.Note ? `
        <div class="section-title" style="margin-top:1rem">Notes</div>
        <div class="detail-field full">
          <span class="value">${escHtml(order.Note)}</span>
        </div>` : ""}

      ${renderGoodsReadOnly(order.GoodsList)}

      ${order.DriverComment ? `
        <div class="section-title" style="margin-top:1rem">Driver Comment</div>
        <div class="detail-field full"><span class="value">${escHtml(order.DriverComment)}</span></div>` : ""}

      ${renderDeliveryOutcome(order)}

      ${renderMeta(order._meta)}`;

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm close-panel-btn">Close</button>
      <button class="btn btn-primary btn-sm" id="edit-order-btn">Edit Order</button>`;

    $("#edit-order-btn").addEventListener("click", () => openPanel("edit", order));
  }

  function detailField(label, value, fullWidth = false) {
    if (value === null || value === undefined || value === "" || value === "—") return "";
    return `<div class="detail-field${fullWidth ? " full" : ""}">
      <span class="label">${escHtml(label)}</span>
      <span class="value">${escHtml(String(value))}</span>
    </div>`;
  }

  function renderGoodsReadOnly(goods) {
    if (!goods || !goods.length) return "";
    return `
      <div style="margin-top:1rem">
        <div class="section-title">Goods</div>
        <table style="font-size:.78rem">
          <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Note</th></tr></thead>
          <tbody>
            ${goods.map(g => `<tr>
              <td>${escHtml(g.GoodsName || "")}</td>
              <td>${escHtml(String(g.Quantity ?? ""))}</td>
              <td>${escHtml(g.GoodsUnit || "")}</td>
              <td>${escHtml(g.Note || "")}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderDeliveryOutcome(order) {
    const parts = [];
    if (order.SignatureName)   parts.push(detailField("Signed By",      order.SignatureName));
    if (order.RejectReason)    parts.push(detailField("Reject Reason",  order.RejectReason));
    if (order.ReturnReason)    parts.push(detailField("Return Reason",  order.ReturnReason));
    if (order.StatusDate)      parts.push(detailField("Status Date",    formatDate(order.StatusDate)));
    if (!parts.length) return "";
    return `<div class="section-title" style="margin-top:1rem">Outcome</div>
      <div class="detail-grid">${parts.join("")}</div>`;
  }

  function renderMeta(meta) {
    if (!meta || !meta.first_seen_at) return "";
    return `<div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--border)">
      <div class="section-title">Deliver-It Tracking</div>
      <div class="detail-grid">
        ${detailField("First Seen",   meta.first_seen_at)}
        ${detailField("First Viewed", meta.first_viewed_at || "—")}
      </div></div>`;
  }

  // ---- Route panels ----

  function routeStopsHTML(routeCode, routeStatus) {
    const orders = state.orders.filter(o => o.RouteNumber === routeCode);
    if (!orders.length) return "";

    // Group by address (case-insensitive key, preserve original text)
    const addrMap = new Map();
    for (const o of orders) {
      const key = (o.Address || "").trim().toLowerCase();
      if (!addrMap.has(key)) addrMap.set(key, { address: (o.Address || "").trim(), orders: [] });
      addrMap.get(key).orders.push(o);
    }

    // Sort each group by SeqNumber, then sort groups by their first SeqNumber
    const stops = [...addrMap.values()];
    stops.forEach(s => s.orders.sort((a, b) => (a.SeqNumber ?? 9999) - (b.SeqNumber ?? 9999)));
    stops.sort((a, b) => (a.orders[0].SeqNumber ?? 9999) - (b.orders[0].SeqNumber ?? 9999));

    // For InProgress routes: label at the STOP level (not per-order) so that a
    // stop with multiple orders can never receive both "current" and "next".
    // A stop is pending when at least one of its orders is not completed/failed.
    if (routeStatus === "InProgress") {
      const pendingStops = stops.filter(s =>
        s.orders.some(o => {
          const cat = statusCategory(o.Status || "");
          return cat !== "completed" && cat !== "failed";
        })
      );
      if (pendingStops[0]) pendingStops[0]._label = "current";
      if (pendingStops[1]) pendingStops[1]._label = "next";
    }

    const rows = stops.map((stop, idx) => {
      const seqNum   = stop.orders[0].SeqNumber;
      const seqLabel = seqNum != null ? String(seqNum) : String(idx + 1);

      const isCurrent = stop._label === "current";
      const isNext    = stop._label === "next";

      const bubbleBg    = isCurrent ? "#f59e0b"          : "var(--brand-light)";
      const bubbleColor = isCurrent ? "#fff"              : "var(--brand)";
      const stopBadge   = isCurrent
        ? '<span class="badge badge-current-stop" style="margin-left:.4rem">▶ Now</span>'
        : isNext
          ? '<span class="badge badge-next-stop" style="margin-left:.4rem">Next</span>'
          : "";

      const orderLines = stop.orders.map(o => {
        const num    = o.Number || o.Id || "—";
        const client = o.Client || "";
        const status = o.Status || "Unassigned";
        return `<div style="font-size:.78rem;margin-top:.25rem;display:flex;align-items:center;gap:.35rem;flex-wrap:wrap">
          <strong>${escHtml(num)}</strong>
          ${client ? `<span style="color:var(--text-muted)">${escHtml(client)}</span>` : ""}
          <span class="badge ${statusBadgeClass(status)}">${escHtml(status)}</span>
        </div>`;
      }).join("");

      return `<div style="display:flex;gap:.75rem;padding:.6rem 0;border-bottom:1px solid var(--border);align-items:flex-start">
        <div style="flex-shrink:0;width:24px;height:24px;border-radius:50%;background:${bubbleBg};color:${bubbleColor};font-size:.7rem;font-weight:700;display:flex;align-items:center;justify-content:center">${escHtml(seqLabel)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.82rem;font-weight:600;word-break:break-word">${escHtml(stop.address || "—")}${stopBadge}</div>
          ${orderLines}
        </div>
      </div>`;
    }).join("");

    const addrCount  = stops.length;
    const orderCount = orders.length;
    const summary    = addrCount === orderCount
      ? `${orderCount} order${orderCount !== 1 ? "s" : ""}`
      : `${addrCount} stop${addrCount !== 1 ? "s" : ""}, ${orderCount} order${orderCount !== 1 ? "s" : ""}`;

    return `<div class="section-title" style="margin-top:1.25rem">Stops · ${summary}</div>
      <div>${rows}</div>`;
  }

  function renderRouteViewPanel(route, header, body, footer) {
    const code   = route.Code || "—";
    const status = route.Status || "";
    header.innerHTML = `
      <div>
        <h2>${escHtml(code)}</h2>
        ${status ? `<span class="badge ${routeStatusBadgeClass(status)}" style="margin-top:.25rem">${escHtml(status)}</span>` : ""}
      </div>
      <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;

    const unassigned = state.orders.filter(o => !o.RouteNumber);
    body.innerHTML = `
      <div class="section-title">Route Details</div>
      <div class="detail-grid">
        ${detailField("Route Code",    code)}
        ${detailField("Date",          formatDate(route.Date || ""))}
        ${detailField("Driver",        route.DriverName)}
        ${detailField("Vehicle",       route.DriverVehicle)}
        ${detailField("Depot",         route.Depot)}
        ${detailField("Planned Start", route.StartTimePlan ? String(route.StartTimePlan).replace(/^(\d{4}-\d{2}-\d{2}T)/, "").slice(0, 5) : null)}
      </div>
      ${routeStopsHTML(route.Code, status)}
      ${unassigned.length ? `
        <div class="section-title" style="margin-top:1.25rem">Add Unassigned Orders</div>
        <div>
          ${unassigned.map(o => {
            const num = o.Number || o.Id || "—";
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:.45rem 0;border-bottom:1px solid var(--border)">
              <span style="font-size:.8rem">
                <strong>${escHtml(num)}</strong>
                <span style="color:var(--text-muted);margin-left:.35rem">${escHtml(o.Client || "")}</span>
              </span>
              <button class="btn btn-outline btn-sm add-to-route-btn"
                      data-order-num="${escAttr(num)}" data-route-code="${escAttr(code)}"
                      style="flex-shrink:0">Add →</button>
            </div>`;
          }).join("")}
        </div>
      ` : `<p style="margin-top:1rem;font-size:.8rem;color:var(--text-muted)">All orders are assigned to routes.</p>`}`;

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm close-panel-btn">Close</button>
      <button class="btn btn-primary btn-sm" id="edit-route-btn">Edit Route</button>`;

    $$(".add-to-route-btn").forEach(btn => {
      btn.addEventListener("click", () =>
        assignOrderToRoute(btn.dataset.routeCode, btn.dataset.orderNum, btn));
    });
    $("#edit-route-btn").addEventListener("click", () => openPanel("route-edit", null, route));
  }

  function renderRouteCreateForm(header, body, footer) {
    const baseDate   = state.query.mode === "range" ? state.query.date_from : state.query.date;
    const defaultName = routeNameForDate(baseDate);

    header.innerHTML = `<h2>New Route</h2>
      <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;

    body.innerHTML = `
      <div class="section-title">Route Details</div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Route Name<span class="required">*</span></label>
          <div style="display:flex;gap:.5rem">
            <input type="text" id="r-name-base" value="${escAttr(defaultName)}" readonly
                   style="flex:0 0 auto;width:auto;background:var(--bg)">
            <input type="text" id="r-name-suffix" placeholder="Suffix — e.g. Run 2, Northside" style="flex:1">
          </div>
          <span style="font-size:.68rem;color:var(--text-muted)">
            Full code: <strong id="r-code-preview">${escHtml(defaultName)}</strong>
          </span>
        </div>
        <div class="form-group">
          <label>Date<span class="required">*</span></label>
          <input type="date" id="r-date" value="${escAttr(baseDate)}">
        </div>
        <div class="form-group">
          <label>Planned Start</label>
          <input type="time" id="r-start-time">
        </div>
        <div class="form-group">
          <label>Driver Name</label>
          <input type="text" id="r-driver">
        </div>
        <div class="form-group">
          <label>Vehicle</label>
          <input type="text" id="r-vehicle" placeholder="Plate number">
        </div>
        <div class="form-group full">
          <label>Depot / Start Address</label>
          <input type="text" id="r-depot">
        </div>
      </div>`;

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm close-panel-btn">Cancel</button>
      <button class="btn btn-primary btn-sm" id="save-route-btn">Create Route</button>`;

    function updatePreview() {
      const base   = $("#r-name-base").value.trim();
      const suffix = $("#r-name-suffix").value.trim();
      $("#r-code-preview").textContent = suffix ? `${base} ${suffix}` : base;
    }
    $("#r-name-suffix").addEventListener("input", updatePreview);
    $("#r-date").addEventListener("change", function () {
      if (this.value) { $("#r-name-base").value = routeNameForDate(this.value); updatePreview(); }
    });
    $("#save-route-btn").addEventListener("click", submitCreateRoute);
  }

  async function submitCreateRoute() {
    const base   = $("#r-name-base").value.trim();
    const suffix = $("#r-name-suffix").value.trim();
    const code   = suffix ? `${base} ${suffix}` : base;
    if (!code) { toast("Route name is required.", "error"); return; }
    const dateVal = $("#r-date").value;
    if (!dateVal) { toast("Date is required.", "error"); return; }

    const payload = { Code: code, Date: dateVal };
    const driver  = $("#r-driver").value.trim();       if (driver)  payload.DriverName   = driver;
    const vehicle = $("#r-vehicle").value.trim();      if (vehicle) payload.DriverVehicle = vehicle;
    const depot   = $("#r-depot").value.trim();        if (depot)   payload.Depot         = depot;
    const start   = $("#r-start-time").value;          if (start)   payload.StartTimePlan = start;

    const btn = $("#save-route-btn");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      await apiFetch("/api/routes", { method: "POST", body: JSON.stringify(payload) });
      toast("Route created.", "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false; btn.textContent = "Create Route";
    }
  }

  function renderRouteEditForm(route, header, body, footer) {
    const code = route.Code || "";
    header.innerHTML = `<h2>Edit ${escHtml(code)}</h2>
      <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;

    const startVal = (() => {
      const s = route.StartTimePlan || "";
      if (!s) return "";
      const t = s.indexOf("T");
      return t >= 0 ? s.slice(t + 1, t + 6) : s.slice(0, 5);
    })();

    body.innerHTML = `
      <div class="section-title">Route Details</div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Route Code</label>
          <input type="text" value="${escAttr(code)}" readonly style="background:var(--bg)">
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="r-date" value="${escAttr(isoDate(route.Date || ""))}">
        </div>
        <div class="form-group">
          <label>Planned Start</label>
          <input type="time" id="r-start-time" value="${escAttr(startVal)}">
        </div>
        <div class="form-group">
          <label>Driver Name</label>
          <input type="text" id="r-driver" value="${escAttr(route.DriverName || "")}">
        </div>
        <div class="form-group">
          <label>Vehicle</label>
          <input type="text" id="r-vehicle" value="${escAttr(route.DriverVehicle || "")}">
        </div>
        <div class="form-group full">
          <label>Depot / Start Address</label>
          <input type="text" id="r-depot" value="${escAttr(route.Depot || "")}">
        </div>
      </div>`;

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm" id="back-route-btn">← Back</button>
      <button class="btn btn-primary btn-sm" id="save-route-btn">Save Changes</button>`;

    $("#back-route-btn").addEventListener("click", () => openPanel("route-view", null, route));
    $("#save-route-btn").addEventListener("click", () => submitEditRoute(code));
  }

  async function submitEditRoute(code) {
    const payload = {};
    const dateVal = $("#r-date").value;        if (dateVal) payload.Date          = dateVal;
    const driver  = $("#r-driver").value.trim();  if (driver)  payload.DriverName   = driver;
    const vehicle = $("#r-vehicle").value.trim(); if (vehicle) payload.DriverVehicle = vehicle;
    const depot   = $("#r-depot").value.trim();   if (depot)   payload.Depot         = depot;
    const start   = $("#r-start-time").value;     if (start)   payload.StartTimePlan = start;

    const btn = $("#save-route-btn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await apiFetch(`/api/routes/${encodeURIComponent(code)}`,
        { method: "PUT", body: JSON.stringify(payload) });
      toast("Route updated.", "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false; btn.textContent = "Save Changes";
    }
  }

  async function assignOrderToRoute(routeCode, orderNumber, btn) {
    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = "Adding…";
    try {
      await apiFetch(
        `/api/routes/${encodeURIComponent(routeCode)}/orders/${encodeURIComponent(orderNumber)}`,
        { method: "PUT" }
      );
      toast(`Order ${orderNumber} added to route.`, "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false; btn.textContent = origText;
    }
  }

  // ---- Create form ----

  function renderCreateForm(header, body, footer) {
    header.innerHTML = `<h2>New Order</h2>
      <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;

    body.innerHTML = orderFormHTML(null);
    attachItemsLogic(body);

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm close-panel-btn">Cancel</button>
      <button class="btn btn-primary btn-sm" id="save-order-btn">Create Order</button>`;

    $("#save-order-btn").addEventListener("click", submitCreate);
  }

  // ---- Edit form ----

  function renderEditForm(order, header, body, footer) {
    const num = order.Number || order.Id || "";
    header.innerHTML = `<h2>Edit Order ${escHtml(num)}</h2>
      <button class="btn btn-ghost btn-sm close-panel-btn">✕</button>`;

    body.innerHTML = orderFormHTML(order);
    attachItemsLogic(body);

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm" id="back-btn">← Back</button>
      <button class="btn btn-primary btn-sm" id="save-order-btn">Save Changes</button>`;

    $("#back-btn").addEventListener("click", () => openPanel("view", order));
    $("#save-order-btn").addEventListener("click", () => submitEdit(num));
  }

  // ---- Order form HTML ----

  function orderFormHTML(o) {
    const v = o ? (k) => (o[k] != null ? String(o[k]) : "") : () => "";
    const goods = o ? (o.GoodsList || []) : [];

    return `
      <div class="section-title">Order Details</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Order Number${o ? "" : '<span class="required">*</span>'}</label>
          <input type="text" id="f-number" value="${escAttr(v("Number"))}" placeholder="e.g. ORD-001"${o ? " readonly" : ""}>
        </div>
        <div class="form-group">
          <label>Order Date</label>
          <input type="date" id="f-date" value="${escAttr(isoDate(v("Date")))}">
        </div>
        <div class="form-group">
          <label>Time From</label>
          <input type="time" id="f-time-from" value="${escAttr(v("TimeSlotFrom").slice(0,5))}">
        </div>
        <div class="form-group">
          <label>Time To</label>
          <input type="time" id="f-time-to" value="${escAttr(v("TimeSlotTo").slice(0,5))}">
        </div>
        <div class="form-group">
          <label>Type</label>
          <select id="f-type">
            <option value="0"${v("Type") !== "1" ? " selected" : ""}>Delivery</option>
            <option value="1"${v("Type") === "1" ? " selected" : ""}>Collection</option>
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select id="f-priority">
            <option value="">—</option>
            <option value="low"${v("Priority") === "low" ? " selected" : ""}>Low</option>
            <option value="normal"${v("Priority") === "normal" ? " selected" : ""}>Normal</option>
            <option value="high"${v("Priority") === "high" ? " selected" : ""}>High</option>
          </select>
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Client<span class="required">*</span></div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Client / Customer Name<span class="required">*</span></label>
          <input type="text" id="f-client" value="${escAttr(v("Client"))}" placeholder="Required">
        </div>
        <div class="form-group">
          <label>Contact Name</label>
          <input type="text" id="f-contact" value="${escAttr(v("ContactName"))}">
        </div>
        <div class="form-group">
          <label>Phone</label>
          <input type="tel" id="f-phone" value="${escAttr(v("Phone"))}">
        </div>
        <div class="form-group full">
          <label>Email</label>
          <input type="email" id="f-email" value="${escAttr(v("Email"))}">
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Delivery Address</div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Address<span class="required">*</span></label>
          <input type="text" id="f-address" value="${escAttr(v("Address"))}" placeholder="Full delivery address. Required">
        </div>
        <div class="form-group full">
          <label>Depot / Pickup Address</label>
          <input type="text" id="f-depot" value="${escAttr(v("Depot"))}">
        </div>
        <div class="form-group full">
          <label>Shipper</label>
          <input type="text" id="f-shipper" value="${escAttr(v("Shipper"))}">
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Load</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Weight (kg)</label>
          <input type="number" id="f-weight" step="0.01" value="${escAttr(v("Weight"))}">
        </div>
        <div class="form-group">
          <label>Volume (m³)</label>
          <input type="number" id="f-volume" step="0.001" value="${escAttr(v("Volume"))}">
        </div>
        <div class="form-group">
          <label>Pallets</label>
          <input type="number" id="f-pallets" step="0.5" value="${escAttr(v("Pallets"))}">
        </div>
        <div class="form-group">
          <label>COD ($)</label>
          <input type="number" id="f-cod" step="0.01" value="${escAttr(v("COD"))}">
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Notes</div>
      <div class="form-group">
        <textarea id="f-note" rows="2">${escHtml(v("Note"))}</textarea>
      </div>

      <div class="section-title" style="margin-top:1rem">Goods</div>
      <div id="items-header" style="display:grid;grid-template-columns:1fr 80px 90px 28px;gap:.4rem;margin-bottom:.25rem;padding:0 .1rem">
        <span style="font-size:.68rem;color:var(--text-muted);font-weight:600">ITEM NAME</span>
        <span style="font-size:.68rem;color:var(--text-muted);font-weight:600">QTY</span>
        <span style="font-size:.68rem;color:var(--text-muted);font-weight:600">UNIT</span>
        <span></span>
      </div>
      <div id="items-container">
        ${goods.length ? goods.map((g, i) => itemRowHTML(i, g)).join("") : itemRowHTML(0, {})}
      </div>
      <button type="button" class="add-item-btn" id="add-item-btn">+ Add goods line</button>`;
  }

  function itemRowHTML(idx, item = {}) {
    return `<div class="item-row" data-item-idx="${idx}">
      <input type="text"   placeholder="Item description" class="item-name"
             value="${escAttr(item.GoodsName || "")}">
      <input type="number" placeholder="Qty" min="0" step="0.01" class="item-qty"
             value="${escAttr(item.Quantity != null ? String(item.Quantity) : "")}">
      <input type="text"   placeholder="pcs / kg / pkg…" class="item-unit"
             value="${escAttr(item.GoodsUnit || "")}">
      <button type="button" class="btn btn-ghost btn-sm remove-item" title="Remove" style="padding:.25rem">✕</button>
    </div>`;
  }

  function attachItemsLogic(ctx) {
    const container = $("#items-container", ctx);
    $("#add-item-btn", ctx).addEventListener("click", () => {
      const idx = $$(".item-row", container).length;
      container.insertAdjacentHTML("beforeend", itemRowHTML(idx, {}));
      attachRemoveItems(container);
    });
    attachRemoveItems(container);
  }

  function attachRemoveItems(container) {
    $$(".remove-item", container).forEach(btn => {
      btn.onclick = () => {
        if ($$(".item-row", container).length > 1) {
          btn.closest(".item-row").remove();
        } else {
          $$("input", btn.closest(".item-row")).forEach(i => i.value = "");
        }
      };
    });
  }

  // ---- Collect & submit ----

  function collectFormPayload() {
    const g = (id) => ($(id)?.value || "").trim();
    const n = (id) => { const v = $(id)?.value; return v ? Number(v) : null; };

    const payload = {};

    const number = g("#f-number");
    if (number) payload.Number = number;

    const dt = g("#f-date");
    if (dt) payload.Date = dt;

    const timeFrom = g("#f-time-from");
    if (timeFrom) payload.TimeSlotFrom = timeFrom;

    const timeTo = g("#f-time-to");
    if (timeTo) payload.TimeSlotTo = timeTo;

    const type = g("#f-type");
    payload.Type = Number(type);   // 0=Delivery, 1=Collection

    const priority = g("#f-priority");
    if (priority) payload.Priority = priority;

    const client = g("#f-client");
    if (client) payload.Client = client;

    const contact = g("#f-contact");
    if (contact) payload.ContactName = contact;

    const phone = g("#f-phone");
    if (phone) payload.Phone = phone;

    const email = g("#f-email");
    if (email) payload.Email = email;

    const address = g("#f-address");
    if (address) payload.Address = address;

    const depot = g("#f-depot");
    if (depot) payload.Depot = depot;

    const shipper = g("#f-shipper");
    if (shipper) payload.Shipper = shipper;

    const weight  = n("#f-weight");  if (weight  != null) payload.Weight  = weight;
    const volume  = n("#f-volume");  if (volume  != null) payload.Volume  = volume;
    const pallets = n("#f-pallets"); if (pallets != null) payload.Pallets = pallets;
    const cod     = n("#f-cod");     if (cod     != null) payload.COD     = cod;

    const note = g("#f-note");
    if (note) payload.Note = note;

    const goods = $$(".item-row").map(row => {
      const name = $(".item-name", row)?.value.trim() || "";
      const qty  = $(".item-qty",  row)?.value.trim() || "";
      const unit = $(".item-unit", row)?.value.trim() || "";
      if (!name && !qty) return null;
      const item = {};
      if (name) item.GoodsName = name;
      if (qty)  item.Quantity  = Number(qty);
      if (unit) item.GoodsUnit = unit;
      return item;
    }).filter(Boolean);
    if (goods.length) payload.GoodsList = goods;

    return payload;
  }

  function validatePayload(payload) {
    const errs = [];
    if (!payload.Client)  errs.push("Client name is required.");
    if (!payload.Address) errs.push("Address is required.");
    return errs;
  }

  async function submitCreate() {
    const payload = collectFormPayload();
    const errs = validatePayload(payload);
    if (errs.length) { toast(errs.join(" "), "error"); return; }

    const btn = $("#save-order-btn");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      await apiFetch("/api/orders", { method: "POST", body: JSON.stringify(payload) });
      toast("Order created in Track-POD.", "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false; btn.textContent = "Create Order";
    }
  }

  async function submitEdit(orderNumber) {
    const payload = collectFormPayload();
    const errs = validatePayload(payload);
    if (errs.length) { toast(errs.join(" "), "error"); return; }

    const btn = $("#save-order-btn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await apiFetch(`/api/orders/${encodeURIComponent(orderNumber)}`,
        { method: "PUT", body: JSON.stringify(payload) });
      toast("Order updated.", "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false; btn.textContent = "Save Changes";
    }
  }

  // ----------------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------------

  function formatDate(raw) {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d)) return raw;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function isoDate(raw) {
    if (!raw) return "";
    // Handle "yyyy-MM-dd" strings without timezone shift
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const d = new Date(raw);
    return isNaN(d) ? "" : d.toISOString().slice(0, 10);
  }

  function timeWindow(order) {
    const from = (order.TimeSlotFrom || "").slice(0, 5);
    const to   = (order.TimeSlotTo   || "").slice(0, 5);
    if (from && to) return `${from} – ${to}`;
    return from || to || "";
  }

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escAttr(str) { return escHtml(str); }

  function shiftDate(dateStr, days) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // ----------------------------------------------------------------
  // Wire up page controls
  // ----------------------------------------------------------------

  function init() {
    // Initialise date pickers to today
    $("#filter-date").value = today;
    $("#filter-from").value = today;
    $("#filter-to").value   = today;

    // Mode switch
    $("#filter-mode").addEventListener("change", function () {
      const isRange = this.value === "range";
      state.query.mode = this.value;
      $("#filter-day-wrap").style.display        = isRange ? "none"  : "";
      $("#filter-range-from-wrap").style.display = isRange ? ""      : "none";
      $("#filter-range-to-wrap").style.display   = isRange ? ""      : "none";
      $("#prev-day").style.visibility            = isRange ? "hidden": "";
      $("#next-day").style.visibility            = isRange ? "hidden": "";
    });

    // Filters
    $("#apply-filters").addEventListener("click", () => {
      const mode = state.query.mode;
      if (mode === "range") {
        state.query.date_from = $("#filter-from").value || today;
        state.query.date_to   = $("#filter-to").value   || today;
      } else {
        state.query.date = $("#filter-date").value || today;
      }
      loadOrders();
    });

    // Day navigation
    $("#prev-day").addEventListener("click", () => {
      state.query.date = shiftDate(state.query.date, -1);
      $("#filter-date").value = state.query.date;
      loadOrders();
    });
    $("#next-day").addEventListener("click", () => {
      state.query.date = shiftDate(state.query.date, 1);
      $("#filter-date").value = state.query.date;
      loadOrders();
    });
    $("#today-btn").addEventListener("click", () => {
      state.query.date = today;
      $("#filter-date").value = today;
      loadOrders();
    });

    // Status filter
    $("#filter-status").addEventListener("change", function () {
      state.statusFilter = this.value;
      renderOrderList();
    });

    // Header actions
    $("#refresh-btn").addEventListener("click", loadOrders);
    $("#new-route-btn").addEventListener("click", () => openPanel("route-create"));
    $("#new-order-btn").addEventListener("click", () => openPanel("create"));

    // Close panel on overlay click
    $("#overlay").addEventListener("click", e => {
      if (e.target === $("#overlay")) closePanel();
    });

    // Escape key
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closePanel();
    });

    loadOrders();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
