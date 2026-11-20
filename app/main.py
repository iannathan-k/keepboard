import os
import re
import json
import uuid
import time
import hashlib
import asyncio
import secrets
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Header, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_DIR = os.getenv("DATA_DIR", "/data")
FILES_DIR = os.path.join(DATA_DIR, "files")
NOTES_FILE = os.path.join(DATA_DIR, "notes.json")
VAULT_FILE = os.path.join(DATA_DIR, "vault.json")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# In-memory vault session tokens (token -> expiry_ms). Cleared on restart
# (intentional: tmpfs reboot = new session).
vault_sessions: dict[str, int] = {}
VAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000  # 24 h

notes_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def init_storage():
    os.makedirs(FILES_DIR, exist_ok=True)
    if not os.path.exists(NOTES_FILE):
        _atomic_write(NOTES_FILE, [])
    if not os.path.exists(VAULT_FILE):
        _atomic_write(VAULT_FILE, {})


def _atomic_write(path: str, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{uuid.uuid4().hex}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_notes_sync() -> list:
    if not os.path.exists(NOTES_FILE):
        return []
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def read_vault_meta() -> dict:
    if not os.path.exists(VAULT_FILE):
        return {}
    try:
        with open(VAULT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# File upload helpers
# ---------------------------------------------------------------------------

async def save_uploaded_file(upload_file: UploadFile) -> dict:
    att_id = uuid.uuid4().hex
    orig_filename = upload_file.filename or "attachment.bin"
    safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', os.path.basename(orig_filename))
    stored_name = f"{att_id}_{safe_name}"
    file_path = os.path.join(FILES_DIR, stored_name)
    total_size = 0
    with open(file_path, "wb") as f:
        while True:
            chunk = await upload_file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            total_size += len(chunk)
    return {
        "id": att_id,
        "filename": orig_filename,
        "stored_name": stored_name,
        "size": total_size,
        "created_at": int(time.time() * 1000)
    }


def delete_file_on_disk(stored_name: str):
    path = os.path.join(FILES_DIR, stored_name)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Vault helpers
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


def _validate_vault_token(token: str | None) -> bool:
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
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_storage()
    yield


app = FastAPI(title="RAM Scratchpad", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class NoteUpdateRequest(BaseModel):
    text: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None
    is_vault: Optional[bool] = None
    checklist: Optional[list] = None   # [{text, checked}]
    tags: Optional[list] = None        # [str]


class VaultSetPasswordRequest(BaseModel):
    password: str


class VaultUnlockRequest(BaseModel):
    password: str


# ---------------------------------------------------------------------------
# API: Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health_check():
    async with notes_lock:
        notes = read_notes_sync()
    return {"status": "healthy", "data_dir": DATA_DIR, "notes_count": len(notes)}


# ---------------------------------------------------------------------------
# API: Notes
# ---------------------------------------------------------------------------

@app.get("/api/notes")
async def get_notes(x_vault_token: Optional[str] = Header(default=None)):
    """
    Returns notes for the main board (archived=False, is_vault=False).
    Vault notes are excluded unless a valid vault token is supplied —
    in which case ONLY vault notes are returned (for the Vault view).
    """
    async with notes_lock:
        all_notes = read_notes_sync()

    vault_ok = _validate_vault_token(x_vault_token)

    if vault_ok:
        # Vault view: return only vault notes
        filtered = [n for n in all_notes if n.get("is_vault")]
    else:
        # Main board / archive: exclude vault notes entirely
        filtered = [n for n in all_notes if not n.get("is_vault")]

    filtered.sort(key=lambda n: (not n.get("pinned", False), -n.get("updated_at", 0)))
    return filtered


@app.post("/api/notes")
async def create_note(
    text: str = Form(""),
    color: str = Form("#1e1f22"),
    pinned: bool = Form(False),
    is_vault: bool = Form(False),
    tags: str = Form(""),           # JSON array string e.g. '["work","todo"]'
    files: List[UploadFile] = File(default=[]),
    x_vault_token: Optional[str] = Header(default=None)
):
    # Creating vault notes requires a valid vault token
    if is_vault and not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault token required")

    now = int(time.time() * 1000)
    note_id = uuid.uuid4().hex

    attachments = []
    for file in files:
        if file.filename:
            attachments.append(await save_uploaded_file(file))

    parsed_tags = []
    if tags:
        try:
            parsed_tags = json.loads(tags)
        except Exception:
            parsed_tags = []

    new_note = {
        "id": note_id,
        "text": text or "",
        "color": color or "#1e1f22",
        "pinned": bool(pinned),
        "archived": False,
        "is_vault": bool(is_vault),
        "checklist": [],
        "tags": parsed_tags,
        "attachments": attachments,
        "created_at": now,
        "updated_at": now
    }

    async with notes_lock:
        notes = read_notes_sync()
        notes.insert(0, new_note)
        _atomic_write(NOTES_FILE, notes)

    return new_note


@app.put("/api/notes/{note_id}")
async def update_note(
    note_id: str,
    payload: NoteUpdateRequest,
    x_vault_token: Optional[str] = Header(default=None)
):
    async with notes_lock:
        notes = read_notes_sync()
        target = None

        for n in notes:
            if n["id"] == note_id:
                # Vault note mutations require token
                if n.get("is_vault") and not _validate_vault_token(x_vault_token):
                    raise HTTPException(status_code=403, detail="Vault token required")
                # Moving into vault requires token
                if payload.is_vault and not _validate_vault_token(x_vault_token):
                    raise HTTPException(status_code=403, detail="Vault token required")

                if payload.text is not None:
                    n["text"] = payload.text
                if payload.color is not None:
                    n["color"] = payload.color
                if payload.pinned is not None:
                    n["pinned"] = payload.pinned
                if payload.archived is not None:
                    n["archived"] = payload.archived
                if payload.is_vault is not None:
                    n["is_vault"] = payload.is_vault
                    if payload.is_vault:          # moving to vault: unpin & unarchive
                        n["pinned"] = False
                        n["archived"] = False
                if payload.checklist is not None:
                    n["checklist"] = payload.checklist
                if payload.tags is not None:
                    n["tags"] = payload.tags

                n["updated_at"] = int(time.time() * 1000)
                target = n
                break

        if not target:
            raise HTTPException(status_code=404, detail="Note not found")

        _atomic_write(NOTES_FILE, notes)
        return target


@app.delete("/api/notes/{note_id}")
async def delete_note(
    note_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    async with notes_lock:
        notes = read_notes_sync()
        target = None
        new_notes = []

        for n in notes:
            if n["id"] == note_id:
                if n.get("is_vault") and not _validate_vault_token(x_vault_token):
                    raise HTTPException(status_code=403, detail="Vault token required")
                target = n
            else:
                new_notes.append(n)

        if not target:
            raise HTTPException(status_code=404, detail="Note not found")

        for att in target.get("attachments", []):
            delete_file_on_disk(att["stored_name"])

        _atomic_write(NOTES_FILE, new_notes)

    return {"status": "deleted", "id": note_id}


# ---------------------------------------------------------------------------
# API: Attachments
# ---------------------------------------------------------------------------

@app.post("/api/notes/{note_id}/attachments")
async def add_attachments(
    note_id: str,
    files: List[UploadFile] = File(...),
    x_vault_token: Optional[str] = Header(default=None)
):
    uploaded = []
    for file in files:
        if file.filename:
            uploaded.append(await save_uploaded_file(file))

    async with notes_lock:
        notes = read_notes_sync()
        target = None
        for n in notes:
            if n["id"] == note_id:
                if n.get("is_vault") and not _validate_vault_token(x_vault_token):
                    for att in uploaded:
                        delete_file_on_disk(att["stored_name"])
                    raise HTTPException(status_code=403, detail="Vault token required")
                n.setdefault("attachments", []).extend(uploaded)
                n["updated_at"] = int(time.time() * 1000)
                target = n
                break

        if not target:
            for att in uploaded:
                delete_file_on_disk(att["stored_name"])
            raise HTTPException(status_code=404, detail="Note not found")

        _atomic_write(NOTES_FILE, notes)

    return target


@app.delete("/api/notes/{note_id}/attachments/{attachment_id}")
async def delete_attachment(
    note_id: str,
    attachment_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    async with notes_lock:
        notes = read_notes_sync()
        target = None
        to_delete = None

        for n in notes:
            if n["id"] == note_id:
                if n.get("is_vault") and not _validate_vault_token(x_vault_token):
                    raise HTTPException(status_code=403, detail="Vault token required")
                target = n
                new_atts = []
                for att in n.get("attachments", []):
                    if att["id"] == attachment_id:
                        to_delete = att["stored_name"]
                    else:
                        new_atts.append(att)
                n["attachments"] = new_atts
                n["updated_at"] = int(time.time() * 1000)
                break

        if not target:
            raise HTTPException(status_code=404, detail="Note not found")

        if to_delete:
            delete_file_on_disk(to_delete)

        _atomic_write(NOTES_FILE, notes)

    return target


@app.get("/api/files/{attachment_id}")
async def download_file(
    attachment_id: str,
    x_vault_token: Optional[str] = Header(default=None)
):
    async with notes_lock:
        notes = read_notes_sync()

    target_att = None
    is_vault_att = False
    for n in notes:
        for att in n.get("attachments", []):
            if att["id"] == attachment_id:
                target_att = att
                is_vault_att = bool(n.get("is_vault"))
                break
        if target_att:
            break

    if not target_att:
        raise HTTPException(status_code=404, detail="Attachment not found")

    if is_vault_att and not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault token required")

    file_path = os.path.join(FILES_DIR, target_att["stored_name"])
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File missing on disk")

    return FileResponse(
        path=file_path,
        filename=target_att["filename"],
        media_type="application/octet-stream"
    )


# ---------------------------------------------------------------------------
# API: Vault management
# ---------------------------------------------------------------------------

@app.get("/api/vault/status")
async def vault_status():
    meta = read_vault_meta()
    return {"configured": bool(meta.get("password_hash"))}


@app.post("/api/vault/setup")
async def vault_setup(payload: VaultSetPasswordRequest):
    meta = read_vault_meta()
    if meta.get("password_hash"):
        raise HTTPException(status_code=409, detail="Vault password already set. Use /api/vault/change.")
    if not payload.password or len(payload.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(payload.password, salt)
    _atomic_write(VAULT_FILE, {"password_hash": pw_hash, "salt": salt})
    return {"status": "configured"}


@app.post("/api/vault/change")
async def vault_change(
    payload: dict,
    x_vault_token: Optional[str] = Header(default=None)
):
    if not _validate_vault_token(x_vault_token):
        raise HTTPException(status_code=403, detail="Vault token required")
    new_password = payload.get("new_password", "")
    if not new_password or len(new_password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(new_password, salt)
    _atomic_write(VAULT_FILE, {"password_hash": pw_hash, "salt": salt})
    return {"status": "changed"}


@app.post("/api/vault/unlock")
async def vault_unlock(payload: VaultUnlockRequest):
    meta = read_vault_meta()
    if not meta.get("password_hash"):
        raise HTTPException(status_code=404, detail="Vault not configured.")
    salt = meta["salt"]
    candidate = _hash_password(payload.password, salt)
    if not secrets.compare_digest(candidate, meta["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong password.")
    token = _new_vault_token()
    vault_sessions[token] = int(time.time() * 1000) + VAULT_SESSION_TTL_MS
    return {"token": token}


@app.post("/api/vault/lock")
async def vault_lock(x_vault_token: Optional[str] = Header(default=None)):
    if x_vault_token:
        vault_sessions.pop(x_vault_token, None)
    return {"status": "locked"}


# ---------------------------------------------------------------------------
# Serve SPA
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
