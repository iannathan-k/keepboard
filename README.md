# KeepBoard

A minimalist, high-speed, self-hosted Google Keep–style scratchpad and arbitrary file-parking web application designed to run entirely in RAM as a single lightweight Docker container mounted on a `tmpfs` RAM disk with optional persistent disk mirroring (`/persist`).

Zero social-media clutter. Zero account registration friction. Instant cold boots into a production-ready board with near **0.00% idle CPU** and negligible RAM overhead.

---

## What's New in KeepBoard v4

- **Modern Keep (Theme A) + Classic Keep Dark (Palette A2)**:
  - Deep-slate canvas (`#141517`), elevated surfaces (`#1E2023`), warm gold brand highlights (`#FACC15`), and frosted sticky headers (`rgba(20, 21, 23, 0.90)` with `backdrop-filter: blur(14px)`).
  - Crisp inline SVG favicon in `<head>` (dark-slate badge `#1E2023` with warm gold lightbulb) rendering sharply on browser tabs and bookmarks with zero network requests.
  - Authentic Google Keep left-aligned masonry tiling (`justify-content: start`) so notes naturally fill columns from left to right without awkward centering gaps.
- **Ultra-Lean Resource Footprint (~0.00% Idle CPU & Minimal RAM)**:
  - Docker container tuned for production: `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`, single Uvicorn worker with `--no-access-log`, and lightweight 120s healthcheck.
  - In-memory metadata index (`notes_cache`, `notes_index`, `workspaces_cache`) and cached storage stats with zero disk-walking on API hits.
  - HTTP cache-control headers on static assets (`max-age=86400` on JS/CSS, `no-cache` on HTML).
- **Lightweight Monotonic Cross-Device Auto-Sync**:
  - Replaced heavy open SSE connections with a periodic monotonic sync check: backend increments `server_sync_revision` on note mutations, exposed at `GET /api/sync-token` (<30 bytes).
  - Frontend polls `/api/sync-token` every 5 seconds on active tabs and completely pauses (`clearInterval`) when `document.hidden` is true (minimized/background tab), achieving 0.00% idle CPU.
  - Resumes and validates immediately on focus, refreshing notes only if the user is not actively typing inside an open editor.
- **Decluttered Minimal Card Hover Action Bar**:
  - Pinned button (top-right) and multi-select checkmark (top-left) remain accessible at a glance.
  - Compact bottom hover toolbar with 4 primary quick actions matching Google Keep:
    - **Color Palette**
    - **Archive / Unarchive**
    - **Open Side-by-Side** (`◫`)
    - **Delete / Move to Trash** (subtle red hover tint; shows Restore and Delete Forever in Trash view)
    - **More (⋮) Overflow Menu**: Move to Workspace, Labels, Persist on Disk (Shield), Lock in Vault, and Duplicate.
  - Full editing controls (Aa formatting, checklist toggle, attachments, shield, tags, workspace selector) preserved inside opened notes.
- **Natural Side-by-Side Dual Note Modal (`◫`)**:
  - One-click `◫` button in the note modal header smoothly widens the modal into a two-column layout (`max-width: 1180px`, `gap: 16px`).
  - Integrated note picker on the secondary pane with instant search to pick any note to open beside your current one, complete with independent `✕` close controls.
- **Advanced Interactive Checklists**:
  - Interactive checkboxes render directly inside the main editor body area in both composer and modal.
  - Accurate progress bar percentage calculation (`Math.round((checked / total) * 100)`).
  - Clean conversion back to plain text without leaving orphaned `☐` or `☑` characters.
  - Collapsible Google Keep-style `▸ N completed items` section (collapsed by default). Checking an item moves it down; unchecking restores it to active.
  - 1-level 24px indented checkbox hierarchy with `⇥` / `⇤` buttons and keyboard shortcuts (<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>). Checking a parent item cascades to check all indented sub-items.
- **Canvas Rubber-Band Drag-to-Select**:
  - Dragging across empty canvas space draws a Theme A lasso rectangle (`rgba(250, 204, 21, 0.12)`, `1px solid #FACC15`).
  - Intersecting cards enter multi-select mode and bring up the sticky batch action bar.
  - Clicking empty canvas cleanly deselects all notes.
- **Multi-Workspace Organization**:
  - Switch between isolated workspaces (Personal, Work, Scratch, etc.) with workspace-scoped views and batch note relocation.
- **Reliable Universal Clipboard Copy**:
  - Universal `copyToClipboard()` with `<textarea>` + `document.execCommand('copy')` fallback ensuring copy operations for notes, code blocks, QR share links, and CLI snippets work over plain HTTP and local IP origins.
- **Auto-Collapsing Document Outline Rail**:
  - Table of Contents auto-collapses when a note has 0 headings (H1–H3) and smoothly expands when headings are added.
- **Global Drag-and-Drop File Uploads**:
  - Global `window` drop protection prevents accidental browser navigation or previewer openings when dropping files.
  - Dropping files onto cards uploads to that card's attachments; dropping onto empty canvas creates a new note.
- **Esc & Backdrop Click to Save & Exit**:
  - Flushes auto-saves, closes modal, and updates cards on <kbd>Esc</kbd> or clicking the blurred backdrop.

---

## Core Features

- **Google Keep Layout & Collapsible Left Navigation**: Notes, Archive, Trash, Vault, dynamic Labels, and Workspaces.
- **8 Refined Dark-Mode Color Swatches**: Default Dark, Coral, Amber, Sand, Olive, Teal, Slate, Purple with harmonizing border tints.
- **Multi-Select & Floating Batch Action Bar**: Batch Pin, Color, Tag, Archive, Merge, Export `.zip`, Move Workspace, and Trash/Delete Forever.
- **7-Day Auto-Purging Trash Bin**: Soft-delete lifecycle with countdown badges (`🗑 Purges in 6d`), Restore, and one-click "Empty Trash Now".
- **Password-Protected Vault**: PBKDF2-SHA256 encrypted confidential scratchpad with session lock/unlock.
- **Hybrid RAM + Persistent Disk Option**: "Save to Disk" shield toggle on cards mirroring designated notes to an optional `/persist` volume across restarts while keeping the primary store in high-speed RAM (`tmpfs`).
- **Direct CLI / Terminal Drops (`POST /api/drop`)**: `curl` files, logs, or piped text directly into KeepBoard from your command line without opening a browser.
- **Embedded Pure-JS QR Code Generator**: Instant mobile phone scanning for direct file downloads or note links over local Wi-Fi.
- **ZIP / JAR Archive Peek & Extract**: Inspect file lists and sizes inside archives without downloading, and extract single files on demand.
- **SSRF-Safe Rich Bookmark Link Previews**: Open Graph metadata, title, description, and favicon scraping.
- **Spotlight / Command Palette (<kbd>Cmd</kbd>+<kbd>K</kbd> / <kbd>Ctrl</kbd>+<kbd>K</kbd>)**: Fast keyboard navigation, commands, and note jumping.
- **One-Click Backup Export & Restore**: Full `.zip` bundle containing `notes.json`, `vault.json`, `workspaces.json`, and all attachments.

---

## Project Structure

```
keepboard/
├── Dockerfile              # Alpine-based lean image (UID 1000:1000, 1 worker, no-access-log)
├── docker-compose.yml      # Service with tmpfs RAM mount and optional persist volume
├── requirements.txt        # FastAPI, Uvicorn, Python-Multipart
├── app/
│   ├── main.py             # FastAPI backend with in-memory caching, atomic persistence, & sync
│   └── static/
│       ├── index.html      # Single-page app markup with inline SVG favicon & Theme A styling
│       ├── styles.css      # Theme A + Palette A2 design system, animations, & density styles
│       ├── app.js          # Core application orchestration, state, auto-sync, & lasso selection
│       ├── editor.js       # WYSIWYG formatting, checklist tree logic, & outline extractor
│       └── media.js        # File uploads, drag-and-drop dropzones, & pure-JS QR generator
└── README.md
```

---

## Deployment with Docker Compose

### 1. Prerequisites
Ensure your Docker host has the `proxy-net` external network created (if using a reverse proxy):
```bash
docker network create proxy-net
```

### 2. Launch Container
```bash
docker compose up -d --build
```

The container starts with:
- `/data` mounted in volatile RAM (`tmpfs: ["/data:size=1G,uid=1000,gid=1000,mode=0755"]`).
- Optional `/persist` host directory mounted for notes marked with the "Save to Disk" shield.
- Non-root user `1000:1000`.
- Attached to `proxy-net` without exposing host ports directly.

### 3. Nginx Proxy Manager Setup
In Nginx Proxy Manager:
1. **Add Proxy Host**:
   - **Forward Hostname / IP**: `keepboard` (resolves via Docker DNS on `proxy-net`)
   - **Forward Port**: `8080`
   - **Websockets Support**: On
2. **Advanced Tab**:
   ```nginx
   client_max_body_size 0;
   ```

---

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check endpoint |
| `GET` | `/api/sync-token` | Monotonic server revision integer for cross-device sync (< 30 bytes) |
| `GET` | `/api/stats` | Storage and RAM tmpfs utilization metrics (served from cache) |
| `POST` | `/api/stats/purge-orphans` | Purge unreferenced attachment files from RAM/disk |
| `GET` | `/api/notes?view={all\|archive\|trash\|vault}` | List notes filtered by view |
| `POST` | `/api/notes` | Create a note (accepts title, rich text, color, files, checklist, tags, TTL) |
| `PUT` | `/api/notes/{id}` | Update title, text, color, pin, archive, checklist, or tags |
| `POST` | `/api/notes/{id}/duplicate` | Make a copy of a note |
| `POST` | `/api/notes/{id}/toggle-persist` | Toggle "Save to Disk" persistent mirroring (/persist) |
| `POST` | `/api/notes/{id}/restore` | Restore note from Trash |
| `DELETE` | `/api/notes/{id}?forever={false\|true}` | Soft delete to Trash or permanent purge |
| `DELETE` | `/api/trash` or `POST /api/trash/empty` | Empty Trash (permanently deletes all trashed notes and files) |
| `POST` | `/api/notes/batch` | Batch operations: pin, unpin, color, archive, trash, delete_forever, merge |
| `POST` | `/api/notes/batch/download` | Stream `.zip` bundle of all attachments across selected notes |
| `POST` | `/api/notes/reorder` | Persist custom note sort order |
| `POST` | `/api/notes/{id}/attachments` | Upload attachments to a note |
| `DELETE` | `/api/notes/{id}/attachments/{att_id}` | Remove attachment from a note |
| `GET` | `/api/files/{att_id}` | Stream file inline (preview for image/audio/video) or download |
| `POST` | `/api/notes/{target_id}/transfer-attachment` | Transfer attachment between notes |
| `PUT` | `/api/notes/{id}/attachments/{att_id}/rename` | Rename attachment display filename |
| `GET` | `/api/files/{att_id}/zip-list` | Peek inside ZIP or JAR archive without downloading |
| `GET` | `/api/files/{att_id}/zip-extract?path=...` | Extract and download single file from archive |
| `POST` | `/api/drop` | Direct CLI / Piping file or text drop endpoint |
| `GET` | `/api/link-preview?url=...` | SSRF-safe Open Graph link metadata scraper |
| `GET` | `/api/workspaces` | List all workspaces |
| `POST` | `/api/workspaces` | Create a new workspace |
| `PUT` | `/api/workspaces/{id}` | Rename or update workspace |
| `DELETE` | `/api/workspaces/{id}` | Delete workspace |
| `POST` | `/api/notes/{id}/move-workspace` | Move single note to another workspace |
| `POST` | `/api/notes/batch/move-workspace` | Move multiple notes to another workspace |
| `GET` | `/api/backup/export` | Stream full `.zip` backup bundle |
| `POST` | `/api/backup/restore` | Restore notes and files from `.zip` backup |
| `GET` | `/api/vault/status` | Check if vault password is configured |
| `POST` | `/api/vault/set-password` or `/setup` | Set master password for vault |
| `POST` | `/api/vault/unlock` | Unlock vault session (returns session token) |
| `POST` | `/api/vault/verify` | Verify vault master password |
| `POST` | `/api/vault/lock` | Lock vault session |
| `POST` | `/api/vault/change` | Change vault master password |
