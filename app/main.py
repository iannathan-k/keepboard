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
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# In-memory vault session tokens (token -> expiry_ms)
vault_sessions: dict[str, int] = {}
VAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000  # 24 hours

# 7 days in milliseconds
SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

# Concurrency lock for notes.json operations
notes_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Storage Helpers
# ---------------------------------------------------------------------------

def init_storage():
    """Ensure data directories and json state files exist."""
    os.makedirs(FILES_DIR, exist_ok=True)
    if not os.path.exists(NOTES_FILE):
        _atomic_write(NOTES_FILE, [])
    if not os.path.exists(VAULT_FILE):
        _atomic_write(VAULT_FILE, {})


def _atomic_write(path: str, obj: Any):
    """Atomically write JSON to disk using a unique temporary file and fsync."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{uuid.uuid4().hex}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_notes_sync() -> list:
    """Read all notes synchronously from disk."""
    if not os.path.exists(NOTES_FILE):
        return []
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def read_vault_meta() -> dict:
    """Read vault metadata synchronously from disk."""
    if not os.path.exists(VAULT_FILE):
        return {}
    try:
        with open(VAULT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return []


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
            if note.get("trashed"):
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
            else:
                kept_notes.append(note)

        if purged_count > 0:
            _atomic_write(NOTES_FILE, kept_notes)


async def maintenance_loop():
    """Periodic maintenance loop running every hour."""
    while True:
        try:
            await prune_expired_and_trash()
        except Exception:
            pass
        await asyncio.sleep(3600)  # Check every 1 hour


# ---------------------------------------------------------------------------
# FastAPI Lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_storage()
    # Run initial cleanup on boot
    asyncio.create_task(prune_expired_and_trash())
    # Start periodic background task
    task = asyncio.create_task(maintenance_loop())
    yield
    task.cancel()


app = FastAPI(title="KeepBoard", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Request Schemas
# ---------------------------------------------------------------------------

class NoteUpdateRequest(BaseModel):
    text: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None
    trashed: Optional[bool] = None
    deleted_at: Optional[int] = None
    expires_at: Optional[int] = None
    is_vault: Optional[bool] = None
    checklist: Optional[list] = None
    tags: Optional[list] = None
    sort_order: Optional[int] = None


class BatchActionRequest(BaseModel):
    ids: List[str]
    action: str  # "pin", "unpin", "color", "archive", "unarchive", "trash", "restore", "delete_forever", "add_tag", "remove_tag", "merge"
    payload: Optional[dict] = None


class BatchDownloadRequest(BaseModel):
    ids: List[str]


class ReorderRequest(BaseModel):
    order: List[str]  # Ordered list of note IDs


class VaultSetPasswordRequest(BaseModel):
    password: str


class VaultUnlockRequest(BaseModel):
    password: str


# ---------------------------------------------------------------------------
# API: System Health & Stats
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "KeepBoard", "data_dir": DATA_DIR}


@app.get("/api/stats")
async def get_stats(x_vault_token: Optional[str] = Header(default=None)):
    """Return storage metrics, note counts, and RAM tmpfs utilization."""
    async with notes_lock:
        all_notes = read_notes_sync()

    vault_ok = _validate_vault_token(x_vault_token)
    notes_in_view = [n for n in all_notes if not n.get("is_vault") or vault_ok]

    active_count = len([n for n in notes_in_view if not n.get("trashed") and not n.get("archived")])
    archived_count = len([n for n in notes_in_view if n.get("archived") and not n.get("trashed")])
    trashed_count = len([n for n in notes_in_view if n.get("trashed")])
    vault_count = len([n for n in all_notes if n.get("is_vault")])

    total_files_bytes = 0
    total_files_count = 0
    for n in all_notes:
        for att in n.get("attachments", []):
            total_files_bytes += att.get("size", 0)
            total_files_count += 1

    return {
        "active_count": active_count,
        "archived_count": archived_count,
        "trashed_count": trashed_count,
        "vault_count": vault_count,
        "total_notes": len(all_notes),
        "total_files_count": total_files_count,
        "total_files_bytes": total_files_bytes,
        "storage_dir": DATA_DIR
    }


# ---------------------------------------------------------------------------
# API: Notes Retrieval
# ---------------------------------------------------------------------------

@app.get("/api/notes")
async def get_notes(
    view: str = Query("notes"),
    x_view: Optional[str] = Header(default=None),
    x_vault_token: Optional[str] = Header(default=None)
):
    """
    Retrieve notes based on the view filter:
    - 'notes' (default): active notes (not archived, not trashed, not vault)
    - 'archive': archived notes (not trashed, not vault)
    - 'trash': trashed notes (not vault)
    - 'vault': vault notes (strictly requires valid vault token)
    """
    active_view = x_view or view or "notes"
    vault_ok = _validate_vault_token(x_vault_token)

    async with notes_lock:
        all_notes = read_notes_sync()

    if active_view == "vault":
        if not vault_ok:
            raise HTTPException(status_code=403, detail="Vault password authentication required.")
        filtered = [n for n in all_notes if n.get("is_vault") and not n.get("trashed")]
    elif active_view == "archive":
        filtered = [n for n in all_notes if n.get("archived") and not n.get("trashed") and not n.get("is_vault")]
    elif active_view == "trash":
        filtered = [n for n in all_notes if n.get("trashed") and not n.get("is_vault")]
    else:  # 'notes' main board
        filtered = [n for n in all_notes if not n.get("archived") and not n.get("trashed") and not n.get("is_vault")]

    # Sort order: pinned first, then sort_order asc (if non-zero), then updated_at descending
    def sort_key(note):
        pinned = not bool(note.get("pinned", False))
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
    text: str = Form(""),
    color: str = Form("#1b1c1f"),
    pinned: bool = Form(False),
    archived: bool = Form(False),
    is_vault: bool = Form(False),
    expires_in: int = Form(0),  # In seconds (0 = never, 3600 = 1h, 86400 = 24h, 604800 = 7d)
    tags: str = Form("[]"),
    checklist: str = Form("[]"),
    files: List[UploadFile] = File(default=[]),
    x_vault_token: Optional[str] = Header(default=None)
):
    """Create a new note with arbitrary binary attachments and optional checklist/TTL."""
    if is_vault and not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault authentication required to create vault notes.")

    now = int(time.time() * 1000)
    note_id = uuid.uuid4().hex

    attachments = []
    for file in files:
        if file.filename:
            att = await save_uploaded_file(file)
            attachments.append(att)

    parsed_tags = []
    try:
        parsed_tags = json.loads(tags) if tags else []
    except Exception:
        parsed_tags = []

    parsed_checklist = []
    try:
        parsed_checklist = json.loads(checklist) if checklist else []
    except Exception:
        parsed_checklist = []

    expires_at = (now + expires_in * 1000) if expires_in > 0 else 0

    new_note = {
        "id": note_id,
        "text": text or "",
        "color": color or "#1b1c1f",
        "pinned": bool(pinned),
        "archived": bool(archived),
        "trashed": False,
        "deleted_at": None,
        "expires_at": expires_at,
        "is_vault": bool(is_vault),
        "checklist": parsed_checklist,
        "tags": parsed_tags,
        "attachments": attachments,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now
    }

    async with notes_lock:
        notes = read_notes_sync()
        notes.insert(0, new_note)
        _atomic_write(NOTES_FILE, notes)

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
        copy_note["created_at"] = now
        copy_note["updated_at"] = now
        # Deepcopy checklist and tags
        copy_note["checklist"] = [dict(it) for it in source.get("checklist", [])]
        copy_note["tags"] = list(source.get("tags", []))
        # Share attachments (same files on disk, or duplicate attachment records)
        copy_note["attachments"] = [dict(att) for att in source.get("attachments", [])]

        notes.insert(0, copy_note)
        _atomic_write(NOTES_FILE, notes)

    return copy_note


# ---------------------------------------------------------------------------
# API: Single Note Mutation & Restore
# ---------------------------------------------------------------------------

@app.put("/api/notes/{note_id}")
async def update_note(
    note_id: str,
    payload: NoteUpdateRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """Update fields on a note."""
    now = int(time.time() * 1000)
    async with notes_lock:
        notes = read_notes_sync()
        target = next((n for n in notes if n["id"] == note_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Note not found.")

        if (target.get("is_vault") or payload.is_vault) and not _validate_vault_token(x_vault_token):
            raise HTTPException(status_code=403, detail="Vault authentication required.")

        if payload.text is not None:
            target["text"] = payload.text
        if payload.color is not None:
            target["color"] = payload.color
        if payload.pinned is not None:
            target["pinned"] = payload.pinned
        if payload.archived is not None:
            target["archived"] = payload.archived
        if payload.trashed is not None:
            target["trashed"] = payload.trashed
            if payload.trashed:
                target["deleted_at"] = payload.deleted_at or now
                target["pinned"] = False
            else:
                target["deleted_at"] = None
        if payload.expires_at is not None:
            target["expires_at"] = payload.expires_at
        if payload.is_vault is not None:
            target["is_vault"] = payload.is_vault
            if payload.is_vault:
                target["pinned"] = False
                target["archived"] = False
        if payload.checklist is not None:
            target["checklist"] = payload.checklist
        if payload.tags is not None:
            target["tags"] = payload.tags
        if payload.sort_order is not None:
            target["sort_order"] = payload.sort_order

        target["updated_at"] = now
        _atomic_write(NOTES_FILE, notes)

    return target


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
        target["deleted_at"] = None
        target["archived"] = False
        target["updated_at"] = int(time.time() * 1000)
        _atomic_write(NOTES_FILE, notes)

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
            # Permanent purge
            for att in target.get("attachments", []):
                delete_file_on_disk(att["stored_name"])
            notes = [n for n in notes if n["id"] != note_id]
            _atomic_write(NOTES_FILE, notes)
            return {"status": "purged", "id": note_id}
        else:
            # Soft delete into Trash
            target["trashed"] = True
            target["deleted_at"] = now
            target["pinned"] = False
            target["updated_at"] = now
            _atomic_write(NOTES_FILE, notes)
            return {"status": "trashed", "id": note_id}


@app.delete("/api/trash")
async def empty_trash(x_vault_token: Optional[str] = Header(default=None)):
    """Permanently delete all notes in Trash and reclaim tmpfs RAM."""
    vault_ok = _validate_vault_token(x_vault_token)
    async with notes_lock:
        notes = read_notes_sync()
        kept_notes = []
        purged_count = 0

        for n in notes:
            if n.get("trashed"):
                if n.get("is_vault") and not vault_ok:
                    kept_notes.append(n)
                    continue
                purged_count += 1
                for att in n.get("attachments", []):
                    delete_file_on_disk(att["stored_name"])
            else:
                kept_notes.append(n)

        _atomic_write(NOTES_FILE, kept_notes)

    return {"status": "emptied", "purged_count": purged_count}


# ---------------------------------------------------------------------------
# API: Batch Operations & Card Merging
# ---------------------------------------------------------------------------

@app.post("/api/notes/batch")
async def batch_action(
    req: BatchActionRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    """
    Perform a batch operation on multiple notes atomically.
    Supported actions:
    'pin', 'unpin', 'color', 'archive', 'unarchive', 'trash', 'restore',
    'delete_forever', 'add_tag', 'remove_tag', 'merge'
    """
    vault_ok = _validate_vault_token(x_vault_token)
    now = int(time.time() * 1000)
    target_ids = set(req.ids)

    async with notes_lock:
        notes = read_notes_sync()
        matching = [n for n in notes if n["id"] in target_ids]

        # Verify vault permissions if any target is in vault
        for n in matching:
            if n.get("is_vault") and not vault_ok:
                raise HTTPException(status_code=403, detail="Vault authentication required for vault notes.")

        if req.action == "pin":
            for n in matching:
                n["pinned"] = True
                n["updated_at"] = now
        elif req.action == "unpin":
            for n in matching:
                n["pinned"] = False
                n["updated_at"] = now
        elif req.action == "color":
            new_color = (req.payload or {}).get("color", "#1b1c1f")
            for n in matching:
                n["color"] = new_color
                n["updated_at"] = now
        elif req.action == "archive":
            for n in matching:
                n["archived"] = True
                n["pinned"] = False
                n["updated_at"] = now
        elif req.action == "unarchive":
            for n in matching:
                n["archived"] = False
                n["updated_at"] = now
        elif req.action == "trash":
            for n in matching:
                n["trashed"] = True
                n["deleted_at"] = now
                n["pinned"] = False
                n["updated_at"] = now
        elif req.action == "restore":
            for n in matching:
                n["trashed"] = False
                n["deleted_at"] = None
                n["archived"] = False
                n["updated_at"] = now
        elif req.action == "delete_forever":
            for n in matching:
                for att in n.get("attachments", []):
                    delete_file_on_disk(att["stored_name"])
            notes = [n for n in notes if n["id"] not in target_ids]
            _atomic_write(NOTES_FILE, notes)
            return {"status": "deleted_forever", "count": len(matching)}
        elif req.action == "add_tag":
            tag_to_add = (req.payload or {}).get("tag", "").strip().lower()
            if tag_to_add:
                for n in matching:
                    tags = set(n.get("tags", []))
                    tags.add(tag_to_add)
                    n["tags"] = sorted(list(tags))
                    n["updated_at"] = now
        elif req.action == "remove_tag":
            tag_to_remove = (req.payload or {}).get("tag", "").strip().lower()
            if tag_to_remove:
                for n in matching:
                    n["tags"] = [t for t in n.get("tags", []) if t != tag_to_remove]
                    n["updated_at"] = now
        elif req.action == "merge":
            if len(matching) < 2:
                raise HTTPException(status_code=400, detail="At least 2 notes required to merge.")

            # Combine texts with markdown separators
            merged_texts = [n.get("text", "").strip() for n in matching if n.get("text", "").strip()]
            combined_text = "\n\n---\n\n".join(merged_texts)

            # Combine checklists
            combined_checklist = []
            for n in matching:
                combined_checklist.extend(n.get("checklist", []))

            # Combine tags
            merged_tags = set()
            for n in matching:
                for t in n.get("tags", []):
                    merged_tags.add(t)

            # Combine attachments
            merged_attachments = []
            for n in matching:
                merged_attachments.extend(n.get("attachments", []))

            # Primary note keeps the first note's color and pinned state
            primary = matching[0]
            primary["text"] = combined_text
            primary["checklist"] = combined_checklist
            primary["tags"] = sorted(list(merged_tags))
            primary["attachments"] = merged_attachments
            primary["updated_at"] = now

            # Remove secondary notes (attachments are now owned by primary)
            secondary_ids = {n["id"] for n in matching[1:]}
            notes = [n for n in notes if n["id"] not in secondary_ids]

        _atomic_write(NOTES_FILE, notes)

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
                    # Handle duplicate filenames in the zip
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

    return target


@app.get("/api/files/{attachment_id}")
async def serve_file(
    attachment_id: str,
    download: bool = Query(False),
    x_vault_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None)  # Query param support for <img>/<video> tags
):
    """
    Stream attachment file:
    - By default renders inline for images/audio/video preview.
    - If download=True: serves as Content-Disposition: attachment.
    """
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
# API: Full Backup Export & Restore
# ---------------------------------------------------------------------------

@app.get("/api/backup/export")
async def export_backup():
    """Create and stream a full zip backup containing notes.json, vault.json, and all files."""
    async with notes_lock:
        notes_data = read_notes_sync()
        vault_data = read_vault_meta()

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # Add metadata JSONs
        zf.writestr("notes.json", json.dumps(notes_data, indent=2, ensure_ascii=False))
        if vault_data:
            zf.writestr("vault.json", json.dumps(vault_data, indent=2, ensure_ascii=False))

        # Add all physical files
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
                # Restore files/
                if member.startswith("files/") and not member.endswith("/"):
                    fname = os.path.basename(member)
                    if fname:
                        out_path = os.path.join(FILES_DIR, fname)
                        with zf.open(member) as src, open(out_path, "wb") as dst:
                            shutil.copyfileobj(src, dst)

                # Restore vault.json if present and not currently configured
                elif member == "vault.json" and not os.path.exists(VAULT_FILE):
                    vault_bytes = zf.read(member)
                    with open(VAULT_FILE, "wb") as dst:
                        dst.write(vault_bytes)

            # Merge notes.json
            if "notes.json" in zf.namelist():
                raw = zf.read("notes.json").decode("utf-8")
                imported = json.loads(raw)
                for imp in imported:
                    if imp["id"] not in existing_ids:
                        existing_notes.append(imp)
                        existing_ids.add(imp["id"])
                        restored_notes_count += 1

        _atomic_write(NOTES_FILE, existing_notes)

    return {"status": "restored", "restored_notes_count": restored_notes_count, "total_notes": len(existing_notes)}


# ---------------------------------------------------------------------------
# API: Password-Protected Vault
# ---------------------------------------------------------------------------

@app.get("/api/vault/status")
async def vault_status():
    meta = read_vault_meta()
    return {"configured": bool(meta.get("password_hash"))}


@app.post("/api/vault/setup")
async def vault_setup(payload: VaultSetPasswordRequest):
    meta = read_vault_meta()
    if meta.get("password_hash"):
        raise HTTPException(status_code=409, detail="Vault password already configured.")
    if not payload.password or len(payload.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(payload.password, salt)
    _atomic_write(VAULT_FILE, {"password_hash": pw_hash, "salt": salt})
    return {"status": "configured"}


@app.post("/api/vault/unlock")
async def vault_unlock(payload: VaultUnlockRequest):
    meta = read_vault_meta()
    if not meta.get("password_hash"):
        raise HTTPException(status_code=404, detail="Vault not configured.")
    salt = meta.get("salt", "")
    candidate = _hash_password(payload.password, salt)
    if not secrets.compare_digest(candidate, meta["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect vault password.")
    token = _new_vault_token()
    vault_sessions[token] = int(time.time() * 1000) + VAULT_SESSION_TTL_MS
    return {"token": token}


@app.post("/api/vault/lock")
async def vault_lock(x_vault_token: Optional[str] = Header(default=None)):
    if x_vault_token:
        vault_sessions.pop(x_vault_token, None)
    return {"status": "locked"}


@app.post("/api/vault/change")
async def vault_change(
    payload: dict,
    x_vault_token: Optional[str] = Header(default=None)
):
    if not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault authentication required.")
    new_password = payload.get("new_password", "")
    if not new_password or len(new_password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(new_password, salt)
    _atomic_write(VAULT_FILE, {"password_hash": pw_hash, "salt": salt})
    return {"status": "changed"}


# ---------------------------------------------------------------------------
# Serve Single-Page App
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
