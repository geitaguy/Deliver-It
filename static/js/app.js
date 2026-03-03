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
    loading:      false,
    statusFilter: "all",
    query:        { mode: "day", date: today, date_from: today, date_to: today },
    panel:        { mode: null, order: null },
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
    if (q.mode === "range") {
      params.set("date_from", q.date_from);
      params.set("date_to",   q.date_to);
    } else {
      params.set("date", q.date);
    }

    try {
      state.orders = await apiFetch(`/api/orders?${params}`);
    } catch (err) {
      toast(err.message, "error");
      state.orders = [];
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
    tbody.innerHTML = visible.map(o => {
      const num    = o.Number || o.Id || "—";
      const client = o.Client || "—";
      const addr   = o.Address || "—";
      const dt     = formatDate(o.Date || o.RouteDate || "");
      const status = o.Status || "Unassigned";
      const isNew  = o._new;

      return `<tr class="${isNew ? "is-new" : ""}" data-order="${escHtml(num)}" tabindex="0">
        <td>${isNew ? '<span class="dot-new" title="Not yet viewed in Deliver-It"></span>' : ""}</td>
        <td><strong>${escHtml(num)}</strong></td>
        <td>${escHtml(client)}</td>
        <td>${escHtml(addr)}</td>
        <td>${escHtml(dt)}</td>
        <td><span class="badge ${statusBadgeClass(status)}">${escHtml(status)}</span></td>
        <td>${isNew ? '<span class="badge badge-new"><span class="dot-new"></span>New</span>' : ""}</td>
      </tr>`;
    }).join("");

    $$("tbody tr[data-order]").forEach(row => {
      row.addEventListener("click", () => openOrderDetail(row.dataset.order));
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") openOrderDetail(row.dataset.order);
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

  function openPanel(mode, order = null) {
    state.panel = { mode, order };
    renderPanel();
    $("#overlay").classList.add("open");
  }

  function closePanel() {
    state.panel = { mode: null, order: null };
    $("#overlay").classList.remove("open");
  }

  function renderPanel() {
    const { mode, order } = state.panel;
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
