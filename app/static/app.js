// ── KeepBoard v3: app.js ───────────────────────────────────────────────────
// Core state management, API client, live SSE sync, compact grid, search flairs,
// multi-select batch bar, parking lot, split workspace, and command palette.

import {
  formatDoc,
  formatHighlight,
  formatInlineCode,
  applyTextStyle,
  setupCleanPaste,
  setupInlineMath,
  setupSmartTyping,
  extractDocumentOutline,
  calculateChecklistProgress,
  uncheckAllItems,
  deleteCheckedItems,
  renderChecklistEditor,
  convertTextToChecklist,
  convertChecklistToText,
} from "./editor.js";

import {
  formatDateTimeStamp,
  setupGlobalPaste,
  setupGlobalDragDrop,
  setupCardDropzone,
  createQRCodeSVG,
  initMedia,
} from "./media.js";

// ── Universal Clipboard Copy Helper with HTTP/Insecure Context Fallback ──────
export async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fall through to fallback
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(ta);
    return successful;
  } catch (err) {
    console.error("Failed to copy using fallback:", err);
    return false;
  }
}

// Prevent default browser file-drop behavior (navigation/preview) globally immediately on module load
if (typeof window !== "undefined") {
  const preventNav = (e) => {
    if (e.dataTransfer && e.dataTransfer.types && (e.dataTransfer.types.includes("Files") || Array.from(e.dataTransfer.types).includes("Files"))) {
      e.preventDefault();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "copy";
    }
  };
  window.addEventListener("dragover", preventNav, false);
  document.addEventListener("dragover", preventNav, false);
  window.addEventListener("drop", preventNav, false);
  document.addEventListener("drop", preventNav, false);
}

// ── Classic Google Keep Dark Palette (Palette A2) ──────────────────────────
const PALETTES = {
  default: { bg: "#202124", border: "#3C4043" },
  amber:   { bg: "#3C3219", border: "#614F23" },
  coral:   { bg: "#422220", border: "#6B3532" },
  sage:    { bg: "#1F3529", border: "#315742" },
  teal:    { bg: "#1B3538", border: "#2B565C" },
  cobalt:  { bg: "#1E2E42", border: "#304B6E" },
  plum:    { bg: "#31233E", border: "#513866" },
  rose:    { bg: "#3D2232", border: "#633550" },
};

const LEGACY_COLOR_MAP = {
  peach: "amber",
  sand: "amber",
  mint: "teal",
  fog: "cobalt",
  dusk: "plum",
  blush: "rose",
  "#1b1c1f": "default",
  "#202124": "default",
  "#483220": "amber",
  "#443e22": "amber",
  "#3c3219": "amber",
  "#4a2424": "coral",
  "#422220": "coral",
  "#1e3d34": "teal",
  "#1b3538": "teal",
  "#233d2c": "sage",
  "#1f3529": "sage",
  "#203445": "cobalt",
  "#1e2e42": "cobalt",
  "#332948": "plum",
  "#31233e": "plum",
  "#422238": "rose",
  "#3d2232": "rose",
};

function normalizeColorName(c) {
  if (!c) return "default";
  const lower = String(c).trim().toLowerCase();
  if (PALETTES[lower]) return lower;
  if (LEGACY_COLOR_MAP[lower]) return LEGACY_COLOR_MAP[lower];
  return "default";
}

function paletteFor(color) {
  const name = normalizeColorName(color);
  const pal = PALETTES[name] || PALETTES.default;
  return {
    name,
    bg: pal.bg,
    border: pal.border,
    toString() { return pal.bg; },
    valueOf() { return pal.bg; },
  };
}

// ── Application State ──────────────────────────────────────────────────────
let allNotes = [];
let allWorkspaces = [{ id: "default", name: "Personal" }];
let currentWorkspaceId = localStorage.getItem("keepboard_active_workspace") || "default";
let currentNavView = "notes"; // "notes" | "archive" | "trash" | "vault"
let selectedNoteIds = new Set();
let activeSearchFlairs = new Set(); // e.g. "has:files", "is:checklist", "color:coral", "#work"
let searchQuery = "";
let gridDensity = localStorage.getItem("keepboard_density") || "standard"; // "standard" | "compact" | "list"

let vaultToken = sessionStorage.getItem("keepboard_vault_token") || null;
let vaultConfigured = false;
let vaultUnlocked = Boolean(vaultToken);

let currentEditingNoteId = null;
let modal2NoteId = null;
let modal2ChecklistItems = [];
let modal2SaveTimer = null;
let currentTagCallback = null;
let archivePeekFiles = [];
let archivePeekAttachmentId = null;
let archivePeekFilename = "";

// Composer pending state
let composerPendingFiles = [];
let composerTags = new Set();
let composerChecklistItems = [];
let composerIsChecklist = false;
let composerColor = "default";
let composerIsPinned = false;
let composerTTL = "";
let composerRawMode = false;

// Modal pending state
let modalRawMode = false;
let modalChecklistItems = [];
let modalPendingFiles = [];
let modalTags = new Set();
let modalColor = "default";
let modalIsPinned = false;

// ── DOM References ─────────────────────────────────────────────────────────
const dropOverlay = document.getElementById("drop-overlay");
const dropOverlayHint = document.getElementById("drop-overlay-hint");
const mainHeader = document.getElementById("main-header");
const menuToggleBtn = document.getElementById("menu-toggle-btn");
const searchInput = document.getElementById("search-input");
const searchHint = document.getElementById("search-hint");
const searchClearBtn = document.getElementById("search-clear-btn");
const searchActiveFlairsContainer = document.getElementById("search-active-flairs");
const searchFlairsPopover = document.getElementById("search-flairs-popover");
const searchFlairTagsContainer = document.getElementById("search-flair-tags-container");
const searchFlairTags = document.getElementById("search-flair-tags");

const densityToggleBtn = document.getElementById("density-toggle-btn");
const densityIcon = document.getElementById("density-icon");
const headerCliBtn = document.getElementById("header-cli-btn");
const ramPill = document.getElementById("ram-pill");
const ramUsageText = document.getElementById("ram-usage-text");
const sidebarRamPill = document.getElementById("sidebar-ram-pill");
const sidebarRamText = document.getElementById("sidebar-ram-text");
const sidebarRamFill = document.getElementById("sidebar-ram-fill");
const storageInspectorBackdrop = document.getElementById("storage-inspector-backdrop");
const storageInspectorCloseBtn = document.getElementById("storage-inspector-close-btn");
const storageInspectorBody = document.getElementById("storage-inspector-body");

const selectionBar = document.getElementById("selection-bar");
const selClearBtn = document.getElementById("sel-clear-btn");
const selCountText = document.getElementById("sel-count-text");
const selSelectAllBtn = document.getElementById("sel-select-all-btn");
const batchPinBtn = document.getElementById("batch-pin-btn");
const batchColorBtn = document.getElementById("batch-color-btn");
const batchColorPopover = document.getElementById("batch-color-popover");
const batchTagBtn = document.getElementById("batch-tag-btn");
const batchWorkspaceBtn = document.getElementById("batch-workspace-btn");
const batchWorkspacePopover = document.getElementById("batch-workspace-popover");
const batchArchiveBtn = document.getElementById("batch-archive-btn");
const batchMergeBtn = document.getElementById("batch-merge-btn");
const batchDownloadBtn = document.getElementById("batch-download-btn");
const batchTrashBtn = document.getElementById("batch-trash-btn");
const batchRestoreBtn = document.getElementById("batch-restore-btn");

const sidebar = document.getElementById("sidebar");
const workspacePillBtn = document.getElementById("workspace-pill-btn");
const workspaceCurrentLabel = document.getElementById("workspace-current-label");
const workspaceDropdown = document.getElementById("workspace-dropdown");
const workspaceItemsList = document.getElementById("workspace-items-list");
const workspaceCreateBtn = document.getElementById("workspace-create-btn");

const navNotes = document.getElementById("nav-notes");
const navArchive = document.getElementById("nav-archive");
const navTrash = document.getElementById("nav-trash");
const navVault = document.getElementById("nav-vault");
const vaultNavIcon = document.getElementById("vault-nav-icon");
const vaultNavText = document.getElementById("vault-nav-text");
const sidebarTagsList = document.getElementById("sidebar-tags-list");
const btnExportBackup = document.getElementById("btn-export-backup");
const btnImportBackup = document.getElementById("btn-import-backup");
const backupFileInput = document.getElementById("backup-file-input");

const mainContent = document.getElementById("main-content");
const trashBanner = document.getElementById("trash-banner");
const emptyTrashBtn = document.getElementById("empty-trash-btn");
const vaultSetupBanner = document.getElementById("vault-setup-banner");
const vaultSetupBtn = document.getElementById("vault-setup-btn");
const vaultLockedBanner = document.getElementById("vault-locked-banner");
const vaultUnlockBtn = document.getElementById("vault-unlock-btn");
const vaultUnlockedToolbar = document.getElementById("vault-unlocked-toolbar");
const vaultLockBtn = document.getElementById("vault-lock-btn");

const composerContainer = document.getElementById("composer-container");
const captureBox = document.getElementById("capture-box");
const captureCollapsed = document.getElementById("capture-collapsed");
const quickChecklistBtn = document.getElementById("quick-checklist-btn");
const quickAttachBtn = document.getElementById("quick-attach-btn");
const captureExpanded = document.getElementById("capture-expanded");
const composerTitleInput = document.getElementById("composer-title-input");
const composerFmtToolbar = document.getElementById("composer-fmt-toolbar");
const composerRichEditor = document.getElementById("composer-rich-editor");
const composerRawTextarea = document.getElementById("composer-raw-textarea");
const composerChecklistContainer = document.getElementById("composer-checklist-container");
const composerAttachmentsPreview = document.getElementById("composer-attachments-preview");
const composerTagsPreview = document.getElementById("composer-tags-preview");

const composerFmtToggleBtn = document.getElementById("composer-fmt-toggle-btn");
const composerRawToggleBtn = document.getElementById("composer-raw-toggle-btn");
const composerColorBtn = document.getElementById("composer-color-btn");
const composerColorPopover = document.getElementById("composer-color-popover");
const composerChecklistToggleBtn = document.getElementById("composer-checklist-toggle-btn");
const composerAttachBtn = document.getElementById("composer-attach-btn");
const composerPinBtn = document.getElementById("composer-pin-btn");
const composerTagBtn = document.getElementById("composer-tag-btn");
const composerTTLSelect = document.getElementById("composer-ttl-select");
const composerSaveBtn = document.getElementById("composer-save-btn");
const composerCloseBtn = document.getElementById("composer-close-btn");

const notesGridRoot = document.getElementById("notes-grid-root");
const pinnedSection = document.getElementById("pinned-section");
const pinnedGrid = document.getElementById("pinned-grid");
const othersSection = document.getElementById("others-section");
const othersTitle = document.getElementById("others-title");
const othersGrid = document.getElementById("others-grid");
const emptyState = document.getElementById("empty-state");
const emptyTitle = document.getElementById("empty-title");
const emptySubtitle = document.getElementById("empty-subtitle");

const composerFileInput = document.getElementById("composer-file-input");
const modalFileInput = document.getElementById("modal-file-input");
const cardActionFileInput = document.getElementById("card-action-file-input");

// Modals
const editModalBackdrop = document.getElementById("edit-modal-backdrop");
const editModalCard = document.getElementById("edit-modal-card");
const modalOutlineRail = document.getElementById("modal-outline-rail");
const modalOutlineItems = document.getElementById("modal-outline-items");
const modalOutlineToggleBtn = document.getElementById("modal-outline-toggle-btn");
const modalBesideBtn = document.getElementById("modal-beside-btn");
const modalHeaderCloseBtn = document.getElementById("modal-header-close-btn");
const modalTitleInput = document.getElementById("modal-title-input");
const modalPinBtn = document.getElementById("modal-pin-btn");
const modalTagsContainer = document.getElementById("modal-tags-container");
const modalFmtToolbar = document.getElementById("modal-fmt-toolbar");
const modalRichEditor = document.getElementById("modal-rich-editor");
const modalRawTextarea = document.getElementById("modal-raw-textarea");
const modalChecklistContainer = document.getElementById("modal-checklist-container");
const modalAttachmentsList = document.getElementById("modal-attachments-list");
const modalFmtToggleBtn = document.getElementById("modal-fmt-toggle-btn");
const modalChecklistBtn = document.getElementById("modal-checklist-btn");
const modalRawToggleBtn = document.getElementById("modal-raw-toggle-btn");
const modalColorBtn = document.getElementById("modal-color-btn");
const modalColorPopover = document.getElementById("modal-color-popover");
const modalAttachBtn = document.getElementById("modal-attach-btn");
const modalShieldBtn = document.getElementById("modal-shield-btn");
const modalVaultBtn = document.getElementById("modal-vault-btn");
const modalTagBtn = document.getElementById("modal-tag-btn");
const modalWorkspaceBtn = document.getElementById("modal-workspace-btn");
const modalWorkspacePopover = document.getElementById("modal-workspace-popover");
const modalSplitBtn = document.getElementById("modal-split-btn");
const modalQrBtn = document.getElementById("modal-qr-btn");
const modalDuplicateBtn = document.getElementById("modal-duplicate-btn");
const modalArchiveBtn = document.getElementById("modal-archive-btn");
const modalTrashBtn = document.getElementById("modal-trash-btn");
const modalCloseBtn = document.getElementById("modal-close-btn");

// Side-by-Side Dual Note Secondary Pane
const modalPanePrimary = document.getElementById("modal-pane-primary");
const modalPaneSecondary = document.getElementById("modal-pane-secondary");
const modal2CloseBtn = document.getElementById("modal2-close-btn");
const modal2ChangeBtn = document.getElementById("modal2-change-btn");
const modal2Picker = document.getElementById("modal2-picker");
const modal2Search = document.getElementById("modal2-search");
const modal2List = document.getElementById("modal2-list");
const modal2Editor = document.getElementById("modal2-editor");
const modal2TitleInput = document.getElementById("modal2-title-input");
const modal2RichEditor = document.getElementById("modal2-rich-editor");
const modal2ChecklistContainer = document.getElementById("modal2-checklist-container");
const modal2AttachmentsList = document.getElementById("modal2-attachments-list");

const cmdPaletteBackdrop = document.getElementById("cmd-palette-backdrop");
const cmdPaletteInput = document.getElementById("cmd-palette-input");
const cmdPaletteList = document.getElementById("cmd-palette-list");

const cliModalBackdrop = document.getElementById("cli-modal-backdrop");
const cliCloseBtn = document.getElementById("cli-close-btn");
const cliDoneBtn = document.getElementById("cli-done-btn");
const cliCopy1 = document.getElementById("cli-copy-1");
const cliSnippet1 = document.getElementById("cli-snippet-1");
const cliCopy2 = document.getElementById("cli-copy-2");
const cliSnippet2 = document.getElementById("cli-snippet-2");
const cliCopy3 = document.getElementById("cli-copy-3");
const cliSnippet3 = document.getElementById("cli-snippet-3");

const qrModalBackdrop = document.getElementById("qr-modal-backdrop");
const qrModalTitle = document.getElementById("qr-modal-title");
const qrCodeSvgContainer = document.getElementById("qr-code-svg-container");
const qrModalUrlText = document.getElementById("qr-modal-url-text");
const qrCopyBtn = document.getElementById("qr-copy-btn");
const qrCloseBtn = document.getElementById("qr-close-btn");

const archivePeekBackdrop = document.getElementById("archive-peek-backdrop");
const archivePeekTitle = document.getElementById("archive-peek-title");
const archivePeekMeta = document.getElementById("archive-peek-meta");
const archiveFilterInput = document.getElementById("archive-filter-input");
const archivePeekTbody = document.getElementById("archive-peek-tbody");
const archivePeekCloseBtn = document.getElementById("archive-peek-close-btn");
const archivePeekDoneBtn = document.getElementById("archive-peek-done-btn");

const vaultModalBackdrop = document.getElementById("vault-modal-backdrop");
const vaultModalTitle = document.getElementById("vault-modal-title");
const vaultModalDesc = document.getElementById("vault-modal-desc");
const vaultModalPassword = document.getElementById("vault-modal-password");
const vaultModalError = document.getElementById("vault-modal-error");
const vaultModalCancelBtn = document.getElementById("vault-modal-cancel-btn");
const vaultModalSubmitBtn = document.getElementById("vault-modal-submit-btn");

const tagPromptBackdrop = document.getElementById("tag-prompt-backdrop");
const tagPromptInput = document.getElementById("tag-prompt-input");
const tagPromptCancelBtn = document.getElementById("tag-prompt-cancel-btn");
const tagPromptOkBtn = document.getElementById("tag-prompt-ok-btn");

const toastContainer = document.getElementById("toast-container");

// ── Utility Functions ──────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message, undoCallback = null) {
  const toast = document.createElement("div");
  toast.className = "toast";
  const msgSpan = document.createElement("span");
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  if (undoCallback) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "toast-undo-btn";
    undoBtn.textContent = "Undo";
    undoBtn.onclick = () => {
      undoCallback();
      toast.remove();
    };
    toast.appendChild(undoBtn);
  }

  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = "opacity 0.3s, transform 0.3s";
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 320);
  }, 3500);
}

function vaultHeaders() {
  const h = {};
  if (vaultToken) {
    h["X-Vault-Token"] = vaultToken;
  }
  return h;
}

function isMediaFile(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "m4a", "webm"].includes(ext)) return "audio";
  return null;
}

function isArchiveFile(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  return ["zip", "tar", "gz", "tgz"].includes(ext);
}

// ── Swatch Picker Renderer ─────────────────────────────────────────────────
function renderSwatches(container, onSelect, currentSelected = "default") {
  container.innerHTML = "";
  const curNorm = normalizeColorName(currentSelected);
  Object.keys(PALETTES).forEach((c) => {
    const circle = document.createElement("div");
    circle.className = `color-swatch-circle ${c === curNorm ? "selected" : ""}`;
    circle.style.backgroundColor = PALETTES[c].bg;
    circle.style.border = `1.5px solid ${PALETTES[c].border}`;
    circle.title = c.charAt(0).toUpperCase() + c.slice(1);
    circle.onclick = (e) => {
      e.stopPropagation();
      onSelect(c);
      container.classList.remove("show");
    };
    container.appendChild(circle);
  });
}

// ── Markdown Exporter ──────────────────────────────────────────────────────
function exportNoteMarkdown(note) {
  let md = "";
  if (note.title) {
    md += `# ${note.title}\n\n`;
  }
  if (note.tags && Array.isArray(note.tags) && note.tags.length > 0) {
    md += `Tags: ${note.tags.map((t) => (t.startsWith("#") ? t : "#" + t)).join(" ")}\n\n`;
  }
  if (note.checklist && Array.isArray(note.checklist) && note.checklist.length > 0) {
    note.checklist.forEach((it) => {
      const indent = "  ".repeat(it.indent || 0);
      md += `${indent}- [${it.checked ? "x" : " "}] ${it.text || ""}\n`;
    });
    md += "\n";
  }
  if (note.content) {
    const cleanContent = (note.content || "")
      .replace(/<br\s*[\/]?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
      .replace(/<[^>]+>/g, "");
    md += cleanContent.trim() + "\n";
  }

  const safeTitle = (note.title ? note.title.trim().replace(/[^a-zA-Z0-9_-]+/g, "_") : `note_${(note.id || "export").substring(0, 8)}`) + ".md";
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeTitle;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${safeTitle}`);
}

// ── Storage Status Badge Helper ────────────────────────────────────────────
function updateStorageBadge(badgeEl, isDisk) {
  if (!badgeEl) return;
  if (isDisk) {
    badgeEl.className = "storage-status-badge disk";
    badgeEl.innerHTML = `<svg style="width:12px;height:12px;fill:currentColor;" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg> Persisted to Disk`;
  } else {
    badgeEl.className = "storage-status-badge ram";
    badgeEl.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block;"></span> Saved to RAM`;
  }
}

// ── Lightweight Monotonic Cross-Device Auto-Sync (<30 bytes, 0.00% Idle CPU) ─
let clientSyncRevision = null;
let syncPollInterval = null;

async function checkSync() {
  if (document.hidden) return;
  const isModalOpen = editModalBackdrop && editModalBackdrop.style.display === "flex";
  const isComposerActive = captureExpanded && captureExpanded.style.display === "flex";

  try {
    const res = await fetch("/api/sync-token", { headers: vaultHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.revision === "number") {
      if (clientSyncRevision === null) {
        clientSyncRevision = data.revision;
      } else if (data.revision > clientSyncRevision) {
        clientSyncRevision = data.revision;
        // Re-fetch notes only if user is not actively editing inside modal or expanded composer
        if (!isModalOpen && !isComposerActive) {
          await loadNotes(false);
          await updateStats();
        }
      }
    }
  } catch (err) {
    // Ignore transient network blips
  }
}

function startAutoSync() {
  stopAutoSync();
  syncPollInterval = setInterval(checkSync, 20000);
}

function stopAutoSync() {
  if (syncPollInterval) {
    clearInterval(syncPollInterval);
    syncPollInterval = null;
  }
}

function initLiveSync() {
  startAutoSync();

  // Pause completely when tab is hidden to achieve 0.00% idle CPU; resume and check immediately on focus
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopAutoSync();
    } else {
      checkSync();
      startAutoSync();
    }
  });

  window.addEventListener("focus", () => {
    if (!document.hidden) {
      checkSync();
    }
  });
}

// ── Grid Density Switcher ──────────────────────────────────────────────────
function applyGridDensity(density) {
  gridDensity = density;
  localStorage.setItem("keepboard_density", density);

  notesGridRoot.classList.remove("density-standard", "density-compact", "density-list");
  notesGridRoot.classList.add(`density-${density}`);

  if (density === "compact") {
    densityToggleBtn.title = "Grid Density: Compact (Click for List)";
    densityIcon.innerHTML = `<path d="M3 3h4v4H3zm6 0h4v4H9zm6 0h4v4h-4zM3 9h4v4H3zm6 0h4v4H9zm6 0h4v4h-4zM3 15h4v4H3zm6 0h4v4H9zm6 0h4v4h-4z"/>`;
  } else if (density === "list") {
    densityToggleBtn.title = "Grid Density: List View (Click for Standard)";
    densityIcon.innerHTML = `<path d="M4 5h16v3H4zm0 5h16v3H4zm0 5h16v3H4zm0 5h16v3H4z"/>`;
  } else {
    // standard
    densityToggleBtn.title = "Grid Density: Standard (Click for Compact)";
    densityIcon.innerHTML = `<path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>`;
  }

  renderNotesGrid();
}

function cycleGridDensity() {
  if (gridDensity === "standard") {
    applyGridDensity("compact");
  } else if (gridDensity === "compact") {
    applyGridDensity("list");
  } else {
    applyGridDensity("standard");
  }
}

// ── Search & Contextual Flairs ─────────────────────────────────────────────
function renderActiveFlairs() {
  searchActiveFlairsContainer.innerHTML = "";
  if (activeSearchFlairs.size > 0 || searchQuery.trim() !== "") {
    searchClearBtn.style.display = "block";
    searchHint.style.display = "none";
  } else {
    searchClearBtn.style.display = "none";
    searchHint.style.display = "block";
  }

  activeSearchFlairs.forEach((flair) => {
    const pill = document.createElement("span");
    pill.className = "active-flair-pill";

    let label = flair;
    if (flair.startsWith("color:")) {
      const c = normalizeColorName(flair.replace("color:", ""));
      label = `🎨 ${c.charAt(0).toUpperCase() + c.slice(1)}`;
    } else if (flair === "has:files") {
      label = "📎 Files";
    } else if (flair === "is:checklist") {
      label = "☑ Checklist";
    } else if (flair === "is:expiring") {
      label = "⏳ Expiring";
    } else if (flair === "is:saved") {
      label = "🛡 Saved";
    }

    pill.innerHTML = `<span>${escapeHtml(label)}</span><button class="remove-flair-btn" title="Remove filter">✕</button>`;
    pill.querySelector(".remove-flair-btn").onclick = (e) => {
      e.stopPropagation();
      activeSearchFlairs.delete(flair);
      renderActiveFlairs();
      renderNotesGrid();
    };
    searchActiveFlairsContainer.appendChild(pill);
  });
}

function updateSearchFlairsTags() {
  // Collect all unique tags across notes
  const tagsSet = new Set();
  allNotes.forEach((n) => {
    if (n.tags && Array.isArray(n.tags)) {
      n.tags.forEach((t) => tagsSet.add(t));
    }
  });

  if (tagsSet.size > 0) {
    searchFlairTagsContainer.style.display = "block";
    searchFlairTags.innerHTML = "";
    tagsSet.forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "flair-chip";
      chip.dataset.flair = tag.startsWith("#") ? tag : `#${tag}`;
      chip.textContent = chip.dataset.flair;
      chip.onclick = (e) => {
        e.stopPropagation();
        toggleSearchFlair(chip.dataset.flair);
      };
      searchFlairTags.appendChild(chip);
    });
  } else {
    searchFlairTagsContainer.style.display = "none";
  }
}

function toggleSearchFlair(flair) {
  if (activeSearchFlairs.has(flair)) {
    activeSearchFlairs.delete(flair);
  } else {
    activeSearchFlairs.add(flair);
  }
  renderActiveFlairs();
  renderNotesGrid();
  searchFlairsPopover.classList.remove("show");
  searchInput.focus();
}

function setupSearchFlairs() {
  // Show popover on input focus
  searchInput.addEventListener("focus", () => {
    updateSearchFlairsTags();
    searchFlairsPopover.classList.add("show");
  });

  // Hide popover on outside click
  document.addEventListener("click", (e) => {
    if (
      !searchFlairsPopover.contains(e.target) &&
      e.target !== searchInput &&
      !searchActiveFlairsContainer.contains(e.target)
    ) {
      searchFlairsPopover.classList.remove("show");
    }
  });

  // Wire static flair chips
  searchFlairsPopover.querySelectorAll(".flair-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const flair = chip.dataset.flair;
      if (flair) toggleSearchFlair(flair);
    });
  });

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderActiveFlairs();
    renderNotesGrid();
  });

  searchClearBtn.addEventListener("click", () => {
    searchQuery = "";
    searchInput.value = "";
    activeSearchFlairs.clear();
    renderActiveFlairs();
    renderNotesGrid();
    searchInput.focus();
  });
}

// ── Filtered Notes Calculation ─────────────────────────────────────────────
function getFilteredNotes() {
  const activeWs = currentWorkspaceId || "default";
  return allNotes.filter((note) => {
    // 0. Active Workspace Filtering
    const noteWs = note.workspace || "default";
    if (noteWs !== activeWs) return false;

    // 1. Navigation View Filtering
    const isTrashed = Boolean(note.is_trash || note.trashed);
    const isArchived = Boolean(note.is_archived || note.archived);
    const isVault = Boolean(note.is_vault);

    if (currentNavView === "trash") {
      if (!isTrashed) return false;
    } else if (currentNavView === "archive") {
      if (isTrashed || !isArchived) return false;
    } else if (currentNavView === "vault") {
      if (isTrashed || !isVault) return false;
    } else {
      // "notes" view
      if (isTrashed || isArchived || isVault) return false;
    }

    // 2. Active Search Flairs Filtering
    if (activeSearchFlairs.size > 0) {
      for (const flair of activeSearchFlairs) {
        if (flair === "has:files") {
          if (!note.attachments || note.attachments.length === 0) return false;
        } else if (flair === "is:checklist") {
          if (!note.is_checklist) return false;
        } else if (flair === "is:expiring") {
          if (!note.expires_at) return false;
        } else if (flair === "is:saved") {
          if (!note.saved_to_disk) return false;
        } else if (flair.startsWith("color:")) {
          const col = normalizeColorName(flair.replace("color:", ""));
          if (normalizeColorName(note.color) !== col) return false;
        } else if (flair.startsWith("#")) {
          const tag = flair.replace("#", "").toLowerCase();
          const noteTags = (note.tags || []).map((t) => t.toLowerCase().replace("#", ""));
          if (!noteTags.includes(tag)) return false;
        }
      }
    }

    // 3. Search Query Text Filtering
    if (searchQuery.trim() !== "") {
      const q = searchQuery.toLowerCase().trim();
      const titleMatch = (note.title || "").toLowerCase().includes(q);
      const contentMatch = (note.content || "").toLowerCase().includes(q);
      const tagMatch = (note.tags || []).some((t) => t.toLowerCase().includes(q));
      const attMatch = (note.attachments || []).some((a) =>
        (a.filename || "").toLowerCase().includes(q)
      );
      if (!titleMatch && !contentMatch && !tagMatch && !attMatch) return false;
    }

    return true;
  });
}

// ── Masonry Layout Engine ──────────────────────────────────────────────────
function computeColumnCount(gridEl, count = 1) {
  if (gridDensity === "list") return 1;
  const containerWidth = gridEl.getBoundingClientRect().width || gridEl.parentElement?.clientWidth || 1000;
  const colWidth = gridDensity === "compact" ? 212 : 252;
  const gap = gridDensity === "compact" ? 12 : 16;
  const maxCols = Math.max(1, Math.floor((containerWidth + gap) / (colWidth + gap)));
  return Math.min(Math.max(1, count), maxCols);
}

function layoutMasonry(gridEl, notesList) {
  gridEl.innerHTML = "";
  if (notesList.length === 0) return;

  const colCount = computeColumnCount(gridEl, notesList.length);
  const cols = [];
  for (let i = 0; i < colCount; i++) {
    const colDiv = document.createElement("div");
    colDiv.className = "masonry-column";
    gridEl.appendChild(colDiv);
    cols.push({ el: colDiv, height: 0 });
  }

  notesList.forEach((note) => {
    const card = createCardElement(note);
    if (colCount === 1) {
      cols[0].el.appendChild(card);
    } else {
      // Find shortest column
      let shortest = cols[0];
      for (let i = 1; i < cols.length; i++) {
        if (cols[i].height < shortest.height) {
          shortest = cols[i];
        }
      }
      shortest.el.appendChild(card);
      // Rough heuristic height calculation for balancing
      const estHeight =
        60 +
        (note.content ? Math.min(240, note.content.length * 0.4) : 0) +
        (note.attachments ? note.attachments.length * 30 : 0) +
        (note.checklist ? note.checklist.length * 24 : 0);
      shortest.height += estHeight;
    }
  });

  // Clamp height & check overflow after elements are in DOM
  requestAnimationFrame(() => {
    gridEl.querySelectorAll(".card-content-clamped").forEach((wrapper) => {
      const contentEl = wrapper.querySelector(".card-content");
      if (contentEl && contentEl.scrollHeight > 240) {
        wrapper.classList.add("is-overflowing");
        const expandBtn = wrapper.parentElement.querySelector(".card-expand-btn");
        if (expandBtn) expandBtn.style.display = "inline-block";
      }
    });
  });
}

function renderNotesGrid() {
  const filtered = getFilteredNotes();

  if (filtered.length === 0) {
    pinnedSection.style.display = "none";
    othersSection.style.display = "none";
    emptyState.style.display = "block";
    if (currentNavView === "trash") {
      emptyTitle.textContent = "Trash is empty";
      emptySubtitle.textContent = "Items moved to trash will be permanently deleted after 7 days";
    } else if (currentNavView === "archive") {
      emptyTitle.textContent = "Your archived notes appear here";
      emptySubtitle.textContent = "Archive notes you want to keep without cluttering your board";
    } else if (currentNavView === "vault") {
      emptyTitle.textContent = vaultUnlocked ? "No protected notes in vault" : "Vault is locked";
      emptySubtitle.textContent = vaultUnlocked
        ? "Create secret notes or move existing notes to the vault"
        : "Unlock the vault with your master password to access protected cards";
    } else {
      emptyTitle.textContent = "Notes you add appear here";
      emptySubtitle.textContent = "Take notes, paste screenshots (⌘V), or drop files anywhere onto the screen";
    }
    return;
  }

  emptyState.style.display = "none";

  const pinnedNotes = filtered.filter((n) => n.is_pinned);
  const otherNotes = filtered.filter((n) => !n.is_pinned);

  if (pinnedNotes.length > 0) {
    pinnedSection.style.display = "block";
    layoutMasonry(pinnedGrid, pinnedNotes);
    othersTitle.style.display = "block";
  } else {
    pinnedSection.style.display = "none";
    othersTitle.style.display = "none";
  }

  if (otherNotes.length > 0) {
    othersSection.style.display = "block";
    layoutMasonry(othersGrid, otherNotes);
  } else {
    othersSection.style.display = "none";
  }
}

// ── Card Element Builder (Lightweight DOM with Event Delegation) ────────────
function createCardElement(note) {
  const card = document.createElement("div");
  const pal = paletteFor(note.color);
  card.className = `card note-color-${pal.name} ${selectedNoteIds.has(note.id) ? "selected" : ""}`;
  card.dataset.id = note.id;
  card.style.backgroundColor = pal.bg;
  card.style.borderColor = pal.border;

  // Wire per-card dropzone
  setupCardDropzone(card, note.id, {
    onAttachmentsUploaded: () => loadNotes(false),
    showToast,
    vaultHeaders,
  });

  // Card Selection Checkbox Button
  const selectBtn = document.createElement("div");
  selectBtn.className = "card-select-btn";
  selectBtn.title = "Select note";
  selectBtn.dataset.action = "select";
  card.appendChild(selectBtn);

  // Top Tools: Floating Quick Copy & Pin Button
  const topTools = document.createElement("div");
  topTools.className = `card-top-tools ${note.is_pinned ? "has-pin" : ""}`;

  // Copy Note Content Button
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-icon";
  copyBtn.title = "Copy note text";
  copyBtn.dataset.action = "copy";
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  topTools.appendChild(copyBtn);

  // Pin Button
  const pinBtn = document.createElement("button");
  pinBtn.className = "btn-icon";
  pinBtn.title = note.is_pinned ? "Unpin note" : "Pin note";
  pinBtn.dataset.action = "pin";
  pinBtn.style.color = note.is_pinned ? "var(--accent)" : "inherit";
  pinBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
  topTools.appendChild(pinBtn);
  card.appendChild(topTools);

  // Note Title
  if (note.title) {
    const titleEl = document.createElement("div");
    titleEl.className = "card-title";
    titleEl.textContent = note.title;
    card.appendChild(titleEl);
  }

  // Clamped Content Container
  const clampedWrapper = document.createElement("div");
  clampedWrapper.className = "card-content-clamped";

  const contentEl = document.createElement("div");
  contentEl.className = "card-content";

  // Check if content has rich HTML formatting or plain text
  if (note.content) {
    renderFormattedCardContent(contentEl, note.content);
  }
  clampedWrapper.appendChild(contentEl);

  const fadeEl = document.createElement("div");
  fadeEl.className = "card-content-fade";
  fadeEl.style.background = `linear-gradient(to bottom, transparent, ${pal.bg})`;
  clampedWrapper.appendChild(fadeEl);

  card.appendChild(clampedWrapper);

  // Show More / Show Less Toggle Button
  const expandBtn = document.createElement("button");
  expandBtn.className = "card-expand-btn";
  expandBtn.dataset.action = "expand";
  expandBtn.textContent = "Show more";
  card.appendChild(expandBtn);

  // ── Tab / URL Parking Lot (If 2+ URLs present) ────────────────────────────
  if (note.content) {
    const urlMatches = note.content.match(/https?:\/\/[^\s<>"'()]+/g);
    if (urlMatches && urlMatches.length >= 2) {
      const parkingLot = document.createElement("div");
      parkingLot.className = "url-parking-lot";

      const parkingHeader = document.createElement("div");
      parkingHeader.className = "url-parking-header";
      parkingHeader.innerHTML = `<span>Saved Links (${urlMatches.length})</span>`;

      const openAllBtn = document.createElement("button");
      openAllBtn.className = "open-all-tabs-btn";
      openAllBtn.dataset.action = "open-all-tabs";
      openAllBtn.textContent = "Open all in tabs";
      parkingHeader.appendChild(openAllBtn);
      parkingLot.appendChild(parkingHeader);

      urlMatches.slice(0, 5).forEach((url) => {
        try {
          const parsed = new URL(url);
          const item = document.createElement("a");
          item.className = "url-parking-item";
          item.href = url;
          item.target = "_blank";
          item.rel = "noopener noreferrer";
          item.onclick = (e) => e.stopPropagation();

          const favicon = document.createElement("img");
          favicon.className = "url-parking-favicon";
          favicon.src = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
          favicon.onerror = () => (favicon.style.display = "none");

          const textSpan = document.createElement("span");
          textSpan.textContent = parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "");

          item.appendChild(favicon);
          item.appendChild(textSpan);
          parkingLot.appendChild(item);
        } catch (e) {
          // ignore invalid url
        }
      });

      card.appendChild(parkingLot);
    }
  }

  // ── Nested Checklists with Progress Bar ──────────────────────────────────
  if (note.is_checklist && note.checklist && note.checklist.length > 0) {
    const checklistBox = document.createElement("div");

    // Progress Bar
    const progress = calculateChecklistProgress(note.checklist);
    if (progress) {
      const pBar = document.createElement("div");
      pBar.className = "checklist-progress-bar";
      pBar.innerHTML = `
        <div class="checklist-progress-track">
          <div class="checklist-progress-fill" style="width: ${progress.percent}%"></div>
        </div>
        <span class="checklist-progress-text">${progress.checked}/${progress.total}</span>
      `;
      checklistBox.appendChild(pBar);
    }

    // Checklist Tools (Uncheck all / Delete checked)
    const toolsMenu = document.createElement("div");
    toolsMenu.className = "checklist-tools-menu";
    const uncheckBtn = document.createElement("button");
    uncheckBtn.className = "checklist-tool-btn";
    uncheckBtn.dataset.action = "uncheck-all";
    uncheckBtn.textContent = "Uncheck all";
    toolsMenu.appendChild(uncheckBtn);

    const deleteCheckedBtn = document.createElement("button");
    deleteCheckedBtn.className = "checklist-tool-btn";
    deleteCheckedBtn.dataset.action = "delete-checked";
    deleteCheckedBtn.textContent = "Delete checked";
    toolsMenu.appendChild(deleteCheckedBtn);
    checklistBox.appendChild(toolsMenu);

    // Checklist Items: Show active items first, then "+ N completed" count
    const listEl = document.createElement("div");
    listEl.className = "checklist-list";
    let completedCount = 0;

    note.checklist.forEach((item, idx) => {
      if (item.checked) {
        completedCount++;
        return;
      }
      const itemEl = document.createElement("div");
      itemEl.className = `checklist-item indent-${item.indent || 0}`;
      if (item.indent) {
        itemEl.style.paddingLeft = "20px";
      }

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "checklist-checkbox";
      cb.dataset.action = "toggle-check";
      cb.dataset.index = idx;
      cb.checked = false;

      const span = document.createElement("span");
      span.textContent = item.text;

      itemEl.appendChild(cb);
      itemEl.appendChild(span);
      listEl.appendChild(itemEl);
    });

    if (completedCount > 0) {
      const compSummary = document.createElement("div");
      compSummary.className = "card-completed-count";
      compSummary.style.fontSize = "11.5px";
      compSummary.style.color = "var(--text-muted)";
      compSummary.style.padding = "4px 0 2px 24px";
      compSummary.style.fontStyle = "italic";
      compSummary.textContent = `+ ${completedCount} completed ${completedCount === 1 ? "item" : "items"}`;
      listEl.appendChild(compSummary);
    }

    checklistBox.appendChild(listEl);
    card.appendChild(checklistBox);
  }

  // ── Media Attachments Preview ────────────────────────────────────────────
  if (note.attachments && note.attachments.length > 0) {
    const firstMedia = note.attachments.find((a) => isMediaFile(a.filename));
    if (firstMedia) {
      const mediaType = isMediaFile(firstMedia.filename);
      const mediaBox = document.createElement("div");
      mediaBox.className = "card-media-preview";

      const fileUrl = `/api/files/${firstMedia.id}`;
      if (mediaType === "image") {
        const img = document.createElement("img");
        img.src = fileUrl;
        img.alt = firstMedia.filename;
        img.loading = "lazy";
        mediaBox.appendChild(img);
      } else if (mediaType === "video") {
        const vid = document.createElement("video");
        vid.src = fileUrl;
        vid.controls = true;
        vid.preload = "metadata";
        mediaBox.appendChild(vid);
      } else if (mediaType === "audio") {
        const aud = document.createElement("audio");
        aud.src = fileUrl;
        aud.controls = true;
        mediaBox.appendChild(aud);
      }
      card.appendChild(mediaBox);
    }

    // Attachment Download Pills
    const attList = document.createElement("div");
    attList.className = "attachment-list";
    note.attachments.forEach((att) => {
      const pill = document.createElement("div");
      pill.className = "attachment-pill";

      const link = document.createElement("a");
      link.href = `/api/files/${att.id}?download=true`;
      link.className = "attachment-name";
      link.textContent = att.filename;
      link.title = `Download ${att.filename} (${formatBytes(att.size)})`;
      link.onclick = (e) => e.stopPropagation();

      const sz = document.createElement("span");
      sz.className = "attachment-size";
      sz.textContent = formatBytes(att.size);

      pill.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a3 3 0 0 0 6 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>`;
      pill.appendChild(link);
      pill.appendChild(sz);

      // ZIP Peek Action
      if (isArchiveFile(att.filename)) {
        const peekBtn = document.createElement("button");
        peekBtn.className = "attachment-action-btn";
        peekBtn.title = "Peek contents of ZIP";
        peekBtn.textContent = "Peek";
        peekBtn.dataset.action = "peek-zip";
        peekBtn.dataset.attId = att.id;
        peekBtn.dataset.attName = att.filename;
        pill.appendChild(peekBtn);
      }

      // Rename Attachment
      const renameBtn = document.createElement("button");
      renameBtn.className = "attachment-action-btn";
      renameBtn.title = "Rename attachment";
      renameBtn.innerHTML = "✎";
      renameBtn.dataset.action = "rename-att";
      renameBtn.dataset.attId = att.id;
      renameBtn.dataset.attName = att.filename;
      pill.appendChild(renameBtn);

      attList.appendChild(pill);
    });
    card.appendChild(attList);
  }

  // ── Card Metadata Row (Tags, Badges, Shield, Snooze, TTL) ─────────────────
  const metaRow = document.createElement("div");
  metaRow.className = "card-meta-row";

  // Saved to Disk Shield Badge
  if (note.saved_to_disk) {
    const shieldBadge = document.createElement("span");
    shieldBadge.className = "card-shield-badge";
    shieldBadge.title = "Persisted to disk (/persist)";
    shieldBadge.innerHTML = `🛡 Disk`;
    metaRow.appendChild(shieldBadge);
  }

  // Snoozed Badge
  if (note.snoozed_until) {
    const snoozeBadge = document.createElement("span");
    snoozeBadge.className = "card-snooze-badge";
    snoozeBadge.title = `Snoozed until ${new Date(note.snoozed_until * 1000).toLocaleString()}`;
    snoozeBadge.textContent = "⏰ Snoozed";
    metaRow.appendChild(snoozeBadge);
  }

  // TTL Auto-Expiry Badge
  if (note.expires_at) {
    const ttlBadge = document.createElement("span");
    ttlBadge.className = "card-timer-badge";
    const remainingSec = Math.max(0, Math.floor(note.expires_at - Date.now() / 1000));
    const hours = Math.floor(remainingSec / 3600);
    const mins = Math.floor((remainingSec % 3600) / 60);
    ttlBadge.textContent = `⏳ ${hours > 0 ? hours + "h " : ""}${mins}m left`;
    metaRow.appendChild(ttlBadge);
  }

  // Trash Purge Badge
  if (note.is_trash && note.trashed_at) {
    const trashBadge = document.createElement("span");
    trashBadge.className = "card-trash-badge";
    const daysLeft = Math.max(0, 7 - Math.floor((Date.now() / 1000 - note.trashed_at) / 86400));
    trashBadge.textContent = `🗑 Purges in ${daysLeft}d`;
    metaRow.appendChild(trashBadge);
  }

  // Tags Pills
  if (note.tags && note.tags.length > 0) {
    note.tags.forEach((tag) => {
      const tagPill = document.createElement("span");
      tagPill.className = "card-tag-pill";
      const tagText = tag.startsWith("#") ? tag : `#${tag}`;
      tagPill.textContent = tagText;
      tagPill.dataset.action = "filter-tag";
      tagPill.dataset.tag = tagText;
      metaRow.appendChild(tagPill);
    });
  }

  if (metaRow.children.length > 0) {
    card.appendChild(metaRow);
  }

  // ── Card Hover Actions Bar (Minimal: Color, Archive, Split, Trash, More ⋮) ─────
  const actionsBar = document.createElement("div");
  actionsBar.className = "card-actions";

  // 1. Color Palette
  const colorWrap = document.createElement("div");
  colorWrap.style.position = "relative";
  const colorBtn = document.createElement("button");
  colorBtn.className = "btn-icon";
  colorBtn.title = "Change color";
  colorBtn.dataset.action = "color-popover";
  colorBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zm-5.5 11c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-4C8.67 9 8 8.33 8 7.5S8.67 6 9.5 6s1.5.67 1.5 1.5S10.33 9 9.5 9zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 6 14.5 6s1.5.67 1.5 1.5S15.33 9 14.5 9zm3 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`;
  const colorPopover = document.createElement("div");
  colorPopover.className = "color-popover";
  renderSwatches(colorPopover, (newColor) => updateNoteColor(note.id, newColor), note.color);
  colorWrap.appendChild(colorBtn);
  colorWrap.appendChild(colorPopover);

  if (note.is_trash) {
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "btn-icon";
    restoreBtn.dataset.action = "restore";
    restoreBtn.title = "Restore note";
    restoreBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>`;
    actionsBar.appendChild(restoreBtn);

    const delForeverBtn = document.createElement("button");
    delForeverBtn.className = "btn-icon card-action-trash";
    delForeverBtn.dataset.action = "delete-forever";
    delForeverBtn.title = "Delete forever";
    delForeverBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
    actionsBar.appendChild(delForeverBtn);
  } else {
    // 1. Color Palette
    actionsBar.appendChild(colorWrap);

    // 2. Archive / Unarchive
    const archBtn = document.createElement("button");
    archBtn.className = "btn-icon";
    archBtn.dataset.action = "archive";
    archBtn.title = note.is_archived ? "Unarchive" : "Archive";
    archBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.83 1H5.42l.82-1zM5 19V8h14v11H5zm7-2l5-5h-3.5V9h-3v3H7l5 5z"/></svg>`;
    actionsBar.appendChild(archBtn);

    // 3. Open in Split Pane
    const splitBtn = document.createElement("button");
    splitBtn.className = "btn-icon";
    splitBtn.dataset.action = "split";
    splitBtn.title = "Open in Split Pane (or ⌘/Ctrl+Click)";
    splitBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 16H5V5h6v14zm8 0h-6V5h6v14z"/></svg>`;
    actionsBar.appendChild(splitBtn);

    // 4. Delete / Move to Trash
    const trashBtn = document.createElement("button");
    trashBtn.className = "btn-icon card-action-trash";
    trashBtn.dataset.action = "trash";
    trashBtn.title = "Delete";
    trashBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>`;
    actionsBar.appendChild(trashBtn);

    // 5. More (⋮) Overflow Menu
    const moreWrap = document.createElement("div");
    moreWrap.style.position = "relative";
    const moreBtn = document.createElement("button");
    moreBtn.className = "btn-icon";
    moreBtn.dataset.action = "more-popover";
    moreBtn.title = "More";
    moreBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>`;

    const morePopover = document.createElement("div");
    morePopover.className = "card-more-popover";

    // Move to Workspace
    const wsItem = document.createElement("button");
    wsItem.className = "card-more-item";
    wsItem.dataset.action = "move-ws";
    wsItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg><span>Move to workspace</span>`;
    morePopover.appendChild(wsItem);

    // Labels
    const tagItem = document.createElement("button");
    tagItem.className = "card-more-item";
    tagItem.dataset.action = "labels";
    tagItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 17H5V7h11l3.55 5L16 17z"/></svg><span>Labels</span>`;
    morePopover.appendChild(tagItem);

    // Persist on Disk (Shield)
    const persistItem = document.createElement("button");
    persistItem.className = "card-more-item";
    persistItem.dataset.action = "persist";
    persistItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg><span>${note.saved_to_disk ? "Remove from disk" : "Persist on disk (Shield)"}</span>`;
    morePopover.appendChild(persistItem);

    // Lock in Vault
    const vaultItem = document.createElement("button");
    vaultItem.className = "card-more-item";
    vaultItem.dataset.action = "vault";
    vaultItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg><span>${note.is_vault ? "Unlock from vault" : "Lock in vault"}</span>`;
    morePopover.appendChild(vaultItem);

    // Duplicate
    const dupItem = document.createElement("button");
    dupItem.className = "card-more-item";
    dupItem.dataset.action = "duplicate";
    dupItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><span>Duplicate</span>`;
    morePopover.appendChild(dupItem);

    // Export Markdown (.md)
    const exportItem = document.createElement("button");
    exportItem.className = "card-more-item";
    exportItem.dataset.action = "export-md";
    exportItem.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg><span>Export Markdown (.md)</span>`;
    morePopover.appendChild(exportItem);

    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(morePopover);
    actionsBar.appendChild(moreWrap);
  }

  card.appendChild(actionsBar);
  return card;
}

// ── Render Formatted Card Content (Rich HTML + Code Blocks + Links) ────────
function renderFormattedCardContent(container, contentText) {
  // If content contains fenced code blocks (```lang ... ```), split and render nicely
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(contentText)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      const textChunk = contentText.substring(lastIndex, match.index);
      appendProseChunk(container, textChunk);
    }

    // Code block itself
    const lang = match[1] || "CODE";
    const codeBody = match[2];
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    const header = document.createElement("div");
    header.className = "code-block-header";
    header.innerHTML = `<span>${escapeHtml(lang.toUpperCase())}</span>`;

    const copyBtn = document.createElement("button");
    copyBtn.className = "code-copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      copyToClipboard(codeBody);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
    };
    header.appendChild(copyBtn);
    wrapper.appendChild(header);

    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.textContent = codeBody;
    wrapper.appendChild(pre);

    container.appendChild(wrapper);
    lastIndex = match.index + match[0].length;
  }

  // Trailing text chunk
  if (lastIndex < contentText.length) {
    appendProseChunk(container, contentText.substring(lastIndex));
  }
}

function appendProseChunk(container, text) {
  const span = document.createElement("span");
  // If text already has HTML tags (<p>, <mark>, <b>, etc.), assign innerHTML, else textContent with linkification
  if (/<[a-z][\s\S]*>/i.test(text)) {
    span.innerHTML = text;
  } else {
    span.innerHTML = linkifyAndFormat(text);
  }
  container.appendChild(span);
}

function linkifyAndFormat(rawText) {
  let escaped = escapeHtml(rawText);
  // URL linkify
  escaped = escaped.replace(
    /(https?:\/\/[^\s<>"'()]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">$1</a>'
  );
  // Inline code `code`
  escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  return escaped;
}

// ── Multi-Select Batch Actions (Direct DOM Mutation) ──────────────────────
function toggleCardSelection(noteId, isShift = false) {
  const isSelected = selectedNoteIds.has(noteId);
  if (isSelected) {
    selectedNoteIds.delete(noteId);
  } else {
    selectedNoteIds.add(noteId);
  }
  const card = document.querySelector(`.card[data-id="${noteId}"]`);
  if (card) {
    card.classList.toggle("selected", !isSelected);
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const count = selectedNoteIds.size;
  if (count > 0) {
    if (mainHeader) mainHeader.style.display = "none";
    if (selectionBar) {
      selectionBar.classList.add("active");
      selectionBar.style.display = "flex";
    }
    if (selCountText) selCountText.textContent = `${count} selected`;

    const isTrash = currentNavView === "trash";
    if (batchRestoreBtn) batchRestoreBtn.style.display = isTrash ? "inline-flex" : "none";
    if (batchTrashBtn) {
      batchTrashBtn.title = isTrash ? "Delete selected forever" : "Move selected to Trash";
    }
    if (batchPinBtn) {
      batchPinBtn.style.display = isTrash ? "none" : "inline-flex";
      const allPinned = Array.from(selectedNoteIds).every((id) => allNotes.find((n) => n.id === id)?.is_pinned);
      batchPinBtn.title = allPinned ? "Unpin selected" : "Pin selected";
    }
    if (batchArchiveBtn) {
      batchArchiveBtn.style.display = isTrash ? "none" : "inline-flex";
      batchArchiveBtn.title = currentNavView === "archive" ? "Unarchive selected" : "Archive selected";
    }
    if (batchColorBtn) batchColorBtn.style.display = isTrash ? "none" : "inline-flex";
    if (batchMergeBtn) batchMergeBtn.style.display = isTrash ? "none" : "inline-flex";
    if (batchWorkspaceBtn) batchWorkspaceBtn.style.display = isTrash ? "none" : "inline-flex";
    if (batchTagBtn) batchTagBtn.style.display = isTrash ? "none" : "inline-flex";
    if (batchDownloadBtn) batchDownloadBtn.style.display = isTrash ? "none" : "inline-flex";
  } else {
    if (selectionBar) {
      selectionBar.classList.remove("active");
      selectionBar.style.display = "none";
    }
    if (mainHeader) mainHeader.style.display = "flex";
  }
}

function clearSelection() {
  selectedNoteIds.clear();
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
  updateSelectionBar();
}

function selectAllNotes() {
  const visible = getFilteredNotes();
  const allSelected = visible.length > 0 && visible.every((n) => selectedNoteIds.has(n.id));
  if (allSelected) {
    clearSelection();
  } else {
    visible.forEach((n) => selectedNoteIds.add(n.id));
    document.querySelectorAll(".card").forEach((c) => c.classList.add("selected"));
    updateSelectionBar();
  }
}

async function executeBatchAction(action, payload = null) {
  const ids = Array.from(selectedNoteIds);
  if (ids.length === 0) return;

  try {
    const res = await fetch("/api/notes/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...vaultHeaders() },
      body: JSON.stringify({ ids, action, payload }),
    });

    if (res.ok) {
      showToast(`Batch ${action} completed`);
      clearSelection();
      await loadNotes();
      await updateStats();
    } else {
      showToast("Batch action failed");
    }
  } catch (err) {
    showToast("Network error executing batch action");
  }
}

// ── Top Composer Logic ─────────────────────────────────────────────────────
function expandComposer() {
  captureCollapsed.style.display = "none";
  captureExpanded.style.display = "flex";
  composerTitleInput.focus();
}

function collapseComposer() {
  captureCollapsed.style.display = "flex";
  captureExpanded.style.display = "none";
  composerFmtToolbar.classList.remove("show");
  composerTitleInput.value = "";
  composerRichEditor.innerHTML = "";
  composerRawTextarea.value = "";
  composerRawTextarea.style.display = "none";
  composerRichEditor.style.display = "block";
  composerRawMode = false;
  composerChecklistContainer.style.display = "none";
  composerChecklistItems = [];
  composerIsChecklist = false;
  composerPendingFiles = [];
  composerTags.clear();
  composerColor = "default";
  composerIsPinned = false;
  composerTTL = "";
  composerTTLSelect.value = "";
  captureBox.style.backgroundColor = paletteFor("default");
  renderComposerPendingFiles();
  renderComposerTags();

}

function renderComposerPendingFiles() {
  composerAttachmentsPreview.innerHTML = "";
  composerPendingFiles.forEach((file, idx) => {
    const pill = document.createElement("div");
    pill.className = "attachment-pill";
    pill.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a3 3 0 0 0 6 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
      <span class="attachment-name">${escapeHtml(file.name)}</span>
      <span class="attachment-size">${formatBytes(file.size)}</span>
      <button class="attachment-action-btn" title="Remove">✕</button>
    `;
    pill.querySelector(".attachment-action-btn").onclick = (e) => {
      e.stopPropagation();
      composerPendingFiles.splice(idx, 1);
      renderComposerPendingFiles();
    };
    composerAttachmentsPreview.appendChild(pill);
  });
}

function renderComposerTags() {
  composerTagsPreview.innerHTML = "";
  composerTags.forEach((tag) => {
    const pill = document.createElement("span");
    pill.className = "card-tag-pill";
    pill.innerHTML = `${escapeHtml(tag)} <span style="cursor:pointer;">✕</span>`;
    pill.querySelector("span").onclick = (e) => {
      e.stopPropagation();
      composerTags.delete(tag);
      renderComposerTags();
    };
    composerTagsPreview.appendChild(pill);
  });
}

let isSavingComposer = false;

async function saveComposerNote() {
  if (isSavingComposer) return;

  const title = composerTitleInput.value.trim();
  const textContent = (composerRichEditor.textContent || "").trim().replace(/\u200B/g, "");
  const hasBodyContent = composerRawMode
    ? composerRawTextarea.value.trim().length > 0
    : textContent.length > 0;
  const content = composerRawMode
    ? composerRawTextarea.value.trim()
    : (hasBodyContent ? composerRichEditor.innerHTML.trim() : "");
  const hasChecklistContent = composerIsChecklist && composerChecklistItems.some(it => (it.text || "").trim().length > 0);
  const hasFiles = composerPendingFiles && composerPendingFiles.length > 0;

  // If completely empty with no files or checklist, just collapse without making a request
  if (!title && !hasBodyContent && !hasChecklistContent && !hasFiles) {
    collapseComposer();
    return;
  }

  isSavingComposer = true;
  const formData = new FormData();
  if (title) formData.append("title", title);
  if (content) {
    formData.append("text", content);
    formData.append("content", content);
  }
  formData.append("color", composerColor);
  formData.append("pinned", composerIsPinned);
  formData.append("is_pinned", composerIsPinned);
  formData.append("is_vault", currentNavView === "vault");
  formData.append("is_checklist", composerIsChecklist);
  formData.append("workspace", currentWorkspaceId || "default");

  if (composerTTL) {
    formData.append("ttl", composerTTL);
    const ttlMap = { "1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000 };
    if (ttlMap[composerTTL]) {
      formData.append("expires_in", ttlMap[composerTTL]);
    }
  }

  if (composerTags.size > 0) {
    formData.append("tags", JSON.stringify(Array.from(composerTags)));
  }

  if (composerIsChecklist && composerChecklistItems.length > 0) {
    formData.append("checklist", JSON.stringify(composerChecklistItems));
  }

  composerPendingFiles.forEach((f) => {
    formData.append("files", f);
  });

  try {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: vaultHeaders(),
      body: formData,
    });

    if (res.ok) {
      showToast("Note created");
      collapseComposer();
      await loadNotes();
      await updateStats();
    } else {
      showToast("Error creating note");
    }
  } catch (err) {
    showToast("Network error creating note");
  } finally {
    isSavingComposer = false;
  }
}

// ── Edit Modal Logic ───────────────────────────────────────────────────────
async function openEditModal(noteId) {
  const note = allNotes.find((n) => n.id === noteId);
  if (!note) return;

  currentEditingNoteId = note.id;
  modalTitleInput.value = note.title || "";
  modalRichEditor.innerHTML = note.content || "";
  modalRawTextarea.value = note.content || "";
  modalRawMode = false;
  modalRawTextarea.style.display = "none";
  modalRichEditor.style.display = "block";
  modalColor = normalizeColorName(note.color);
  modalIsPinned = Boolean(note.is_pinned);
  modalTags = new Set(note.tags || []);
  modalChecklistItems = note.checklist ? JSON.parse(JSON.stringify(note.checklist)) : [];
  modalPendingFiles = [];

  const mPal = paletteFor(modalColor);
  editModalCard.style.backgroundColor = mPal.bg;
  editModalCard.style.borderColor = mPal.border;
  modalPinBtn.style.color = modalIsPinned ? "var(--accent)" : "inherit";
  const modalStorageBadge = document.getElementById("modal-storage-badge");
  updateStorageBadge(modalStorageBadge, Boolean(note.saved_to_disk));
  if (modalShieldBtn) {
    modalShieldBtn.classList.toggle("active", Boolean(note.saved_to_disk));
    modalShieldBtn.title = note.saved_to_disk ? "Remove from persistent disk" : "Save to persistent disk (/persist)";
  }
  if (modalVaultBtn) {
    modalVaultBtn.classList.toggle("active", Boolean(note.is_vault));
    modalVaultBtn.title = note.is_vault ? "Unlock from Vault" : "Lock in Vault (Protected)";
  }
  if (modalTrashBtn) {
    modalTrashBtn.title = (note.is_trash || note.trashed) ? "Delete forever" : "Move to Trash";
  }

  // Wire dropzone on modal editor card
  setupCardDropzone(editModalCard, () => currentEditingNoteId, {
    onAttachmentsUploaded: (updated) => {
      const refreshed = allNotes.find((n) => n.id === currentEditingNoteId) || updated;
      if (refreshed) renderModalAttachments(refreshed.attachments || []);
    },
    showToast,
    vaultHeaders,
  });

  renderModalTags();
  renderModalAttachments(note.attachments || []);

  if (note.is_checklist && modalChecklistItems.length > 0) {
    modalChecklistContainer.style.display = "block";
    modalRichEditor.style.display = "none";
    modalRawTextarea.style.display = "none";
    renderChecklistEditor(modalChecklistContainer, modalChecklistItems, (updated) => {
      modalChecklistItems = updated;
    });
  } else {
    modalChecklistContainer.style.display = "none";
    modalRichEditor.style.display = "block";
  }

  // Reset side-by-side secondary pane state when opening modal
  modal2NoteId = null;
  if (modalPaneSecondary) modalPaneSecondary.style.display = "none";
  if (editModalCard) editModalCard.classList.remove("side-by-side");

  // Update Document Outline Rail
  extractDocumentOutline(modalRichEditor, modalOutlineItems);

  editModalBackdrop.style.display = "flex";
  modalRichEditor.focus();
}

function renderModalTags() {
  modalTagsContainer.innerHTML = "";
  modalTags.forEach((t) => {
    const pill = document.createElement("span");
    pill.className = "card-tag-pill";
    pill.innerHTML = `${escapeHtml(t)} <span style="cursor:pointer;">✕</span>`;
    pill.querySelector("span").onclick = (e) => {
      e.stopPropagation();
      modalTags.delete(t);
      renderModalTags();
    };
    modalTagsContainer.appendChild(pill);
  });
}

function renderModalAttachments(attachments) {
  modalAttachmentsList.innerHTML = "";
  attachments.forEach((att) => {
    const pill = document.createElement("div");
    pill.className = "attachment-pill";
    pill.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a3 3 0 0 0 6 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
      <a href="/api/files/${att.id}?download=true" class="attachment-name">${escapeHtml(att.filename)}</a>
      <span class="attachment-size">${formatBytes(att.size)}</span>
      <button class="attachment-action-btn" title="Delete attachment">✕</button>
    `;
    pill.querySelector(".attachment-action-btn").onclick = async (e) => {
      e.stopPropagation();
      await deleteAttachment(currentEditingNoteId, att.id);
    };
    modalAttachmentsList.appendChild(pill);
  });
}

async function closeEditModal() {
  if (!currentEditingNoteId) {
    editModalBackdrop.style.display = "none";
    closeSideBySideMode();
    return;
  }

  // Save side-by-side note if open
  if (modal2NoteId) {
    await saveSecondNote();
  }

  const title = modalTitleInput.value.trim();
  const content = modalRawMode ? modalRawTextarea.value : modalRichEditor.innerHTML.trim();

  const payload = {
    title,
    text: content,
    content: content,
    color: modalColor,
    pinned: modalIsPinned,
    is_pinned: modalIsPinned,
    tags: Array.from(modalTags),
  };

  const isChecklist = modalChecklistContainer.style.display !== "none";
  if (isChecklist && modalChecklistItems.length > 0) {
    payload.checklist = modalChecklistItems;
    payload.is_checklist = true;
  } else if (!isChecklist) {
    payload.checklist = [];
    payload.is_checklist = false;
  }

  try {
    const res = await fetch(`/api/notes/${currentEditingNoteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...vaultHeaders() },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      editModalBackdrop.style.display = "none";
      currentEditingNoteId = null;
      closeSideBySideMode();
      await loadNotes();
    }
  } catch (err) {
    showToast("Error updating note");
  }
}

// ── Side-by-Side Dual Note Mode ─────────────────────────────────────────────
function openInSplitWorkspace(noteId) {
  if (editModalBackdrop.style.display === "flex") {
    if (currentEditingNoteId === noteId) {
      if (editModalCard.classList.contains("side-by-side")) {
        closeSideBySideMode();
      } else {
        openSideBySideMode();
      }
    } else {
      openSideBySideMode(noteId);
    }
  } else {
    openEditModal(noteId);
    openSideBySideMode();
  }
}

function openSideBySideMode(secondNoteId = null) {
  if (!editModalCard || !modalPaneSecondary) return;
  editModalCard.classList.add("side-by-side");
  modalPaneSecondary.style.display = "flex";

  if (secondNoteId) {
    loadSecondNote(secondNoteId);
  } else {
    showSecondNotePicker();
  }
}

function closeSideBySideMode() {
  if (modal2NoteId) {
    saveSecondNote();
  }
  modal2NoteId = null;
  if (modalPaneSecondary) modalPaneSecondary.style.display = "none";
  if (editModalCard) editModalCard.classList.remove("side-by-side");
}

function showSecondNotePicker() {
  if (!modal2Picker || !modal2Editor) return;
  modal2Picker.style.display = "flex";
  modal2Editor.style.display = "none";
  if (modal2ChangeBtn) modal2ChangeBtn.style.display = "none";
  renderSecondNotePickerList(modal2Search ? modal2Search.value.trim() : "");
  if (modal2Search) {
    modal2Search.value = "";
    modal2Search.focus();
  }
}

function renderSecondNotePickerList(filter = "") {
  if (!modal2List) return;
  modal2List.innerHTML = "";
  const curWs = currentWorkspaceId || "default";
  const notes = allNotes.filter((n) => !n.is_trash && (n.workspace || "default") === curWs && n.id !== currentEditingNoteId);
  const q = filter.toLowerCase();
  const filtered = q
    ? notes.filter((n) => (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q))
    : notes;

  if (filtered.length === 0) {
    modal2List.innerHTML = `<div style="font-size:12px; color:var(--text-muted); font-style:italic; padding:12px; text-align:center;">No other notes in this workspace</div>`;
    return;
  }

  filtered.forEach((note) => {
    const item = document.createElement("div");
    item.className = "modal2-note-item";
    const snippet = (note.content || "").replace(/<[^>]+>/g, "").slice(0, 90) || "(empty note)";
    item.innerHTML = `
      <div class="modal2-note-title">${escapeHtml(note.title || "Untitled")}</div>
      <div class="modal2-note-snippet">${escapeHtml(snippet)}</div>
    `;
    item.onclick = () => {
      loadSecondNote(note.id);
    };
    modal2List.appendChild(item);
  });
}

function loadSecondNote(noteId) {
  const note = allNotes.find((n) => n.id === noteId);
  if (!note || !modal2Editor || !modal2Picker) return;
  modal2NoteId = note.id;
  modal2Picker.style.display = "none";
  modal2Editor.style.display = "flex";
  if (modal2ChangeBtn) modal2ChangeBtn.style.display = "inline-block";

  modal2TitleInput.value = note.title || "";
  modal2RichEditor.innerHTML = note.content || "";
  if (note.is_checklist && note.checklist && note.checklist.length > 0) {
    modal2ChecklistItems = [...note.checklist];
    modal2ChecklistContainer.style.display = "block";
    modal2RichEditor.style.display = "none";
    renderChecklistEditor(modal2ChecklistContainer, modal2ChecklistItems, (updated) => {
      modal2ChecklistItems = updated;
      debouncedSaveSecondNote();
    });
  } else {
    modal2ChecklistContainer.style.display = "none";
    modal2RichEditor.style.display = "block";
    modal2ChecklistItems = [];
  }
  renderModalAttachments(note.attachments || [], modal2AttachmentsList);
}

function debouncedSaveSecondNote() {
  clearTimeout(modal2SaveTimer);
  modal2SaveTimer = setTimeout(() => saveSecondNote(), 450);
}

async function saveSecondNote() {
  if (!modal2NoteId) return;
  const note = allNotes.find((n) => n.id === modal2NoteId);
  if (!note) return;

  const title = modal2TitleInput ? modal2TitleInput.value.trim() : note.title;
  const isChecklist = modal2ChecklistContainer && modal2ChecklistContainer.style.display !== "none";
  const content = isChecklist ? "" : (modal2RichEditor ? modal2RichEditor.innerHTML.trim() : note.content);

  const payload = {
    title,
    text: content,
    content,
    is_checklist: isChecklist,
    checklist: isChecklist ? modal2ChecklistItems : [],
  };

  try {
    await fetch(`/api/notes/${modal2NoteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...vaultHeaders() },
      body: JSON.stringify(payload),
    });
    // Update local memory
    note.title = title;
    note.content = content;
    note.text = content;
    note.is_checklist = isChecklist;
    note.checklist = isChecklist ? modal2ChecklistItems : [];
  } catch (err) {
    console.error("Error saving side note:", err);
  }
}

// ── Workspaces Management ──────────────────────────────────────────────────
async function loadWorkspaces() {
  try {
    const res = await fetch("/api/workspaces");
    if (res.ok) {
      const data = await res.json();
      allWorkspaces = Array.isArray(data) && data.length > 0 ? data : [{ id: "default", name: "Personal" }];
    }
  } catch (err) {
    console.error("Failed to load workspaces:", err);
  }
  if (!allWorkspaces.some((w) => w.id === currentWorkspaceId)) {
    currentWorkspaceId = allWorkspaces[0]?.id || "default";
    localStorage.setItem("keepboard_active_workspace", currentWorkspaceId);
  }
  renderWorkspaceSwitcher();
}

function renderWorkspaceSwitcher() {
  const currentWs = allWorkspaces.find((w) => w.id === currentWorkspaceId) || allWorkspaces[0] || { id: "default", name: "Personal" };
  workspaceCurrentLabel.textContent = currentWs.name;

  workspaceItemsList.innerHTML = "";
  allWorkspaces.forEach((ws) => {
    const row = document.createElement("div");
    row.className = `workspace-item-row ${ws.id === currentWorkspaceId ? "active" : ""}`;

    const titleSpan = document.createElement("span");
    titleSpan.style.textOverflow = "ellipsis";
    titleSpan.style.overflow = "hidden";
    titleSpan.style.whiteSpace = "nowrap";
    titleSpan.textContent = ws.name;
    titleSpan.style.flex = "1";

    row.appendChild(titleSpan);

    const actions = document.createElement("div");
    actions.className = "workspace-item-actions";

    // Rename button
    const renameBtn = document.createElement("button");
    renameBtn.className = "workspace-item-btn";
    renameBtn.title = "Rename workspace";
    renameBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
    renameBtn.onclick = async (e) => {
      e.stopPropagation();
      const newName = prompt("Rename workspace:", ws.name);
      if (newName && newName.trim() && newName.trim() !== ws.name) {
        try {
          const res = await fetch(`/api/workspaces/${ws.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName.trim() }),
          });
          if (res.ok) {
            await loadWorkspaces();
            await loadNotes(false);
          }
        } catch (err) {
          showToast("Failed to rename workspace");
        }
      }
    };
    actions.appendChild(renameBtn);

    // Delete button (non-default only)
    if (ws.id !== "default") {
      const delBtn = document.createElement("button");
      delBtn.className = "workspace-item-btn";
      delBtn.title = "Delete workspace";
      delBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Delete workspace "${ws.name}"? Notes in this workspace will be moved to Personal.`)) {
          try {
            const res = await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
            if (res.ok) {
              if (currentWorkspaceId === ws.id) {
                currentWorkspaceId = "default";
                localStorage.setItem("keepboard_active_workspace", "default");
              }
              await loadWorkspaces();
              await loadNotes();
            }
          } catch (err) {
            showToast("Failed to delete workspace");
          }
        }
      };
      actions.appendChild(delBtn);
    }

    row.appendChild(actions);

    row.onclick = () => {
      switchWorkspace(ws.id);
      workspaceDropdown.style.display = "none";
      workspacePillBtn.classList.remove("open");
    };

    workspaceItemsList.appendChild(row);
  });
}

function switchWorkspace(wsId) {
  currentWorkspaceId = wsId;
  localStorage.setItem("keepboard_active_workspace", currentWorkspaceId);
  renderWorkspaceSwitcher();
  renderSidebarTags();
  renderNotesGrid();
}

async function moveNoteToWorkspace(noteId, wsId) {
  const ws = allWorkspaces.find((w) => w.id === wsId);
  const note = allNotes.find((n) => n.id === noteId);
  try {
    const res = await fetch(`/api/notes/${noteId}/move-workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...vaultHeaders() },
      body: JSON.stringify({ workspace: wsId }),
    });
    if (res.ok) {
      if (note) note.workspace = wsId;
      showToast(`Moved note to ${ws ? ws.name : wsId}`);
      await loadNotes();
    } else {
      showToast("Failed to move note");
    }
  } catch (err) {
    showToast("Error moving note");
  }
}

async function addTagToNote(noteId, tags) {
  try {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...vaultHeaders(),
      },
      body: JSON.stringify({ tags }),
    });
    if (res.ok) {
      const note = allNotes.find((n) => n.id === noteId);
      if (note) note.tags = tags;
      showToast("Label added");
      await loadNotes(false);
    }
  } catch (err) {
    showToast("Error updating labels");
  }
}

async function duplicateNote(noteId) {
  try {
    const res = await fetch(`/api/notes/${noteId}/duplicate`, {
      method: "POST",
      headers: vaultHeaders(),
    });
    if (res.ok) {
      showToast("Note duplicated");
      await loadNotes();
    } else {
      showToast("Failed to duplicate note");
    }
  } catch (err) {
    showToast("Error duplicating note");
  }
}

async function toggleNoteVault(noteId) {
  const note = allNotes.find((n) => n.id === noteId);
  const targetVaultState = note ? !note.is_vault : true;
  if (!vaultConfigured) {
    showToast("Configure Vault password first");
    promptVaultPassword(true, () => toggleNoteVault(noteId));
    return;
  }
  if (!vaultUnlocked || !vaultToken) {
    showToast("Enter Vault master password to unlock");
    promptVaultPassword(false, () => toggleNoteVault(noteId));
    return;
  }
  try {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...vaultHeaders(),
      },
      body: JSON.stringify({ is_vault: targetVaultState }),
    });
    if (res.ok) {
      if (note) note.is_vault = targetVaultState;
      showToast(targetVaultState ? "Note locked in Vault (Protected)" : "Note unlocked from Vault");
      if (modalVaultBtn && currentEditingNoteId === noteId) {
        modalVaultBtn.classList.toggle("active", targetVaultState);
        modalVaultBtn.title = targetVaultState ? "Unlock from Vault" : "Lock in Vault (Protected)";
      }
      await loadNotes(false);
    } else {
      showToast("Failed to update Vault status");
    }
  } catch (err) {
    showToast("Error updating Vault status");
  }
}

async function lockNoteInVault(noteId) {
  return toggleNoteVault(noteId);
}

function showMoveWorkspacePopover(noteId, anchorEl) {
  document.querySelectorAll(".card-ws-popover").forEach((el) => el.remove());

  const popover = document.createElement("div");
  popover.className = "workspace-popover card-ws-popover show";
  popover.style.display = "flex";
  popover.style.position = "absolute";
  popover.style.bottom = "38px";
  popover.style.left = "0";

  const header = document.createElement("div");
  header.className = "workspace-dropdown-header";
  header.textContent = "Move to workspace";
  popover.appendChild(header);

  const note = allNotes.find((n) => n.id === noteId);
  const currentWs = note?.workspace || "default";

  allWorkspaces.forEach((ws) => {
    const item = document.createElement("div");
    item.className = `workspace-item-row ${ws.id === currentWs ? "active" : ""}`;
    item.textContent = ws.name;
    item.onclick = async (e) => {
      e.stopPropagation();
      popover.remove();
      if (ws.id === currentWs) return;
      try {
        const res = await fetch(`/api/notes/${noteId}/move-workspace`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...vaultHeaders() },
          body: JSON.stringify({ workspace: ws.id }),
        });
        if (res.ok) {
          if (note) note.workspace = ws.id;
          showToast(`Moved note to ${ws.name}`);
          await loadNotes();
        } else {
          showToast("Failed to move note");
        }
      } catch (err) {
        showToast("Error moving note");
      }
    };
    popover.appendChild(item);
  });

  anchorEl.parentElement.style.position = "relative";
  anchorEl.parentElement.appendChild(popover);
}

function showBatchMoveWorkspacePopover() {
  batchWorkspacePopover.innerHTML = "";
  const header = document.createElement("div");
  header.className = "workspace-dropdown-header";
  header.textContent = "Move selected to";
  batchWorkspacePopover.appendChild(header);

  allWorkspaces.forEach((ws) => {
    const item = document.createElement("div");
    item.className = `workspace-item-row ${ws.id === currentWorkspaceId ? "active" : ""}`;
    item.textContent = ws.name;
    item.onclick = async (e) => {
      e.stopPropagation();
      batchWorkspacePopover.style.display = "none";
      const ids = Array.from(selectedNoteIds);
      if (ids.length === 0) return;
      try {
        const res = await fetch("/api/notes/batch/move-workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...vaultHeaders() },
          body: JSON.stringify({ note_ids: ids, ids, workspace: ws.id }),
        });
        if (res.ok) {
          showToast(`Moved ${ids.length} note(s) to ${ws.name}`);
          clearSelection();
          await loadNotes();
        } else {
          showToast("Failed to move notes");
        }
      } catch (err) {
        showToast("Error moving notes");
      }
    };
    batchWorkspacePopover.appendChild(item);
  });
  batchWorkspacePopover.style.display = "flex";
}

// ── Spotlight Command Palette (⌘K) ─────────────────────────────────────────
function openCommandPalette() {
  cmdPaletteInput.value = "";
  renderCommandPaletteList("");
  cmdPaletteBackdrop.style.display = "flex";
  cmdPaletteInput.focus();
}

function closeCommandPalette() {
  cmdPaletteBackdrop.style.display = "none";
}

function renderCommandPaletteList(query) {
  cmdPaletteList.innerHTML = "";
  const q = (query || "").toLowerCase().trim();

  // 1. Workspaces (Quick Switcher)
  const matchedWorkspaces = allWorkspaces.filter((w) => (w.name || "").toLowerCase().includes(q));
  if (matchedWorkspaces.length > 0) {
    const wsHeader = document.createElement("div");
    wsHeader.className = "cmd-group-label";
    wsHeader.textContent = "Workspaces";
    cmdPaletteList.appendChild(wsHeader);

    matchedWorkspaces.forEach((ws) => {
      const el = document.createElement("div");
      el.className = "cmd-item";
      el.innerHTML = `<span>Switch to Workspace: <b>${escapeHtml(ws.name)}</b></span><span class="cmd-item-shortcut">${ws.id === currentWorkspaceId ? "Active" : "Jump"}</span>`;
      el.onclick = () => {
        closeCommandPalette();
        switchWorkspace(ws.id);
      };
      cmdPaletteList.appendChild(el);
    });
  }

  // 2. Labels / Tags (Quick Filter)
  const allTags = new Set();
  allNotes.forEach((n) => {
    if (n.tags && Array.isArray(n.tags)) {
      n.tags.forEach((t) => allTags.add(t.replace(/^#/, "")));
    }
  });
  const matchedTags = Array.from(allTags).filter((t) => t.toLowerCase().includes(q.replace(/^#/, "")));
  if (matchedTags.length > 0) {
    const tagHeader = document.createElement("div");
    tagHeader.className = "cmd-group-label";
    tagHeader.textContent = "Labels";
    cmdPaletteList.appendChild(tagHeader);

    matchedTags.slice(0, 6).forEach((tag) => {
      const el = document.createElement("div");
      el.className = "cmd-item";
      el.innerHTML = `<span>Filter by Label: <b>#${escapeHtml(tag)}</b></span><span class="cmd-item-shortcut">Filter</span>`;
      el.onclick = () => {
        closeCommandPalette();
        activeSearchFlairs.clear();
        activeSearchFlairs.add(`#${tag}`);
        renderActiveFlairs();
        renderNotesGrid();
      };
      cmdPaletteList.appendChild(el);
    });
  }

  // 3. Actions
  const systemActions = [
    { label: "New Note", shortcut: "C", action: () => { expandComposer(); composerTitleInput.focus(); } },
    { label: "New Checklist", shortcut: "L", action: () => { expandComposer(); composerChecklistToggleBtn.click(); } },
    { label: "Cycle Grid Density", shortcut: "D", action: () => cycleGridDensity() },
    { label: "Storage & Attachment Inspector", shortcut: "⌘I", action: () => openStorageInspector() },
    { label: "View: All Notes", shortcut: "G N", action: () => navNotes.click() },
    { label: "View: Archive", shortcut: "G A", action: () => navArchive.click() },
    { label: "View: Trash", shortcut: "G T", action: () => navTrash.click() },
    { label: "View: Vault", shortcut: "G V", action: () => navVault.click() },
    { label: "CLI & Piped Drops", shortcut: ">_", action: () => headerCliBtn.click() },
    { label: "Export Full ZIP Backup", shortcut: "⌘E", action: () => btnExportBackup.click() },
    { label: "Empty Trash Now", shortcut: "DEL", action: () => emptyTrash() },
  ];

  const matchedActions = systemActions.filter((a) => a.label.toLowerCase().includes(q));
  if (matchedActions.length > 0) {
    const lbl = document.createElement("div");
    lbl.className = "cmd-group-label";
    lbl.textContent = "Actions";
    cmdPaletteList.appendChild(lbl);

    matchedActions.forEach((item) => {
      const el = document.createElement("div");
      el.className = "cmd-item";
      el.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="cmd-item-shortcut">${item.shortcut}</span>`;
      el.onclick = () => {
        closeCommandPalette();
        item.action();
      };
      cmdPaletteList.appendChild(el);
    });
  }

  // Matched Notes
  const matchedNotes = allNotes
    .filter((n) => !n.is_trash && ((n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q)))
    .slice(0, 8);

  if (matchedNotes.length > 0) {
    const lbl = document.createElement("div");
    lbl.className = "cmd-group-label";
    lbl.textContent = "Notes";
    cmdPaletteList.appendChild(lbl);

    matchedNotes.forEach((n) => {
      const el = document.createElement("div");
      el.className = "cmd-item";
      el.innerHTML = `
        <span style="text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:440px;">
          ${escapeHtml(n.title || n.content.replace(/<[^>]*>/g, "").slice(0, 45) || "Untitled Note")}
        </span>
        <span class="cmd-item-shortcut">${n.attachments?.length ? "📎" : ""}</span>
      `;
      el.onclick = () => {
        closeCommandPalette();
        openEditModal(n.id);
      };
      cmdPaletteList.appendChild(el);
    });
  }
}

// ── QR Code Sharing Modal ──────────────────────────────────────────────────
function showQRCode(note) {
  const shareText = `${window.location.origin}/#note-${note.id}\n\n${note.title || ""}\n${note.content || ""}`.trim();
  qrModalTitle.textContent = note.title ? `Scan: ${note.title}` : "Scan Note on Mobile";
  qrModalUrlText.textContent = shareText.slice(0, 160) + (shareText.length > 160 ? "..." : "");
  qrCodeSvgContainer.innerHTML = createQRCodeSVG(shareText, 220);

  qrCopyBtn.onclick = async () => {
    await copyToClipboard(shareText);
    showToast("Note content copied to clipboard");
  };

  qrModalBackdrop.style.display = "flex";
}

// ── ZIP Archive Peek Modal ─────────────────────────────────────────────────
async function openArchivePeek(attachmentId, filename) {
  archivePeekAttachmentId = attachmentId;
  archivePeekFilename = filename;
  archivePeekTitle.textContent = `Contents of ${filename}`;
  archivePeekMeta.textContent = "Reading ZIP archive metadata in RAM...";
  archiveFilterInput.value = "";
  archivePeekTbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:16px;">Loading archive index...</td></tr>`;
  archivePeekBackdrop.style.display = "flex";

  try {
    const res = await fetch(`/api/files/${attachmentId}/zip-list`, { headers: vaultHeaders() });
    if (res.ok) {
      archivePeekFiles = await res.json();
      archivePeekMeta.textContent = `${archivePeekFiles.length} files found inside archive`;
      renderArchivePeekRows("");
    } else {
      archivePeekMeta.textContent = "Could not parse archive contents.";
      archivePeekTbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--danger); padding:16px;">Failed to inspect ZIP.</td></tr>`;
    }
  } catch (err) {
    archivePeekMeta.textContent = "Error reading archive.";
  }
}

function renderArchivePeekRows(query) {
  archivePeekTbody.innerHTML = "";
  const q = (query || "").toLowerCase().trim();
  const filtered = archivePeekFiles.filter((f) => f.filename.toLowerCase().includes(q));

  if (filtered.length === 0) {
    archivePeekTbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:16px; color:var(--text-muted);">No matching files</td></tr>`;
    return;
  }

  filtered.forEach((f) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="word-break:break-all;">${escapeHtml(f.filename)}</td>
      <td style="font-family:var(--mono); color:var(--text-muted);">${formatBytes(f.size)}</td>
      <td>
        <a href="/api/files/${archivePeekAttachmentId}/zip-extract?filename=${encodeURIComponent(f.filename)}" class="btn-secondary" style="padding:2px 8px; font-size:11px; text-decoration:none;">Extract</a>
      </td>
    `;
    archivePeekTbody.appendChild(tr);
  });
}

function normalizeNote(n) {
  n.text = n.text || n.content || "";
  n.content = n.text;
  n.workspace = n.workspace || "default";
  n.pinned = Boolean(n.pinned ?? n.is_pinned);
  n.is_pinned = n.pinned;
  n.archived = Boolean(n.archived ?? n.is_archived);
  n.is_archived = n.archived;
  n.trashed = Boolean(n.trashed ?? n.is_trash);
  n.is_trash = n.trashed;
  n.is_checklist = Boolean(n.is_checklist || (n.checklist && n.checklist.length > 0));
  return n;
}

// ── API Operations ─────────────────────────────────────────────────────────
async function loadNotes(showLoading = true) {
  try {
    const res = await fetch("/api/notes?view=all", { headers: vaultHeaders() });
    if (res.ok) {
      const raw = await res.json();
      allNotes = (Array.isArray(raw) ? raw : []).map(normalizeNote);
      renderSidebarTags();
      renderNotesGrid();
      // Keep local sync revision aligned with backend
      fetch("/api/sync-token", { headers: vaultHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.revision === "number") clientSyncRevision = d.revision; })
        .catch(() => {});
    }
  } catch (err) {
    console.error("Failed to load notes:", err);
  }
}

async function updateStats() {
  try {
    const res = await fetch("/api/stats", { headers: vaultHeaders() });
    if (res.ok) {
      const stats = await res.json();
      const ramUsed = Number(stats.ram_used ?? stats.used ?? stats.ram_bytes ?? 0);
      const ramTotal = Number(stats.ram_total ?? stats.total ?? 1024 * 1024 * 1024);
      const persistUsed = Number(stats.persist_used ?? stats.disk_used ?? stats.persist_bytes ?? 0);
      const persistTotal = Number(stats.persist_total ?? stats.disk_total ?? 0);
      const ramPct = ramTotal > 0 ? Math.min(100, Math.max(0, (ramUsed / ramTotal) * 100)) : 0;

      if (ramUsageText) {
        ramUsageText.textContent = `${formatBytes(ramUsed)} RAM`;
      }
      if (ramPill) {
        const persistInfo = stats.persist_available
          ? `\nDisk (/persist): ${formatBytes(persistUsed)}${persistTotal ? ` / ${formatBytes(persistTotal)}` : ""}`
          : "\nDisk (/persist): Not mounted";
        ramPill.title = `In RAM (/data tmpfs): ${formatBytes(ramUsed)}${ramTotal ? ` / ${formatBytes(ramTotal)}` : ""}${persistInfo}\nActive: ${stats.active_count || 0} | Trash: ${stats.trashed_count || 0}\nClick to open Storage & Attachment Inspector`;
      }

      if (sidebarRamText) {
        sidebarRamText.textContent = `In RAM: ${formatBytes(ramUsed)}`;
      }
      if (sidebarRamFill) {
        sidebarRamFill.style.width = `${ramPct.toFixed(1)}%`;
      }
      if (sidebarRamPill) {
        sidebarRamPill.title = `In RAM (/data tmpfs): ${formatBytes(ramUsed)} / ${formatBytes(ramTotal)} (${ramPct.toFixed(1)}%)\nClick to open Storage & Attachment Inspector`;
      }

      if (storageInspectorBackdrop && storageInspectorBackdrop.style.display === "flex") {
        renderStorageInspector(stats);
      }
    }
  } catch (err) {
    // ignore
  }
}

async function openStorageInspector() {
  if (!storageInspectorBackdrop) return;
  storageInspectorBackdrop.style.display = "flex";
  if (storageInspectorBody) {
    storageInspectorBody.innerHTML = `<div style="text-align:center; padding:32px; color:var(--text-muted); font-size:13px;">Loading storage telemetry...</div>`;
  }
  try {
    const res = await fetch("/api/stats?orphans=true", { headers: vaultHeaders() });
    if (res.ok) {
      const stats = await res.json();
      renderStorageInspector(stats);
    } else {
      if (storageInspectorBody) {
        storageInspectorBody.innerHTML = `<div style="text-align:center; padding:32px; color:var(--danger); font-size:13px;">Failed to load storage telemetry.</div>`;
      }
    }
  } catch (err) {
    if (storageInspectorBody) {
      storageInspectorBody.innerHTML = `<div style="text-align:center; padding:32px; color:var(--danger); font-size:13px;">Error loading storage metrics: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function closeStorageInspector() {
  if (storageInspectorBackdrop) {
    storageInspectorBackdrop.style.display = "none";
  }
}

function renderStorageInspector(stats) {
  if (!storageInspectorBody) return;

  const ramUsed = Number(stats.ram_used ?? stats.used ?? stats.ram_bytes ?? 0);
  const ramTotal = Number(stats.ram_total ?? stats.total ?? 1024 * 1024 * 1024);
  const ramPct = ramTotal > 0 ? Math.min(100, Math.max(0, (ramUsed / ramTotal) * 100)) : 0;

  const activeNotesBytes = Number(stats.active_notes_bytes || 0);
  const activeNotesCount = Number(stats.active_count || 0);
  const attBytes = Number(stats.total_files_bytes || stats.active_attachments_bytes || 0);
  const attCount = Number(stats.total_files_count || 0);
  const trashBytes = Number(stats.trash_total_bytes || stats.trashed_notes_bytes || 0);
  const trashCount = Number(stats.trashed_count || 0);

  const persistUsed = Number(stats.persist_used ?? stats.disk_used ?? stats.persist_bytes ?? 0);
  const persistTotal = Number(stats.persist_total ?? stats.disk_total ?? 0);
  const persistNotesCount = Number(stats.persist_count || 0);
  const isPersistMounted = Boolean(stats.persist_available);

  const workspaces = Array.isArray(stats.workspaces) ? stats.workspaces : [];
  const topAttachments = Array.isArray(stats.top_attachments) ? stats.top_attachments : [];
  const orphanedCount = Number(stats.orphaned_count || 0);
  const orphanedBytes = Number(stats.orphaned_bytes || 0);

  let html = `
    <!-- 1. Volatile RAM (tmpfs /data) -->
    <div class="inspector-section">
      <div class="inspector-sec-head">
        <span class="inspector-sec-title">
          <svg style="width:14px;height:14px;fill:currentColor;" viewBox="0 0 24 24"><path d="M4 6h16v12H4z"/></svg>
          Volatile RAM (tmpfs /data)
        </span>
        <span class="inspector-sec-badge">${formatBytes(ramUsed)} / ${formatBytes(ramTotal)} (${ramPct.toFixed(1)}%)</span>
      </div>
      <div class="inspector-progress-track">
        <div class="inspector-progress-fill" style="width: ${ramPct.toFixed(1)}%;"></div>
      </div>
      <div class="inspector-grid-3">
        <div class="inspector-stat-card">
          <span class="inspector-stat-label">Active Notes</span>
          <span class="inspector-stat-val">${formatBytes(activeNotesBytes)}</span>
          <span class="inspector-stat-sub">${activeNotesCount} notes</span>
        </div>
        <div class="inspector-stat-card">
          <span class="inspector-stat-label">Attachments</span>
          <span class="inspector-stat-val">${formatBytes(attBytes)}</span>
          <span class="inspector-stat-sub">${attCount} files</span>
        </div>
        <div class="inspector-stat-card">
          <span class="inspector-stat-label">Trash (Pending)</span>
          <span class="inspector-stat-val">${formatBytes(trashBytes)}</span>
          <span class="inspector-stat-sub">${trashCount} notes</span>
        </div>
      </div>
      <div class="inspector-footnote">* Note: RAM tmpfs and Trash are auto-purged on container restart & 7-day retention.</div>
    </div>

    <!-- 2. Persisted Storage (/persist) -->
    <div class="inspector-section">
      <div class="inspector-sec-head">
        <span class="inspector-sec-title">
          <svg style="width:14px;height:14px;fill:currentColor;" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
          Persisted Storage (/persist)
        </span>
        <span class="inspector-sec-badge" style="${isPersistMounted ? 'color:#81c995; background:rgba(129,201,149,0.1); border-color:rgba(129,201,149,0.25);' : 'color:#f28b82; background:rgba(242,139,130,0.1); border-color:rgba(242,139,130,0.25);'}">
          ${isPersistMounted ? 'Mounted & Active' : 'Not Mounted'}
        </span>
      </div>
      <div class="inspector-grid-3" style="grid-template-columns: repeat(2, 1fr);">
        <div class="inspector-stat-card">
          <span class="inspector-stat-label">Disk Usage</span>
          <span class="inspector-stat-val">${isPersistMounted ? formatBytes(persistUsed) + (persistTotal ? ` / ${formatBytes(persistTotal)}` : "") : "N/A"}</span>
          <span class="inspector-stat-sub">${isPersistMounted ? "Persistent volume on host" : "Volume mount missing"}</span>
        </div>
        <div class="inspector-stat-card">
          <span class="inspector-stat-label">Shielded Notes</span>
          <span class="inspector-stat-val">${persistNotesCount} notes</span>
          <span class="inspector-stat-sub">Persisted to disk safely</span>
        </div>
      </div>
    </div>

    <!-- 3. Workspace Storage -->
    <div class="inspector-section">
      <div class="inspector-sec-head">
        <span class="inspector-sec-title">Workspace Storage</span>
        <span class="inspector-sec-badge">${workspaces.length} Workspaces</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${workspaces.map(ws => `
          <div class="inspector-item-row">
            <div class="inspector-item-info">
              <span class="inspector-item-name">${escapeHtml(ws.name)}</span>
              <span class="inspector-item-meta">
                <span>${ws.active_notes} active notes</span>
                <span>•</span>
                <span>${ws.attachments_count} files (${formatBytes(ws.bytes)})</span>
              </span>
            </div>
            <div class="inspector-actions-cell">
              <span class="inspector-stat-sub">${ws.total_notes} total</span>
            </div>
          </div>
        `).join("")}
      </div>
    </div>

    <!-- 4. Top 3 Largest Attachments -->
    <div class="inspector-section">
      <div class="inspector-sec-head">
        <span class="inspector-sec-title">Top 3 Largest Attachments</span>
        <span class="inspector-sec-badge">${topAttachments.length} Tracked</span>
      </div>
      ${topAttachments.length > 0 ? `
        <div style="display:flex; flex-direction:column; gap:6px;">
          ${topAttachments.map(att => `
            <div class="inspector-item-row">
              <div class="inspector-item-info">
                <span class="inspector-item-name">${escapeHtml(att.filename)}</span>
                <span class="inspector-item-meta">
                  <span>Note: "${escapeHtml(att.note_title)}"</span>
                  <span>•</span>
                  <span style="font-family:var(--mono); color:#fff; font-weight:600;">${formatBytes(att.size)}</span>
                </span>
              </div>
              <div class="inspector-actions-cell">
                <button class="btn-secondary inspector-jump-btn" data-note-id="${att.note_id}" style="padding:4px 10px; font-size:11.5px;">Jump</button>
                <button class="btn-danger inspector-del-att-btn" data-note-id="${att.note_id}" data-att-id="${att.id}" style="padding:4px 10px; font-size:11.5px;">Delete</button>
              </div>
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="clean-healthy-box">No attachments currently stored.</div>
      `}
    </div>

    <!-- 5. Orphaned Files Detector -->
    <div class="inspector-section">
      <div class="inspector-sec-head">
        <span class="inspector-sec-title">Orphaned Files Detector</span>
      </div>
      ${orphanedCount > 0 ? `
        <div class="orphan-alert-box">
          <div>
            <strong>⚠️ ${orphanedCount} Orphaned File${orphanedCount > 1 ? "s" : ""} Detected</strong>
            <div style="font-size:11.5px; opacity:0.9; margin-top:2px;">
              Occupying ${formatBytes(orphanedBytes)} unreferenced in storage (/data or /persist).
            </div>
          </div>
          <button class="btn-danger" id="inspector-purge-btn" style="padding:6px 14px; font-size:12px; white-space:nowrap;">
            Purge Orphans
          </button>
        </div>
      ` : `
        <div class="clean-healthy-box">
          <svg style="width:16px;height:16px;fill:currentColor;flex-shrink:0;" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          <span>All clean! No unreferenced or orphaned files detected in tmpfs RAM or disk storage.</span>
        </div>
      `}
    </div>
  `;

  storageInspectorBody.innerHTML = html;

  // Wire Jump buttons
  storageInspectorBody.querySelectorAll(".inspector-jump-btn").forEach(btn => {
    btn.onclick = () => {
      const noteId = btn.dataset.noteId;
      closeStorageInspector();
      if (noteId) {
        openEditModal(noteId);
      }
    };
  });

  // Wire Delete Attachment buttons
  storageInspectorBody.querySelectorAll(".inspector-del-att-btn").forEach(btn => {
    btn.onclick = async () => {
      const noteId = btn.dataset.noteId;
      const attId = btn.dataset.attId;
      if (!confirm("Delete this attachment from the note to free storage?")) return;
      try {
        const res = await fetch(`/api/notes/${noteId}/attachments/${attId}`, {
          method: "DELETE",
          headers: vaultHeaders()
        });
        if (res.ok) {
          showToast("Attachment deleted");
          await loadNotes(false);
          await updateStats();
        } else {
          showToast("Failed to delete attachment");
        }
      } catch (err) {
        showToast("Error deleting attachment");
      }
    };
  });

  // Wire Purge Orphans button
  const purgeBtn = storageInspectorBody.querySelector("#inspector-purge-btn");
  if (purgeBtn) {
    purgeBtn.onclick = async () => {
      purgeBtn.disabled = true;
      purgeBtn.textContent = "Purging...";
      try {
        const res = await fetch("/api/stats/purge-orphans", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...vaultHeaders() }
        });
        if (res.ok) {
          const result = await res.json();
          showToast(`Purged ${result.purged_count} orphaned file(s) (reclaimed ${formatBytes(result.reclaimed_bytes)})`);
          await loadNotes(false);
          await updateStats();
        } else {
          showToast("Failed to purge orphaned files");
        }
      } catch (err) {
        showToast("Error purging orphaned files");
      }
    };
  }
}

const fetchStats = updateStats;

async function toggleNotePin(noteId, isPinned) {
  const note = allNotes.find((n) => n.id === noteId);
  if (note) {
    note.is_pinned = isPinned;
    note.pinned = isPinned;
  }
  renderNotesGrid();
  fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ pinned: isPinned, is_pinned: isPinned }),
  }).catch((err) => console.error("Pin save error:", err));
}

async function updateNoteColor(noteId, color) {
  const note = allNotes.find((n) => n.id === noteId);
  if (note) note.color = color;

  const card = document.querySelector(`.card[data-id="${noteId}"]`);
  if (card) {
    const pal = paletteFor(color);
    card.className = card.className.replace(/\bnote-color-\S+/g, "").trim();
    card.classList.add(`note-color-${pal.name}`);
    card.style.backgroundColor = pal.bg;
    card.style.borderColor = pal.border;
    const fadeEl = card.querySelector(".card-content-fade");
    if (fadeEl) {
      fadeEl.style.background = `linear-gradient(to bottom, transparent, ${pal.bg})`;
    }
    const popover = card.querySelector(".color-popover");
    if (popover) popover.classList.remove("show");
  }

  fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ color }),
  }).catch((err) => console.error("Color save error:", err));
}

async function togglePersistNote(noteId) {
  const res = await fetch(`/api/notes/${noteId}/toggle-persist`, {
    method: "POST",
    headers: vaultHeaders(),
  });
  if (res.ok) {
    const data = await res.json();
    showToast(data.saved_to_disk ? "Saved to persistent disk (/persist)" : "Removed from persistent disk");
    await loadNotes(false);
    await updateStats();
  }
}

async function bumpNote(noteId) {
  const res = await fetch(`/api/notes/${noteId}/bump`, {
    method: "POST",
    headers: vaultHeaders(),
  });
  if (res.ok) {
    showToast("Bumped to top");
    await loadNotes(false);
    await updateStats();
  }
}

function snoozeNotePrompt(noteId) {
  const hours = prompt("Snooze note for how many hours?", "24");
  if (hours && !isNaN(hours)) {
    const until = Math.floor(Date.now() / 1000) + parseFloat(hours) * 3600;
    fetch(`/api/notes/${noteId}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...vaultHeaders() },
      body: JSON.stringify({ snoozed_until: until }),
    }).then(() => {
      showToast(`Snoozed for ${hours} hours`);
      loadNotes(false);
      updateStats();
    });
  }
}

async function toggleNoteArchive(noteId, isArchived) {
  await fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ archived: isArchived, is_archived: isArchived }),
  });
  showToast(isArchived ? "Note archived" : "Note unarchived");
  await loadNotes(false);
  await updateStats();
}

async function trashNote(noteId) {
  try {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: "DELETE",
      headers: vaultHeaders(),
    });
    if (res.ok) {
      showToast("Moved to Trash (7d auto-purge)", async () => {
        await restoreNote(noteId);
      });
      await loadNotes(false);
      await updateStats();
    } else {
      showToast("Failed to move note to Trash");
    }
  } catch (err) {
    showToast("Error moving note to Trash");
  }
}

async function restoreNote(noteId) {
  try {
    const res = await fetch(`/api/notes/${noteId}/restore`, {
      method: "POST",
      headers: vaultHeaders(),
    });
    if (res.ok) {
      showToast("Note restored from Trash");
      await loadNotes(false);
      await updateStats();
    } else {
      showToast("Failed to restore note");
    }
  } catch (err) {
    showToast("Error restoring note");
  }
}

async function deleteForeverNote(noteId) {
  if (!confirm("Permanently delete this note? This cannot be undone.")) return;
  try {
    const res = await fetch(`/api/notes/${noteId}?forever=true`, {
      method: "DELETE",
      headers: vaultHeaders(),
    });
    if (res.ok) {
      showToast("Note permanently deleted");
      await loadNotes(false);
      await updateStats();
    } else {
      showToast("Failed to delete note");
    }
  } catch (err) {
    showToast("Error deleting note");
  }
}

async function emptyTrash() {
  if (!confirm("Permanently delete all notes in Trash? This cannot be undone.")) return;
  try {
    const res = await fetch("/api/trash", { method: "DELETE", headers: vaultHeaders() });
    if (res.ok) {
      showToast("Trash emptied");
      await loadNotes(false);
      await updateStats();
    } else {
      showToast("Failed to empty Trash");
    }
  } catch (err) {
    showToast("Error emptying Trash");
  }
}

async function saveChecklistUpdate(noteId, checklist) {
  const note = allNotes.find((n) => n.id === noteId);
  if (note) note.checklist = checklist;

  const card = document.querySelector(`.card[data-id="${noteId}"]`);
  if (card) {
    const progress = calculateChecklistProgress(checklist);
    if (progress) {
      const fillEl = card.querySelector(".checklist-progress-fill");
      const textEl = card.querySelector(".checklist-progress-text");
      if (fillEl) fillEl.style.width = `${progress.percent}%`;
      if (textEl) textEl.textContent = `${progress.checked}/${progress.total}`;
    }
  }

  fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ checklist }),
  }).catch((err) => console.error("Checklist save error:", err));
}

async function uploadFilesToNote(noteId, files) {
  const formData = new FormData();
  files.forEach((f) => formData.append("files", f));
  await fetch(`/api/notes/${noteId}/attachments`, {
    method: "POST",
    headers: vaultHeaders(),
    body: formData,
  });
  showToast("Attachments uploaded");
  await loadNotes(false);
  await updateStats();
}

async function deleteAttachment(noteId, attachmentId) {
  await fetch(`/api/notes/${noteId}/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: vaultHeaders(),
  });
  showToast("Attachment removed");
  await loadNotes(false);
  await updateStats();
  const updated = allNotes.find((n) => n.id === noteId);
  if (updated) renderModalAttachments(updated.attachments || []);
}

async function renameAttachment(noteId, attachmentId, newFilename) {
  await fetch(`/api/notes/${noteId}/attachments/${attachmentId}/rename`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ filename: newFilename }),
  });
  showToast("Attachment renamed");
  await loadNotes(false);
}

// ── Sidebar Tags Rendering ─────────────────────────────────────────────────
function renderSidebarTags() {
  sidebarTagsList.innerHTML = "";
  const tagCounts = {};
  const activeWs = currentWorkspaceId || "default";
  allNotes.forEach((n) => {
    const noteWs = n.workspace || "default";
    if (noteWs !== activeWs) return;
    if (!n.is_trash && n.tags && Array.isArray(n.tags)) {
      n.tags.forEach((t) => {
        const clean = t.replace("#", "");
        tagCounts[clean] = (tagCounts[clean] || 0) + 1;
      });
    }
  });

  Object.keys(tagCounts).sort().forEach((tag) => {
    const item = document.createElement("div");
    item.className = "nav-item";
    item.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 17H5V7h11l3.55 5L16 17z"/></svg>
      <span>#${escapeHtml(tag)}</span>
      <span style="margin-left:auto; font-size:11px; color:var(--text-muted);">${tagCounts[tag]}</span>
    `;
    item.onclick = () => {
      toggleSearchFlair(`#${tag}`);
    };
    sidebarTagsList.appendChild(item);
  });
}

// ── Vault Auth & Status ────────────────────────────────────────────────────
async function checkVaultStatus() {
  try {
    const res = await fetch("/api/vault/status");
    if (res.ok) {
      const data = await res.json();
      vaultConfigured = Boolean(data.configured);
      updateVaultUI();
    }
  } catch (err) {
    // ignore
  }
}

function updateVaultUI() {
  vaultNavText.textContent = "Vault";
  if (vaultUnlocked) {
    vaultNavIcon.innerHTML = `<path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>`;
  } else {
    vaultNavIcon.innerHTML = `<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>`;
  }

  // Vault banners in Vault view
  if (currentNavView === "vault") {
    if (!vaultConfigured) {
      vaultSetupBanner.style.display = "flex";
      vaultLockedBanner.style.display = "none";
      vaultUnlockedToolbar.style.display = "none";
      composerContainer.style.display = "none";
    } else if (!vaultUnlocked) {
      vaultSetupBanner.style.display = "none";
      vaultLockedBanner.style.display = "flex";
      vaultUnlockedToolbar.style.display = "none";
      composerContainer.style.display = "none";
    } else {
      vaultSetupBanner.style.display = "none";
      vaultLockedBanner.style.display = "none";
      vaultUnlockedToolbar.style.display = "flex";
      composerContainer.style.display = "block";
    }
  } else {
    vaultSetupBanner.style.display = "none";
    vaultLockedBanner.style.display = "none";
    vaultUnlockedToolbar.style.display = "none";
    composerContainer.style.display = (currentNavView === "notes") ? "block" : "none";
  }
}

function promptVaultPassword(isSetup = false, onSuccess = null) {
  vaultModalTitle.textContent = isSetup ? "Set Vault Master Password" : "Unlock Vault";
  vaultModalDesc.textContent = isSetup
    ? "Create a master password using PBKDF2-SHA256 to protect your secret notes:"
    : "Enter your master password to unlock protected notes for this session:";
  vaultModalPassword.value = "";
  vaultModalError.style.display = "none";
  vaultModalSubmitBtn.textContent = isSetup ? "Set Password" : "Unlock";
  vaultModalBackdrop.style.display = "flex";
  vaultModalPassword.focus();

  vaultModalPassword.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      vaultModalSubmitBtn.click();
    }
  };

  vaultModalSubmitBtn.onclick = async () => {
    const pw = vaultModalPassword.value;
    if (!pw) return;

    if (isSetup) {
      const res = await fetch("/api/vault/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        showToast("Vault password configured");
        vaultConfigured = true;
        vaultModalBackdrop.style.display = "none";
        promptVaultPassword(false, onSuccess);
      } else {
        vaultModalError.textContent = "Failed to set password";
        vaultModalError.style.display = "block";
      }
    } else {
      const res = await fetch("/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        const data = await res.json();
        vaultToken = data.token;
        sessionStorage.setItem("keepboard_vault_token", vaultToken);
        vaultUnlocked = true;
        vaultModalBackdrop.style.display = "none";
        showToast("Vault unlocked");
        updateVaultUI();
        await loadNotes();
        if (typeof onSuccess === "function") {
          onSuccess();
        }
      } else {
        vaultModalError.textContent = "Incorrect master password";
        vaultModalError.style.display = "block";
      }
    }
  };
}

// ── Event Listeners Setup ──────────────────────────────────────────────────
function setupEventListeners() {
  // ── Delegated Grid Card Event Handlers ───────────────────────────────────
  notesGridRoot.addEventListener("click", async (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const noteId = card.dataset.id;
    const note = allNotes.find((n) => n.id === noteId);
    if (!note) return;

    const actionEl = e.target.closest("[data-action]");
    if (actionEl) {
      e.stopPropagation();
      const action = actionEl.dataset.action;
      switch (action) {
        case "select":
          toggleCardSelection(noteId, e.shiftKey);
          return;
        case "copy": {
          const textToCopy = `${note.title ? note.title + "\n\n" : ""}${note.content || ""}`.trim();
          if (textToCopy) {
            copyToClipboard(textToCopy);
            showToast("Note copied to clipboard");
          }
          return;
        }
        case "pin":
          toggleNotePin(noteId, !note.is_pinned);
          return;
        case "expand": {
          const clampedWrapper = card.querySelector(".card-content-clamped");
          if (clampedWrapper) {
            const isExp = clampedWrapper.classList.toggle("expanded");
            actionEl.textContent = isExp ? "Show less" : "Show more";
          }
          return;
        }
        case "open-all-tabs": {
          if (note.content) {
            const matches = note.content.match(/https?:\/\/[^\s<>"'()]+/g);
            if (matches) {
              matches.forEach((u) => window.open(u, "_blank"));
            }
          }
          return;
        }
        case "uncheck-all": {
          if (note.checklist) {
            const updated = uncheckAllItems(note.checklist);
            saveChecklistUpdate(noteId, updated);
            card.querySelectorAll(".checklist-item").forEach((it) => it.classList.remove("checked"));
            card.querySelectorAll(".checklist-checkbox").forEach((cb) => (cb.checked = false));
          }
          return;
        }
        case "delete-checked": {
          if (note.checklist) {
            const updated = deleteCheckedItems(note.checklist);
            saveChecklistUpdate(noteId, updated);
            card.querySelectorAll(".checklist-item.checked").forEach((it) => it.remove());
          }
          return;
        }
        case "peek-zip": {
          const attId = actionEl.dataset.attId;
          const attName = actionEl.dataset.attName;
          if (attId) openArchivePeek(attId, attName);
          return;
        }
        case "rename-att": {
          const attId = actionEl.dataset.attId;
          const attName = actionEl.dataset.attName;
          if (attId) {
            const newName = prompt("Rename attachment:", attName);
            if (newName && newName.trim() && newName !== attName) {
              await renameAttachment(noteId, attId, newName.trim());
            }
          }
          return;
        }
        case "filter-tag": {
          const tag = actionEl.dataset.tag;
          if (tag) toggleSearchFlair(tag);
          return;
        }
        case "color-popover": {
          const popover = card.querySelector(".color-popover");
          if (popover) {
            document.querySelectorAll(".card-more-popover.show, .card-ws-popover").forEach((p) => p.classList.remove("show"));
            popover.classList.toggle("show");
          }
          return;
        }
        case "restore":
          restoreNote(noteId);
          return;
        case "delete-forever":
          deleteForeverNote(noteId);
          return;
        case "archive":
          toggleNoteArchive(noteId, !note.is_archived);
          return;
        case "split":
          openInSplitWorkspace(noteId);
          return;
        case "trash":
          trashNote(noteId);
          return;
        case "more-popover": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) {
            document.querySelectorAll(".color-popover.show, .card-more-popover.show, .card-ws-popover").forEach((p) => {
              if (p !== popover) p.classList.remove("show");
            });
            popover.classList.toggle("show");
          }
          return;
        }
        case "move-ws": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) popover.classList.remove("show");
          const moreBtn = card.querySelector('[data-action="more-popover"]');
          showMoveWorkspacePopover(noteId, moreBtn || card);
          return;
        }
        case "labels": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) popover.classList.remove("show");
          openTagPromptModal(async (tag) => {
            if (!tag) return;
            const curTags = new Set(note.tags || []);
            curTags.add(tag);
            await addTagToNote(noteId, Array.from(curTags));
          });
          return;
        }
        case "persist": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) popover.classList.remove("show");
          togglePersistNote(noteId);
          return;
        }
        case "vault": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) popover.classList.remove("show");
          toggleNoteVault(noteId);
          return;
        }
        case "duplicate": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) popover.classList.remove("show");
          duplicateNote(noteId);
          return;
        }
        case "export-md": {
          const popover = card.querySelector(".card-more-popover");
          if (popover) popover.classList.remove("show");
          exportNoteMarkdown(note);
          return;
        }
      }
    }

    if (e.target.closest("button, a, input, .color-popover, .card-more-popover, .workspace-popover")) {
      return;
    }

    if (note.is_trash) {
      showToast("Note is in Trash. Restore it to view or edit.", async () => {
        await restoreNote(note.id);
      });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      openInSplitWorkspace(note.id);
      return;
    }
    openEditModal(note.id);
  });

  // Delegated change listener for checklist checkboxes
  notesGridRoot.addEventListener("change", (e) => {
    if (e.target.matches("input.checklist-checkbox")) {
      e.stopPropagation();
      const card = e.target.closest(".card");
      if (!card) return;
      const noteId = card.dataset.id;
      const note = allNotes.find((n) => n.id === noteId);
      if (!note || !note.checklist) return;

      const idx = parseInt(e.target.dataset.index, 10);
      if (!isNaN(idx) && note.checklist[idx]) {
        note.checklist[idx].checked = e.target.checked;
        const itemEl = e.target.closest(".checklist-item");
        if (itemEl) itemEl.classList.toggle("checked", e.target.checked);
        saveChecklistUpdate(noteId, note.checklist);
      }
    }
  });

  // Navigation
  [navNotes, navArchive, navTrash, navVault].forEach((btn) => {
    if (!btn) return;
    btn.onclick = () => {
      [navNotes, navArchive, navTrash, navVault].forEach((b) => b?.classList.remove("active"));
      btn.classList.add("active");

      if (btn === navNotes) currentNavView = "notes";
      else if (btn === navArchive) currentNavView = "archive";
      else if (btn === navTrash) currentNavView = "trash";
      else if (btn === navVault) {
        currentNavView = "vault";
        if (!vaultConfigured) {
          promptVaultPassword(true);
        } else if (!vaultUnlocked) {
          promptVaultPassword(false);
        }
      }

      trashBanner.style.display = currentNavView === "trash" ? "flex" : "none";
      updateVaultUI();
      renderNotesGrid();
    };
  });

  const sidebarDrawerBackdrop = document.getElementById("sidebar-drawer-backdrop");
  menuToggleBtn.onclick = () => {
    if (window.innerWidth <= 768) {
      const isOpen = sidebar.classList.toggle("drawer-open");
      if (sidebarDrawerBackdrop) sidebarDrawerBackdrop.classList.toggle("show", isOpen);
    } else {
      sidebar.classList.toggle("collapsed");
      mainContent.classList.toggle("sidebar-collapsed");
    }
  };

  if (sidebarDrawerBackdrop) {
    sidebarDrawerBackdrop.onclick = () => {
      sidebar.classList.remove("drawer-open");
      sidebarDrawerBackdrop.classList.remove("show");
    };
  }

  // Close slide-over drawer when selecting view on mobile
  const closeDrawerOnMobile = () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.remove("drawer-open");
      if (sidebarDrawerBackdrop) sidebarDrawerBackdrop.classList.remove("show");
    }
  };
  [navNotes, navArchive, navTrash, navVault].forEach((el) => {
    if (el) el.addEventListener("click", closeDrawerOnMobile);
  });

  // Grid Density Switcher
  densityToggleBtn.onclick = cycleGridDensity;

  // Search and Flairs
  setupSearchFlairs();

  // Multi-Select Batch Actions
  if (selClearBtn) selClearBtn.onclick = clearSelection;
  if (selSelectAllBtn) selSelectAllBtn.onclick = selectAllNotes;

  if (batchPinBtn) {
    batchPinBtn.onclick = () => {
      const allPinned = Array.from(selectedNoteIds).every((id) => allNotes.find((n) => n.id === id)?.is_pinned);
      executeBatchAction(allPinned ? "unpin" : "pin");
    };
  }

  if (batchArchiveBtn) {
    batchArchiveBtn.onclick = () => {
      executeBatchAction(currentNavView === "archive" ? "unarchive" : "archive");
    };
  }

  if (batchMergeBtn) batchMergeBtn.onclick = () => executeBatchAction("merge");

  if (batchDownloadBtn) {
    batchDownloadBtn.onclick = () => {
      const ids = Array.from(selectedNoteIds);
      window.location.href = `/api/notes/export?ids=${ids.join(",")}`;
      clearSelection();
    };
  }

  if (batchTrashBtn) {
    batchTrashBtn.onclick = () => {
      if (currentNavView === "trash") {
        if (confirm("Permanently delete selected notes? This cannot be undone.")) {
          executeBatchAction("delete_forever");
        }
      } else {
        executeBatchAction("trash");
      }
    };
  }

  if (batchRestoreBtn) {
    batchRestoreBtn.onclick = () => executeBatchAction("restore");
  }

  if (batchColorBtn) {
    batchColorBtn.onclick = (e) => {
      e.stopPropagation();
      batchColorPopover.classList.toggle("show");
    };
    renderSwatches(batchColorPopover, (color) => executeBatchAction("color", color));
  }

  if (batchTagBtn) {
    batchTagBtn.onclick = () => {
      openTagPromptModal((tag) => executeBatchAction("tag", tag));
    };
  }

  if (batchWorkspaceBtn) {
    batchWorkspaceBtn.onclick = (e) => {
      e.stopPropagation();
      if (batchWorkspacePopover.style.display === "flex") {
        batchWorkspacePopover.style.display = "none";
      } else {
        showBatchMoveWorkspacePopover();
      }
    };
  }

  // Workspace Switcher (Sidebar)
  workspacePillBtn.onclick = (e) => {
    e.stopPropagation();
    const isVisible = workspaceDropdown.style.display === "flex";
    workspaceDropdown.style.display = isVisible ? "none" : "flex";
    workspacePillBtn.classList.toggle("open", !isVisible);
  };

  workspaceCreateBtn.onclick = async (e) => {
    e.stopPropagation();
    const name = prompt("New workspace name:");
    if (name && name.trim()) {
      try {
        const res = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (res.ok) {
          const newWs = await res.json();
          await loadWorkspaces();
          switchWorkspace(newWs.id);
        } else {
          showToast("Failed to create workspace");
        }
      } catch (err) {
        showToast("Error creating workspace");
      }
    }
    workspaceDropdown.style.display = "none";
    workspacePillBtn.classList.remove("open");
  };

  // Composer Expansion & Collapse
  captureCollapsed.onclick = expandComposer;
  composerCloseBtn.onclick = saveComposerNote;
  composerSaveBtn.onclick = saveComposerNote;

  // Auto-create and save note when clicking outside composer on background
  document.addEventListener("mousedown", (e) => {
    if (captureExpanded && captureExpanded.style.display === "flex") {
      // If clicking inside capture-box or related dialogs, ignore
      if (
        captureBox.contains(e.target) ||
        (tagPromptBackdrop && tagPromptBackdrop.contains(e.target)) ||
        e.target.closest(".toast")
      ) {
        return;
      }
      // Clicked outside on background/canvas/etc. -> auto-create and save note
      saveComposerNote();
    }
  });

  quickChecklistBtn.onclick = (e) => {
    e.stopPropagation();
    expandComposer();
    composerChecklistToggleBtn.click();
  };
  quickAttachBtn.onclick = (e) => {
    e.stopPropagation();
    expandComposer();
    composerAttachBtn.click();
  };

  // Rich-Text Toolbar Controls
  setupCleanPaste(composerRichEditor);
  setupCleanPaste(modalRichEditor);
  setupInlineMath(composerRichEditor);
  setupInlineMath(modalRichEditor);
  setupSmartTyping(composerRichEditor, () => {
    if (!composerIsChecklist) composerChecklistToggleBtn.click();
  });
  setupSmartTyping(modalRichEditor, () => {
    const isCurrentlyChecklist = modalChecklistContainer.style.display !== "none";
    if (!isCurrentlyChecklist) modalChecklistBtn.click();
  });

  composerFmtToggleBtn.onclick = (e) => {
    e.stopPropagation();
    composerFmtToolbar.classList.toggle("show");
  };
  modalFmtToggleBtn.onclick = (e) => {
    e.stopPropagation();
    modalFmtToolbar.classList.toggle("show");
  };

  // WYSIWYG Formatting Buttons Helper
  const bindClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  const bindChange = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onchange = fn;
  };

  // WYSIWYG Formatting Buttons (Composer)
  bindClick("fmt-c-bold", () => formatDoc("bold"));
  bindClick("fmt-c-italic", () => formatDoc("italic"));
  bindClick("fmt-c-underline", () => formatDoc("underline"));
  bindClick("fmt-c-strike", () => formatDoc("strikeThrough"));
  bindClick("fmt-c-hl-yellow", () => formatHighlight("#524816"));
  bindClick("fmt-c-hl-cyan", () => formatHighlight("#16424d"));
  bindClick("fmt-c-hl-pink", () => formatHighlight("#4d1637"));
  bindClick("fmt-c-hl-green", () => formatHighlight("#1a4225"));
  bindClick("fmt-c-hl-orange", () => formatHighlight("#4d2c16"));
  bindClick("fmt-c-ul", () => formatDoc("insertUnorderedList"));
  bindClick("fmt-c-ol", () => formatDoc("insertOrderedList"));
  bindClick("fmt-c-code", () => formatInlineCode());
  bindChange("fmt-c-heading", (e) => applyTextStyle(e.target.value));

  // WYSIWYG Formatting Buttons (Modal)
  bindClick("fmt-m-bold", () => formatDoc("bold"));
  bindClick("fmt-m-italic", () => formatDoc("italic"));
  bindClick("fmt-m-underline", () => formatDoc("underline"));
  bindClick("fmt-m-strike", () => formatDoc("strikeThrough"));
  bindClick("fmt-m-hl-yellow", () => formatHighlight("#524816"));
  bindClick("fmt-m-hl-cyan", () => formatHighlight("#16424d"));
  bindClick("fmt-m-hl-pink", () => formatHighlight("#4d1637"));
  bindClick("fmt-m-hl-green", () => formatHighlight("#1a4225"));
  bindClick("fmt-m-hl-orange", () => formatHighlight("#4d2c16"));
  bindClick("fmt-m-ul", () => formatDoc("insertUnorderedList"));
  bindClick("fmt-m-ol", () => formatDoc("insertOrderedList"));
  bindClick("fmt-m-code", () => formatInlineCode());
  bindChange("fmt-m-heading", (e) => applyTextStyle(e.target.value));

  // Raw Markdown Toggle (Composer)
  if (composerRawToggleBtn) {
    composerRawToggleBtn.onclick = () => {
      composerRawMode = !composerRawMode;
      if (composerRawMode) {
        composerRawTextarea.value = composerRichEditor.innerHTML;
        composerRichEditor.style.display = "none";
        composerRawTextarea.style.display = "block";
        composerRawToggleBtn.classList.add("active");
      } else {
        composerRichEditor.innerHTML = composerRawTextarea.value;
        composerRawTextarea.style.display = "none";
        composerRichEditor.style.display = "block";
        composerRawToggleBtn.classList.remove("active");
      }
    };
  }

  // Raw Markdown Toggle (Modal)
  if (modalRawToggleBtn) {
    modalRawToggleBtn.onclick = () => {
      modalRawMode = !modalRawMode;
      if (modalRawMode) {
        modalRawTextarea.value = modalRichEditor.innerHTML;
        modalRichEditor.style.display = "none";
        modalRawTextarea.style.display = "block";
        modalRawToggleBtn.classList.add("active");
      } else {
        modalRichEditor.innerHTML = modalRawTextarea.value;
        modalRawTextarea.style.display = "none";
        modalRichEditor.style.display = "block";
        modalRawToggleBtn.classList.remove("active");
      }
    };
  }

  // Color Pickers
  renderSwatches(composerColorPopover, (color) => {
    composerColor = color;
    const cPal = paletteFor(color);
    captureBox.style.backgroundColor = cPal.bg;
    captureBox.style.borderColor = cPal.border;
  });
  composerColorBtn.onclick = (e) => {
    e.stopPropagation();
    composerColorPopover.classList.toggle("show");
  };

  renderSwatches(modalColorPopover, (color) => {
    modalColor = color;
    const mPal = paletteFor(color);
    editModalCard.style.backgroundColor = mPal.bg;
    editModalCard.style.borderColor = mPal.border;
  });
  modalColorBtn.onclick = (e) => {
    e.stopPropagation();
    modalColorPopover.classList.toggle("show");
  };

  // Checklists in Composer
  composerChecklistToggleBtn.onclick = () => {
    composerIsChecklist = !composerIsChecklist;
    composerChecklistToggleBtn.classList.toggle("active", composerIsChecklist);
    if (composerIsChecklist) {
      const text = composerRichEditor.innerText || composerRichEditor.textContent || "";
      composerChecklistItems = convertTextToChecklist(text);
      if (composerChecklistItems.length === 0) {
        composerChecklistItems.push({ text: "", checked: false, indent: 0 });
      }
      composerRichEditor.style.display = "none";
      composerRawTextarea.style.display = "none";
      composerChecklistContainer.style.display = "block";
      renderChecklistEditor(composerChecklistContainer, composerChecklistItems, (updated) => {
        composerChecklistItems = updated;
      });
    } else {
      const text = convertChecklistToText(composerChecklistItems);
      composerRichEditor.innerHTML = text;
      composerChecklistContainer.style.display = "none";
      composerRichEditor.style.display = "block";
      composerChecklistItems = [];
    }
  };

  // File Attachments in Composer
  composerAttachBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    composerFileInput.click();
  };
  composerFileInput.onchange = (e) => {
    e.preventDefault();
    if (composerFileInput.files.length > 0) {
      Array.from(composerFileInput.files).forEach((f) => composerPendingFiles.push(f));
      renderComposerPendingFiles();
      composerFileInput.value = "";
    }
  };

  // Modal Attachments
  modalAttachBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalFileInput.click();
  };
  modalFileInput.onchange = async (e) => {
    e.preventDefault();
    if (modalFileInput.files.length > 0 && currentEditingNoteId) {
      await uploadFilesToNote(currentEditingNoteId, Array.from(modalFileInput.files));
      modalFileInput.value = "";
      const updated = allNotes.find((n) => n.id === currentEditingNoteId);
      if (updated) renderModalAttachments(updated.attachments || []);
    }
  };

  // Modal Checklists Toggle
  modalChecklistBtn.onclick = () => {
    const isCurrentlyChecklist = modalChecklistContainer.style.display !== "none";
    if (isCurrentlyChecklist) {
      const text = convertChecklistToText(modalChecklistItems);
      modalRichEditor.innerHTML = text;
      modalChecklistContainer.style.display = "none";
      modalRichEditor.style.display = "block";
      modalChecklistItems = [];
    } else {
      const text = modalRichEditor.innerText || modalRichEditor.textContent || "";
      modalChecklistItems = convertTextToChecklist(text);
      if (modalChecklistItems.length === 0) {
        modalChecklistItems = [{ text: "", checked: false }];
      }
      modalRichEditor.style.display = "none";
      modalChecklistContainer.style.display = "block";
      renderChecklistEditor(modalChecklistContainer, modalChecklistItems, (updated) => {
        modalChecklistItems = updated;
      });
    }
  };


  // Modal Shield Toggle
  modalShieldBtn.onclick = async () => {
    if (!currentEditingNoteId) return;
    const note = allNotes.find((n) => n.id === currentEditingNoteId);
    if (!note) return;
    const newSaved = !note.saved_to_disk;
    note.saved_to_disk = newSaved;
    modalShieldBtn.classList.toggle("active", newSaved);
    modalShieldBtn.title = newSaved ? "Remove from persistent disk" : "Save to persistent disk (/persist)";
    const modalStorageBadge = document.getElementById("modal-storage-badge");
    updateStorageBadge(modalStorageBadge, newSaved);
    await fetch(`/api/notes/${note.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...vaultHeaders() },
      body: JSON.stringify({ saved_to_disk: newSaved }),
    });
    showToast(newSaved ? "Saved to persistent disk (/persist)" : "Removed from persistent disk");
    renderNotesGrid();
  };

  // Modal Labels Prompt
  modalTagBtn.onclick = () => {
    openTagPromptModal((tag) => {
      modalTags.add(tag);
      renderModalTags();
    });
  };

  // Modal Move to Workspace
  modalWorkspaceBtn.onclick = (e) => {
    e.stopPropagation();
    if (modalWorkspacePopover.classList.contains("show")) {
      modalWorkspacePopover.classList.remove("show");
      return;
    }
    modalWorkspacePopover.innerHTML = "";
    allWorkspaces.forEach((ws) => {
      const item = document.createElement("button");
      item.className = "workspace-item-row";
      item.textContent = ws.name;
      item.onclick = async (ev) => {
        ev.stopPropagation();
        modalWorkspacePopover.classList.remove("show");
        if (currentEditingNoteId) {
          await moveNoteToWorkspace(currentEditingNoteId, ws.id);
          closeEditModal();
        }
      };
      modalWorkspacePopover.appendChild(item);
    });
    modalWorkspacePopover.classList.add("show");
  };

  // Tags Prompt
  composerTagBtn.onclick = () => {
    openTagPromptModal((tag) => {
      composerTags.add(tag);
      renderComposerTags();
    });
  };

  if (modalPinBtn) {
    modalPinBtn.onclick = () => {
      modalIsPinned = !modalIsPinned;
      modalPinBtn.style.color = modalIsPinned ? "var(--accent)" : "inherit";
    };
  }

  if (modalOutlineToggleBtn) {
    modalOutlineToggleBtn.onclick = () => {
      if (modalOutlineRail) modalOutlineRail.classList.toggle("collapsed");
    };
  }

  if (modalBesideBtn) {
    modalBesideBtn.onclick = () => {
      if (editModalCard.classList.contains("side-by-side")) {
        closeSideBySideMode();
      } else {
        openSideBySideMode();
      }
    };
  }

  if (modalSplitBtn) {
    modalSplitBtn.onclick = () => {
      if (editModalCard.classList.contains("side-by-side")) {
        closeSideBySideMode();
      } else {
        openSideBySideMode();
      }
    };
  }

  if (modalHeaderCloseBtn) {
    modalHeaderCloseBtn.onclick = () => closeEditModal();
  }

  if (modal2CloseBtn) {
    modal2CloseBtn.onclick = () => closeSideBySideMode();
  }

  if (modal2ChangeBtn) {
    modal2ChangeBtn.onclick = () => showSecondNotePicker();
  }

  if (modal2Search) {
    modal2Search.oninput = () => renderSecondNotePickerList(modal2Search.value.trim());
  }

  if (modal2TitleInput) {
    modal2TitleInput.oninput = debouncedSaveSecondNote;
  }

  if (modal2RichEditor) {
    setupCleanPaste(modal2RichEditor);
    setupInlineMath(modal2RichEditor);
    modal2RichEditor.oninput = debouncedSaveSecondNote;
  }

  editModalBackdrop.addEventListener("click", (e) => {
    if (e.target === editModalBackdrop) {
      closeEditModal();
    }
  });

  if (modalVaultBtn) {
    modalVaultBtn.onclick = () => {
      if (currentEditingNoteId) toggleNoteVault(currentEditingNoteId);
    };
  }

  if (modalQrBtn) {
    modalQrBtn.onclick = () => {
      const note = allNotes.find((n) => n.id === currentEditingNoteId);
      if (note) showQRCode(note);
    };
  }

  modalDuplicateBtn.onclick = async () => {
    if (!currentEditingNoteId) return;
    const res = await fetch(`/api/notes/${currentEditingNoteId}/duplicate`, {
      method: "POST",
      headers: vaultHeaders(),
    });
    if (res.ok) {
      showToast("Note duplicated");
      closeEditModal();
      await loadNotes();
    }
  };

  modalArchiveBtn.onclick = async () => {
    if (!currentEditingNoteId) return;
    const note = allNotes.find((n) => n.id === currentEditingNoteId);
    if (note) {
      await toggleNoteArchive(note.id, !note.is_archived);
      closeEditModal();
    }
  };

  modalTrashBtn.onclick = async () => {
    if (!currentEditingNoteId) return;
    const note = allNotes.find((n) => n.id === currentEditingNoteId);
    if (note && (note.is_trash || note.trashed)) {
      await deleteForeverNote(currentEditingNoteId);
    } else {
      await trashNote(currentEditingNoteId);
    }
    closeEditModal();
  };

  modalCloseBtn.onclick = closeEditModal;

  // Split Workspace
  splitCloseBtn.onclick = () => {
    closeAllSplitPanes();
    loadNotes(false);
  };

  // CLI Modal Snippets
  headerCliBtn.onclick = () => (cliModalBackdrop.style.display = "flex");
  cliCloseBtn.onclick = () => (cliModalBackdrop.style.display = "none");
  cliDoneBtn.onclick = () => (cliModalBackdrop.style.display = "none");
  cliCopy1.onclick = () => {
    copyToClipboard(cliSnippet1.textContent);
    cliCopy1.textContent = "Copied!";
    setTimeout(() => (cliCopy1.textContent = "Copy"), 2000);
  };
  cliCopy2.onclick = () => {
    copyToClipboard(cliSnippet2.textContent);
    cliCopy2.textContent = "Copied!";
    setTimeout(() => (cliCopy2.textContent = "Copy"), 2000);
  };
  cliCopy3.onclick = () => {
    copyToClipboard(cliSnippet3.textContent);
    cliCopy3.textContent = "Copied!";
    setTimeout(() => (cliCopy3.textContent = "Copy"), 2000);
  };

  // QR Modal
  qrCloseBtn.onclick = () => (qrModalBackdrop.style.display = "none");

  // Archive Peek Modal
  archivePeekCloseBtn.onclick = () => (archivePeekBackdrop.style.display = "none");
  archivePeekDoneBtn.onclick = () => (archivePeekBackdrop.style.display = "none");
  archiveFilterInput.oninput = (e) => renderArchivePeekRows(e.target.value);

  // Vault Buttons
  vaultSetupBtn.onclick = () => promptVaultPassword(true);
  vaultUnlockBtn.onclick = () => promptVaultPassword(false);
  vaultLockBtn.onclick = async () => {
    try {
      await fetch("/api/vault/lock", {
        method: "POST",
        headers: vaultHeaders(),
      });
    } catch (e) {}
    vaultToken = null;
    sessionStorage.removeItem("keepboard_vault_token");
    vaultUnlocked = false;
    showToast("Vault locked");
    updateVaultUI();
    loadNotes();
  };
  vaultModalCancelBtn.onclick = () => (vaultModalBackdrop.style.display = "none");

  // Trash Empty Button
  emptyTrashBtn.onclick = emptyTrash;

  // Full-Window Drag and Drop Anywhere
  setupGlobalDragDrop({
    onGlobalDrop: async (files) => {
      if (!files || files.length === 0) return;

      // If composer is open, add to composer attachments
      if (captureExpanded && captureExpanded.style.display === "flex") {
        files.forEach((f) => composerPendingFiles.push(f));
        renderComposerPendingFiles();
        showToast(`${files.length} file(s) attached to draft`);
        return;
      }

      // Otherwise, create a new note immediately with these files
      const formData = new FormData();
      formData.append("title", files.length === 1 ? files[0].name : `Dropped Files (${files.length})`);
      formData.append("color", "default");
      formData.append("workspace", currentWorkspaceId || "default");
      files.forEach((f) => formData.append("files", f));

      try {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: vaultHeaders(),
          body: formData,
        });
        if (res.ok) {
          showToast(`Created note with ${files.length} file(s)`);
          await loadNotes();
          await updateStats();
        } else {
          showToast("Failed to create note from dropped files");
        }
      } catch (err) {
        showToast("Failed to upload dropped files");
      }
    },
    showToast,
    vaultHeaders,
    getWorkspace: () => currentWorkspaceId || "default",
  });

  // Global Clipboard Capture (⌘V / Ctrl+V)
  setupGlobalPaste({
    onNoteCreated: async () => {
      await loadNotes();
      await updateStats();
    },
    showToast,
    vaultHeaders,
    getWorkspace: () => currentWorkspaceId || "default",
  });

  // Dismiss Popovers on Outside Click
  document.addEventListener("click", (e) => {
    if (workspaceDropdown && !workspaceDropdown.contains(e.target) && !workspacePillBtn.contains(e.target)) {
      workspaceDropdown.style.display = "none";
      workspacePillBtn.classList.remove("open");
    }
    if (batchWorkspacePopover && !batchWorkspacePopover.contains(e.target) && !batchWorkspaceBtn.contains(e.target)) {
      batchWorkspacePopover.style.display = "none";
    }
    if (batchColorPopover && !batchColorPopover.contains(e.target) && !batchColorBtn.contains(e.target)) {
      batchColorPopover.classList.remove("show");
    }
    if (modalWorkspacePopover && !modalWorkspacePopover.contains(e.target) && !modalWorkspaceBtn?.contains(e.target)) {
      modalWorkspacePopover.classList.remove("show");
    }
    if (!e.target.closest(".card-more-popover") && !e.target.closest("button[title='More']")) {
      document.querySelectorAll(".card-more-popover.show").forEach((el) => el.classList.remove("show"));
    }
    if (!e.target.closest(".color-popover") && !e.target.closest("button[title='Change color']")) {
      document.querySelectorAll(".color-popover.show").forEach((el) => el.classList.remove("show"));
    }
    if (!e.target.closest(".card-ws-popover") && !e.target.closest("button[title='Move to workspace']")) {
      document.querySelectorAll(".card-ws-popover").forEach((el) => el.remove());
    }
  });

  // Spotlight Command Palette
  cmdPaletteInput.oninput = (e) => renderCommandPaletteList(e.target.value);
  cmdPaletteBackdrop.onclick = (e) => {
    if (e.target === cmdPaletteBackdrop) closeCommandPalette();
  };

  // Keyboard Shortcuts (⌘K, '/', ⌘Enter, Esc)
  window.addEventListener("keydown", (e) => {
    // ⌘K or Ctrl+K -> Spotlight Command Palette
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openCommandPalette();
      return;
    }

    // '/' to focus search bar (when not inside an input/editor/contenteditable or open modal)
    const activeTag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    const isEditable = e.target && (e.target.isContentEditable || activeTag === "input" || activeTag === "textarea" || activeTag === "select");
    const isModalOpen = (editModalBackdrop && editModalBackdrop.style.display === "flex") ||
                        (cmdPaletteBackdrop && cmdPaletteBackdrop.style.display === "flex") ||
                        (storageInspectorBackdrop && storageInspectorBackdrop.style.display === "flex") ||
                        (vaultModalBackdrop && vaultModalBackdrop.style.display === "flex") ||
                        (tagPromptBackdrop && tagPromptBackdrop.style.display === "flex") ||
                        (cliModalBackdrop && cliModalBackdrop.style.display === "flex") ||
                        (qrModalBackdrop && qrModalBackdrop.style.display === "flex");

    if (e.key === "/" && !isEditable && !isModalOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
      return;
    }

    // ⌘Enter -> Save open note or composer
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if (editModalBackdrop.style.display === "flex") {
        e.preventDefault();
        closeEditModal();
      } else if (captureExpanded.style.display === "flex") {
        e.preventDefault();
        saveComposerNote();
      }
    }

    // Escape -> Close modals / selection / mobile drawer
    if (e.key === "Escape") {
      if (sidebar && sidebar.classList.contains("drawer-open")) {
        sidebar.classList.remove("drawer-open");
        const sdb = document.getElementById("sidebar-drawer-backdrop");
        if (sdb) sdb.classList.remove("show");
      }
      if (cmdPaletteBackdrop.style.display === "flex") {
        closeCommandPalette();
      } else if (storageInspectorBackdrop && storageInspectorBackdrop.style.display === "flex") {
        closeStorageInspector();
      } else if (editModalBackdrop.style.display === "flex") {
        closeEditModal();
      } else if (qrModalBackdrop.style.display === "flex") {
        qrModalBackdrop.style.display = "none";
      } else if (archivePeekBackdrop.style.display === "flex") {
        archivePeekBackdrop.style.display = "none";
      } else if (cliModalBackdrop.style.display === "flex") {
        cliModalBackdrop.style.display = "none";
      } else if (vaultModalBackdrop.style.display === "flex") {
        vaultModalBackdrop.style.display = "none";
      } else if (tagPromptBackdrop.style.display === "flex") {
        tagPromptBackdrop.style.display = "none";
      } else if (selectedNoteIds.size > 0) {
        clearSelection();
      } else if (captureExpanded.style.display === "flex") {
        saveComposerNote();
      }
    }
  });

  // Storage & Attachment Inspector wiring
  if (ramPill) {
    ramPill.onclick = () => openStorageInspector();
  }
  if (sidebarRamPill) {
    sidebarRamPill.onclick = () => openStorageInspector();
  }
  if (storageInspectorCloseBtn) {
    storageInspectorCloseBtn.onclick = () => closeStorageInspector();
  }
  if (storageInspectorBackdrop) {
    storageInspectorBackdrop.onclick = (e) => {
      if (e.target === storageInspectorBackdrop) closeStorageInspector();
    };
  }

  // Tag Prompt Modal
  tagPromptCancelBtn.onclick = () => (tagPromptBackdrop.style.display = "none");
  tagPromptOkBtn.onclick = () => {
    const val = tagPromptInput.value.trim();
    if (val && currentTagCallback) {
      currentTagCallback(val.startsWith("#") ? val : `#${val}`);
    }
    tagPromptBackdrop.style.display = "none";
  };

  // Backups Export / Import
  btnExportBackup.onclick = () => {
    window.location.href = "/api/backup/export";
    showToast("Exporting workspace backup (.zip)...");
  };

  btnImportBackup.onclick = () => backupFileInput.click();
  backupFileInput.onchange = async () => {
    if (backupFileInput.files.length > 0) {
      if (!confirm("Restoring a backup will overwrite cards with the backup contents. Proceed?")) {
        backupFileInput.value = "";
        return;
      }
      const formData = new FormData();
      formData.append("file", backupFileInput.files[0]);
      try {
        const res = await fetch("/api/backup/import", {
          method: "POST",
          headers: vaultHeaders(),
          body: formData,
        });
        if (res.ok) {
          showToast("Workspace restored successfully");
          await loadNotes();
          await updateStats();
        } else {
          showToast("Failed to restore backup");
        }
      } catch (err) {
        showToast("Error restoring backup");
      }
      backupFileInput.value = "";
    }
  };

  // Window resize re-balance masonry
  window.addEventListener("resize", () => {
    renderNotesGrid();
  });
}

// ── Canvas Rubber-Band Lasso Selection ─────────────────────────────────────
function setupRubberbandSelection() {
  let isDragging = false;
  let didDrag = false;
  let startX = 0, startY = 0;
  let lassoEl = null;

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (captureExpanded && captureExpanded.style.display === "flex") {
      return;
    }
    // Don't trigger if clicking inside card, modal, header, sidebar, capture box, or interactive controls
    if (e.target.closest(".card, .modal-backdrop, .app-header, .sidebar, .capture-box, .btn-icon, button, input, textarea, a, select, .workspace-popover, .card-more-popover, .color-popover, .toast, .trash-banner")) {
      return;
    }
    const mainContent = document.getElementById("main-content");
    if (!mainContent || (!mainContent.contains(e.target) && e.target !== document.body && e.target !== document.documentElement)) {
      return;
    }

    startX = e.clientX;
    startY = e.clientY;
    isDragging = true;
    didDrag = false;

    function onMouseMove(moveEvent) {
      if (!isDragging) return;
      const curX = moveEvent.clientX;
      const curY = moveEvent.clientY;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      if (!didDrag && (w > 6 || h > 6)) {
        didDrag = true;
        lassoEl = document.createElement("div");
        lassoEl.className = "rubberband-selection";
        document.body.appendChild(lassoEl);
      }

      if (didDrag && lassoEl) {
        lassoEl.style.left = `${x}px`;
        lassoEl.style.top = `${y}px`;
        lassoEl.style.width = `${w}px`;
        lassoEl.style.height = `${h}px`;

        if (!moveEvent.shiftKey && !moveEvent.metaKey && !moveEvent.ctrlKey) {
          selectedNoteIds.clear();
        }
        const cards = document.querySelectorAll("#notes-grid-root .card");
        cards.forEach((c) => {
          const r = c.getBoundingClientRect();
          const intersects = !(r.right < x || r.left > x + w || r.bottom < y || r.top > y + h);
          const id = c.dataset.id;
          if (intersects && id) {
            selectedNoteIds.add(id);
            c.classList.add("selected");
          } else if (!moveEvent.shiftKey && !moveEvent.metaKey && !moveEvent.ctrlKey) {
            c.classList.remove("selected");
          }
        });
        updateSelectionBar();
      }
    }

    function onMouseUp(upEvent) {
      isDragging = false;
      if (lassoEl) {
        lassoEl.remove();
        lassoEl = null;
      }
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      // If clicked without dragging on empty canvas, clear active selection
      if (!didDrag && selectedNoteIds.size > 0 && !upEvent.shiftKey && !upEvent.metaKey && !upEvent.ctrlKey) {
        clearSelection();
      }
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
}

function openTagPromptModal(cb) {
  currentTagCallback = cb;
  tagPromptInput.value = "";
  tagPromptBackdrop.style.display = "flex";
  tagPromptInput.focus();
}

// ── Application Initialization ─────────────────────────────────────────────
async function initApp() {
  try { applyGridDensity(gridDensity); } catch (e) { console.error("Density err:", e); }
  try { setupEventListeners(); } catch (e) { console.error("Listeners err:", e); }
  try { initLiveSync(); } catch (e) { console.error("Sync err:", e); }
  try { setupRubberbandSelection(); } catch (e) { console.error("Lasso err:", e); }
  try { await loadWorkspaces(); } catch (e) { console.error("Workspaces err:", e); }
  try { await checkVaultStatus(); } catch (e) { console.error("Vault err:", e); }
  try { await loadNotes(); } catch (e) { console.error("Notes err:", e); }
  try { await updateStats(); } catch (e) { console.error("Stats err:", e); }
}

document.addEventListener("DOMContentLoaded", initApp);
