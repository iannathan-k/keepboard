import os
import re
import io
import json
import uuid
import time
import shutil
import zipfile
import secrets
import hashlib
import asyncio
import mimetypes
import socket
import ipaddress
import urllib.request
import urllib.parse
import html.parser
from datetime import datetime
from typing import Optional, List, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Header, Query, Request, status
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration & Paths
# ---------------------------------------------------------------------------
DATA_DIR = os.getenv("DATA_DIR", "/data")
FILES_DIR = os.path.join(DATA_DIR, "files")
NOTES_FILE = os.path.join(DATA_DIR, "notes.json")
VAULT_FILE = os.path.join(DATA_DIR, "vault.json")
WORKSPACES_FILE = os.path.join(DATA_DIR, "workspaces.json")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Optional persistent storage directory
PERSIST_DIR = os.getenv("PERSIST_DIR", "/persist")
PERSIST_FILES_DIR = os.path.join(PERSIST_DIR, "files")
PERSIST_NOTES_FILE = os.path.join(PERSIST_DIR, "notes.json")
PERSIST_VAULT_FILE = os.path.join(PERSIST_DIR, "vault.json")
PERSIST_WORKSPACES_FILE = os.path.join(PERSIST_DIR, "workspaces.json")

DEFAULT_WORKSPACES = [{"id": "default", "name": "Personal"}]

# In-memory vault session tokens (token -> expiry_ms)
vault_sessions: dict[str, int] = {}
VAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000  # 24 hours

# 7 days in milliseconds
SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

# Concurrency lock for notes.json operations
notes_lock = asyncio.Lock()

# SSE event broadcast subscribers
sse_subscribers: set[asyncio.Queue] = set()

# In-memory cache for link previews
link_preview_cache: dict[str, dict] = {}
MAX_LINK_CACHE = 500


# ---------------------------------------------------------------------------
# Storage & Persistence Helpers
# ---------------------------------------------------------------------------

def is_persist_available() -> bool:
    """Check if /persist directory is mounted and writable."""
    try:
        if not os.path.exists(PERSIST_DIR):
            return False
        test_file = os.path.join(PERSIST_DIR, ".write_test")
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
        return True
    except Exception:
        return False


def _atomic_write(path: str, obj: Any):
    """Atomically write JSON to disk using a unique temporary file and fsync, ensuring 1000:1000 ownership."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
        try:
            os.chown(parent, 1000, 1000)
        except Exception:
            pass
    tmp = f"{path}.tmp.{uuid.uuid4().hex}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chown(tmp, 1000, 1000)
    except Exception:
        pass
    os.replace(tmp, path)
    try:
        os.chown(path, 1000, 1000)
    except Exception:
        pass


def init_storage():
    """Ensure data directories and json state files exist with proper ownership."""
    os.makedirs(FILES_DIR, exist_ok=True)
    try:
        os.chown(FILES_DIR, 1000, 1000)
    except Exception:
        pass
    if not os.path.exists(NOTES_FILE):
        _atomic_write(NOTES_FILE, [])
    if not os.path.exists(VAULT_FILE):
        _atomic_write(VAULT_FILE, {})
    if not os.path.exists(WORKSPACES_FILE):
        _atomic_write(WORKSPACES_FILE, DEFAULT_WORKSPACES)
    if is_persist_available():
        os.makedirs(PERSIST_FILES_DIR, exist_ok=True)
        try:
            os.chown(PERSIST_FILES_DIR, 1000, 1000)
        except Exception:
            pass
        if not os.path.exists(PERSIST_NOTES_FILE):
            _atomic_write(PERSIST_NOTES_FILE, [])
        if not os.path.exists(PERSIST_WORKSPACES_FILE):
            _atomic_write(PERSIST_WORKSPACES_FILE, DEFAULT_WORKSPACES)


def read_workspaces_sync() -> list:
    """Read workspaces list from disk synchronously, falling back to default/persist."""
    if not os.path.exists(WORKSPACES_FILE):
        if is_persist_available() and os.path.exists(PERSIST_WORKSPACES_FILE):
            try:
                with open(PERSIST_WORKSPACES_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list) and len(data) > 0:
                        _atomic_write(WORKSPACES_FILE, data)
                        return data
            except Exception:
                pass
        return list(DEFAULT_WORKSPACES)
    try:
        with open(WORKSPACES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list) and len(data) > 0:
                return data
            return list(DEFAULT_WORKSPACES)
    except Exception:
        return list(DEFAULT_WORKSPACES)


def write_workspaces_sync(workspaces: list):
    """Write workspaces list to disk and mirror to /persist if available."""
    _atomic_write(WORKSPACES_FILE, workspaces)
    if is_persist_available():
        try:
            _atomic_write(PERSIST_WORKSPACES_FILE, workspaces)
        except Exception as e:
            print(f"Error mirroring workspaces to persist: {e}")


def sync_from_persist_on_boot():
    """Load notes, workspaces, and vault metadata from persistent disk on startup."""
    if not is_persist_available():
        return

    # 1. Restore workspaces if missing on local tmpfs
    if os.path.exists(PERSIST_WORKSPACES_FILE) and not os.path.exists(WORKSPACES_FILE):
        try:
            with open(PERSIST_WORKSPACES_FILE, "r", encoding="utf-8") as f:
                ws_data = json.load(f)
                if isinstance(ws_data, list):
                    _atomic_write(WORKSPACES_FILE, ws_data)
        except Exception as e:
            print(f"Error restoring workspaces from persist: {e}")

    # 2. Restore vault config if missing on local tmpfs
    if os.path.exists(PERSIST_VAULT_FILE) and not os.path.exists(VAULT_FILE):
        try:
            with open(PERSIST_VAULT_FILE, "r", encoding="utf-8") as f:
                v_data = json.load(f)
                if isinstance(v_data, dict):
                    _atomic_write(VAULT_FILE, v_data)
        except Exception as e:
            print(f"Error restoring vault from persist: {e}")

    # 3. Restore notes and files
    if not os.path.exists(PERSIST_NOTES_FILE):
        return
    try:
        with open(PERSIST_NOTES_FILE, "r", encoding="utf-8") as f:
            persisted = json.load(f)
        if not isinstance(persisted, list):
            return

        current_notes = read_notes_sync()
        current_ids = {n["id"]: n for n in current_notes}
        changed = False

        for p_note in persisted:
            pid = p_note.get("id")
            if not pid:
                continue
            p_note["saved_to_disk"] = True
            if not p_note.get("workspace"):
                p_note["workspace"] = "default"
            if pid not in current_ids:
                current_notes.append(p_note)
                changed = True
            else:
                current_ids[pid]["saved_to_disk"] = True
                if not current_ids[pid].get("workspace"):
                    current_ids[pid]["workspace"] = p_note.get("workspace", "default")
                changed = True

            # Restore physical attachments from /persist/files/ to /data/files/
            for att in p_note.get("attachments", []):
                sname = att.get("stored_name")
                if sname:
                    p_path = os.path.join(PERSIST_FILES_DIR, sname)
                    d_path = os.path.join(FILES_DIR, sname)
                    if os.path.exists(p_path) and not os.path.exists(d_path):
                        shutil.copy2(p_path, d_path)
                        try:
                            os.chown(d_path, 1000, 1000)
                        except Exception:
                            pass

        if changed:
            _atomic_write(NOTES_FILE, current_notes)
    except Exception as e:
        print(f"Error restoring from persist disk: {e}")


def mirror_note_to_persist(note: dict, remove: bool = False):
    """Mirror or remove a note with 'saved_to_disk' to /persist disk."""
    if not is_persist_available():
        return
    try:
        os.makedirs(PERSIST_FILES_DIR, exist_ok=True)
        persisted = []
        if os.path.exists(PERSIST_NOTES_FILE):
            with open(PERSIST_NOTES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    persisted = data

        nid = note.get("id")
        persisted = [n for n in persisted if n.get("id") != nid]

        if not remove and note.get("saved_to_disk"):
            if not note.get("workspace"):
                note["workspace"] = "default"
            persisted.append(note)
            for att in note.get("attachments", []):
                sname = att.get("stored_name")
                if sname:
                    d_path = os.path.join(FILES_DIR, sname)
                    p_path = os.path.join(PERSIST_FILES_DIR, sname)
                    if os.path.exists(d_path) and not os.path.exists(p_path):
                        shutil.copy2(d_path, p_path)
                        try:
                            os.chown(p_path, 1000, 1000)
                        except Exception:
                            pass

        _atomic_write(PERSIST_NOTES_FILE, persisted)
    except Exception as e:
        print(f"Error mirroring to persist: {e}")


def read_notes_sync() -> list:
    """Read all notes synchronously from disk, ensuring each has a workspace field."""
    if not os.path.exists(NOTES_FILE):
        return []
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            notes_list = data if isinstance(data, list) else []
            for n in notes_list:
                if not n.get("workspace"):
                    n["workspace"] = "default"
            return notes_list
    except Exception:
        return []


def read_vault_meta() -> dict:
    """Read vault metadata synchronously from disk, with fallback to persist."""
    if not os.path.exists(VAULT_FILE):
        if is_persist_available() and os.path.exists(PERSIST_VAULT_FILE):
            try:
                with open(PERSIST_VAULT_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        _atomic_write(VAULT_FILE, data)
                        return data
            except Exception:
                pass
        return {}
    try:
        with open(VAULT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Server-Sent Events (SSE) Live Multi-Device Sync
# ---------------------------------------------------------------------------

async def broadcast_event(event_type: str, data: dict):
    """Broadcast an update event to all active browser tabs/devices."""
    msg = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
    for queue in list(sse_subscribers):
        try:
            queue.put_nowait(msg)
        except Exception:
            sse_subscribers.discard(queue)


# ---------------------------------------------------------------------------
# Safe HTML Sanitizer
# ---------------------------------------------------------------------------

class SafeHTMLSanitizer(html.parser.HTMLParser):
    ALLOWED_TAGS = {
        'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
        'mark', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
    }
    DROP_TAGS = {'script', 'style', 'iframe', 'object', 'embed', 'applet', 'meta', 'link'}
    VOID_TAGS = {'br', 'hr'}

    def __init__(self):
        super().__init__()
        self.result = []
        self.drop_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.DROP_TAGS:
            self.drop_depth += 1
            return
        if self.drop_depth > 0:
            return
        if tag not in self.ALLOWED_TAGS:
            return
        clean_attrs = []
        for k, v in attrs:
            k = k.lower()
            if k.startswith('on') or k in {'data', 'srcdoc'}:
                continue
            if tag == 'a' and k == 'href':
                v_clean = v.strip().lower()
                if v_clean.startswith(('http://', 'https://', 'mailto:', '/')):
                    clean_attrs.append((k, v.strip()))
            elif tag in {'mark', 'span'} and k == 'style':
                styles = [s.strip() for s in v.split(';') if s.strip()]
                safe_styles = [s for s in styles if s.split(':')[0].strip().lower() in {'background-color', 'color', 'font-size', 'font-weight', 'text-decoration'}]
                if safe_styles:
                    clean_attrs.append(('style', '; '.join(safe_styles)))
            elif k in {'class', 'title'}:
                clean_attrs.append((k, v.strip()))
        if tag == 'a':
            clean_attrs.append(('target', '_blank'))
            clean_attrs.append(('rel', 'noopener noreferrer'))
        attr_str = ''.join(f' {k}="{v}"' for k, v in clean_attrs)
        self.result.append(f'<{tag}{attr_str}>')

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.DROP_TAGS:
            if self.drop_depth > 0:
                self.drop_depth -= 1
            return
        if self.drop_depth > 0:
            return
        if tag in self.ALLOWED_TAGS and tag not in self.VOID_TAGS:
            self.result.append(f'</{tag}>')

    def handle_data(self, data):
        if self.drop_depth == 0:
            self.result.append(data)


def sanitize_html(raw: str) -> str:
    """Sanitize HTML note body to safe formatting elements, stripping scripts and malicious styles."""
    if not raw:
        return ""
    p = SafeHTMLSanitizer()
    try:
        p.feed(raw)
        return "".join(p.result)
    except Exception:
        return raw.replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# File & Media Helpers
# ---------------------------------------------------------------------------

async def save_uploaded_file(upload_file: UploadFile) -> dict:
    """Stream an arbitrary uploaded binary file directly to /data/files/ in 1MB chunks."""
    att_id = uuid.uuid4().hex
    orig_filename = upload_file.filename or "attachment.bin"
    safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', os.path.basename(orig_filename))
    stored_name = f"{att_id}_{safe_name}"
    file_path = os.path.join(FILES_DIR, stored_name)

    total_size = 0
    chunk_size = 1024 * 1024  # 1MB chunks to prevent memory spikes
    with open(file_path, "wb") as f:
        while True:
            chunk = await upload_file.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            total_size += len(chunk)

    guessed_type, _ = mimetypes.guess_type(orig_filename)
    content_type = guessed_type or upload_file.content_type or "application/octet-stream"

    return {
        "id": att_id,
        "filename": orig_filename,
        "stored_name": stored_name,
        "size": total_size,
        "content_type": content_type,
        "created_at": int(time.time() * 1000)
    }


def delete_file_on_disk(stored_name: str):
    """Safely delete stored attachment file from disk."""
    path = os.path.join(FILES_DIR, stored_name)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass
    if is_persist_available():
        p_path = os.path.join(PERSIST_FILES_DIR, stored_name)
        if os.path.exists(p_path):
            try:
                os.remove(p_path)
            except OSError:
                pass


def format_bytes_py(bytes_val: int) -> str:
    if not bytes_val or bytes_val == 0:
        return "0 B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if bytes_val < 1024.0:
            return f"{bytes_val:.1f} {unit}".replace(".0 ", " ")
        bytes_val /= 1024.0
    return f"{bytes_val:.1f} PB"


# ---------------------------------------------------------------------------
# Vault Security Helpers
# ---------------------------------------------------------------------------

PBKDF2_ITERS = 260_000

def _hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERS
    ).hex()


def _new_vault_token() -> str:
    return secrets.token_hex(32)


def _validate_vault_token(token: Optional[str]) -> bool:
    if not token:
        return False
    expiry = vault_sessions.get(token)
    if expiry is None:
        return False
    if int(time.time() * 1000) > expiry:
        vault_sessions.pop(token, None)
        return False
    return True


# ---------------------------------------------------------------------------
# SSRF-Protected Link Preview Scraper
# ---------------------------------------------------------------------------

class HTMLMetaScraper(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.title = ""
        self.meta_title = ""
        self.og_title = ""
        self.meta_desc = ""
        self.og_desc = ""
        self.og_image = ""
        self.favicon = ""

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        attr_dict = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self.in_title = True
        elif tag == "meta":
            prop = attr_dict.get("property", "").lower()
            name = attr_dict.get("name", "").lower()
            content = attr_dict.get("content", "").strip()
            if prop == "og:title":
                self.og_title = content
            elif name == "title":
                self.meta_title = content
            elif prop == "og:description":
                self.og_desc = content
            elif name == "description":
                self.meta_desc = content
            elif prop == "og:image":
                self.og_image = content
        elif tag == "link":
            rel = attr_dict.get("rel", "").lower()
            if "icon" in rel and not self.favicon:
                self.favicon = attr_dict.get("href", "").strip()

    def handle_endtag(self, tag):
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title and not self.title:
            self.title = data.strip()


def check_url_ssrf_safety(url_str: str) -> urllib.parse.ParseResult:
    """Validate URL and resolve DNS to disallow private, loopback, and local network IPs."""
    parsed = urllib.parse.urlparse(url_str)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http and https URLs are allowed.")
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid URL hostname.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addr_info = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        for family, socktype, proto, canonname, sockaddr in addr_info:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                raise HTTPException(status_code=403, detail="Forbidden: Private, local, and reserved network targets are blocked.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to resolve hostname: {str(e)}")
    return parsed


# ---------------------------------------------------------------------------
# Background Maintenance (7-Day Trash Auto-Purge & Ephemeral Notes Pruning)
# ---------------------------------------------------------------------------

async def prune_expired_and_trash():
    """Background task to delete 7-day-old trashed notes and expired ephemeral notes."""
    now = int(time.time() * 1000)
    async with notes_lock:
        notes = read_notes_sync()
        kept_notes = []
        purged_count = 0

        for note in notes:
            should_purge = False
            # 1. 7-day Trash Auto-Purge
            if note.get("trashed") or note.get("is_trash"):
                deleted_at = note.get("deleted_at") or 0
                if now - deleted_at >= SEVEN_DAYS_MS:
                    should_purge = True

            # 2. Ephemeral Notes Auto-Expiry (Burn after TTL)
            expires_at = note.get("expires_at")
            if expires_at and expires_at > 0 and now >= expires_at:
                should_purge = True

            if should_purge:
                purged_count += 1
                for att in note.get("attachments", []):
                    delete_file_on_disk(att["stored_name"])
                mirror_note_to_persist(note, remove=True)
            else:
                kept_notes.append(note)

        if purged_count > 0:
            _atomic_write(NOTES_FILE, kept_notes)
            await broadcast_event("notes_updated", {"action": "pruned", "count": purged_count})


async def maintenance_loop():
    """Periodic maintenance loop running every hour."""
    while True:
        try:
            await prune_expired_and_trash()
        except Exception:
            pass
        await asyncio.sleep(3600)


# ---------------------------------------------------------------------------
# FastAPI Lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_storage()
    sync_from_persist_on_boot()
    asyncio.create_task(prune_expired_and_trash())
    task = asyncio.create_task(maintenance_loop())
    yield
    task.cancel()


app = FastAPI(title="KeepBoard", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Request Schemas
# ---------------------------------------------------------------------------

class NoteUpdateRequest(BaseModel):
    title: Optional[str] = None
    text: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    is_pinned: Optional[bool] = None
    archived: Optional[bool] = None
    is_archived: Optional[bool] = None
    trashed: Optional[bool] = None
    is_trash: Optional[bool] = None
    deleted_at: Optional[int] = None
    expires_at: Optional[int] = None
    is_vault: Optional[bool] = None
    saved_to_disk: Optional[bool] = None
    snoozed_until: Optional[int] = None
    checklist: Optional[list] = None
    tags: Optional[list] = None
    sort_order: Optional[int] = None
    workspace: Optional[str] = None


class WorkspaceCreateRequest(BaseModel):
    name: str
    id: Optional[str] = None


class WorkspaceUpdateRequest(BaseModel):
    name: str


class MoveWorkspaceRequest(BaseModel):
    workspace: str


class BatchMoveWorkspaceRequest(BaseModel):
    note_ids: List[str]
    workspace: str


class BatchActionRequest(BaseModel):
    ids: List[str]
    action: str  # "pin", "unpin", "color", "archive", "unarchive", "trash", "restore", "delete_forever", "add_tag", "remove_tag", "merge", "toggle_persist", "move_workspace"
    payload: Optional[Any] = None


class BatchDownloadRequest(BaseModel):
    ids: List[str]


class ReorderRequest(BaseModel):
    order: List[str]


class VaultSetPasswordRequest(BaseModel):
    password: Optional[str] = None
    new_password: Optional[str] = None
    master_password: Optional[str] = None


class VaultUnlockRequest(BaseModel):
    password: Optional[str] = None
    master_password: Optional[str] = None


class TransferAttachmentRequest(BaseModel):
    source_note_id: str
    attachment_id: str


class RenameAttachmentRequest(BaseModel):
    filename: str


class SnoozeRequest(BaseModel):
    snooze_until: Optional[int] = None
    snoozed_until: Optional[int] = None


# ---------------------------------------------------------------------------
# API: System Health, Stats & SSE Live Sync
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "KeepBoard",
        "version": "3.1.0",
        "data_dir": DATA_DIR,
        "persist_available": is_persist_available()
    }


@app.get("/api/stats")
async def get_stats(x_vault_token: Optional[str] = Header(default=None)):
    """Return storage metrics, note counts, and RAM tmpfs utilization."""
    async with notes_lock:
        all_notes = read_notes_sync()

    vault_ok = _validate_vault_token(x_vault_token)
    notes_in_view = [n for n in all_notes if not n.get("is_vault") or vault_ok]

    active_count = len([n for n in notes_in_view if not (n.get("trashed") or n.get("is_trash")) and not (n.get("archived") or n.get("is_archived"))])
    archived_count = len([n for n in notes_in_view if (n.get("archived") or n.get("is_archived")) and not (n.get("trashed") or n.get("is_trash"))])
    trashed_count = len([n for n in notes_in_view if (n.get("trashed") or n.get("is_trash"))])
    vault_count = len([n for n in all_notes if n.get("is_vault")])
    persist_count = len([n for n in all_notes if n.get("saved_to_disk")])

    total_files_bytes = 0
    total_files_count = 0
    for n in all_notes:
        for att in n.get("attachments", []):
            total_files_bytes += att.get("size", 0)
            total_files_count += 1

    # Measure RAM tmpfs (/data) storage
    ram_total = 0
    ram_used = 0
    ram_free = 0
    data_bytes = 0
    try:
        if os.path.exists(DATA_DIR):
            usage = shutil.disk_usage(DATA_DIR)
            ram_total = usage.total
            ram_used = usage.used
            ram_free = usage.free
            for root, dirs, files in os.walk(DATA_DIR):
                for f in files:
                    try:
                        data_bytes += os.path.getsize(os.path.join(root, f))
                    except Exception:
                        pass
    except Exception:
        pass

    if ram_used == 0 and data_bytes > 0:
        ram_used = data_bytes

    # Measure persistent disk (/persist) storage
    persist_total = 0
    persist_used = 0
    persist_free = 0
    persist_bytes = 0
    if is_persist_available():
        try:
            if os.path.exists(PERSIST_DIR):
                p_usage = shutil.disk_usage(PERSIST_DIR)
                persist_total = p_usage.total
                persist_used = p_usage.used
                persist_free = p_usage.free
                for root, dirs, files in os.walk(PERSIST_DIR):
                    for f in files:
                        try:
                            persist_bytes += os.path.getsize(os.path.join(root, f))
                        except Exception:
                            pass
        except Exception:
            pass

    return {
        "ram_used": ram_used,
        "ram_total": ram_total,
        "ram_free": ram_free,
        "ram_bytes": data_bytes,
        "ram_percent": round((ram_used / ram_total * 100), 1) if ram_total > 0 else 0.0,
        "persist_used": persist_used,
        "persist_total": persist_total,
        "persist_free": persist_free,
        "persist_bytes": persist_bytes,
        "persist_available": is_persist_available(),
        "active_count": active_count,
        "archived_count": archived_count,
        "trashed_count": trashed_count,
        "vault_count": vault_count,
        "persist_count": persist_count,
        "total_notes": len(all_notes),
        "total_files_count": total_files_count,
        "total_files_bytes": total_files_bytes,
        "storage_dir": DATA_DIR,
        # Backward-compatible aliases
        "used": ram_used,
        "total": ram_total,
        "free": ram_free,
        "disk_used": persist_used,
        "disk_total": persist_total
    }


@app.get("/api/events")
async def events_stream(request: Request):
    """Server-Sent Events endpoint for instant live sync across open tabs and devices."""
    queue = asyncio.Queue(maxsize=50)
    sse_subscribers.add(queue)

    async def generator():
        try:
            yield f"event: connected\ndata: {json.dumps({'time': int(time.time() * 1000)})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            sse_subscribers.discard(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


# ---------------------------------------------------------------------------
# API: Notes Retrieval
# ---------------------------------------------------------------------------

@app.get("/api/notes")
async def get_notes(
    view: Optional[str] = Query(None),
    x_view: Optional[str] = Header(default=None),
    x_vault_token: Optional[str] = Header(default=None)
):
    """Retrieve notes. If no view filter is specified or view='all', returns all notes (respecting vault authentication)."""
    active_view = x_view or view or "all"
    vault_ok = _validate_vault_token(x_vault_token)

    async with notes_lock:
        all_notes = read_notes_sync()

    if active_view == "vault":
        if not vault_ok:
            raise HTTPException(status_code=403, detail="Vault password authentication required.")
        filtered = [n for n in all_notes if n.get("is_vault") and not (n.get("trashed") or n.get("is_trash"))]
    elif active_view == "archive":
        filtered = [n for n in all_notes if (n.get("archived") or n.get("is_archived")) and not (n.get("trashed") or n.get("is_trash")) and (not n.get("is_vault") or vault_ok)]
    elif active_view == "trash":
        filtered = [n for n in all_notes if (n.get("trashed") or n.get("is_trash")) and (not n.get("is_vault") or vault_ok)]
    elif active_view == "notes":
        filtered = [n for n in all_notes if not (n.get("archived") or n.get("is_archived")) and not (n.get("trashed") or n.get("is_trash")) and not n.get("is_vault")]
    else:
        # Default / "all": return all notes. Vault notes are included if unlocked, or excluded if locked.
        if vault_ok:
            filtered = list(all_notes)
        else:
            filtered = [n for n in all_notes if not n.get("is_vault")]

    def sort_key(note):
        pinned = not bool(note.get("pinned", False) or note.get("is_pinned", False))
        order = note.get("sort_order", 0)
        sort_rank = order if order > 0 else 999999999
        updated = -int(note.get("updated_at", 0))
        return (pinned, sort_rank, updated)

    filtered.sort(key=sort_key)
    return filtered


# ---------------------------------------------------------------------------
# API: Note Creation & Duplication
# ---------------------------------------------------------------------------

@app.post("/api/notes")
async def create_note(
    title: str = Form(""),
    text: str = Form(""),
    content: Optional[str] = Form(None),
    color: str = Form("#1b1c1f"),
    pinned: bool = Form(False),
    is_pinned: Optional[bool] = Form(None),
    archived: bool = Form(False),
    is_archived: Optional[bool] = Form(None),
    is_vault: bool = Form(False),
    saved_to_disk: bool = Form(False),
    snoozed_until: int = Form(0),
    expires_in: int = Form(0),
    ttl: Optional[str] = Form(None),
    tags: str = Form("[]"),
    checklist: str = Form("[]"),
    is_checklist: Optional[bool] = Form(None),
    workspace: str = Form("default"),
    files: List[UploadFile] = File(default=[]),
    x_vault_token: Optional[str] = Header(default=None)
):
    """Create a new note with arbitrary binary attachments and optional checklist/TTL/persist."""
    is_vault_bool = bool(is_vault) if isinstance(is_vault, bool) else bool(getattr(is_vault, "default", False))
    pinned_bool = bool(pinned) if isinstance(pinned, bool) else bool(getattr(pinned, "default", False))
    if is_pinned is not None:
        pinned_bool = bool(is_pinned) if isinstance(is_pinned, bool) else bool(getattr(is_pinned, "default", False))

    archived_bool = bool(archived) if isinstance(archived, bool) else bool(getattr(archived, "default", False))
    if is_archived is not None:
        archived_bool = bool(is_archived) if isinstance(is_archived, bool) else bool(getattr(is_archived, "default", False))

    saved_disk_bool = bool(saved_to_disk) if isinstance(saved_to_disk, bool) else bool(getattr(saved_to_disk, "default", False))

    if is_vault_bool and not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault authentication required to create vault notes.")

    now = int(time.time() * 1000)
    note_id = uuid.uuid4().hex

    attachments = []
    if isinstance(files, list):
        for file in files:
            if hasattr(file, "filename") and file.filename:
                att = await save_uploaded_file(file)
                attachments.append(att)

    parsed_tags = []
    tags_str = tags if isinstance(tags, str) else getattr(tags, "default", "[]")
    try:
        parsed_tags = json.loads(tags_str) if tags_str else []
    except Exception:
        parsed_tags = []

    parsed_checklist = []
    checklist_str = checklist if isinstance(checklist, str) else getattr(checklist, "default", "[]")
    try:
        parsed_checklist = json.loads(checklist_str) if checklist_str else []
    except Exception:
        parsed_checklist = []

    exp_val = expires_in if isinstance(expires_in, int) else getattr(expires_in, "default", 0)
    ttl_val = ttl if isinstance(ttl, str) else getattr(ttl, "default", None)
    if ttl_val and exp_val == 0:
        ttl_map = {"1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000}
        exp_val = ttl_map.get(ttl_val, 0)
    expires_at = (now + exp_val * 1000) if exp_val > 0 else 0
    snooze_val = snoozed_until if isinstance(snoozed_until, int) else getattr(snoozed_until, "default", 0)

    note_title = title if isinstance(title, str) else getattr(title, "default", "")
    note_text = text if isinstance(text, str) else getattr(text, "default", "")
    content_val = content if isinstance(content, str) else getattr(content, "default", None)
    if content_val and not note_text:
        note_text = content_val

    note_color = color if isinstance(color, str) else getattr(color, "default", "#1b1c1f")
    is_check_bool = bool(is_checklist) if isinstance(is_checklist, bool) else bool(getattr(is_checklist, "default", False))
    if parsed_checklist:
        is_check_bool = True

    new_note = {
        "id": note_id,
        "title": (note_title or "").strip(),
        "text": sanitize_html(note_text) if note_text else "",
        "content": sanitize_html(note_text) if note_text else "",
        "color": note_color or "#1b1c1f",
        "pinned": pinned_bool,
        "is_pinned": pinned_bool,
        "archived": archived_bool,
        "is_archived": archived_bool,
        "trashed": False,
        "is_trash": False,
        "deleted_at": None,
        "expires_at": expires_at,
        "is_vault": is_vault_bool,
        "saved_to_disk": saved_disk_bool,
        "snoozed_until": snooze_val,
        "checklist": parsed_checklist,
        "is_checklist": is_check_bool,
        "tags": parsed_tags,
        "attachments": attachments,
        "workspace": (workspace if isinstance(workspace, str) else getattr(workspace, "default", "default")).strip() or "default",
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }

    async with notes_lock:
        notes = read_notes_sync()
        notes.insert(0, new_note)
        _atomic_write(NOTES_FILE, notes)
        if saved_disk_bool:
            mirror_note_to_persist(new_note)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "created", "id": note_id, "workspace": new_note["workspace"]}))
    return new_note


@app.post("/api/notes/{note_id}/duplicate")
async def duplicate_note(
    note_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Create an exact copy of a note ('Make a copy') with a fresh ID."""
    async with notes_lock:
        notes = read_notes_sync()
        source = next((n for n in notes if n["id"] == note_id), None)
        if not source:
            raise HTTPException(status_code=404, detail="Note not found.")

        if source.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        now = int(time.time() * 1000)
        copy_note = dict(source)
        copy_note["id"] = uuid.uuid4().hex
        copy_note["title"] = source.get("title", "")
        copy_note["created_at"] = now
        copy_note["updated_at"] = now
        copy_note["workspace"] = source.get("workspace", "default")
        copy_note["checklist"] = [dict(it) for it in source.get("checklist", [])]
        copy_note["tags"] = list(source.get("tags", []))
        copy_note["attachments"] = [dict(att) for att in source.get("attachments", [])]

        notes.insert(0, copy_note)
        _atomic_write(NOTES_FILE, notes)
        if copy_note.get("saved_to_disk"):
            mirror_note_to_persist(copy_note)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "duplicated", "id": copy_note["id"]}))
    return copy_note


# ---------------------------------------------------------------------------
# API: Single Note Mutation & Restore
# ---------------------------------------------------------------------------

@app.put("/api/notes/{note_id}")
@app.patch("/api/notes/{note_id}")
async def update_note(
    note_id: str,
    payload: NoteUpdateRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Update fields on a note with HTML sanitization."""
    now = int(time.time() * 1000)
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")

        if (target.get("is_vault") or payload.is_vault) and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        if payload.title is not None:
            target["title"] = payload.title.strip()
        
        note_text_val = payload.text if payload.text is not None else payload.content
        if note_text_val is not None:
            sanitized = sanitize_html(note_text_val)
            target["text"] = sanitized
            target["content"] = sanitized

        if payload.color is not None:
            target["color"] = payload.color
        
        pinned_val = payload.pinned if payload.pinned is not None else payload.is_pinned
        if pinned_val is not None:
            target["pinned"] = pinned_val
            target["is_pinned"] = pinned_val

        archived_val = payload.archived if payload.archived is not None else payload.is_archived
        if archived_val is not None:
            target["archived"] = archived_val
            target["is_archived"] = archived_val

        trashed_val = payload.trashed if payload.trashed is not None else payload.is_trash
        if trashed_val is not None:
            target["trashed"] = trashed_val
            target["is_trash"] = trashed_val
            if trashed_val:
                target["deleted_at"] = payload.deleted_at or now
                target["pinned"] = False
                target["is_pinned"] = False
            else:
                target["deleted_at"] = None
        if payload.expires_at is not None:
            target["expires_at"] = payload.expires_at
        if payload.is_vault is not None:
            target["is_vault"] = payload.is_vault
            if payload.is_vault:
                target["pinned"] = False
                target["archived"] = False
        if payload.saved_to_disk is not None:
            target["saved_to_disk"] = payload.saved_to_disk
        if payload.snoozed_until is not None:
            target["snoozed_until"] = payload.snoozed_until
        if payload.checklist is not None:
            target["checklist"] = payload.checklist
        if payload.tags is not None:
            target["tags"] = payload.tags
        if payload.sort_order is not None:
            target["sort_order"] = payload.sort_order
        if payload.workspace is not None:
            target["workspace"] = payload.workspace.strip() or "default"

        target["updated_at"] = now
        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target, remove=not target.get("saved_to_disk"))

    asyncio.create_task(broadcast_event("notes_updated", {"action": "updated", "id": note_id, "workspace": target.get("workspace", "default")}))
    return target


@app.post("/api/notes/{note_id}/bump")
async def bump_note(
    note_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Bring note to the top of unpinned notes without pinning."""
    now = int(time.time() * 1000)
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")
        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        target["updated_at"] = now
        target["sort_order"] = 0
        target["snoozed_until"] = 0
        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "bumped", "id": note_id}))
    return {"status": "bumped", "id": note_id, "updated_at": now}


@app.post("/api/notes/{note_id}/snooze")
async def snooze_note(
    note_id: str,
    req: SnoozeRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Set snooze reminder timestamp on note."""
    snooze_ts = req.snooze_until if req.snooze_until is not None else (req.snoozed_until or 0)
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")
        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        target["snoozed_until"] = snooze_ts
        target["updated_at"] = int(time.time() * 1000)
        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "snoozed", "id": note_id}))
    return {"status": "snoozed", "id": note_id, "snoozed_until": snooze_ts}


@app.post("/api/notes/{note_id}/toggle-persist")
async def toggle_persist(
    note_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Toggle saved_to_disk flag for hybrid RAM/Disk persistence."""
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")
        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        current_val = bool(target.get("saved_to_disk", False))
        new_val = not current_val
        target["saved_to_disk"] = new_val
        target["updated_at"] = int(time.time() * 1000)
        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target, remove=(not new_val))

    asyncio.create_task(broadcast_event("notes_updated", {"action": "persist_toggled", "id": note_id}))
    return {"id": note_id, "saved_to_disk": new_val}


@app.post("/api/notes/{note_id}/restore")
async def restore_note(
    note_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Restore a note from the Trash bin back to active notes."""
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")

        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        target["trashed"] = False
        target["is_trash"] = False
        target["deleted_at"] = None
        target["archived"] = False
        target["is_archived"] = False
        target["updated_at"] = int(time.time() * 1000)
        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "restored", "id": note_id}))
    return target


@app.delete("/api/notes/{note_id}")
async def delete_note(
    note_id: str,
    forever: bool = Query(False),
    x_vault_token: Optional[str] = Header(default=None)
):
    """
    Delete note:
    - Default (forever=False): Soft-deletes note into the Trash with deleted_at timestamp.
    - forever=True: Permanently deletes note and removes its files from /data/files/.
    """
    now = int(time.time() * 1000)
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")

        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        if forever:
            for att in target.get("attachments", []):
                delete_file_on_disk(att["stored_name"])
            notes = [n for n in notes if n["id"] != note_id]
            _atomic_write(NOTES_FILE, notes)
            mirror_note_to_persist(target, remove=True)
            action_type = "deleted_forever"
        else:
            target["trashed"] = True
            target["is_trash"] = True
            target["deleted_at"] = now
            target["pinned"] = False
            target["is_pinned"] = False
            target["updated_at"] = now
            _atomic_write(NOTES_FILE, notes)
            mirror_note_to_persist(target)
            action_type = "trashed"

    asyncio.create_task(broadcast_event("notes_updated", {"action": action_type, "id": note_id}))
    return {"status": action_type, "id": note_id}


@app.delete("/api/trash")
@app.post("/api/trash/empty")
@app.delete("/api/trash/empty")
async def empty_trash(x_vault_token: Optional[str] = Header(default=None)):
    """Permanently delete all notes in Trash and reclaim tmpfs RAM."""
    vault_ok = _validate_vault_token(x_vault_token)
    async with notes_lock:
        notes = read_notes_sync()
        kept_notes = []
        purged_count = 0

        for n in notes:
            if n.get("trashed") or n.get("is_trash"):
                if n.get("is_vault") and not vault_ok:
                    kept_notes.append(n)
                    continue
                purged_count += 1
                for att in n.get("attachments", []):
                    delete_file_on_disk(att["stored_name"])
                mirror_note_to_persist(n, remove=True)
            else:
                kept_notes.append(n)

        _atomic_write(NOTES_FILE, kept_notes)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "trash_emptied", "purged_count": purged_count}))
    return {"status": "emptied", "purged_count": purged_count}


# ---------------------------------------------------------------------------
# API: Batch Operations & Card Merging
# ---------------------------------------------------------------------------

@app.post("/api/notes/batch")
async def batch_action(
    req: BatchActionRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Perform a batch operation on multiple notes atomically."""
    vault_ok = _validate_vault_token(x_vault_token)
    now = int(time.time() * 1000)
    target_ids = set(req.ids)

    async with notes_lock:
        notes = read_notes_sync()
        matching = [n for n in notes if n["id"] in target_ids]

        for n in matching:
            if n.get("is_vault") and not vault_ok:
                raise HTTPException(status_code=403, detail="Vault authentication required for vault notes.")

        if req.action == "pin":
            for n in matching:
                n["pinned"] = True
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "unpin":
            for n in matching:
                n["pinned"] = False
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "color":
            if isinstance(req.payload, dict):
                new_color = req.payload.get("color", "#1b1c1f")
            elif isinstance(req.payload, str):
                new_color = req.payload
            else:
                new_color = "#1b1c1f"
            for n in matching:
                n["color"] = new_color
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "archive":
            for n in matching:
                n["archived"] = True
                n["pinned"] = False
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "unarchive":
            for n in matching:
                n["archived"] = False
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "trash":
            for n in matching:
                n["trashed"] = True
                n["is_trash"] = True
                n["deleted_at"] = now
                n["pinned"] = False
                n["is_pinned"] = False
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "restore":
            for n in matching:
                n["trashed"] = False
                n["is_trash"] = False
                n["deleted_at"] = None
                n["archived"] = False
                n["is_archived"] = False
                n["updated_at"] = now
                mirror_note_to_persist(n)
        elif req.action == "delete_forever":
            for n in matching:
                for att in n.get("attachments", []):
                    delete_file_on_disk(att["stored_name"])
                mirror_note_to_persist(n, remove=True)
            notes = [n for n in notes if n["id"] not in target_ids]
            _atomic_write(NOTES_FILE, notes)
            asyncio.create_task(broadcast_event("notes_updated", {"action": "batch_deleted", "count": len(matching)}))
            return {"status": "deleted_forever", "count": len(matching)}
        elif req.action == "toggle_persist":
            for n in matching:
                val = not bool(n.get("saved_to_disk"))
                n["saved_to_disk"] = val
                n["updated_at"] = now
                mirror_note_to_persist(n, remove=not val)
        elif req.action == "move_workspace":
            target_ws = ""
            if isinstance(req.payload, dict):
                target_ws = req.payload.get("workspace", "").strip()
            elif isinstance(req.payload, str):
                target_ws = req.payload.strip()
            if target_ws:
                for n in matching:
                    n["workspace"] = target_ws
                    n["updated_at"] = now
                    mirror_note_to_persist(n)
        elif req.action in ("tag", "add_tag"):
            if isinstance(req.payload, dict):
                tag_to_add = req.payload.get("tag", "").strip()
            elif isinstance(req.payload, str):
                tag_to_add = req.payload.strip()
            else:
                tag_to_add = ""
            if tag_to_add:
                for n in matching:
                    tags = set(n.get("tags", []))
                    tags.add(tag_to_add)
                    n["tags"] = sorted(list(tags))
                    n["updated_at"] = now
                    mirror_note_to_persist(n)
        elif req.action == "remove_tag":
            tag_to_remove = (req.payload or {}).get("tag", "").strip().lower()
            if tag_to_remove:
                for n in matching:
                    n["tags"] = [t for t in n.get("tags", []) if t != tag_to_remove]
                    n["updated_at"] = now
                    mirror_note_to_persist(n)
        elif req.action == "merge":
            if len(matching) < 2:
                raise HTTPException(status_code=400, detail="At least 2 notes required to merge.")

            merged_titles = [n.get("title", "").strip() for n in matching if n.get("title", "").strip()]
            combined_title = " / ".join(merged_titles) if merged_titles else ""

            merged_texts = [n.get("text", "").strip() for n in matching if n.get("text", "").strip()]
            combined_text = "<br><hr><br>".join(merged_texts)

            combined_checklist = []
            for n in matching:
                combined_checklist.extend(n.get("checklist", []))

            merged_tags = set()
            for n in matching:
                for t in n.get("tags", []):
                    merged_tags.add(t)

            merged_attachments = []
            for n in matching:
                merged_attachments.extend(n.get("attachments", []))

            primary = matching[0]
            if combined_title:
                primary["title"] = combined_title
            primary["text"] = combined_text
            primary["checklist"] = combined_checklist
            primary["tags"] = sorted(list(merged_tags))
            primary["attachments"] = merged_attachments
            primary["updated_at"] = now

            secondary_ids = {n["id"] for n in matching[1:]}
            for sid in secondary_ids:
                s_note = next((n for n in notes if n["id"] == sid), None)
                if s_note:
                    mirror_note_to_persist(s_note, remove=True)
            notes = [n for n in notes if n["id"] not in secondary_ids]
            mirror_note_to_persist(primary)

        _atomic_write(NOTES_FILE, notes)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "batch", "type": req.action}))
    return {"status": "ok", "action": req.action, "count": len(matching)}


@app.post("/api/notes/batch/download")
async def batch_download(
    req: BatchDownloadRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Bundle all attachments across selected notes into a single streamed .zip file."""
    vault_ok = _validate_vault_token(x_vault_token)
    async with notes_lock:
        all_notes = read_notes_sync()

    target_ids = set(req.ids)
    selected = [n for n in all_notes if n["id"] in target_ids]

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        seen_names = set()
        for note in selected:
            if note.get("is_vault") and not vault_ok:
                continue
            for att in note.get("attachments", []):
                file_path = os.path.join(FILES_DIR, att["stored_name"])
                if os.path.exists(file_path):
                    orig_name = att.get("filename", "file.bin")
                    arcname = orig_name
                    counter = 1
                    while arcname in seen_names:
                        base, ext = os.path.splitext(orig_name)
                        arcname = f"{base}_{counter}{ext}"
                        counter += 1
                    seen_names.add(arcname)
                    zf.write(file_path, arcname=arcname)

    zip_buffer.seek(0)
    filename = f"keepboard-attachments-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.post("/api/notes/reorder")
async def reorder_notes(req: ReorderRequest):
    """Persist custom drag-and-drop sort order."""
    async with notes_lock:
        notes = read_notes_sync()
        id_to_order = {note_id: idx + 1 for idx, note_id in enumerate(req.order)}
        for n in notes:
            if n["id"] in id_to_order:
                n["sort_order"] = id_to_order[n["id"]]
        _atomic_write(NOTES_FILE, notes)
    asyncio.create_task(broadcast_event("notes_updated", {"action": "reordered"}))
    return {"status": "reordered"}


# ---------------------------------------------------------------------------
# API: Attachments & Inline Media Streaming
# ---------------------------------------------------------------------------

@app.post("/api/notes/{note_id}/attachments")
async def add_attachments(
    note_id: str,
    files: List[UploadFile] = File(...),
    x_vault_token: Optional[str] = Header(default=None)
):
    """Upload and attach arbitrary files to an existing note."""
    uploaded = []
    for file in files:
        if file.filename:
            uploaded.append(await save_uploaded_file(file))

    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            for att in uploaded:
                delete_file_on_disk(att["stored_name"])
            raise HTTPException(status_code=404, detail="Note not found.")

        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            for att in uploaded:
                delete_file_on_disk(att["stored_name"])
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        target.setdefault("attachments", []).extend(uploaded)
        target["updated_at"] = int(time.time() * 1000)
        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "attachments_added", "id": note_id}))
    return target


@app.delete("/api/notes/{note_id}/attachments/{attachment_id}")
async def delete_attachment(
    note_id: str,
    attachment_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Delete a single attachment from a note and disk."""
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")

        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        to_delete = None
        new_atts = []
        for att in target.get("attachments", []):
            if att["id"] == attachment_id:
                to_delete = att["stored_name"]
            else:
                new_atts.append(att)

        target["attachments"] = new_atts
        target["updated_at"] = int(time.time() * 1000)

        if to_delete:
            delete_file_on_disk(to_delete)

        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "attachment_deleted", "id": note_id}))
    return target


@app.get("/api/files/{attachment_id}")
async def serve_file(
    attachment_id: str,
    download: bool = Query(False),
    x_vault_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None)
):
    """Stream attachment file inline or as download."""
    v_token = x_vault_token or token
    async with notes_lock:
        notes = read_notes_sync()

    target_att = None
    is_vault = False
    for n in notes:
        for att in n.get("attachments", []):
            if att["id"] == attachment_id:
                target_att = att
                is_vault = bool(n.get("is_vault"))
                break
        if target_att:
            break

    if not target_att:
        raise HTTPException(status_code=404, detail="Attachment not found.")

    if is_vault and not _validate_vault_token(v_token):
        raise HTTPException(status_code=403, detail="Vault authentication required.")

    file_path = os.path.join(FILES_DIR, target_att["stored_name"])
    if not os.path.exists(file_path):
        if is_persist_available():
            p_path = os.path.join(PERSIST_FILES_DIR, target_att["stored_name"])
            if os.path.exists(p_path):
                file_path = p_path
            else:
                raise HTTPException(status_code=404, detail="File missing on disk.")
        else:
            raise HTTPException(status_code=404, detail="File missing on disk.")

    content_type = target_att.get("content_type") or "application/octet-stream"
    disp_type = "attachment" if download else "inline"
    safe_filename = target_att.get("filename", "file.bin")

    return FileResponse(
        path=file_path,
        media_type=content_type,
        content_disposition_type=disp_type,
        filename=safe_filename
    )


# ---------------------------------------------------------------------------
# API: Cross-Card Attachment Transfer & Inline Renaming
# ---------------------------------------------------------------------------

@app.post("/api/notes/{target_id}/transfer-attachment")
async def transfer_attachment(
    target_id: str,
    req: TransferAttachmentRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Transfer an attachment from a source note directly to a target note without re-uploading."""
    vault_ok = _validate_vault_token(x_vault_token)
    now = int(time.time() * 1000)

    async with notes_lock:
        notes = read_notes_sync()
        source = next((n for n in notes if n["id"] == req.source_note_id), None)
        target = next((n for n in notes if n["id"] == target_id), None)

        if not source or not target:
            raise HTTPException(status_code=404, detail="Source or target note not found.")

        if (source.get("is_vault") or target.get("is_vault")) and not vault_ok:
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        att_to_move = None
        new_source_atts = []
        for att in source.get("attachments", []):
            if att["id"] == req.attachment_id:
                att_to_move = att
            else:
                new_source_atts.append(att)

        if not att_to_move:
            raise HTTPException(status_code=404, detail="Attachment not found in source note.")

        source["attachments"] = new_source_atts
        source["updated_at"] = now

        target.setdefault("attachments", []).append(att_to_move)
        target["updated_at"] = now

        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(source)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "transferred", "target_id": target_id}))
    return {"status": "transferred", "attachment": att_to_move, "target_id": target_id}


@app.put("/api/notes/{note_id}/attachments/{attachment_id}/rename")
async def rename_attachment(
    note_id: str,
    attachment_id: str,
    req: RenameAttachmentRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Rename an attachment display filename."""
    if not req.filename or not req.filename.strip():
        raise HTTPException(status_code=400, detail="Filename cannot be empty.")

    clean_filename = os.path.basename(req.filename.strip())
    now = int(time.time() * 1000)

    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")

        if target.get("is_vault") and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        target_att = next((a for a in target.get("attachments", []) if a["id"] == attachment_id), None)
        if not target_att:
            raise HTTPException(status_code=404, detail="Attachment not found.")

        target_att["filename"] = clean_filename
        guessed_type, _ = mimetypes.guess_type(clean_filename)
        if guessed_type:
            target_att["content_type"] = guessed_type
        target["updated_at"] = now

        _atomic_write(NOTES_FILE, notes)
        mirror_note_to_persist(target)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "renamed_attachment", "id": note_id}))
    return {"status": "renamed", "attachment": target_att}


# ---------------------------------------------------------------------------
# API: ZIP / JAR Archive Peek & Extract
# ---------------------------------------------------------------------------

@app.get("/api/files/{attachment_id}/zip-list")
async def get_zip_list(
    attachment_id: str,
    x_vault_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None)
):
    """Peek inside a ZIP or JAR archive, listing files and sizes without downloading."""
    v_token = x_vault_token or token
    async with notes_lock:
        notes = read_notes_sync()

    target_att = None
    is_vault = False
    for n in notes:
        for att in n.get("attachments", []):
            if att["id"] == attachment_id:
                target_att = att
                is_vault = bool(n.get("is_vault"))
                break
        if target_att:
            break

    if not target_att:
        raise HTTPException(status_code=404, detail="Attachment not found.")

    if is_vault and not _validate_vault_token(v_token):
        raise HTTPException(status_code=403, detail="Vault authentication required.")

    file_path = os.path.join(FILES_DIR, target_att["stored_name"])
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File missing on disk.")

    if not zipfile.is_zipfile(file_path):
        raise HTTPException(status_code=400, detail="File is not a valid ZIP or JAR archive.")

    try:
        with zipfile.ZipFile(file_path, "r") as zf:
            items = []
            for info in zf.infolist():
                items.append({
                    "path": info.filename,
                    "size": info.file_size,
                    "compress_size": info.compress_size,
                    "is_dir": info.is_dir()
                })
        return {
            "attachment_id": attachment_id,
            "filename": target_att.get("filename", "archive.zip"),
            "files": items,
            "total_files": len(items)
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read archive: {str(e)}")


@app.get("/api/files/{attachment_id}/zip-extract")
async def extract_zip_file(
    attachment_id: str,
    path: str = Query(...),
    download: bool = Query(True),
    x_vault_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None)
):
    """Extract and stream a single file directly from a ZIP or JAR archive."""
    v_token = x_vault_token or token
    async with notes_lock:
        notes = read_notes_sync()

    target_att = None
    is_vault = False
    for n in notes:
        for att in n.get("attachments", []):
            if att["id"] == attachment_id:
                target_att = att
                is_vault = bool(n.get("is_vault"))
                break
        if target_att:
            break

    if not target_att:
        raise HTTPException(status_code=404, detail="Attachment not found.")

    if is_vault and not _validate_vault_token(v_token):
        raise HTTPException(status_code=403, detail="Vault authentication required.")

    file_path = os.path.join(FILES_DIR, target_att["stored_name"])
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File missing on disk.")

    if not zipfile.is_zipfile(file_path):
        raise HTTPException(status_code=400, detail="File is not a valid ZIP or JAR archive.")

    try:
        with zipfile.ZipFile(file_path, "r") as zf:
            target_info = next((i for i in zf.infolist() if i.filename == path and not i.is_dir()), None)
            if not target_info:
                raise HTTPException(status_code=404, detail="File not found in archive.")

            file_bytes = zf.read(target_info)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to extract file: {str(e)}")

    guessed_type, _ = mimetypes.guess_type(path)
    ct = guessed_type or "application/octet-stream"
    disp = "attachment" if download else "inline"
    safe_name = os.path.basename(path) or "extracted.bin"

    return StreamingResponse(
        io.BytesIO(file_bytes),
        media_type=ct,
        headers={"Content-Disposition": f'{disp}; filename="{safe_name}"'}
    )


# ---------------------------------------------------------------------------
# API: Direct CLI / Piping Drop Endpoint
# ---------------------------------------------------------------------------

@app.post("/api/drop")
async def direct_drop(
    request: Request,
    x_title: Optional[str] = Header(default=None),
    x_filename: Optional[str] = Header(default=None),
    x_vault_token: Optional[str] = Header(default=None),
    title: Optional[str] = Query(default=None)
):
    """
    Direct CLI / Piping File & Text drop endpoint.
    Supports:
    - curl -F "file=@dump.log" https://.../api/drop
    - cat report.txt | curl -X POST --data-binary @- -H "Content-Type: text/plain" https://.../api/drop
    - curl -F "text=Meeting notes..." -F "title=Sync" https://.../api/drop
    """
    now = int(time.time() * 1000)
    content_type = request.headers.get("content-type", "")

    note_title = (x_title or title or "").strip()
    note_text = ""
    attachments = []
    tags = []
    color = "#1b1c1f"

    if "multipart/form-data" in content_type:
        form = await request.form()
        form_title = form.get("title")
        if form_title and not note_title:
            note_title = str(form_title).strip()
        form_text = form.get("text")
        if form_text:
            note_text = sanitize_html(str(form_text))
        form_color = form.get("color")
        if form_color:
            color = str(form_color).strip()
        form_tags = form.get("tags")
        if form_tags:
            try:
                parsed = json.loads(str(form_tags))
                if isinstance(parsed, list):
                    tags = parsed
                else:
                    tags = [str(form_tags).strip()]
            except Exception:
                tags = [t.strip() for t in str(form_tags).split(",") if t.strip()]

        for key in ("file", "files"):
            val = form.getlist(key) if hasattr(form, "getlist") else [form.get(key)]
            for item in val:
                if isinstance(item, UploadFile) and item.filename:
                    att = await save_uploaded_file(item)
                    attachments.append(att)

        if not note_title and not note_text and attachments:
            note_title = attachments[0]["filename"]
        elif not note_title:
            note_title = f"CLI Drop - {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    else:
        raw_body = await request.body()
        if not note_title:
            note_title = f"CLI Drop - {datetime.now().strftime('%Y-%m-%d %H:%M')}"

        is_text = False
        text_content = ""
        try:
            text_content = raw_body.decode("utf-8")
            is_text = True
        except UnicodeDecodeError:
            is_text = False

        if is_text and ("text" in content_type or not content_type or not x_filename):
            note_text = sanitize_html(text_content)
        else:
            att_id = uuid.uuid4().hex
            orig_filename = x_filename or f"drop_{now}.bin"
            safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', os.path.basename(orig_filename))
            stored_name = f"{att_id}_{safe_name}"
            file_path = os.path.join(FILES_DIR, stored_name)
            with open(file_path, "wb") as f:
                f.write(raw_body)
            guessed_type, _ = mimetypes.guess_type(orig_filename)
            content_type_val = guessed_type or content_type or "application/octet-stream"
            att = {
                "id": att_id,
                "filename": orig_filename,
                "stored_name": stored_name,
                "size": len(raw_body),
                "content_type": content_type_val,
                "created_at": now
            }
            attachments.append(att)
            if not note_text:
                note_text = f"Piped binary drop ({format_bytes_py(len(raw_body))})"

    note_id = uuid.uuid4().hex
    new_note = {
        "id": note_id,
        "title": note_title,
        "text": note_text,
        "color": color,
        "pinned": False,
        "archived": False,
        "trashed": False,
        "deleted_at": None,
        "expires_at": 0,
        "is_vault": False,
        "saved_to_disk": False,
        "snoozed_until": 0,
        "checklist": [],
        "tags": tags,
        "attachments": attachments,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now
    }

    async with notes_lock:
        notes = read_notes_sync()
        notes.insert(0, new_note)
        _atomic_write(NOTES_FILE, notes)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "cli_dropped", "id": note_id}))
    return {
        "status": "ok",
        "id": note_id,
        "title": note_title,
        "attachments_count": len(attachments),
        "url": f"/#note-{note_id}"
    }


# ---------------------------------------------------------------------------
# API: SSRF-Safe Link Metadata Previews
# ---------------------------------------------------------------------------

@app.get("/api/link-preview")
async def get_link_preview(url: str = Query(...)):
    """Fetch Open Graph title, description, and favicon with SSRF protection against private/loopback IPs."""
    url = url.strip()
    if url in link_preview_cache:
        return link_preview_cache[url]

    parsed = check_url_ssrf_safety(url)

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; KeepBoard/3.0; +https://keepboard)"}
    )

    try:
        loop = asyncio.get_event_loop()
        def fetch():
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                content_type = resp.headers.get_content_type()
                if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                    return None, None
                chunk = resp.read(65536)
                charset = resp.headers.get_content_charset() or "utf-8"
                return chunk.decode(charset, errors="ignore"), resp.geturl()

        html_text, final_url = await loop.run_in_executor(None, fetch)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not fetch URL preview: {str(e)}")

    if not html_text:
        preview = {
            "url": url,
            "title": parsed.hostname,
            "description": "",
            "image": None,
            "favicon": f"{parsed.scheme}://{parsed.netloc}/favicon.ico",
            "domain": parsed.netloc
        }
        link_preview_cache[url] = preview
        return preview

    scraper = HTMLMetaScraper()
    try:
        scraper.feed(html_text)
    except Exception:
        pass

    resolved_title = scraper.og_title or scraper.meta_title or scraper.title or parsed.hostname
    resolved_desc = scraper.og_desc or scraper.meta_desc or ""

    base = final_url or url
    resolved_image = urllib.parse.urljoin(base, scraper.og_image) if scraper.og_image else None
    resolved_favicon = urllib.parse.urljoin(base, scraper.favicon) if scraper.favicon else f"{parsed.scheme}://{parsed.netloc}/favicon.ico"

    preview = {
        "url": url,
        "title": resolved_title,
        "description": resolved_desc[:240],
        "image": resolved_image,
        "favicon": resolved_favicon,
        "domain": parsed.netloc
    }

    if len(link_preview_cache) > MAX_LINK_CACHE:
        link_preview_cache.clear()
    link_preview_cache[url] = preview
    return preview


# ---------------------------------------------------------------------------
# API: Full Backup Export & Restore
# ---------------------------------------------------------------------------

@app.get("/api/backup/export")
async def export_backup():
    """Create and stream a full zip backup containing notes.json, vault.json, workspaces.json, and all files."""
    async with notes_lock:
        notes_data = read_notes_sync()
        vault_data = read_vault_meta()
        workspaces_data = read_workspaces_sync()

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("notes.json", json.dumps(notes_data, indent=2, ensure_ascii=False))
        zf.writestr("workspaces.json", json.dumps(workspaces_data, indent=2, ensure_ascii=False))
        if vault_data:
            zf.writestr("vault.json", json.dumps(vault_data, indent=2, ensure_ascii=False))

        if os.path.exists(FILES_DIR):
            for fname in os.listdir(FILES_DIR):
                fpath = os.path.join(FILES_DIR, fname)
                if os.path.isfile(fpath):
                    zf.write(fpath, arcname=f"files/{fname}")

    zip_buffer.seek(0)
    filename = f"keepboard-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.post("/api/backup/restore")
async def restore_backup(file: UploadFile = File(...)):
    """Restore from a KeepBoard zip backup bundle without wiping unrelated records."""
    if not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Backup must be a .zip archive.")

    content = await file.read()
    zip_buffer = io.BytesIO(content)

    restored_notes_count = 0
    async with notes_lock:
        existing_notes = read_notes_sync()
        existing_ids = {n["id"] for n in existing_notes}

        with zipfile.ZipFile(zip_buffer, "r") as zf:
            for member in zf.namelist():
                if member.startswith("files/") and not member.endswith("/"):
                    fname = os.path.basename(member)
                    if fname:
                        out_path = os.path.join(FILES_DIR, fname)
                        with zf.open(member) as src, open(out_path, "wb") as dst:
                            shutil.copyfileobj(src, dst)

                elif member == "vault.json" and not os.path.exists(VAULT_FILE):
                    vault_bytes = zf.read(member)
                    with open(VAULT_FILE, "wb") as dst:
                        dst.write(vault_bytes)

                elif member == "workspaces.json":
                    try:
                        ws_bytes = zf.read(member).decode("utf-8")
                        ws_imported = json.loads(ws_bytes)
                        if isinstance(ws_imported, list) and len(ws_imported) > 0:
                            write_workspaces_sync(ws_imported)
                    except Exception:
                        pass

            if "notes.json" in zf.namelist():
                raw = zf.read("notes.json").decode("utf-8")
                imported = json.loads(raw)
                for imp in imported:
                    if imp["id"] not in existing_ids:
                        existing_notes.append(imp)
                        existing_ids.add(imp["id"])
                        restored_notes_count += 1

        _atomic_write(NOTES_FILE, existing_notes)

    asyncio.create_task(broadcast_event("notes_updated", {"action": "restored_backup"}))
    return {"status": "restored", "restored_notes_count": restored_notes_count, "total_notes": len(existing_notes)}


# ---------------------------------------------------------------------------
# API: Workspaces
# ---------------------------------------------------------------------------

@app.get("/api/workspaces")
async def get_workspaces():
    return read_workspaces_sync()


@app.post("/api/workspaces")
async def create_workspace(payload: WorkspaceCreateRequest):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name is required.")
    ws_id = payload.id.strip() if payload.id else ""
    if not ws_id:
        ws_id = re.sub(r'[^a-zA-Z0-9_-]', '', name.lower().replace(' ', '-'))[:24]
    if not ws_id:
        ws_id = f"ws_{uuid.uuid4().hex[:8]}"

    workspaces = read_workspaces_sync()
    if any(w["id"] == ws_id for w in workspaces):
        ws_id = f"{ws_id}_{uuid.uuid4().hex[:4]}"

    new_ws = {"id": ws_id, "name": name}
    workspaces.append(new_ws)
    write_workspaces_sync(workspaces)
    asyncio.create_task(broadcast_event("workspaces_updated", {"action": "created", "workspace": new_ws}))
    return new_ws


@app.put("/api/workspaces/{workspace_id}")
@app.patch("/api/workspaces/{workspace_id}")
async def rename_workspace(workspace_id: str, payload: WorkspaceUpdateRequest):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name is required.")
    workspaces = read_workspaces_sync()
    target = next((w for w in workspaces if w["id"] == workspace_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    target["name"] = name
    write_workspaces_sync(workspaces)
    asyncio.create_task(broadcast_event("workspaces_updated", {"action": "renamed", "workspace": target}))
    return target


@app.delete("/api/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str):
    if workspace_id == "default":
        raise HTTPException(status_code=400, detail="Cannot delete default workspace.")
    workspaces = read_workspaces_sync()
    target = next((w for w in workspaces if w["id"] == workspace_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    workspaces = [w for w in workspaces if w["id"] != workspace_id]
    write_workspaces_sync(workspaces)

    # Move notes in deleted workspace to default
    moved_any = False
    async with notes_lock:
        notes = read_notes_sync()
        for n in notes:
            if n.get("workspace") == workspace_id:
                n["workspace"] = "default"
                moved_any = True
                if n.get("saved_to_disk"):
                    mirror_note_to_persist(n)
        if moved_any:
            _atomic_write(NOTES_FILE, notes)

    asyncio.create_task(broadcast_event("workspaces_updated", {"action": "deleted", "id": workspace_id}))
    if moved_any:
        asyncio.create_task(broadcast_event("notes_updated", {"action": "workspace_deleted_reassigned"}))
    return {"status": "deleted", "id": workspace_id}


@app.post("/api/notes/{note_id}/move-workspace")
async def move_note_workspace(note_id: str, payload: MoveWorkspaceRequest):
    target_ws = (payload.workspace or "").strip()
    if not target_ws:
        raise HTTPException(status_code=400, detail="Target workspace required.")
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")
        target["workspace"] = target_ws
        _atomic_write(NOTES_FILE, notes)
        if target.get("saved_to_disk"):
            mirror_note_to_persist(target)
    asyncio.create_task(broadcast_event("notes_updated", {"action": "moved_workspace", "id": note_id, "workspace": target_ws}))
    return {"status": "ok", "id": note_id, "workspace": target_ws}


@app.post("/api/notes/batch/move-workspace")
async def batch_move_workspace(payload: BatchMoveWorkspaceRequest):
    target_ws = (payload.workspace or "").strip()
    if not target_ws:
        raise HTTPException(status_code=400, detail="Target workspace required.")
    ids_set = set(payload.note_ids)
    async with notes_lock:
        notes = read_notes_sync()
        count = 0
        for n in notes:
            if n["id"] in ids_set:
                n["workspace"] = target_ws
                count += 1
                if n.get("saved_to_disk"):
                    mirror_note_to_persist(n)
        if count > 0:
            _atomic_write(NOTES_FILE, notes)
    asyncio.create_task(broadcast_event("notes_updated", {"action": "batch_moved_workspace", "workspace": target_ws, "count": count}))
    return {"status": "ok", "count": count, "workspace": target_ws}


# ---------------------------------------------------------------------------
# API: Password-Protected Vault
# ---------------------------------------------------------------------------

@app.get("/api/vault/status")
async def vault_status():
    meta = read_vault_meta()
    return {"configured": bool(meta.get("password_hash")), "ok": True}


@app.post("/api/vault/set-password")
@app.post("/api/vault/setup")
async def vault_set_password(request: Request):
    meta = read_vault_meta()
    if meta.get("password_hash"):
        raise HTTPException(status_code=409, detail="Vault password already configured.")
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    pw = payload.get("password") or payload.get("new_password") or payload.get("master_password") or ""
    if len(pw) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")
    os.makedirs(os.path.dirname(VAULT_FILE), exist_ok=True)
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(pw, salt)
    vault_config = {"password_hash": pw_hash, "salt": salt}
    _atomic_write(VAULT_FILE, vault_config)
    if is_persist_available():
        try:
            _atomic_write(PERSIST_VAULT_FILE, vault_config)
        except Exception:
            pass
    return {"status": "configured", "ok": True}


@app.post("/api/vault/unlock")
@app.post("/api/vault/verify")
async def vault_unlock(request: Request):
    meta = read_vault_meta()
    if not meta.get("password_hash"):
        raise HTTPException(status_code=404, detail="Vault not configured.")
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    pw = payload.get("password") or payload.get("master_password") or ""
    salt = meta.get("salt", "")
    candidate = _hash_password(pw, salt)
    if not secrets.compare_digest(candidate, meta.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Incorrect vault password.")
    token = _new_vault_token()
    vault_sessions[token] = int(time.time() * 1000) + VAULT_SESSION_TTL_MS
    return {"token": token, "status": "unlocked", "ok": True}


@app.post("/api/vault/lock")
async def vault_lock(x_vault_token: Optional[str] = Header(default=None)):
    if x_vault_token:
        vault_sessions.pop(x_vault_token, None)
    return {"status": "locked", "ok": True}


@app.post("/api/vault/change")
async def vault_change(
    payload: dict,
    x_vault_token: Optional[str] = Header(default=None)
):
    if not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault authentication required.")
    new_password = payload.get("new_password") or payload.get("password") or ""
    if len(new_password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(new_password, salt)
    vault_config = {"password_hash": pw_hash, "salt": salt}
    _atomic_write(VAULT_FILE, vault_config)
    if is_persist_available():
        try:
            _atomic_write(PERSIST_VAULT_FILE, vault_config)
        except Exception:
            pass
    return {"status": "changed", "ok": True}


# ---------------------------------------------------------------------------
# Serve Single-Page App
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
