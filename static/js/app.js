/* ============================================================
   Deliver-It — frontend application
   ============================================================ */

(function () {
  "use strict";

  // ----------------------------------------------------------------
  // State
  // ----------------------------------------------------------------

  const state = {
    orders: [],
    loading: false,
    filters: { date_from: "", date_to: "", status: "" },
    panel: { mode: null, order: null },   // mode: 'view' | 'edit' | 'create'
  };

  // ----------------------------------------------------------------
  // DOM refs
  // ----------------------------------------------------------------

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  // ----------------------------------------------------------------
  // Toast notifications
  // ----------------------------------------------------------------

  function toast(message, type = "info") {
    const container = $("#toast");
    const el = document.createElement("div");
    el.className = `toast-msg ${type}`;
    el.textContent = message;
    container.appendChild(el);
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
    if (!res.ok) {
      const msg = body?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body;
  }

  // ----------------------------------------------------------------
  // Order list
  // ----------------------------------------------------------------

  async function loadOrders() {
    state.loading = true;
    renderOrderList();

    const params = new URLSearchParams();
    if (state.filters.date_from) params.set("date_from", state.filters.date_from);
    if (state.filters.date_to)   params.set("date_to",   state.filters.date_to);
    if (state.filters.status)    params.set("status",    state.filters.status);

    try {
      state.orders = await apiFetch(`/api/orders?${params}`);
    } catch (err) {
      toast(err.message, "error");
      state.orders = [];
    } finally {
      state.loading = false;
      renderOrderList();
      updateNewCount();
    }
  }

  function updateNewCount() {
    const count = state.orders.filter(o => o._new).length;
    const badge = $("#new-count");
    if (count > 0) {
      badge.textContent = `${count} new`;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }

  function statusBadgeClass(status = "") {
    const s = status.toLowerCase();
    if (s.includes("deliver") || s.includes("complete")) return "badge-delivered";
    if (s.includes("progress") || s.includes("transit") || s.includes("route")) return "badge-progress";
    if (s.includes("fail") || s.includes("cancel") || s.includes("reject")) return "badge-failed";
    return "badge-status";
  }

  function renderOrderList() {
    const tbody = $("#orders-tbody");
    const empty = $("#orders-empty");

    if (state.loading) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="state-msg">
            <div class="spinner"></div>
            <div>Loading orders from Track-POD…</div>
          </div>
        </td></tr>`;
      empty.style.display = "none";
      return;
    }

    if (!state.orders.length) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";
    tbody.innerHTML = state.orders.map(order => {
      const num    = orderNum(order);
      const addr   = order.Address1 || order.address1 || order.Address || order.address || "—";
      const city   = order.City || order.city || "";
      const contact= order.ContactName || order.contactName || order.contact_name || "—";
      const date   = formatDate(order.DeliveryDate || order.deliveryDate || order.Date || order.date || "");
      const status = order.Status || order.status || "—";
      const isNew  = order._new;

      return `
        <tr class="${isNew ? "is-new" : ""}" data-order="${escHtml(num)}" tabindex="0">
          <td>
            ${isNew ? '<span class="dot-new" title="Not yet actioned in Deliver-It"></span>' : ""}
          </td>
          <td><strong>${escHtml(num)}</strong></td>
          <td>${escHtml(addr)}${city ? `, ${escHtml(city)}` : ""}</td>
          <td>${escHtml(contact)}</td>
          <td>${escHtml(date)}</td>
          <td><span class="badge ${statusBadgeClass(status)}">${escHtml(status)}</span></td>
          <td>
            ${isNew ? `<span class="badge badge-new"><span class="dot-new"></span>New</span>` : ""}
          </td>
        </tr>`;
    }).join("");

    // Row click → view order
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
      // Remove the row's "new" highlight immediately
      const row = $(`tr[data-order="${CSS.escape(orderNumber)}"]`);
      if (row) {
        row.classList.remove("is-new");
        const dots = $$(".dot-new", row);
        dots.forEach(d => d.remove());
        $$(".badge-new", row).forEach(b => b.remove());
      }
      const idx = state.orders.findIndex(o => orderNum(o) === orderNumber);
      if (idx !== -1) state.orders[idx]._new = false;
      updateNewCount();

      openPanel("view", order);
    } catch (err) {
      toast(err.message, "error");
      closePanel();
    }
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
        <button class="btn btn-ghost btn-sm" id="close-panel">✕</button>`;
      body.innerHTML = `<div class="state-msg"><div class="spinner"></div><div>Fetching order…</div></div>`;
      footer.innerHTML = "";
      $("#close-panel").addEventListener("click", closePanel);
      return;
    }

    if (mode === "create") {
      renderCreateForm(header, body, footer);
      return;
    }

    if (mode === "view") {
      renderViewPanel(order, header, body, footer);
      return;
    }

    if (mode === "edit") {
      renderEditForm(order, header, body, footer);
      return;
    }
  }

  // ---- View (read-only) ----

  function renderViewPanel(order, header, body, footer) {
    const num = orderNum(order);

    header.innerHTML = `
      <div>
        <h2>Order ${escHtml(num)}</h2>
        ${order._new ? '<span class="badge badge-new" style="margin-top:.25rem"><span class="dot-new"></span>New from Track-POD</span>' : ""}
      </div>
      <button class="btn btn-ghost btn-sm" id="close-panel">✕</button>`;
    $("#close-panel").addEventListener("click", closePanel);

    const fields = buildDetailFields(order);
    const meta   = order._meta || {};

    body.innerHTML = `
      <div class="section-title">Delivery Details</div>
      <div class="detail-grid">
        ${fields.map(f => `
          <div class="detail-field">
            <span class="label">${escHtml(f.label)}</span>
            <span class="value">${escHtml(f.value || "—")}</span>
          </div>`).join("")}
      </div>
      ${renderItemsReadOnly(order)}
      ${meta.first_seen_at ? `
        <div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--border)">
          <div class="section-title">Deliver-It Metadata</div>
          <div class="detail-grid">
            <div class="detail-field">
              <span class="label">First Seen</span>
              <span class="value">${escHtml(meta.first_seen_at)}</span>
            </div>
            <div class="detail-field">
              <span class="label">First Viewed</span>
              <span class="value">${escHtml(meta.first_viewed_at || "—")}</span>
            </div>
          </div>
        </div>` : ""}`;

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm" id="close-panel2">Close</button>
      <button class="btn btn-primary btn-sm" id="edit-order-btn">Edit Order</button>`;

    $("#close-panel2").addEventListener("click", closePanel);
    $("#edit-order-btn").addEventListener("click", () => openPanel("edit", order));
  }

  function buildDetailFields(order) {
    return [
      { label: "Order Number",   value: order.OrderNumber || order.orderNumber },
      { label: "Status",         value: order.Status || order.status },
      { label: "Delivery Date",  value: formatDate(order.DeliveryDate || order.deliveryDate || order.Date || order.date) },
      { label: "Time Window",    value: timeWindow(order) },
      { label: "Contact Name",   value: order.ContactName || order.contactName },
      { label: "Phone",          value: order.Phone || order.phone },
      { label: "Email",          value: order.Email || order.email },
      { label: "Address 1",      value: order.Address1 || order.address1 },
      { label: "Address 2",      value: order.Address2 || order.address2 },
      { label: "City",           value: order.City || order.city },
      { label: "Post Code",      value: order.PostCode || order.postCode || order.ZipCode || order.zipCode },
      { label: "Notes",          value: order.Notes || order.notes || order.Comment || order.comment },
    ].filter(f => f.value);
  }

  function renderItemsReadOnly(order) {
    const items = order.Products || order.products || order.Items || order.items || [];
    if (!items.length) return "";
    return `
      <div style="margin-top:1rem">
        <div class="section-title">Items</div>
        <table style="font-size:.78rem">
          <thead><tr>
            <th>Description</th><th>Qty</th><th>Weight</th>
          </tr></thead>
          <tbody>
            ${items.map(it => `<tr>
              <td>${escHtml(it.Description || it.description || it.Name || it.name || "")}</td>
              <td>${escHtml(String(it.Quantity || it.quantity || ""))}</td>
              <td>${escHtml(String(it.Weight || it.weight || ""))}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // ---- Create form ----

  function renderCreateForm(header, body, footer) {
    header.innerHTML = `
      <h2>New Order</h2>
      <button class="btn btn-ghost btn-sm" id="close-panel">✕</button>`;
    $("#close-panel").addEventListener("click", closePanel);

    body.innerHTML = orderFormHTML(null);
    attachItemsLogic(body);

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm" id="close-panel2">Cancel</button>
      <button class="btn btn-primary btn-sm" id="save-order-btn">Create Order</button>`;

    $("#close-panel2").addEventListener("click", closePanel);
    $("#save-order-btn").addEventListener("click", () => submitCreate());
  }

  // ---- Edit form ----

  function renderEditForm(order, header, body, footer) {
    const num = orderNum(order);
    header.innerHTML = `
      <h2>Edit Order ${escHtml(num)}</h2>
      <button class="btn btn-ghost btn-sm" id="close-panel">✕</button>`;
    $("#close-panel").addEventListener("click", closePanel);

    body.innerHTML = orderFormHTML(order);
    attachItemsLogic(body);

    footer.innerHTML = `
      <button class="btn btn-outline btn-sm" id="back-btn">← Back</button>
      <button class="btn btn-primary btn-sm" id="save-order-btn">Save Changes</button>`;

    $("#back-btn").addEventListener("click", () => openPanel("view", order));
    $("#save-order-btn").addEventListener("click", () => submitEdit(num));
  }

  function orderFormHTML(order) {
    const v = (keys) => {
      if (!order) return "";
      for (const k of keys) {
        if (order[k] !== undefined && order[k] !== null) return order[k];
      }
      return "";
    };

    const items = order ? (order.Products || order.products || order.Items || order.items || []) : [];

    return `
      <div class="section-title">Order Details</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Order Number<span class="required">*</span></label>
          <input type="text" id="f-order-number" value="${escAttr(v(["OrderNumber","orderNumber"]))}" placeholder="e.g. ORD-001" ${order ? "readonly" : ""}>
        </div>
        <div class="form-group">
          <label>Delivery Date<span class="required">*</span></label>
          <input type="date" id="f-date" value="${escAttr(isoDate(v(["DeliveryDate","deliveryDate","Date","date"])))}">
        </div>
        <div class="form-group">
          <label>Time From</label>
          <input type="time" id="f-time-from" value="${escAttr(v(["TimeFrom","timeFrom"]))}">
        </div>
        <div class="form-group">
          <label>Time To</label>
          <input type="time" id="f-time-to" value="${escAttr(v(["TimeTo","timeTo"]))}">
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Recipient</div>
      <div class="form-grid">
        <div class="form-group">
          <label>Contact Name<span class="required">*</span></label>
          <input type="text" id="f-contact" value="${escAttr(v(["ContactName","contactName"]))}">
        </div>
        <div class="form-group">
          <label>Phone</label>
          <input type="tel" id="f-phone" value="${escAttr(v(["Phone","phone"]))}">
        </div>
        <div class="form-group full">
          <label>Email</label>
          <input type="email" id="f-email" value="${escAttr(v(["Email","email"]))}">
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Delivery Address</div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Address Line 1<span class="required">*</span></label>
          <input type="text" id="f-addr1" value="${escAttr(v(["Address1","address1","Address","address"]))}">
        </div>
        <div class="form-group full">
          <label>Address Line 2</label>
          <input type="text" id="f-addr2" value="${escAttr(v(["Address2","address2"]))}">
        </div>
        <div class="form-group">
          <label>City<span class="required">*</span></label>
          <input type="text" id="f-city" value="${escAttr(v(["City","city"]))}">
        </div>
        <div class="form-group">
          <label>Post / Zip Code</label>
          <input type="text" id="f-postcode" value="${escAttr(v(["PostCode","postCode","ZipCode","zipCode"]))}">
        </div>
      </div>

      <div class="section-title" style="margin-top:1rem">Notes</div>
      <div class="form-group">
        <textarea id="f-notes" rows="2">${escHtml(v(["Notes","notes","Comment","comment"]))}</textarea>
      </div>

      <div class="section-title" style="margin-top:1rem">Items</div>
      <div id="items-container">
        ${items.length
          ? items.map((it, i) => itemRowHTML(i, it)).join("")
          : itemRowHTML(0, {})}
      </div>
      <button type="button" class="add-item-btn" id="add-item-btn">+ Add item</button>
    `;
  }

  function itemRowHTML(idx, item = {}) {
    const v = (keys) => {
      for (const k of keys) {
        if (item[k] !== undefined && item[k] !== null) return item[k];
      }
      return "";
    };
    return `
      <div class="item-row" data-item-idx="${idx}">
        <input type="text"   placeholder="Description"
               class="item-desc" value="${escAttr(v(["Description","description","Name","name"]))}">
        <input type="number" placeholder="Qty" min="1"
               class="item-qty"  value="${escAttr(v(["Quantity","quantity"]))}">
        <input type="number" placeholder="Weight kg" step="0.01"
               class="item-weight" value="${escAttr(v(["Weight","weight"]))}">
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
        const rows = $$(".item-row", container);
        if (rows.length > 1) btn.closest(".item-row").remove();
        else {
          // Clear the last row instead of removing
          $$("input", btn.closest(".item-row")).forEach(i => i.value = "");
        }
      };
    });
  }

  // ---- Submit ----

  function collectFormPayload() {
    const g = (id) => ($(id)?.value || "").trim();
    const items = $$(".item-row").map(row => {
      const desc   = $(".item-desc", row)?.value.trim()   || "";
      const qty    = $(".item-qty", row)?.value.trim()    || "";
      const weight = $(".item-weight", row)?.value.trim() || "";
      if (!desc && !qty && !weight) return null;
      const item = {};
      if (desc)   item.Description = desc;
      if (qty)    item.Quantity = Number(qty);
      if (weight) item.Weight = Number(weight);
      return item;
    }).filter(Boolean);

    const payload = {};
    const orderNum = g("#f-order-number");
    if (orderNum) payload.OrderNumber = orderNum;

    const date = g("#f-date");
    if (date) payload.DeliveryDate = date;

    const timeFrom = g("#f-time-from");
    if (timeFrom) payload.TimeFrom = timeFrom;

    const timeTo = g("#f-time-to");
    if (timeTo) payload.TimeTo = timeTo;

    const contact = g("#f-contact");
    if (contact) payload.ContactName = contact;

    const phone = g("#f-phone");
    if (phone) payload.Phone = phone;

    const email = g("#f-email");
    if (email) payload.Email = email;

    const addr1 = g("#f-addr1");
    if (addr1) payload.Address1 = addr1;

    const addr2 = g("#f-addr2");
    if (addr2) payload.Address2 = addr2;

    const city = g("#f-city");
    if (city) payload.City = city;

    const postcode = g("#f-postcode");
    if (postcode) payload.PostCode = postcode;

    const notes = g("#f-notes");
    if (notes) payload.Notes = notes;

    if (items.length) payload.Products = items;

    return payload;
  }

  function validatePayload(payload, requireOrderNumber = true) {
    const errors = [];
    if (requireOrderNumber && !payload.OrderNumber) errors.push("Order Number is required.");
    if (!payload.ContactName)  errors.push("Contact Name is required.");
    if (!payload.Address1)     errors.push("Address Line 1 is required.");
    if (!payload.City)         errors.push("City is required.");
    if (!payload.DeliveryDate) errors.push("Delivery Date is required.");
    return errors;
  }

  async function submitCreate() {
    const payload = collectFormPayload();
    const errs = validatePayload(payload, true);
    if (errs.length) { toast(errs.join(" "), "error"); return; }

    const btn = $("#save-order-btn");
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      await apiFetch("/api/orders", { method: "POST", body: JSON.stringify(payload) });
      toast("Order created in Track-POD.", "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Create Order";
    }
  }

  async function submitEdit(orderNumber) {
    const payload = collectFormPayload();
    const errs = validatePayload(payload, false);
    if (errs.length) { toast(errs.join(" "), "error"); return; }

    const btn = $("#save-order-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await apiFetch(`/api/orders/${encodeURIComponent(orderNumber)}`,
        { method: "PUT", body: JSON.stringify(payload) });
      toast("Order updated.", "success");
      closePanel();
      loadOrders();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  }

  // ----------------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------------

  function orderNum(order) {
    return (order.OrderNumber || order.orderNumber || order.order_number ||
            order.Number      || order.number      || "").toString();
  }

  function formatDate(raw) {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d)) return raw;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function isoDate(raw) {
    if (!raw) return "";
    const d = new Date(raw);
    if (isNaN(d)) return "";
    return d.toISOString().slice(0, 10);
  }

  function timeWindow(order) {
    const from = order.TimeFrom || order.timeFrom || "";
    const to   = order.TimeTo   || order.timeTo   || "";
    if (from && to) return `${from} – ${to}`;
    return from || to || "";
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escAttr(str) { return escHtml(str); }

  // ----------------------------------------------------------------
  // Wire up the page
  // ----------------------------------------------------------------

  function init() {
    // Filters
    const applyBtn = $("#apply-filters");
    applyBtn?.addEventListener("click", () => {
      state.filters.date_from = $("#filter-from")?.value || "";
      state.filters.date_to   = $("#filter-to")?.value   || "";
      state.filters.status    = $("#filter-status")?.value || "";
      loadOrders();
    });

    $("#clear-filters")?.addEventListener("click", () => {
      $("#filter-from").value   = "";
      $("#filter-to").value     = "";
      $("#filter-status").value = "";
      state.filters = { date_from: "", date_to: "", status: "" };
      loadOrders();
    });

    // Refresh
    $("#refresh-btn")?.addEventListener("click", loadOrders);

    // New order
    $("#new-order-btn")?.addEventListener("click", () => openPanel("create"));

    // Overlay click-outside
    $("#overlay")?.addEventListener("click", e => {
      if (e.target === $("#overlay")) closePanel();
    });

    // Keyboard: Escape closes panel
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closePanel();
    });

    // Initial load
    loadOrders();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
