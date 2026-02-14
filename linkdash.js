/* global cockpit */
(() => {
  "use strict";

  const STORAGE_DIR = "/etc/cockpit/linkdash";
  const STORAGE_PATH = "/etc/cockpit/linkdash/linkdash.json";
  const LS_KEY = "linkdash.links.v1";
  const DEFAULT_GROUP = "General";

  function el(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element #${id}`);
    return node;
  }

  function nowIso() {
    return new Date().toISOString();
  }

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
    } catch {
      return false;
    }
  }

  function uuidv4() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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

  // PFv6 theme sync: copy pf-v6-theme-* from Cockpit shell
  function syncThemeFromParent() {
    try {
      const ours = document.documentElement.classList;
      const theirs = window.parent?.document?.documentElement?.classList;
      if (!theirs) return;

      // Remove old theme classes
      for (const c of Array.from(ours)) {
        if (c.startsWith("pf-v6-theme-")) ours.remove(c);
      }

      // Copy theme class(es) from the Cockpit shell
      for (const c of Array.from(theirs)) {
        if (c.startsWith("pf-v6-theme-")) ours.add(c);
      }
    } catch {
      // ignore
    }
  }

  function byGroupThenName(a, b) {
    const ag = (a.group || "").toLowerCase();
    const bg = (b.group || "").toLowerCase();
    if (ag !== bg) return ag.localeCompare(bg);
    const an = (a.name || "").toLowerCase();
    const bn = (b.name || "").toLowerCase();
    return an.localeCompare(bn);
  }

  function hydrateLink(raw) {
    const name = String(raw?.name ?? "").trim();
    const url = String(raw?.url ?? "").trim();
    const group = String(raw?.group ?? DEFAULT_GROUP).trim() || DEFAULT_GROUP;
    const description = String(raw?.description ?? "").trim();
    const open_in_frame = !!raw?.open_in_frame;

    const id = String(raw?.id ?? "").trim() || uuidv4();
    const created_at = String(raw?.created_at ?? "").trim() || nowIso();
    const updated_at = String(raw?.updated_at ?? "").trim() || created_at;

    return {
      id,
      name,
      url,
      group,
      description,
      open_in_frame,
      created_at,
      updated_at,
    };
  }

  function validateLink(link) {
    const name = String(link?.name || "").trim();
    const url = String(link?.url || "").trim();
    const group = String(link?.group || "").trim();

    if (!name) return "Name is required.";
    if (!group) return "Group is required.";
    if (!url) return "URL is required.";

    const normalized = normalizeUrl(url);
    if (!isHttpHttpsUrl(normalized)) return "URL must be http/https.";

    return null;
  }

  const state = {
    isAdmin: false,
    links: [],
    filtered: [],
    editing: null,
    deleting: null,
    dirtyOrder: false,
    filter: {
      q: "",
      group: "",
      view: "cards",
    },
  };

  async function detectAdmin() {
    try {
      // cockpit.permission is not always present; be defensive
      if (cockpit?.permission) {
        const perm = cockpit.permission({ admin: true });
        state.isAdmin = !!perm.allowed;
        perm.addEventListener?.("changed", () => {
          state.isAdmin = !!perm.allowed;
          updateAdminUi();
          render();
        });
      } else {
        // fallback: try to write test file? keep read-only mode by default
        state.isAdmin = false;
      }
    } catch {
      state.isAdmin = false;
    }
  }

  function updateAdminUi() {
    const permNote = document.getElementById("permissionNote");
    if (permNote) permNote.hidden = !!state.isAdmin;

    const addBtn = document.getElementById("addBtn");
    const importBtn = document.getElementById("importBtn");
    const exportBtn = document.getElementById("exportBtn");
    const saveOrderBtn = document.getElementById("saveOrderBtn");

    if (addBtn) addBtn.disabled = !state.isAdmin;
    if (importBtn) importBtn.disabled = !state.isAdmin;
    if (saveOrderBtn) saveOrderBtn.disabled = !state.isAdmin || !state.dirtyOrder;

    // Export can be allowed even in read-only mode
    if (exportBtn) exportBtn.disabled = false;
  }

  async function ensureStorageDir() {
    try {
      await cockpit.spawn(["/bin/mkdir", "-p", STORAGE_DIR], { superuser: "try" });
    } catch {
      // ignore (read-only mode)
    }
  }

  async function readFile(path) {
    const fs = cockpit.file(path, { superuser: "try" });
    try {
      return await fs.read();
    } catch {
      return null;
    } finally {
      fs.close();
    }
  }

  async function writeFile(path, content) {
    const fs = cockpit.file(path, { superuser: "try" });
    try {
      await fs.replace(content);
      return true;
    } catch (e) {
      console.error("write failed:", e);
      return false;
    } finally {
      fs.close();
    }
  }

  async function loadLinks() {
    // prefer file, fallback to localStorage for read-only demos
    const raw = await readFile(STORAGE_PATH);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const links = Array.isArray(parsed?.links) ? parsed.links : Array.isArray(parsed) ? parsed : [];
        state.links = links.map(hydrateLink).sort(byGroupThenName);
        return;
      } catch (e) {
        console.warn("Invalid JSON in storage file, falling back to localStorage:", e);
      }
    }

    try {
      const fromLs = window.localStorage.getItem(LS_KEY);
      if (fromLs) {
        const parsed = JSON.parse(fromLs);
        state.links = (Array.isArray(parsed) ? parsed : []).map(hydrateLink).sort(byGroupThenName);
      } else {
        state.links = [];
      }
    } catch {
      state.links = [];
    }
  }

  async function saveLinksToDisk() {
    if (!state.isAdmin) return false;

    await ensureStorageDir();

    const payload = JSON.stringify(
      {
        version: 1,
        updated_at: nowIso(),
        links: state.links,
      },
      null,
      2
    );

    const ok = await writeFile(STORAGE_PATH, payload);
    if (!ok) toast("warn", "Could not save to disk (permission?)");
    return ok;
  }

  function saveLinksToLocalStorage() {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(state.links));
    } catch {
      // ignore
    }
  }

  function applyFilter() {
    const q = (state.filter.q || "").toLowerCase().trim();
    const group = (state.filter.group || "").toLowerCase().trim();

    const filtered = state.links
      .map((l, idx) => ({ x: l, idx }))
      .filter(({ x: l }) => {
        if (group && (l.group || "").toLowerCase() !== group) return false;
        if (!q) return true;
        const hay = `${l.name} ${l.group} ${l.url} ${l.description}`.toLowerCase();
        return hay.includes(q);
      });

    state.filtered = filtered;
  }

  function rebuildGroupFilter() {
    const sel = el("groupFilter");
    const groups = uniqSorted(state.links.map(x => x.group).concat([DEFAULT_GROUP]));

    const current = sel.value || "";
    sel.innerHTML = "";

    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "All";
    sel.appendChild(optAll);

    for (const g of groups) {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = g;
      sel.appendChild(o);
    }

    // Keep current selection if still valid
    const wanted = groups.includes(current) ? current : "";
    sel.value = wanted;
    state.filter.group = wanted;
  }

  function setView(view) {
    state.filter.view = view;
    el("viewToggle").value = view;

    if (view === "cards") {
      el("cardsContainer").hidden = false;
      el("tableContainer").hidden = true;
    } else {
      el("cardsContainer").hidden = true;
      el("tableContainer").hidden = false;
    }
  }

  function openLink(link) {
    const url = normalizeUrl(link.url);
    if (link.open_in_frame) {
      openInFrame(link);
    } else {
      window.open(link.url, "_blank", "noopener");
    }
 }
 

  function openInFrame(link) {
    const frame = el("embedFrame");
    const url = normalizeUrl(link.url);
    frame.src = url;
    el("frameTitle").textContent = link.name || "Embedded";
    el("frameUrl").textContent = url;
    el("frameArea").hidden = false;
    toast("info", `Opening "${link.name}" in frame…`);
  }

  function closeFrame() {
    el("embedFrame").src = "about:blank";
    el("frameArea").hidden = true;
  }

  function renderCards(list) {
    const host = el("cardsContainer");
    host.innerHTML = "";

    if (list.length === 0) {
      host.innerHTML = `<div class="ld-note">No links found.</div>`;
      return;
    }

    for (const { x: l } of list) {
      const card = document.createElement("div");
      card.className = "ld-card";
      card.setAttribute("draggable", state.isAdmin ? "true" : "false");
      card.dataset.id = l.id;

      const opening = l.open_in_frame ? "frame" : "new tab";

      // Delete moved into Edit dialog
      const adminButtons = state.isAdmin
        ? `<button class="ld-btn" type="button" data-action="edit" data-id="${escapeHtml(l.id)}">Edit</button>`
        : "";

      const descHtml = l.description
        ? escapeHtml(l.description)
        : `<span class="ld-muted">No description</span>`;

      card.innerHTML = `
     <div class="ld-card-head">
        <div class="ld-card-title">${escapeHtml(l.name)}</div>
        <button class="ld-btn ld-btn-primary" type="button"
          data-action="open" data-id="${escapeHtml(l.id)}">
          Open
        </button>
     </div>

     <div class="ld-card-meta">
        <span class="ld-pill">${escapeHtml(l.group || DEFAULT_GROUP)}</span>
       <span class="ld-pill">Open: ${opening}</span>
     </div>

     <div class="ld-card-url">
        <a href="#" data-action="open" data-id="${escapeHtml(l.id)}">
          ${escapeHtml(normalizeUrl(l.url))}
        </a>
     </div>

  <div class="ld-card-desc">${descHtml}</div>

  <div class="ld-card-actions">
    ${adminButtons}
  </div>
      `;

      host.appendChild(card);
    }

    host.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const action = btn.getAttribute("data-action");
        const id = btn.getAttribute("data-id");
        const link = state.links.find(x => x.id === id);
        if (!link) return;

        if (action === "open") openLink(link);
        if (action === "frame") openInFrame(link);
        if (action === "edit") openEditDialog(link);
      });
    });

    if (state.isAdmin) {
      let dragId = null;

      host.querySelectorAll(".ld-card[draggable='true']").forEach(card => {
        card.addEventListener("dragstart", (e) => {
          dragId = card.dataset.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", dragId);
        });

        card.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });

        card.addEventListener("drop", (e) => {
          e.preventDefault();
          const targetId = card.dataset.id;
          const from = e.dataTransfer.getData("text/plain") || dragId;
          moveById(from, targetId);
          render();
        });
      });
    }
  }

  function renderTable(list) {
    const host = el("tableContainer");
    host.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "ld-table";

    const rows = list.map(({ x: l }) => {
      const opening = l.open_in_frame ? "frame" : "new tab";

      // Delete moved into Edit dialog
      const adminButtons = state.isAdmin
        ? `<button class="ld-btn" type="button" data-action="edit" data-id="${escapeHtml(l.id)}">Edit</button>`
        : "";

      const desc = l.description ? escapeHtml(l.description) : `<span class="ld-muted">—</span>`;

      return `
	<tr data-id="${escapeHtml(l.id)}" ${state.isAdmin ? `draggable="true"` : ""}>
	  <td>${escapeHtml(l.name)}</td>
	  <td>${escapeHtml(l.group || DEFAULT_GROUP)}</td>
	  <td class="ld-url">
		<a href="#" data-action="open" data-id="${escapeHtml(l.id)}">
		  ${escapeHtml(normalizeUrl(l.url))}
		</a>
	  </td>
	  <td>${desc}</td>
	  <td>
		<button class="ld-btn ld-btn-primary"
		  type="button"
		  data-action="open"
		  data-id="${escapeHtml(l.id)}">
		  Open
		</button>
		
	  </td>
	  <td>${opening}</td>
	   <td>${state.isAdmin ? adminButtons : ""}</td>

	</tr>
      `;
    }).join("");

    wrapper.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Group</th>
            <th>URL</th>
            <th>Description</th>
            <th>Open</th>
	    <th>Mode</th>
            ${state.isAdmin ? "<th>Admin</th>" : ""}
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
        const id = btn.getAttribute("data-id");
        const link = state.links.find(x => x.id === id);
        if (!link) return;

        if (action === "open") openLink(link);
        if (action === "edit") openEditDialog(link);
      });
    });

    if (state.isAdmin) {
      let dragId = null;

      wrapper.querySelectorAll("tbody tr[draggable='true']").forEach(tr => {
        tr.addEventListener("dragstart", (e) => {
          dragId = tr.dataset.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", dragId);
        });

        tr.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });

        tr.addEventListener("drop", (e) => {
          e.preventDefault();
          const targetId = tr.dataset.id;
          const from = e.dataTransfer.getData("text/plain") || dragId;
          moveById(from, targetId);
          render();
        });
      });
    }
  }

  function renderOrderNote() {
    const note = el("orderNote");
    note.hidden = !state.dirtyOrder;
    updateAdminUi();
  }

  function moveById(fromId, toId) {
    if (!state.isAdmin) return;
    if (!fromId || !toId || fromId === toId) return;

    const fromIdx = state.links.findIndex(x => x.id === fromId);
    const toIdx = state.links.findIndex(x => x.id === toId);

    if (fromIdx < 0 || toIdx < 0) return;

    const [moved] = state.links.splice(fromIdx, 1);
    state.links.splice(toIdx, 0, moved);

    state.dirtyOrder = true;
    renderOrderNote();
  }

  function render() {
    syncThemeFromParent();
    applyFilter();

    rebuildGroupFilter();

    setView(state.filter.view);

    renderOrderNote();

    if (state.filter.view === "cards") {
      renderCards(state.filtered);
    } else {
      renderTable(state.filtered);
    }
  }

  function openEditDialog(linkOrNull) {
    if (!state.isAdmin) return;

    state.editing = linkOrNull ? { ...linkOrNull } : null;

    el("dialogTitle").textContent = linkOrNull ? "Edit link" : "Add link";
    el("fName").value = linkOrNull?.name || "";
    el("fUrl").value = linkOrNull?.url || "";
    el("fGroup").value = linkOrNull?.group || DEFAULT_GROUP;
    el("fDesc").value = linkOrNull?.description || "";
    el("fFrame").checked = !!linkOrNull?.open_in_frame;

    // Populate group datalist
    const dl = el("groupList");
    dl.innerHTML = "";
    for (const g of uniqSorted(state.links.map(x => x.group)).concat([DEFAULT_GROUP])) {
      const o = document.createElement("option");
      o.value = g;
      dl.appendChild(o);
    }

    // Show Delete only when editing an existing link
    const delBtn = document.getElementById("deleteBtn");
    if (delBtn) {
      if (linkOrNull) {
        delBtn.hidden = false;
        delBtn.onclick = () => {
          closeEditDialog();
          openDeleteDialog(linkOrNull);
        };
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
    if (!state.isAdmin) return;
    state.deleting = link;

    el("confirmText").textContent = `Delete "${link.name}"? This cannot be undone.`;
    el("confirmDialog").showModal();
  }

  function closeDeleteDialog() {
    el("confirmDialog").close();
    state.deleting = null;
  }

  function exportJson() {
    const payload = JSON.stringify(state.links, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
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
    const text = await file.text();
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed?.links) ? parsed.links : Array.isArray(parsed) ? parsed : null;
    if (!arr) throw new Error("Invalid JSON format (expected array or {links:[]}).");

    const imported = arr.map(hydrateLink);

    // Replace existing set (preserve order from file)
    state.links = imported;

    state.dirtyOrder = true;
    renderOrderNote();

    // persist
    await saveLinksToDisk();
    saveLinksToLocalStorage();

    rebuildGroupFilter();
    render();
    toast("info", `Imported ${imported.length} links`);
  }

  function bindUi() {
    // Search
    el("searchInput").addEventListener("input", (e) => {
      state.filter.q = e.target.value || "";
      render();
    });

    // Group filter
    el("groupFilter").addEventListener("change", (e) => {
      state.filter.group = e.target.value || "";
      render();
    });

    // View toggle
    el("viewToggle").addEventListener("change", (e) => {
      setView(e.target.value || "cards");
      render();
    });

    // Add
    el("addBtn").addEventListener("click", () => openEditDialog(null));

    // Import/export
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
      try {
        await importJsonFile(f);
      } catch (err) {
        toast("warn", `Import failed: ${err?.message || err}`);
      }
    });

    // Save order
    el("saveOrderBtn").addEventListener("click", async () => {
      if (!state.isAdmin) return;
      const ok = await saveLinksToDisk();
      if (ok) {
        state.dirtyOrder = false;
        renderOrderNote();
        saveLinksToLocalStorage();
        toast("info", "Order saved");
      }
    });

    // Close frame
    el("closeFrameBtn").addEventListener("click", closeFrame);
    el("openFrameNewTabBtn").addEventListener("click", () => {
      const url = el("embedFrame").src;
      if (url && url !== "about:blank") window.open(url, "_blank", "noopener,noreferrer");
    });

    // Edit dialog: cancel
    el("cancelBtn").addEventListener("click", closeEditDialog);

    // Edit dialog: save
    el("editForm").addEventListener("submit", async () => {
      if (!state.isAdmin) return;

      const draft = hydrateLink({
        id: state.editing?.id || uuidv4(),
        name: el("fName").value,
        url: normalizeUrl(el("fUrl").value),
        group: el("fGroup").value || DEFAULT_GROUP,
        description: el("fDesc").value,
        open_in_frame: el("fFrame").checked,
        created_at: state.editing?.created_at || nowIso(),
        updated_at: nowIso(),
      });

      const err = validateLink(draft);
      if (err) {
        toast("warn", err);
        return;
      }

      if (state.editing) {
        const idx = state.links.findIndex(x => x.id === state.editing.id);
        if (idx >= 0) state.links[idx] = draft;
      } else {
        state.links.push(draft);
      }

      state.dirtyOrder = true;
      renderOrderNote();

      const ok = await saveLinksToDisk();
      if (ok) {
        saveLinksToLocalStorage();
        toast("info", "Saved");
        closeEditDialog();
        rebuildGroupFilter();
        render();
      }
    });

    // Confirm delete: cancel
    el("confirmCancel").addEventListener("click", closeDeleteDialog);

    // Confirm delete: confirm
    el("confirmForm").addEventListener("submit", async () => {
      if (!state.isAdmin) return;
      const link = state.deleting;
      if (!link) return;

      state.links = state.links.filter(x => x.id !== link.id);

      state.dirtyOrder = true;
      renderOrderNote();

      const ok = await saveLinksToDisk();
      if (ok) {
        saveLinksToLocalStorage();
        toast("info", "Deleted");
        closeDeleteDialog();
        rebuildGroupFilter();
        render();
      }
    });

    // Theme changes in shell: best-effort re-sync
    try {
      const obs = new MutationObserver(() => render());
      obs.observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["class"] });
    } catch {
      // ignore
    }
  }

  async function init() {
    syncThemeFromParent();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncThemeFromParent();
    });
    await detectAdmin();
    updateAdminUi();
    await loadLinks();

    // Default view from localStorage (optional)
    try {
      const v = window.localStorage.getItem("linkdash.view");
      if (v === "table" || v === "cards") state.filter.view = v;
    } catch {
      // ignore
    }

    bindUi();
    rebuildGroupFilter();
    render();
  }

  init().catch((e) => {
    console.error(e);
    document.body.innerHTML = `<pre style="white-space:pre-wrap">LinkDash failed to load:\n${escapeHtml(e?.stack || e?.message || String(e))}</pre>`;
  });
})();
