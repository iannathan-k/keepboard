# KeepBoard

A minimalist, high-speed, self-hosted Google Keep–style scratchpad and arbitrary file-parking web application designed to run entirely in RAM as a single lightweight Docker container mounted on a `tmpfs` RAM disk.

Zero social-media clutter. Zero account registration friction. Instant cold boots into a production-ready board.

---

## What's New in KeepBoard v2

- **Google Keep Layout & Collapsible Left Navigation**:
  - Left navigation sidebar featuring **Notes**, **Archive**, **Trash**, **Vault**, and dynamic **Labels/Tags**.
  - Collapses smoothly to an icon rail or expands to full pill navigation on desktop; responsive mobile drawer.
  - Centered pill search bar across the top viewport with instant filtering and `/` shortcut.
  - Real-time RAM & tmpfs metrics pill (`14.2 MB / 1 GB RAM`).
- **Cohesive Modern Dark UI & 8-Color Palette**:
  - `#131314` canvas, `#1b1c1f` elevated cards, `#24262a` hover surfaces, and 12px rounded corners with soft borders (`rgba(255, 255, 255, 0.08)`).
  - 8-color dark-mode palette with harmonizing border tints: Default Dark, Coral, Amber, Sand, Olive, Teal, Slate, Purple.
- **Multi-Select & Floating Batch Action Bar**:
  - Selection checkmark circles on top-left of cards, `Shift+Click` range selection, and `Cmd/Ctrl+A` select all visible.
  - Contextual floating batch bar: Batch Pin/Unpin, Batch Color, Batch Tagging, Batch Archive, Batch Merge into one note, Batch Download all attachments as `.zip`, and Batch Trash/Delete.
- **7-Day Auto-Purging Trash Bin**:
  - Soft delete: notes move to Trash with `deleted_at` timestamp without unlinking files.
  - Countdown badges on cards (e.g. `🗑 Purges in 6d`).
  - Automatic background pruning every hour and on startup for notes in Trash older than 7 days (604,800s).
  - One-click "Empty Trash Now" button to immediately reclaim tmpfs RAM.
- **Nested Indentation Support**:
  - Regular Notes: `Tab` inserts 4 spaces / indents current lines; `Shift+Tab` outdents without losing focus.
  - Checklists: Indented sub-items (`indent: 0, 1, 2, 3`) with `Tab`/`Shift+Tab` and cascading check/uncheck states.
- **Inline Media Previews**:
  - Images (`.png`, `.jpg`, `.webp`, `.gif`, `.svg`), audio (`.mp3`, `.wav`, `.ogg`), and video (`.mp4`, `.webm`) render clean thumbnails and players directly on cards.
  - Non-media binary files (`.cmir`, `.zip`, `.jar`, `.bin`, `.py`, `.docx`, etc.) render as attachment download pills with no file-type restrictions.
- **Note Duplication & Card Merging**:
  - "Make a copy" action creates an instant clone of any note and its checklist/tags.
  - "Merge Selected" combines multiple notes, checklists, tags, and files into a single consolidated card.
- **Auto-Expiring Ephemeral Notes ("Burn After...")**:
  - Set TTL (1 hour, 24 hours, 7 days) on sensitive scratchpads or file drops with countdown badges; automatically purged from RAM when expired.
- **Password-Protected Vault**:
  - Dedicated PBKDF2-SHA256 protected vault for sensitive notes and file drops. Completely excluded from non-vault views and search unless unlocked.
- **One-Click Backup Export & Restore**:
  - Export full `.zip` bundle containing `notes.json`, `vault.json`, and all `/data/files/`.
  - Import `.zip` backup to restore notes and files smoothly.

---

## Project Structure

```
keepboard/
├── Dockerfile              # Alpine-based image (UID/GID 1000:1000, port 8080)
├── docker-compose.yml      # Service with tmpfs mount and proxy-net external network
├── requirements.txt        # FastAPI, Uvicorn, Python-Multipart
├── app/
│   ├── main.py             # FastAPI backend with chunked streaming and atomic persistence
│   └── static/
│       └── index.html      # Modern SPA frontend (HTML5, CSS3, Vanilla JS)
└── README.md
```

---

## Deployment with Docker Compose

### 1. Prerequisites
Ensure your Docker host has the `proxy-net` network created (common for Nginx Proxy Manager / Traefik setups):
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
In the Nginx Proxy Manager UI:
1. **Add Proxy Host**:
   - **Domain Names**: `keepboard.your-domain.lan` (or internal hostname)
   - **Scheme**: `http`
   - **Forward Hostname / IP**: `keepboard` (resolves via Docker DNS on `proxy-net`)
   - **Forward Port**: `8080`
   - **Cache Assets**: Off
   - **Block Common Exploits**: On
   - **Websockets Support**: On
2. **Advanced Tab (for large file uploads)**:
   Add the following directive so Nginx does not restrict upload size:
   ```nginx
   client_max_body_size 0;
   ```

---

## Local Development & Testing

If you wish to test the container standalone with a host port mapped:

```bash
docker run -d \
  --name keepboard-test \
  -p 8080:8080 \
  --tmpfs /data:size=1G,uid=1000,gid=1000,mode=0755 \
  $(docker build -q .)
```
Then open your browser to `http://localhost:8080`.

---

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check endpoint |
| `GET` | `/api/stats` | Storage and RAM tmpfs utilization metrics |
| `GET` | `/api/notes?view={notes\|archive\|trash\|vault}` | List notes filtered by view |
| `POST` | `/api/notes` | Create a note (accepts multipart text, color, files, checklist, tags, TTL) |
| `PUT` | `/api/notes/{id}` | Update text, color, pin, archive, checklist, or tags |
| `POST` | `/api/notes/{id}/duplicate` | Make a copy of a note |
| `POST` | `/api/notes/{id}/restore` | Restore note from Trash |
| `DELETE` | `/api/notes/{id}?forever={false\|true}` | Soft delete to Trash (`forever=false`) or permanent purge (`forever=true`) |
| `DELETE` | `/api/trash` | Empty Trash (permanently deletes all trashed notes and files) |
| `POST` | `/api/notes/batch` | Perform batch operations: pin, unpin, color, archive, trash, delete_forever, merge |
| `POST` | `/api/notes/batch/download` | Stream `.zip` bundle of all attachments across selected notes |
| `POST` | `/api/notes/reorder` | Persist custom drag-to-reorder note sort order |
| `GET` | `/api/files/{att_id}` | Stream file inline (preview for image/audio/video) or download |
| `GET` | `/api/backup/export` | Stream full `.zip` backup bundle |
| `POST` | `/api/backup/restore` | Restore notes and files from `.zip` backup |
| `GET` | `/api/vault/status` | Check if vault password is configured |
| `POST` | `/api/vault/setup` | Set master password for vault |
| `POST` | `/api/vault/unlock` | Unlock vault session (returns session token) |
| `POST` | `/api/vault/lock` | Lock vault session |
