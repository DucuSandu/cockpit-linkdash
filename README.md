# LinkDash

LinkDash is a [Cockpit](https://cockpit-project.org/) plugin that provides a
multi-user service bookmark dashboard with optional embedded frame support.
It integrates cleanly with Cockpit's PatternFly theme without any visual
drift, hardcoded styles, or external framework dependencies.

---

## Requirements

| Requirement | Version |
|---|---|
| Cockpit | ≥ 318 |
| Browser | Any modern browser (ES2020+, native `<dialog>`) |

No build step, no npm, no bundler. Drop the files in and it works.

---

## Installation

### 1. Create the plugin directory

```bash
sudo mkdir -p /usr/share/cockpit/linkdash
```

### 2. Copy the plugin files

```bash
sudo cp index.html linkdash.js linkdash.css manifest.json \
    /usr/share/cockpit/linkdash/
```

### 3. Create the storage directories and set permissions

LinkDash stores links as JSON files under `/etc/cockpit/linkdash/`.
The directory and its contents must be readable and writable by Cockpit's
superuser escalation mechanism.

```bash
sudo mkdir -p /etc/cockpit/linkdash/users
sudo chown -R root:root /etc/cockpit/linkdash
sudo chmod -R 755 /etc/cockpit/linkdash
```

### 4. Reload Cockpit

```bash
sudo systemctl reload cockpit
```

### 5. Open LinkDash

Log into Cockpit and look for **LinkDash** in the left navigation, or search
for `links`, `bookmarks`, or `dashboard` using the Cockpit search.

---

## Storage Layout

All data is stored as plain JSON. No database required.

```
/etc/cockpit/linkdash/
├── global.json          ← Links visible to all users (admin-managed)
├── userlist.json        ← Registry of users who have personal links
└── users/
    ├── alice.json       ← Personal links for user "alice"
    └── bob.json         ← Personal links for user "bob"
```

Each JSON file follows this structure:

```json
{
  "version": 2,
  "updated_at": "2025-01-01T00:00:00.000Z",
  "links": [
    {
      "id": "uuid-v4",
      "name": "Grafana",
      "url": "https://grafana.example.com",
      "group": "Monitoring",
      "description": "Metrics dashboard",
      "open_in_frame": false,
      "created_at": "2025-01-01T00:00:00.000Z",
      "updated_at": "2025-01-01T00:00:00.000Z",
      "_layer": "global",
      "_owner": ""
    }
  ]
}
```

localStorage is used as a read fallback only — if a JSON file exists on disk,
it always takes precedence. localStorage is written on every successful save
so the UI can still load links when file access is temporarily unavailable.

---

## Features

### Link Management

- **Add** links via the *Add link* button in the header
- **Edit** any link you own using the *Edit* button on each card or table row
- **Duplicate** any link using the copy icon (⧉) — creates a clone named
  `"original name (copy)"` and immediately opens it for editing
- **Delete** links from inside the edit dialog (confirmation required)
- All links require a **Name**, **URL** (http/https only), and **Group**.
  Description and open mode are optional. If the URL scheme is omitted,
  `https://` is prepended automatically.

### Two-Layer Permission Model

LinkDash separates links into two layers:

| Layer | Who can create | Who can see | Who can edit |
|---|---|---|---|
| **Global** | Admins only | Everyone | Admins only |
| **Personal** | Any logged-in user | That user + admins | Owner + admins |

Admins see all users' personal links and can edit them. When an admin edits
another user's personal link, the description is automatically tagged with
`(Admin Edited)` to maintain an audit trail.

Admins can promote a personal link to global (or demote a global link to
personal) by toggling the *Global link* checkbox in the edit dialog. Both
the source and destination storage files are updated atomically so no
duplicates appear on reload.

### Groups

Links are organised into named groups. The Group field supports free-text
input with autocomplete drawn from existing groups. The Group filter in the
toolbar lets you scope the view to a single group. The default group is
`General`.

### Search

The search box filters across **name**, **group**, **URL**, **description**,
and **owner** simultaneously, in real time.

### Views

Toggle between **Cards** and **Table** using the View selector. The chosen
view is persisted to localStorage and restored on next load.

**Cards view** shows each link as a card with:
- Name and Open button at the top
- Clickable URL
- Description (clamped to 2 lines)
- Footer row: layer pill, group pill, open-mode pill, owner pill (admin only),
  Edit button, and Duplicate icon — all inline, right-aligned

**Table view** shows all links in a compact table with columns for Name,
Group, URL, Description, Open button, Mode, Type, Owner (admin only), and
an actions cell with Edit + Duplicate icon.

### Drag-and-Drop Reorder

Cards and table rows can be dragged to reorder. Reorder operates on the
underlying data arrays independently of any active search or group filter,
so the full order is preserved even when only a subset is visible. You can
only reorder within the same layer (global links among global links, your
own personal links among your own). A *"Save order"* button appears in the
header whenever there are unsaved order changes.

### Embedded Frame

Any link can be configured to open inside an embedded iframe panel within
Cockpit rather than in a new tab. The frame panel includes the link name,
URL, a hint about X-Frame-Options/CSP restrictions, an *Open in new tab*
escape hatch, and a *Close* button. Frame mode is set per-link in the edit
dialog.

### Import / Export

- **Export** downloads a `linkdash.json` snapshot of all global and personal
  links visible to the current session.
- **Import** (admin only) reads a JSON file and restores links, supporting
  both the current layered format (`v2`) and the legacy flat format from
  earlier versions (imported as global links).

---

## Permissions Summary

| Action | Regular user | Admin |
|---|---|---|
| View global links | ✅ | ✅ |
| View own personal links | ✅ | ✅ |
| View other users' personal links | ❌ | ✅ |
| Add personal links | ✅ | ✅ |
| Add global links | ❌ | ✅ |
| Edit own personal links | ✅ | ✅ |
| Edit other users' personal links | ❌ | ✅ |
| Edit global links | ❌ | ✅ |
| Delete own personal links | ✅ | ✅ |
| Delete any link | ❌ | ✅ |
| Import | ❌ | ✅ |
| Export | ✅ | ✅ |
| Reorder own personal links | ✅ | ✅ |
| Reorder global links | ❌ | ✅ |

---

## Theme Integration

LinkDash uses **only** PatternFly design tokens sourced from Cockpit's
`shell.css`. No colors are hardcoded anywhere in the stylesheet.

All internal styles use `--ld-*` custom properties which are mapped from
PatternFly tokens in `:root`:

```css
:root {
  --ld-bg:         var(--pf-t--global--background--color--secondary--default);
  --ld-text:       var(--pf-t--global--text--color--regular);
  --ld-primary-bg: var(--pf-t--global--background--color--action--primary--default);
  /* ... */
}
```

The plugin syncs the active `pf-v6-theme-*` class from the parent Cockpit
frame on load, on visibility change, and reactively via `MutationObserver`,
so light/dark mode switches apply immediately without a page reload.

---

## File Structure

```
index.html      → HTML layout and dialog markup
linkdash.js     → All application logic and state management
linkdash.css    → PF-token-mapped styles (no hardcoded colors)
manifest.json   → Cockpit plugin metadata and keyword registration
README.md       → This file
```

---

## Design Principles

- Zero visual drift from Cockpit's native UI
- No local theme system — PF tokens only
- No hardcoded color values or fallbacks
- No external dependencies — no npm, no bundler, no CDN
- Explicit behavior over magic
- Clean separation: structure in HTML, style in CSS, logic in JS
- Filesystem-first storage with localStorage as a read fallback only
