# RAM Scratchpad (Google Keep Style)

A minimalist, high-speed, self-hosted scratchpad and arbitrary file-parking web application designed to run entirely in RAM as a lightweight Docker container mounted on a `tmpfs` RAM disk.

Zero social-media clutter. Zero folder sidebars. Zero user authentication friction. Cold boots directly into a ready-to-use board.

---

## Features

- **Google Keep Aesthetic & UX**:
  - Clean dark mode (`#131314` background, `#1e1f22` cards, `#33353a` subtle borders, `#8ab4f8` accent).
  - Responsive multi-column CSS masonry grid (`columns: 4 260px`).
  - Distinct **PINNED** and **OTHERS** sections.
  - 6 subtle dark-mode color swatches (Default, Coral, Amber, Olive, Teal, Slate, Purple) with matched borders.
- **Zero-Friction Top Capture Bar**:
  - Always-ready centered "Take a note..." input box.
  - Auto-expanding textarea—no title field required.
  - `Ctrl+Enter` or `Cmd+Enter` creates cards instantly.
- **Arbitrary File Parking & Downloads**:
  - **Zero file-type or MIME filtering**: accepts `.cmir`, `.zip`, `.jar`, `.docx`, `.py`, `.bin`, raw firmware dumps, and extensionless binary blobs.
  - **Streamed file uploads**: writes chunks directly to disk to prevent RAM bloat on multi-hundred-MB files.
  - Original filenames and exact byte sizes preserved in download headers (`Content-Disposition: attachment`).
  - Interactive attachment pills with human-readable file sizes (`KB`, `MB`, `GB`).
- **Instant Drag-and-Drop Anywhere**:
  - Dragging files over the window displays a fullscreen drop overlay.
  - Dropping creates a new note card immediately with zero confirmation dialogs (or attaches directly if a note is currently open in the edit modal).
  - Clipboard file pasting (`Ctrl+V` / `Cmd+V`) support.
- **Card Interactions & Formatting**:
  - Auto-linkifies URLs into clickable `target="_blank"` links.
  - Formats markdown code fences (` ``` `) with monospace font and a one-click "Copy" button.
  - Preserves exact whitespace and newlines (`white-space: pre-wrap`).
  - Quick action buttons on card hover: Color Picker, Attach Files, Copy Note Text, Delete Note.
  - Inline modal editor for editing note text, adding files, and deleting individual attachments.
- **Live Instant Search**:
  - Single search bar at the top that filters cards in real time across note body text and attached filenames. Press `/` anywhere to focus search.
- **Ephemeral RAM Disk Architecture**:
  - Configured to run on `/data` mounted as a 1GB `tmpfs` RAM disk.
  - Atomic write-and-replace for `notes.json` (`.tmp` + `fsync` + `replace`).
  - Alpine-based image running as unprivileged UID/GID `1000:1000` on port `8080`.

---

## Project Structure

```
ram-scratchpad/
├── Dockerfile              # Minimal Alpine-based image (UID/GID 1000:1000, port 8080)
├── docker-compose.yml      # Service with tmpfs mount and proxy-net external network
├── requirements.txt        # FastAPI, Uvicorn, Python-Multipart
├── app/
│   ├── main.py             # FastAPI backend with chunked streaming and atomic persistence
│   └── static/
│       └── index.html      # Self-contained Google Keep SPA (HTML5, CSS3, Vanilla JS)
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
   - **Domain Names**: `scratchpad.your-domain.lan` (or internal hostname)
   - **Scheme**: `http`
   - **Forward Hostname / IP**: `scratchpad` (resolves via Docker DNS on `proxy-net`)
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
  --name scratchpad-test \
  -p 8080:8080 \
  --tmpfs /data:size=1G,uid=1000,gid=1000,mode=0755 \
  $(docker build -q .)
```
Then open your browser to `http://localhost:8080`.

---

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check endpoint returning storage path and note count |
| `GET` | `/api/notes` | List all notes (sorted by pinned first, then updated time) |
| `POST` | `/api/notes` | Create a note (accepts `multipart/form-data` with `text`, `color`, `pinned`, and multiple `files`) |
| `PUT` | `/api/notes/{id}` | Update text, color, or pin state of a note |
| `DELETE` | `/api/notes/{id}` | Delete a note and purge all its associated files from `/data/files/` |
| `POST` | `/api/notes/{id}/attachments` | Stream upload arbitrary files to attach to an existing note |
| `DELETE` | `/api/notes/{id}/attachments/{att_id}` | Remove a single attachment from a note and disk |
| `GET` | `/api/files/{att_id}` | Download attachment with original filename preserved |
