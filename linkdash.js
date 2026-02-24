/* global cockpit */
(() => {
  "use strict";

  const STORAGE_DIR      = "/etc/cockpit/linkdash";
  const GLOBAL_PATH      = "/etc/cockpit/linkdash/global.json";
  const USERS_DIR        = "/etc/cockpit/linkdash/users";
  const USERLIST_PATH    = "/etc/cockpit/linkdash/userlist.json";
  const LS_KEY_GLOBAL    = "linkdash.global.v2";
  const LS_KEY_PERSONAL  = "linkdash.personal.v2";
  const DEFAULT_GROUP    = "General";
  const ADMIN_EDITED_TAG = "(Admin Edited)";

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function el(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element #${id}`);
    return node;
  }

  function nowIso() { return new Date().toISOString(); }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeUrl(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  function isHttpHttpsUrl(u) {
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch { return false; }
  }

  function uuidv4() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function uniqSorted(arr) {
    return Array.from(new Set(arr))
      .filter(x => x && String(x).trim())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  function toast(kind, message, timeoutMs = 3500) {
    const host = el("toastHost");
    const t = document.createElement("div");
    t.className = `ld-toast ${kind}`;
    t.textContent = message;
    host.appendChild(t);
    window.setTimeout(() => t.remove(), timeoutMs);
  }

  function syncThemeFromParent() {
    try {
      const ours   = document.documentElement.classList;
      const theirs = window.parent?.document?.documentElement?.classList;
      if (!theirs) return;
      for (const c of Array.from(ours))   { if (c.startsWith("pf-v6-theme-")) ours.remove(c); }
      for (const c of Array.from(theirs)) { if (c.startsWith("pf-v6-theme-")) ours.add(c); }
    } catch { /* ignore */ }
  }

  // ─── Link hydration ────────────────────────────────────────────────────────

  function hydrateLink(raw, layer, owner) {
    const name          = String(raw?.name ?? "").trim();
    const url           = String(raw?.url  ?? "").trim();
    const group         = String(raw?.group ?? DEFAULT_GROUP).trim() || DEFAULT_GROUP;
    const description   = String(raw?.description ?? "").trim();
    const open_in_frame = !!raw?.open_in_frame;
    const id            = String(raw?.id ?? "").trim() || uuidv4();
    const created_at    = String(raw?.created_at ?? "").trim() || nowIso();
    const updated_at    = String(raw?.updated_at ?? "").trim() || created_at;
    const _layer        = raw?._layer || layer  || "personal";
    const _owner        = raw?._owner || owner  || "";
    return { id, name, url, group, description, open_in_frame,
             created_at, updated_at, _layer, _owner };
  }

  function validateLink(link) {
    if (!String(link?.name  || "").trim()) return "Name is required.";
    if (!String(link?.group || "").trim()) return "Group is required.";
    if (!String(link?.url   || "").trim()) return "URL is required.";
    if (!isHttpHttpsUrl(normalizeUrl(link.url))) return "URL must be http/https.";
    return null;
  }

  // ─── State ─────────────────────────────────────────────────────────────────

  const state = {
    isAdmin:       false,
    currentUser:   "",
    globalLinks:   [],
    personalLinks: {},    // { username: [link, ...] }
    allLinks:      [],    // merged, computed
    filtered:      [],
    editing:       null,
    deleting:      null,
    dirtyGlobal:   false,
    dirtyPersonal: false,
    filter: { q: "", group: "", view: "cards" },
  };

  // ─── Admin / user detection ────────────────────────────────────────────────

  async function detectAdmin() {
    try {
      if (cockpit?.permission) {
        const perm = cockpit.permission({ admin: true });
        state.isAdmin = !!perm.allowed;
        perm.addEventListener?.("changed", () => {
          state.isAdmin = !!perm.allowed;
          updateAdminUi();
          render();
        });
      } else {
        state.isAdmin = false;
      }
    } catch { state.isAdmin = false; }
  }

  async function detectCurrentUser() {
    try {
      const u = await cockpit.user();
      state.currentUser = u?.name || "";
    } catch { state.currentUser = ""; }
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  function updateAdminUi() {
    const permNote     = document.getElementById("permissionNote");
    const addBtn       = document.getElementById("addBtn");
    const importBtn    = document.getElementById("importBtn");
    const exportBtn    = document.getElementById("exportBtn");
    const saveOrderBtn = document.getElementById("saveOrderBtn");

    // Everyone can add personal links; only admins can import
    if (permNote)     permNote.hidden = true;
    if (addBtn)       addBtn.disabled  = false;
    if (importBtn)    importBtn.disabled = !state.isAdmin;
    if (exportBtn)    exportBtn.disabled = false;
    if (saveOrderBtn) saveOrderBtn.disabled = !(state.dirtyGlobal || state.dirtyPersonal);
  }

  // ─── File I/O ──────────────────────────────────────────────────────────────

  async function ensureDir(path) {
    try { await cockpit.spawn(["/bin/mkdir", "-p", path], { superuser: "try" }); } catch { /* ignore */ }
  }

  async function readFile(path) {
    const fs = cockpit.file(path, { superuser: "try" });
    try   { return await fs.read(); }
    catch { return null; }
    finally { fs.close(); }
  }

  async function writeFile(path, content) {
    const fs = cockpit.file(path, { superuser: "try" });
    try   { await fs.replace(content); return true; }
    catch (e) { console.error("write failed:", path, e); return false; }
    finally { fs.close(); }
  }

  // ─── Userlist ──────────────────────────────────────────────────────────────

  async function readUserlist() {
    const raw = await readFile(USERLIST_PATH);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  async function registerUser(username) {
    const list = await readUserlist();
    if (!list.includes(username)) {
      list.push(username);
      await ensureDir(STORAGE_DIR);
      await writeFile(USERLIST_PATH, JSON.stringify(list, null, 2));
    }
  }

  // ─── Load ──────────────────────────────────────────────────────────────────

  async function loadGlobalLinks() {
    const raw = await readFile(GLOBAL_PATH);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed?.links) ? parsed.links : Array.isArray(parsed) ? parsed : [];
        state.globalLinks = arr.map(l => hydrateLink(l, "global", ""));
        return;
      } catch (e) { console.warn("global.json parse error:", e); }
    }
    try {
      const fromLs = window.localStorage.getItem(LS_KEY_GLOBAL);
      state.globalLinks = fromLs
        ? JSON.parse(fromLs).map(l => hydrateLink(l, "global", ""))
        : [];
    } catch { state.globalLinks = []; }
  }

  async function loadPersonalLinks(username) {
    if (!username) return;
    const path = `${USERS_DIR}/${username}.json`;
    const raw  = await readFile(path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed?.links) ? parsed.links : Array.isArray(parsed) ? parsed : [];
        state.personalLinks[username] = arr.map(l => hydrateLink(l, "personal", username));
        return;
      } catch (e) { console.warn(`user ${username} parse error:`, e); }
    }
    if (username === state.currentUser) {
      try {
        const fromLs = window.localStorage.getItem(LS_KEY_PERSONAL);
        if (fromLs) {
          state.personalLinks[username] = JSON.parse(fromLs).map(l => hydrateLink(l, "personal", username));
          return;
        }
      } catch { /* ignore */ }
    }
    state.personalLinks[username] = [];
  }

  async function loadAllLinks() {
    await loadGlobalLinks();
    if (state.isAdmin) {
      const userlist = await readUserlist();
      const users    = uniqSorted([...userlist, state.currentUser].filter(Boolean));
      for (const u of users) await loadPersonalLinks(u);
    } else {
      await loadPersonalLinks(state.currentUser);
    }
    rebuildAllLinks();
  }

  function rebuildAllLinks() {
    const personal = Object.values(state.personalLinks).flat();
    state.allLinks = [...state.globalLinks, ...personal];
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  async function saveGlobalLinks() {
    if (!state.isAdmin) return false;
    await ensureDir(STORAGE_DIR);
    const payload = JSON.stringify(
      { version: 2, updated_at: nowIso(), links: state.globalLinks }, null, 2);
    const ok = await writeFile(GLOBAL_PATH, payload);
    if (!ok) toast("warn", "Could not save global links (permission?)");
    else {
      try { window.localStorage.setItem(LS_KEY_GLOBAL, JSON.stringify(state.globalLinks)); } catch { /* ignore */ }
    }
    return ok;
  }

  async function savePersonalLinks(username) {
    if (!username) return false;
    await ensureDir(USERS_DIR);
    await registerUser(username);
    const links   = state.personalLinks[username] || [];
    const payload = JSON.stringify({ version: 2, updated_at: nowIso(), links }, null, 2);
    const ok      = await writeFile(`${USERS_DIR}/${username}.json`, payload);
    if (!ok) toast("warn", "Could not save personal links (permission?)");
    else if (username === state.currentUser) {
      try { window.localStorage.setItem(LS_KEY_PERSONAL, JSON.stringify(links)); } catch { /* ignore */ }
    }
    return ok;
  }

  // ─── Filter ────────────────────────────────────────────────────────────────

  function applyFilter() {
    const q     = (state.filter.q     || "").toLowerCase().trim();
    const group = (state.filter.group || "").toLowerCase().trim();
    state.filtered = state.allLinks
      .map((l, idx) => ({ x: l, idx }))
      .filter(({ x: l }) => {
        if (group && (l.group || "").toLowerCase() !== group) return false;
        if (!q) return true;
        const hay = `${l.name} ${l.group} ${l.url} ${l.description} ${l._owner}`.toLowerCase();
        return hay.includes(q);
      });
  }

  function rebuildGroupFilter() {
    const sel     = el("groupFilter");
    const groups  = uniqSorted(state.allLinks.map(x => x.group).concat([DEFAULT_GROUP]));
    const current = sel.value || "";
    sel.innerHTML = "";
    const optAll  = document.createElement("option");
    optAll.value  = "";
    optAll.textContent = "All";
    sel.appendChild(optAll);
    for (const g of groups) {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = g;
      sel.appendChild(o);
    }
    sel.value = groups.includes(current) ? current : "";
    state.filter.group = sel.value;
  }

  // ─── View ──────────────────────────────────────────────────────────────────

  function setView(view) {
    state.filter.view = view;
    el("viewToggle").value = view;
    el("cardsContainer").hidden = view !== "cards";
    el("tableContainer").hidden = view !== "table";
  }

  // ─── Open link ─────────────────────────────────────────────────────────────

  function openLink(link) {
    if (link.open_in_frame) openInFrame(link);
    else window.open(link.url, "_blank", "noopener");
  }

  function openInFrame(link) {
    const url = normalizeUrl(link.url);
    el("embedFrame").src = url;
    el("frameTitle").textContent = link.name || "Embedded";
    el("frameUrl").textContent   = url;
    el("frameArea").hidden = false;
    toast("info", `Opening "${link.name}" in frame…`);
  }

  function closeFrame() {
    el("embedFrame").src = "about:blank";
    el("frameArea").hidden = true;
  }

  // ─── Permissions ───────────────────────────────────────────────────────────

  function canEditLink(link) {
    if (state.isAdmin) return true;
    return link._layer === "personal" && link._owner === state.currentUser;
  }

  // ─── Render cards ──────────────────────────────────────────────────────────

  function renderCards(list) {
    const host = el("cardsContainer");
    host.innerHTML = "";

    if (list.length === 0) {
      host.innerHTML = `<div class="ld-note">No links found.</div>`;
      return;
    }

    for (const { x: l } of list) {
      const card      = document.createElement("div");
      const isGlobal  = l._layer === "global";
      const isOtherUser = !isGlobal && l._owner !== state.currentUser;

      card.className = `ld-card ld-card--${isGlobal ? "global" : "personal"}`;
      card.setAttribute("draggable", canEditLink(l) ? "true" : "false");
      card.dataset.id = l.id;

      const opening = l.open_in_frame ? "frame" : "new tab";

      const iconDup = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 21H8V7h11m0-2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-3-4H4a2 2 0 0 0-2 2v14h2V3h12V1z"/></svg>`;

      const editBtn = canEditLink(l)
        ? `<button class="ld-btn ld-btn-xs" type="button" data-action="edit" data-id="${escapeHtml(l.id)}">Edit</button>`
        : "";
      const dupBtn = canEditLink(l)
        ? `<button class="ld-btn ld-btn-icon" type="button" data-action="duplicate" data-id="${escapeHtml(l.id)}" title="Duplicate">${iconDup}</button>`
        : "";

      const descHtml = l.description
        ? escapeHtml(l.description)
        : `<span class="ld-muted">No description</span>`;

      const layerPill = isGlobal
        ? `<span class="ld-pill ld-pill--global">Global</span>`
        : `<span class="ld-pill ld-pill--personal">Personal</span>`;

      const ownerPill = (state.isAdmin && isOtherUser)
        ? `<span class="ld-pill ld-pill--user">User: ${escapeHtml(l._owner)}</span>`
        : "";

      card.innerHTML = `
        <div class="ld-card-head">
          <div class="ld-card-title">${escapeHtml(l.name)}</div>
          <button class="ld-btn ld-btn-primary" type="button"
            data-action="open" data-id="${escapeHtml(l.id)}">Open</button>
        </div>
        <div class="ld-card-url">
          <a href="#" data-action="open" data-id="${escapeHtml(l.id)}">
            ${escapeHtml(normalizeUrl(l.url))}
          </a>
        </div>
        <div class="ld-card-desc">${descHtml}</div>
        <div class="ld-card-footer">
          <div class="ld-card-meta">
            ${layerPill}
            <span class="ld-pill">${escapeHtml(l.group || DEFAULT_GROUP)}</span>
            <span class="ld-pill">Open: ${opening}</span>
            ${ownerPill}
          </div>
          <div class="ld-card-btns">
            ${editBtn}
            ${dupBtn}
          </div>
        </div>
      `;
      host.appendChild(card);
    }

    host.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const action = btn.getAttribute("data-action");
        const id     = btn.getAttribute("data-id");
        const link   = state.allLinks.find(x => x.id === id);
        if (!link) return;
        if (action === "open")      openLink(link);
        if (action === "edit")      openEditDialog(link);
        if (action === "duplicate") duplicateLink(link);
      });
    });

    let dragId = null;
    host.querySelectorAll(".ld-card[draggable='true']").forEach(card => {
      card.addEventListener("dragstart", (e) => {
        dragId = card.dataset.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragId);
      });
      card.addEventListener("dragover",  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData("text/plain") || dragId;
        moveById(from, card.dataset.id);
        render();
      });
    });
  }

  // ─── Render table ──────────────────────────────────────────────────────────

  function renderTable(list) {
    const host = el("tableContainer");
    host.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "ld-table";

    const rows = list.map(({ x: l }) => {
      const isGlobal = l._layer === "global";
      const opening  = l.open_in_frame ? "frame" : "new tab";
      const iconDupT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 21H8V7h11m0-2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-3-4H4a2 2 0 0 0-2 2v14h2V3h12V1z"/></svg>`;
      const editBtn  = canEditLink(l)
        ? `<button class="ld-btn ld-btn-xs" type="button" data-action="edit" data-id="${escapeHtml(l.id)}">Edit</button>`
        : "";
      const dupBtn = canEditLink(l)
        ? `<button class="ld-btn ld-btn-icon" type="button" data-action="duplicate" data-id="${escapeHtml(l.id)}" title="Duplicate">${iconDupT}</button>`
        : "";
      const desc = l.description ? escapeHtml(l.description) : `<span class="ld-muted">—</span>`;
      const layerBadge = isGlobal
        ? `<span class="ld-pill ld-pill--global">Global</span>`
        : `<span class="ld-pill ld-pill--personal">Personal</span>`;
      const ownerCell = state.isAdmin ? `<td>${escapeHtml(l._owner || "")}</td>` : "";

      return `
        <tr data-id="${escapeHtml(l.id)}" data-layer="${escapeHtml(l._layer)}"
          ${canEditLink(l) ? `draggable="true"` : ""}>
          <td>${escapeHtml(l.name)}</td>
          <td>${escapeHtml(l.group || DEFAULT_GROUP)}</td>
          <td class="ld-url">
            <a href="#" data-action="open" data-id="${escapeHtml(l.id)}">
              ${escapeHtml(normalizeUrl(l.url))}
            </a>
          </td>
          <td>${desc}</td>
          <td>
            <button class="ld-btn ld-btn-primary" type="button"
              data-action="open" data-id="${escapeHtml(l.id)}">Open</button>
          </td>
          <td>${opening}</td>
          <td>${layerBadge}</td>
          ${ownerCell}
          <td class="ld-table-actions">${editBtn}${dupBtn}</td>
        </tr>
      `;
    }).join("");

    wrapper.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Name</th><th>Group</th><th>URL</th><th>Description</th>
            <th>Open</th><th>Mode</th><th>Type</th>
            ${state.isAdmin ? "<th>Owner</th>" : ""}
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    host.appendChild(wrapper);

    wrapper.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const action = btn.getAttribute("data-action");
        const id     = btn.getAttribute("data-id");
        const link   = state.allLinks.find(x => x.id === id);
        if (!link) return;
        if (action === "open")      openLink(link);
        if (action === "edit")      openEditDialog(link);
        if (action === "duplicate") duplicateLink(link);
      });
    });

    let dragId = null;
    wrapper.querySelectorAll("tbody tr[draggable='true']").forEach(tr => {
      tr.addEventListener("dragstart", (e) => {
        dragId = tr.dataset.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragId);
      });
      tr.addEventListener("dragover",  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData("text/plain") || dragId;
        moveById(from, tr.dataset.id);
        render();
      });
    });
  }

  // ─── Reorder ───────────────────────────────────────────────────────────────

  function moveById(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const fromLink = state.allLinks.find(x => x.id === fromId);
    const toLink   = state.allLinks.find(x => x.id === toId);
    if (!fromLink || !toLink) return;

    if (fromLink._layer !== toLink._layer || fromLink._owner !== toLink._owner) {
      toast("warn", "Can only reorder within the same layer.");
      return;
    }

    if (fromLink._layer === "global") {
      const arr  = state.globalLinks;
      const from = arr.findIndex(x => x.id === fromId);
      const to   = arr.findIndex(x => x.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      state.dirtyGlobal = true;
    } else {
      const owner = fromLink._owner;
      const arr   = state.personalLinks[owner];
      if (!arr) return;
      const from  = arr.findIndex(x => x.id === fromId);
      const to    = arr.findIndex(x => x.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      state.dirtyPersonal = true;
    }

    rebuildAllLinks();
    renderOrderNote();
  }

  // ─── Order note ────────────────────────────────────────────────────────────

  function renderOrderNote() {
    const note = el("orderNote");
    note.hidden = !(state.dirtyGlobal || state.dirtyPersonal);
    updateAdminUi();
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  function render() {
    syncThemeFromParent();
    rebuildAllLinks();
    applyFilter();
    rebuildGroupFilter();
    setView(state.filter.view);
    renderOrderNote();
    if (state.filter.view === "cards") renderCards(state.filtered);
    else renderTable(state.filtered);
  }

  // ─── Edit dialog ───────────────────────────────────────────────────────────

  function openEditDialog(linkOrNull) {
    if (linkOrNull && !canEditLink(linkOrNull)) return;
    state.editing = linkOrNull ? { ...linkOrNull } : null;

    el("dialogTitle").textContent = linkOrNull ? "Edit link" : "Add link";
    el("fName").value    = linkOrNull?.name        || "";
    el("fUrl").value     = linkOrNull?.url         || "";
    el("fGroup").value   = linkOrNull?.group       || DEFAULT_GROUP;
    el("fDesc").value    = linkOrNull?.description || "";
    el("fFrame").checked = !!linkOrNull?.open_in_frame;

    // Global checkbox — admin only
    const globalRow = document.getElementById("fGlobalRow");
    if (globalRow) {
      globalRow.hidden = !state.isAdmin;
      el("fGlobal").checked = linkOrNull ? linkOrNull._layer === "global" : false;
    }

    // Populate group datalist
    const dl = el("groupList");
    dl.innerHTML = "";
    for (const g of uniqSorted(state.allLinks.map(x => x.group)).concat([DEFAULT_GROUP])) {
      const o = document.createElement("option");
      o.value = g;
      dl.appendChild(o);
    }

    const delBtn = document.getElementById("deleteBtn");
    if (delBtn) {
      if (linkOrNull) {
        delBtn.hidden = false;
        delBtn.onclick = () => { closeEditDialog(); openDeleteDialog(linkOrNull); };
      } else {
        delBtn.hidden = true;
        delBtn.onclick = null;
      }
    }

    el("editDialog").showModal();
  }

  function closeEditDialog() {
    el("editDialog").close();
    state.editing = null;
  }

  function openDeleteDialog(link) {
    if (!canEditLink(link)) return;
    state.deleting = link;
    el("confirmText").textContent = `Delete "${link.name}"? This cannot be undone.`;
    el("confirmDialog").showModal();
  }

  function closeDeleteDialog() {
    el("confirmDialog").close();
    state.deleting = null;
  }

  // ─── Save link ─────────────────────────────────────────────────────────────

  async function saveEditedLink() {
    const isGlobal = state.isAdmin && el("fGlobal").checked;
    const layer    = isGlobal ? "global" : "personal";
    const owner    = isGlobal ? "" : (state.editing?._owner || state.currentUser);

    let description = el("fDesc").value;

    // Admin editing another user's personal link → tag description
    if (state.isAdmin && state.editing
        && state.editing._layer === "personal"
        && state.editing._owner !== state.currentUser) {
      if (!description.includes(ADMIN_EDITED_TAG)) {
        description = description
          ? `${description} ${ADMIN_EDITED_TAG}`
          : ADMIN_EDITED_TAG;
      }
    }

    const draft = hydrateLink({
      id:            state.editing?.id || uuidv4(),
      name:          el("fName").value,
      url:           normalizeUrl(el("fUrl").value),
      group:         el("fGroup").value || DEFAULT_GROUP,
      description,
      open_in_frame: el("fFrame").checked,
      created_at:    state.editing?.created_at || nowIso(),
      updated_at:    nowIso(),
      _layer:        layer,
      _owner:        owner,
    }, layer, owner);

    const err = validateLink(draft);
    if (err) { toast("warn", err); return; }

    // Track whether the link is switching layers so we can persist the old layer too
    const prevLayer = state.editing?._layer || null;
    const prevOwner = state.editing?._owner || null;
    const layerChanged = state.editing && prevLayer !== layer;

    if (state.editing) removeLinkFromState(state.editing);

    if (layer === "global") {
      state.globalLinks.push(draft);
      state.dirtyGlobal = true;
    } else {
      if (!state.personalLinks[owner]) state.personalLinks[owner] = [];
      state.personalLinks[owner].push(draft);
      state.dirtyPersonal = true;
    }

    rebuildAllLinks();
    renderOrderNote();

    // Save the destination layer
    let ok = layer === "global"
      ? await saveGlobalLinks()
      : await savePersonalLinks(owner);

    // If the link moved between layers, also persist the now-empty source layer
    // so the old entry is removed from disk and doesn't reappear on next load
    if (ok && layerChanged) {
      if (prevLayer === "global") {
        state.dirtyGlobal = true;
        ok = await saveGlobalLinks();
      } else if (prevLayer === "personal" && prevOwner) {
        state.dirtyPersonal = true;
        ok = await savePersonalLinks(prevOwner);
      }
    }

    if (ok) {
      toast("info", "Saved");
      closeEditDialog();
      rebuildGroupFilter();
      render();
    }
  }

  function removeLinkFromState(link) {
    if (link._layer === "global") {
      state.globalLinks = state.globalLinks.filter(x => x.id !== link.id);
    } else {
      const arr = state.personalLinks[link._owner];
      if (arr) state.personalLinks[link._owner] = arr.filter(x => x.id !== link.id);
    }
  }

  // ─── Duplicate link ────────────────────────────────────────────────────────

  async function duplicateLink(link) {
    const clone = hydrateLink({
      ...link,
      id:         uuidv4(),
      name:       `${link.name} (copy)`,
      created_at: nowIso(),
      updated_at: nowIso(),
    }, link._layer, link._owner);

    if (clone._layer === "global") {
      state.globalLinks.push(clone);
      state.dirtyGlobal = true;
      const ok = await saveGlobalLinks();
      if (!ok) return;
    } else {
      const owner = clone._owner || state.currentUser;
      if (!state.personalLinks[owner]) state.personalLinks[owner] = [];
      state.personalLinks[owner].push(clone);
      state.dirtyPersonal = true;
      const ok = await savePersonalLinks(owner);
      if (!ok) return;
    }

    rebuildAllLinks();
    rebuildGroupFilter();
    render();
    toast("info", `Duplicated "${link.name}"`);
    const fresh = state.allLinks.find(x => x.id === clone.id);
    if (fresh) openEditDialog(fresh);
  }

  // ─── Delete link ───────────────────────────────────────────────────────────

  async function deleteLink(link) {
    removeLinkFromState(link);
    let ok;
    if (link._layer === "global") {
      state.dirtyGlobal = true;
      ok = await saveGlobalLinks();
    } else {
      state.dirtyPersonal = true;
      ok = await savePersonalLinks(link._owner);
    }
    if (ok) {
      toast("info", "Deleted");
      closeDeleteDialog();
      rebuildGroupFilter();
      render();
    }
  }

  // ─── Export / Import ───────────────────────────────────────────────────────

  function exportJson() {
    const payload = JSON.stringify({
      version: 2,
      exported_at: nowIso(),
      globalLinks:   state.globalLinks,
      personalLinks: state.personalLinks,
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "linkdash.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("info", "Exported JSON");
  }

  async function importJsonFile(file) {
    if (!state.isAdmin) return;
    const text   = await file.text();
    const parsed = JSON.parse(text);

    if (parsed.globalLinks || parsed.personalLinks) {
      // New layered format
      if (Array.isArray(parsed.globalLinks)) {
        state.globalLinks = parsed.globalLinks.map(l => hydrateLink(l, "global", ""));
        await saveGlobalLinks();
      }
      if (parsed.personalLinks && typeof parsed.personalLinks === "object") {
        for (const [user, links] of Object.entries(parsed.personalLinks)) {
          state.personalLinks[user] = (Array.isArray(links) ? links : [])
            .map(l => hydrateLink(l, "personal", user));
          await savePersonalLinks(user);
        }
      }
    } else {
      // Old flat format → import as global
      const arr = Array.isArray(parsed?.links) ? parsed.links : Array.isArray(parsed) ? parsed : null;
      if (!arr) throw new Error("Invalid JSON format.");
      state.globalLinks = arr.map(l => hydrateLink(l, "global", ""));
      await saveGlobalLinks();
    }

    rebuildAllLinks();
    rebuildGroupFilter();
    render();
    toast("info", "Imported successfully");
  }

  // ─── Save order ────────────────────────────────────────────────────────────

  async function saveOrder() {
    let ok = true;
    if (state.dirtyGlobal && state.isAdmin) {
      ok = await saveGlobalLinks() && ok;
      if (ok) state.dirtyGlobal = false;
    }
    if (state.dirtyPersonal) {
      for (const user of Object.keys(state.personalLinks)) {
        ok = await savePersonalLinks(user) && ok;
      }
      if (ok) state.dirtyPersonal = false;
    }
    if (ok) { renderOrderNote(); toast("info", "Order saved"); }
  }

  // ─── Bind UI ───────────────────────────────────────────────────────────────

  function bindUi() {
    el("searchInput").addEventListener("input",  (e) => { state.filter.q     = e.target.value || ""; render(); });
    el("groupFilter").addEventListener("change", (e) => { state.filter.group = e.target.value || ""; render(); });
    el("viewToggle").addEventListener("change",  (e) => { setView(e.target.value || "cards"); render(); });

    el("addBtn").addEventListener("click", () => openEditDialog(null));
    el("exportBtn").addEventListener("click", exportJson);

    el("importBtn").addEventListener("click", () => {
      if (!state.isAdmin) return;
      el("importFile").value = "";
      el("importFile").click();
    });

    el("importFile").addEventListener("change", async (e) => {
      if (!state.isAdmin) return;
      const f = e.target.files?.[0];
      if (!f) return;
      try { await importJsonFile(f); }
      catch (err) { toast("warn", `Import failed: ${err?.message || err}`); }
    });

    el("saveOrderBtn").addEventListener("click", saveOrder);
    el("closeFrameBtn").addEventListener("click", closeFrame);
    el("openFrameNewTabBtn").addEventListener("click", () => {
      const url = el("embedFrame").src;
      if (url && url !== "about:blank") window.open(url, "_blank", "noopener,noreferrer");
    });

    el("cancelBtn").addEventListener("click", closeEditDialog);

    el("editForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveEditedLink();
    });

    el("confirmCancel").addEventListener("click", closeDeleteDialog);

    el("confirmForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const link = state.deleting;
      if (!link) return;
      await deleteLink(link);
    });

    try {
      const obs = new MutationObserver(() => render());
      obs.observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["class"] });
    } catch { /* ignore */ }
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    syncThemeFromParent();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncThemeFromParent(); });

    await detectAdmin();
    await detectCurrentUser();
    updateAdminUi();
    await loadAllLinks();

    try {
      const v = window.localStorage.getItem("linkdash.view");
      if (v === "table" || v === "cards") state.filter.view = v;
    } catch { /* ignore */ }

    bindUi();
    rebuildGroupFilter();
    render();
  }

  init().catch((e) => {
    console.error(e);
    document.body.innerHTML = `<pre style="white-space:pre-wrap">LinkDash failed to load:\n${escapeHtml(e?.stack || e?.message || String(e))}</pre>`;
  });
})();