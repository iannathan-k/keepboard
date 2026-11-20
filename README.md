# KeepBoard

A minimalist, high-speed, self-hosted Google Keep–style scratchpad and arbitrary file-parking web application designed to run entirely in RAM as a single lightweight Docker container mounted on a `tmpfs` RAM disk.

Zero social-media clutter. Zero account registration friction. Instant cold boots into a production-ready board.

---

## What's New in KeepBoard v3

- **Rich-Text WYSIWYG Editor (`Aa` Formatting Toolbar)**:
  - Clean `contenteditable` note editing in top capture bar, modal, and split panes.
  - Raw / Markdown Source Toggle (`</>`) to view and edit raw Markdown/HTML.
  - Formatting toolbar (`Aa`): Bold (`⌘B`), Italic (`⌘I`), Underline (`⌘U`), Strikethrough, Headings (H1–H3), Bullet/Numbered lists, and Inline Code.
  - 5 dark-mode highlighter marker tints: Yellow, Cyan, Pink, Green, and Orange.
  - Clean paste handler stripping foreign web background colors and styling, backed by server-side HTML sanitization.
- **Multi-Pane Note Workspace & Document Header Outline**:
  - Side-by-side editing of 2 or 3 notes simultaneously in split panes (`split-pane` button on cards and modal).
  - Cross-pane drag-and-drop attachment transfer.
  - Collapsible Document Outline / Table of Contents rail auto-extracting H1–H3 headings with smooth scrolling.
- **Cross-Device & File-Transfer Power Features**:
  - Direct CLI / Terminal Drops (`POST /api/drop`): curl files, logs, or piped text directly into KeepBoard without opening the browser.
  - `>_ CLI` helper button in top header with copyable `curl` commands for current instance.
  - Embedded Zero-Dependency Pure-JS QR Code Generator: instant mobile phone scanning for direct file downloads or note links over local Wi-Fi.
  - ZIP / JAR Archive Peek & Extract (`GET /api/files/{id}/zip-list` & `.../zip-extract`): inspect file lists and sizes inside archives without downloading, and extract single files on demand.
- **Smarter Card Content & Layout Controls**:
  - Optional Note Title field rendering as a bold header on cards.
  - Card Text Clamping (~12 lines) with gradient fade and smooth "Show more / Show less" toggle.
  - SSRF-safe Rich Bookmark Link Previews (`GET /api/link-preview`): Open Graph metadata, title, description, and favicon.
- **Organization, Search Filters & Drag-and-Drop Speed**:
  - Spotlight / Command Palette (`Cmd+K` / `Ctrl+K`) for fast keyboard navigation, commands, and note jumping.
  - Smart Filter Chips under search bar: `All`, `📎 Has Files`, `☑ Checklists`, `⏱ Expiring`, and 8 color dots alongside tags.
  - Cross-card attachment transfer via drag-and-drop.
  - Inline attachment renaming with instant metadata update.

---

## Existing Core Features (v1 & v2)

- **Google Keep Layout & Collapsible Left Navigation**: Notes, Archive, Trash, Vault, and dynamic Labels.
- **8 Refined Dark-Mode Color Swatches**: Default Dark, Coral, Amber, Sand, Olive, Teal, Slate, Purple with harmonizing border tints.
- **Multi-Select & Floating Batch Action Bar**: Batch Pin, Color, Tag, Archive, Merge, Download `.zip`, and Trash/Delete.
- **7-Day Auto-Purging Trash Bin**: Soft-delete with countdown badges (`🗑 Purges in 6d`) and one-click "Empty Trash Now".
- **Nested Indentation Checklists**: `Tab`/`Shift+Tab` hierarchy with cascading check states.
- **Inline Media Previews**: Audio, video, and image streaming previews directly on cards.
- **Password-Protected Vault**: PBKDF2-SHA256 protected confidential scratchpad.
- **One-Click Backup Export & Restore**: Full `.zip` bundle containing `notes.json`, `vault.json`, and all `/data/files/`.

---

## Project Structure

```
keepboard/
├── Dockerfile              # Alpine-based image (UID/GID 1000:1000, port 8080)
├── docker-compose.yml      # Service with tmpfs mount and proxy-net external network
├── requirements.txt        # FastAPI, Uvicorn, Python-Multipart
├── app/
│   ├── main.py             # FastAPI backend with chunked streaming, SSRF protection, and atomic persistence
│   └── static/
│       └── index.html      # Modern SPA frontend (HTML5, CSS3, Vanilla JS, Pure QR generator)
└── README.md
```

---

## Deployment with Docker Compose

### 1. Prerequisites
Ensure your Docker host has the `proxy-net` network created:
```bash
docker network create proxy-net
```

### 2. Launch Container
```bash
docker compose up -d --build
```

The container starts with:
- `/data` mounted in volatile RAM (`tmpfs: ["/data:size=1G,uid=1000,gid=1000,mode=0755"]`).
- Non-root user `1000:1000`.
- Attached to `proxy-net` without exposing host ports.

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
| `GET` | `/api/stats` | Storage and RAM tmpfs utilization metrics |
| `GET` | `/api/notes?view={notes\|archive\|trash\|vault}` | List notes filtered by view |
| `POST` | `/api/notes` | Create a note (accepts title, rich text, color, files, checklist, tags, TTL) |
| `PUT` | `/api/notes/{id}` | Update title, text, color, pin, archive, checklist, or tags |
| `POST` | `/api/notes/{id}/duplicate` | Make a copy of a note |
| `POST` | `/api/notes/{id}/restore` | Restore note from Trash |
| `DELETE` | `/api/notes/{id}?forever={false\|true}` | Soft delete to Trash or permanent purge |
| `DELETE` | `/api/trash` | Empty Trash (permanently deletes all trashed notes and files) |
| `POST` | `/api/notes/batch` | Perform batch operations: pin, unpin, color, archive, trash, delete_forever, merge |
| `POST` | `/api/notes/batch/download` | Stream `.zip` bundle of all attachments across selected notes |
| `POST` | `/api/notes/reorder` | Persist custom drag-to-reorder note sort order |
| `POST` | `/api/drop` | Direct CLI / Piping file or text drop endpoint |
| `GET` | `/api/files/{att_id}` | Stream file inline (preview for image/audio/video) or download |
| `GET` | `/api/files/{att_id}/zip-list` | Peek inside ZIP or JAR archive without downloading |
| `GET` | `/api/files/{att_id}/zip-extract?path=...` | Extract and download single file from archive |
| `POST` | `/api/notes/{target_id}/transfer-attachment` | Transfer attachment between notes |
| `PUT` | `/api/notes/{id}/attachments/{att_id}/rename` | Rename attachment display filename |
| `GET` | `/api/link-preview?url=...` | SSRF-safe Open Graph link metadata scraper |
| `GET` | `/api/backup/export` | Stream full `.zip` backup bundle |
| `POST` | `/api/backup/restore` | Restore notes and files from `.zip` backup |
| `GET` | `/api/vault/status` | Check if vault password is configured |
| `POST` | `/api/vault/setup` | Set master password for vault |
| `POST` | `/api/vault/unlock` | Unlock vault session (returns session token) |
| `POST` | `/api/vault/lock` | Lock vault session |
