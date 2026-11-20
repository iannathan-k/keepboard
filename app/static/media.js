// ── KeepBoard v3: media.js ──────────────────────────────────────────────────
// Global clipboard capture, per-card dropzones, voice recorder, QR generator

export function formatDateTimeStamp() {
  const now = new Date();
  const Y = now.getFullYear();
  const M = String(now.getMonth() + 1).padStart(2, "0");
  const D = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${Y}-${M}-${D}-${h}${m}${s}`;
}

// ── Global Cmd/Ctrl+V Clipboard Capture Anywhere ────────────────────────────
export function setupGlobalPaste({ onNoteCreated, showToast, vaultHeaders }) {
  window.addEventListener("paste", async (e) => {
    const active = document.activeElement;
    const isEditing = active && (
      ["INPUT", "TEXTAREA"].includes(active.tagName) ||
      active.isContentEditable ||
      active.closest(".note-rich-editor") ||
      active.closest(".modal-backdrop")
    );
    if (isEditing) return; // Allow normal paste inside inputs/editors

    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    // 1. Check for files or clipboard screenshot
    if (clipboardData.files && clipboardData.files.length > 0) {
      e.preventDefault();
      const rawFile = clipboardData.files[0];
      let fileToUpload = rawFile;

      const isImage = rawFile.type.startsWith("image/");
      const timestamp = formatDateTimeStamp();
      const filename = isImage
        ? `screenshot-${timestamp}.png`
        : (rawFile.name || `file-${timestamp}.bin`);

      if (rawFile.name === "image.png" || isImage) {
        fileToUpload = new File([rawFile], filename, { type: rawFile.type || "image/png" });
      }

      const fd = new FormData();
      fd.append("files", fileToUpload);
      fd.append("title", isImage ? `Screenshot ${timestamp}` : filename);
      fd.append("text", isImage ? "Pasted screenshot from clipboard" : `Pasted file: ${filename}`);

      try {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: vaultHeaders(),
          body: fd
        });
        const newNote = await res.json();
        onNoteCreated(newNote);
        showToast(isImage ? "Pasted screenshot to new card" : "Pasted file to new card");
      } catch (err) {
        showToast("Error uploading pasted file: " + err.message);
      }
      return;
    }

    // 2. Check for text or code snippet
    const text = clipboardData.getData("text/plain");
    if (text && text.trim()) {
      e.preventDefault();
      const trimmed = text.trim();
      let title = "";
      if (trimmed.length > 40) {
        title = trimmed.split("\n")[0].substring(0, 40);
      }

      const fd = new FormData();
      fd.append("title", title);
      fd.append("text", trimmed);

      try {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: vaultHeaders(),
          body: fd
        });
        const newNote = await res.json();
        onNoteCreated(newNote);
        showToast("Pasted to new card");
      } catch (err) {
        showToast("Error creating card: " + err.message);
      }
    }
  });
}

// ── Per-Card File Dropzone ──────────────────────────────────────────────────
export function setupCardDropzone(cardEl, noteId, { onAttachmentsUploaded, showToast, vaultHeaders }) {
  cardEl.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      cardEl.classList.add("drop-target");
    }
  });

  cardEl.addEventListener("dragleave", () => {
    cardEl.classList.remove("drop-target");
  });

  cardEl.addEventListener("drop", async (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.remove("drop-target");

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const fd = new FormData();
      files.forEach(f => fd.append("files", f));

      try {
        const res = await fetch(`/api/notes/${noteId}/attachments`, {
          method: "POST",
          headers: vaultHeaders(),
          body: fd
        });
        const updated = await res.json();
        onAttachmentsUploaded(updated);
        showToast(`Added ${files.length} attachment(s) to card`);
      } catch (err) {
        showToast("Upload error: " + err.message);
      }
    }
  });
}

// ── Inline Audio Voice Memo Recorder ─────────────────────────────────────────
export class VoiceMemoRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.timerInterval = null;
    this.elapsedSeconds = 0;
  }

  async start({ onTick, onStop, onError }) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];
      this.elapsedSeconds = 0;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : (MediaRecorder.isTypeSupported("audio/ogg") ? "audio/ogg" : "");

      this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        clearInterval(this.timerInterval);
        if (this.stream) {
          this.stream.getTracks().forEach(t => t.stop());
        }
        const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
        const ext = (this.mediaRecorder.mimeType || "").includes("ogg") ? "ogg" : "webm";
        const filename = `voicememo-${formatDateTimeStamp()}.${ext}`;
        const file = new File([blob], filename, { type: blob.type });
        onStop(file);
      };

      this.mediaRecorder.start(250);
      this.timerInterval = setInterval(() => {
        this.elapsedSeconds++;
        const mins = Math.floor(this.elapsedSeconds / 60);
        const secs = String(this.elapsedSeconds % 60).padStart(2, "0");
        onTick(`${mins}:${secs}`);
      }, 1000);

    } catch (err) {
      if (onError) onError(err);
    }
  }

  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
  }

  cancel() {
    clearInterval(this.timerInterval);
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this.audioChunks = [];
  }
}

// ── Pure-JS SVG QR Code Generator ───────────────────────────────────────────
export function createQRCodeSVG(text, size = 200) {
  const PAD0 = 0xEC, PAD1 = 0x11;
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = EXP[i + 255] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function gexp(n) { return EXP[n]; }

  const VER_CAPS = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412];
  const utf8Bytes = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 128) utf8Bytes.push(c);
    else if (c < 2048) { utf8Bytes.push(192 | (c >> 6)); utf8Bytes.push(128 | (c & 63)); }
    else if (c < 55296 || c >= 57344) {
      utf8Bytes.push(224 | (c >> 12)); utf8Bytes.push(128 | ((c >> 6) & 63)); utf8Bytes.push(128 | (c & 63));
    } else {
      i++;
      c = 65536 + (((c & 1023) << 10) | (text.charCodeAt(i) & 1023));
      utf8Bytes.push(240 | (c >> 18)); utf8Bytes.push(128 | ((c >> 12) & 63));
      utf8Bytes.push(128 | ((c >> 6) & 63)); utf8Bytes.push(128 | (c & 63));
    }
  }

  let ver = 1;
  while (ver < VER_CAPS.length && utf8Bytes.length > VER_CAPS[ver]) ver++;
  if (ver >= VER_CAPS.length) ver = VER_CAPS.length - 1;

  const ECC_TABLE = [
    null,
    { total: 26, ec: 10, b1: 1, d1: 16 },
    { total: 44, ec: 16, b1: 1, d1: 28 },
    { total: 70, ec: 26, b1: 1, d1: 44 },
    { total: 100, ec: 18, b1: 2, d1: 32 },
    { total: 134, ec: 24, b1: 2, d1: 43 },
    { total: 172, ec: 16, b1: 4, d1: 27 },
    { total: 196, ec: 18, b1: 4, d1: 31 },
    { total: 242, ec: 22, b1: 2, d1: 38, b2: 2, d2: 39 },
    { total: 292, ec: 22, b1: 3, d1: 36, b2: 2, d2: 37 },
    { total: 346, ec: 26, b1: 4, d1: 43, b2: 1, d2: 44 },
    { total: 404, ec: 30, b1: 2, d1: 50, b2: 2, d2: 51 },
    { total: 466, ec: 22, b1: 4, d1: 36, b2: 4, d2: 37 },
    { total: 532, ec: 22, b1: 4, d1: 37, b2: 6, d2: 38 },
    { total: 581, ec: 24, b1: 3, d1: 54, b2: 4, d2: 55 },
    { total: 655, ec: 24, b1: 5, d1: 54, b2: 3, d2: 55 }
  ];

  const cfg = ECC_TABLE[ver];
  const modCount = ver * 4 + 17;

  const bits = [];
  function putBits(num, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((num >>> i) & 1);
  }
  putBits(4, 4);
  putBits(utf8Bytes.length, ver < 10 ? 8 : 16);
  for (const b of utf8Bytes) putBits(b, 8);

  const totalDataBytes = cfg.b1 * cfg.d1 + (cfg.b2 ? cfg.b2 * cfg.d2 : 0);
  const totalDataBits = totalDataBytes * 8;
  for (let i = 0; i < 4 && bits.length < totalDataBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  let padToggle = 0;
  while (bits.length < totalDataBits) {
    putBits(padToggle ? PAD1 : PAD0, 8);
    padToggle ^= 1;
  }

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }

  function rsPoly(deg) {
    let p = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        next[j] ^= gmul(p[j], gexp(i));
        next[j + 1] ^= p[j];
      }
      p = next;
    }
    return p;
  }

  function calcEC(bytes, ecCount) {
    const poly = rsPoly(ecCount);
    const res = new Uint8Array(ecCount);
    for (const b of bytes) {
      const factor = b ^ res[0];
      for (let i = 0; i < ecCount - 1; i++) {
        res[i] = res[i + 1] ^ gmul(poly[i + 1], factor);
      }
      res[ecCount - 1] = gmul(poly[ecCount], factor);
    }
    return Array.from(res);
  }

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < cfg.b1; i++) {
    const b = dataBytes.slice(offset, offset + cfg.d1);
    offset += cfg.d1;
    blocks.push({ data: b, ec: calcEC(b, cfg.ec) });
  }
  if (cfg.b2) {
    for (let i = 0; i < cfg.b2; i++) {
      const b = dataBytes.slice(offset, offset + cfg.d2);
      offset += cfg.d2;
      blocks.push({ data: b, ec: calcEC(b, cfg.ec) });
    }
  }

  const finalCodewords = [];
  const maxDataLen = Math.max(cfg.d1, cfg.d2 || 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of blocks) {
      if (i < blk.data.length) finalCodewords.push(blk.data[i]);
    }
  }
  for (let i = 0; i < cfg.ec; i++) {
    for (const blk of blocks) finalCodewords.push(blk.ec[i]);
  }

  const grid = Array.from({ length: modCount }, () => new Array(modCount).fill(null));
  const isFunction = Array.from({ length: modCount }, () => new Array(modCount).fill(false));

  function setModule(r, c, val) {
    grid[r][c] = val;
    isFunction[r][c] = true;
  }

  function placeFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const tr = row + r, tc = col + c;
        if (tr >= 0 && tr < modCount && tc >= 0 && tc < modCount) {
          const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                       (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setModule(tr, tc, dark);
        }
      }
    }
  }
  placeFinder(0, 0);
  placeFinder(0, modCount - 7);
  placeFinder(modCount - 7, 0);

  for (let i = 8; i < modCount - 8; i++) {
    if (!isFunction[6][i]) setModule(6, i, i % 2 === 0);
    if (!isFunction[i][6]) setModule(i, 6, i % 2 === 0);
  }

  const ALIGN_POS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]
  ];
  const apos = ALIGN_POS[ver] || [];
  for (let i = 0; i < apos.length; i++) {
    for (let j = 0; j < apos.length; j++) {
      const ar = apos[i], ac = apos[j];
      if (isFunction[ar][ac]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          setModule(ar + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }
  setModule(modCount - 8, 8, true);

  for (let i = 0; i < 9; i++) {
    if (i !== 6) { isFunction[8][i] = true; isFunction[i][8] = true; }
  }
  for (let i = modCount - 8; i < modCount; i++) {
    isFunction[8][i] = true;
    isFunction[i][8] = true;
  }

  const dataBits = [];
  for (const cw of finalCodewords) {
    for (let i = 7; i >= 0; i--) dataBits.push((cw >>> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let c = modCount - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    const rows = upward ? Array.from({ length: modCount }, (_, i) => modCount - 1 - i)
                        : Array.from({ length: modCount }, (_, i) => i);
    for (const r of rows) {
      for (const col of [c, c - 1]) {
        if (!isFunction[r][col]) {
          const bit = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
          const mask = ((r + col) % 2 === 0);
          grid[r][col] = (bit ^ (mask ? 1 : 0)) === 1;
        }
      }
    }
    upward = !upward;
  }

  const formatBits = [1,0,1,0,1,0,0,0,0,0,1,0,0,1,0];
  const fi1 = [
    [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
    [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
  ];
  const fi2 = [
    [modCount-1,8],[modCount-2,8],[modCount-3,8],[modCount-4,8],[modCount-5,8],[modCount-6,8],[modCount-7,8],
    [8,modCount-8],[8,modCount-7],[8,modCount-6],[8,modCount-5],[8,modCount-4],[8,modCount-3],[8,modCount-2],[8,modCount-1]
  ];
  for (let i = 0; i < 15; i++) {
    grid[fi1[i][0]][fi1[i][1]] = formatBits[i] === 1;
    grid[fi2[i][0]][fi2[i][1]] = formatBits[i] === 1;
  }

  const quiet = 4;
  const totalDim = modCount + quiet * 2;
  let path = "";
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (grid[r][c]) {
        path += `M${c + quiet},${r + quiet}h1v1h-1z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDim} ${totalDim}" width="${size}" height="${size}" shape-rendering="crispEdges">
    <rect width="${totalDim}" height="${totalDim}" fill="#ffffff" rx="10" />
    <path d="${path.trim()}" fill="#000000" />
  </svg>`;
}
