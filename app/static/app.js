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
  extractDocumentOutline,
  calculateChecklistProgress,
  uncheckAllItems,
  deleteCheckedItems,
  renderChecklistEditor,
} from "./editor.js";

import {
  formatDateTimeStamp,
  setupGlobalPaste,
  setupCardDropzone,
  VoiceMemoRecorder,
  createQRCodeSVG,
} from "./media.js";

// ── Constants & Color Palettes ─────────────────────────────────────────────
const PALETTES = {
  default: "#1b1c1f",
  coral: "#4a2424",
  peach: "#483220",
  sand: "#443e22",
  mint: "#1e3d34",
  sage: "#233d2c",
  fog: "#203445",
  dusk: "#332948",
  blush: "#422238",
};

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
let openPanes = []; // Up to 4 notes open simultaneously side-by-side
let activeVoiceRecorder = null;
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

const selectionBar = document.getElementById("selection-bar");
const selClearBtn = document.getElementById("sel-clear-btn");
const selCountText = document.getElementById("sel-count-text");
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
const composerVoiceBar = document.getElementById("composer-voice-bar");
const composerVoiceTimer = document.getElementById("composer-voice-timer");
const composerVoiceStopBtn = document.getElementById("composer-voice-stop-btn");
const composerVoiceCancelBtn = document.getElementById("composer-voice-cancel-btn");
const composerAttachmentsPreview = document.getElementById("composer-attachments-preview");
const composerTagsPreview = document.getElementById("composer-tags-preview");

const composerFmtToggleBtn = document.getElementById("composer-fmt-toggle-btn");
const composerRawToggleBtn = document.getElementById("composer-raw-toggle-btn");
const composerColorBtn = document.getElementById("composer-color-btn");
const composerColorPopover = document.getElementById("composer-color-popover");
const composerChecklistToggleBtn = document.getElementById("composer-checklist-toggle-btn");
const composerVoiceBtn = document.getElementById("composer-voice-btn");
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
const modalTitleInput = document.getElementById("modal-title-input");
const modalPinBtn = document.getElementById("modal-pin-btn");
const modalTagsContainer = document.getElementById("modal-tags-container");
const modalFmtToolbar = document.getElementById("modal-fmt-toolbar");
const modalRichEditor = document.getElementById("modal-rich-editor");
const modalRawTextarea = document.getElementById("modal-raw-textarea");
const modalChecklistContainer = document.getElementById("modal-checklist-container");
const modalAttachmentsList = document.getElementById("modal-attachments-list");
const modalFmtToggleBtn = document.getElementById("modal-fmt-toggle-btn");
const modalRawToggleBtn = document.getElementById("modal-raw-toggle-btn");
const modalColorBtn = document.getElementById("modal-color-btn");
const modalColorPopover = document.getElementById("modal-color-popover");
const modalAttachBtn = document.getElementById("modal-attach-btn");
const modalSplitBtn = document.getElementById("modal-split-btn");
const modalQrBtn = document.getElementById("modal-qr-btn");
const modalDuplicateBtn = document.getElementById("modal-duplicate-btn");
const modalArchiveBtn = document.getElementById("modal-archive-btn");
const modalTrashBtn = document.getElementById("modal-trash-btn");
const modalCloseBtn = document.getElementById("modal-close-btn");

const splitWorkspaceModal = document.getElementById("split-workspace-modal");
const splitPanesContainer = document.getElementById("split-panes-container");
const splitCloseBtn = document.getElementById("split-close-btn");
const splitCountBadge = document.getElementById("split-count-badge");

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

function paletteFor(color) {
  return PALETTES[color] || PALETTES.default;
}

// ── Swatch Picker Renderer ─────────────────────────────────────────────────
function renderSwatches(container, onSelect, currentSelected = "default") {
  container.innerHTML = "";
  Object.keys(PALETTES).forEach((c) => {
    const circle = document.createElement("div");
    circle.className = `color-swatch-circle ${c === currentSelected ? "selected" : ""}`;
    circle.style.backgroundColor = PALETTES[c];
    circle.style.border = c === "default" ? "1px solid #444" : "1px solid rgba(255,255,255,0.15)";
    circle.title = c.charAt(0).toUpperCase() + c.slice(1);
    circle.onclick = (e) => {
      e.stopPropagation();
      onSelect(c);
      container.classList.remove("show");
    };
    container.appendChild(circle);
  });
}

// ── Live SSE Synchronization ───────────────────────────────────────────────
function initLiveSync() {
  let eventSource = null;

  function connect() {
    try {
      eventSource = new EventSource("/api/events");
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.event && data.event !== "ping") {
            if (data.event === "workspaces_updated") {
              loadWorkspaces();
            }
            loadNotes(false);
            updateStats();
          }
        } catch (err) {
          // ignore keepalive comments
        }
      };
      eventSource.onerror = () => {
        if (eventSource) eventSource.close();
        setTimeout(connect, 4000);
      };
    } catch (e) {
      setTimeout(connect, 5000);
    }
  }

  connect();

  // Polling fallback to keep RAM stats and TTL notes updated
  setInterval(() => {
    updateStats();
  }, 10000);
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
      const c = flair.replace("color:", "");
      label = `🎨 ${c}`;
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
    if (currentNavView === "trash") {
      if (!note.is_trash) return false;
    } else if (currentNavView === "archive") {
      if (note.is_trash || !note.is_archived) return false;
    } else if (currentNavView === "vault") {
      if (note.is_trash || !note.is_vault) return false;
    } else {
      // "notes" view
      if (note.is_trash || note.is_archived || note.is_vault) return false;
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
          const col = flair.replace("color:", "");
          if ((note.color || "default") !== col) return false;
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
  const colWidth = gridDensity === "compact" ? 210 : 250;
  const maxCols = Math.max(1, Math.floor(containerWidth / colWidth));
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

// ── Card Element Builder ───────────────────────────────────────────────────
function createCardElement(note) {
  const card = document.createElement("div");
  card.className = `card ${selectedNoteIds.has(note.id) ? "selected" : ""}`;
  card.dataset.id = note.id;
  card.style.backgroundColor = paletteFor(note.color);

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
  selectBtn.onclick = (e) => {
    e.stopPropagation();
    toggleCardSelection(note.id, e.shiftKey);
  };
  card.appendChild(selectBtn);

  // Top Tools: Floating Quick Copy & Pin Button
  const topTools = document.createElement("div");
  topTools.className = `card-top-tools ${note.is_pinned ? "has-pin" : ""}`;

  // Copy Note Content Button
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-icon";
  copyBtn.title = "Copy note text";
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    const textToCopy = `${note.title ? note.title + "\n\n" : ""}${note.content || ""}`.trim();
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      showToast("Note copied to clipboard");
    }
  };
  topTools.appendChild(copyBtn);

  // Pin Button
  const pinBtn = document.createElement("button");
  pinBtn.className = "btn-icon";
  pinBtn.title = note.is_pinned ? "Unpin note" : "Pin note";
  pinBtn.style.color = note.is_pinned ? "var(--accent)" : "inherit";
  pinBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    toggleNotePin(note.id, !note.is_pinned);
  };
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
  fadeEl.style.background = `linear-gradient(to bottom, transparent, ${paletteFor(note.color)})`;
  clampedWrapper.appendChild(fadeEl);

  card.appendChild(clampedWrapper);

  // Show More / Show Less Toggle Button
  const expandBtn = document.createElement("button");
  expandBtn.className = "card-expand-btn";
  expandBtn.textContent = "Show more";
  expandBtn.onclick = (e) => {
    e.stopPropagation();
    const isExp = clampedWrapper.classList.toggle("expanded");
    expandBtn.textContent = isExp ? "Show less" : "Show more";
  };
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
      openAllBtn.textContent = "Open all in tabs";
      openAllBtn.onclick = (e) => {
        e.stopPropagation();
        urlMatches.forEach((url) => window.open(url, "_blank"));
      };
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
    const pBar = document.createElement("div");
    pBar.className = "checklist-progress-bar";
    pBar.innerHTML = `
      <div class="checklist-progress-track">
        <div class="checklist-progress-fill" style="width: ${progress.percent}%"></div>
      </div>
      <span class="checklist-progress-text">${progress.checked}/${progress.total}</span>
    `;
    checklistBox.appendChild(pBar);

    // Checklist Tools (Uncheck all / Delete checked)
    const toolsMenu = document.createElement("div");
    toolsMenu.className = "checklist-tools-menu";
    const uncheckBtn = document.createElement("button");
    uncheckBtn.className = "checklist-tool-btn";
    uncheckBtn.textContent = "Uncheck all";
    uncheckBtn.onclick = (e) => {
      e.stopPropagation();
      const updated = uncheckAllItems(note.checklist);
      saveChecklistUpdate(note.id, updated);
    };
    toolsMenu.appendChild(uncheckBtn);

    const deleteCheckedBtn = document.createElement("button");
    deleteCheckedBtn.className = "checklist-tool-btn";
    deleteCheckedBtn.textContent = "Delete checked";
    deleteCheckedBtn.onclick = (e) => {
      e.stopPropagation();
      const updated = deleteCheckedItems(note.checklist);
      saveChecklistUpdate(note.id, updated);
    };
    toolsMenu.appendChild(deleteCheckedBtn);
    checklistBox.appendChild(toolsMenu);

    // Checklist Items
    const listEl = document.createElement("div");
    listEl.className = "checklist-list";
    note.checklist.forEach((item, idx) => {
      const itemEl = document.createElement("div");
      itemEl.className = `checklist-item ${item.checked ? "checked" : ""} indent-${item.indent || 0}`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "checklist-checkbox";
      cb.checked = Boolean(item.checked);
      cb.onclick = (e) => {
        e.stopPropagation();
        note.checklist[idx].checked = cb.checked;
        saveChecklistUpdate(note.id, note.checklist);
      };

      const span = document.createElement("span");
      span.textContent = item.text;

      itemEl.appendChild(cb);
      itemEl.appendChild(span);
      listEl.appendChild(itemEl);
    });
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
        peekBtn.onclick = (e) => {
          e.stopPropagation();
          openArchivePeek(att.id, att.filename);
        };
        pill.appendChild(peekBtn);
      }

      // Rename Attachment
      const renameBtn = document.createElement("button");
      renameBtn.className = "attachment-action-btn";
      renameBtn.title = "Rename attachment";
      renameBtn.innerHTML = "✎";
      renameBtn.onclick = async (e) => {
        e.stopPropagation();
        const newName = prompt("Rename attachment:", att.filename);
        if (newName && newName.trim() && newName !== att.filename) {
          await renameAttachment(note.id, att.id, newName.trim());
        }
      };
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
      tagPill.textContent = tag.startsWith("#") ? tag : `#${tag}`;
      tagPill.onclick = (e) => {
        e.stopPropagation();
        toggleSearchFlair(tagPill.textContent);
      };
      metaRow.appendChild(tagPill);
    });
  }

  if (metaRow.children.length > 0) {
    card.appendChild(metaRow);
  }

  // ── Card Hover Actions Bar ───────────────────────────────────────────────
  const actionsBar = document.createElement("div");
  actionsBar.className = "card-actions";

  // 1. Color Picker
  const colorWrap = document.createElement("div");
  colorWrap.style.position = "relative";
  const colorBtn = document.createElement("button");
  colorBtn.className = "btn-icon";
  colorBtn.title = "Change color";
  colorBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zm-5.5 11c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-4C8.67 9 8 8.33 8 7.5S8.67 6 9.5 6s1.5.67 1.5 1.5S10.33 9 9.5 9zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 6 14.5 6s1.5.67 1.5 1.5S15.33 9 14.5 9zm3 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`;
  const colorPopover = document.createElement("div");
  colorPopover.className = "color-popover";
  renderSwatches(colorPopover, (newColor) => updateNoteColor(note.id, newColor), note.color);
  colorBtn.onclick = (e) => {
    e.stopPropagation();
    colorPopover.classList.toggle("show");
  };
  colorWrap.appendChild(colorBtn);
  colorWrap.appendChild(colorPopover);
  actionsBar.appendChild(colorWrap);

  // 2. Add File Attachment
  const attachBtn = document.createElement("button");
  attachBtn.className = "btn-icon";
  attachBtn.title = "Add file";
  attachBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a3 3 0 0 0 6 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>`;
  attachBtn.onclick = (e) => {
    e.stopPropagation();
    cardActionFileInput.onchange = async () => {
      if (cardActionFileInput.files.length > 0) {
        await uploadFilesToNote(note.id, Array.from(cardActionFileInput.files));
        cardActionFileInput.value = "";
      }
    };
    cardActionFileInput.click();
  };
  actionsBar.appendChild(attachBtn);

  // 3. Save to Disk Toggle (Hybrid RAM + Disk Shield)
  const shieldBtn = document.createElement("button");
  shieldBtn.className = `btn-icon ${note.saved_to_disk ? "active" : ""}`;
  shieldBtn.title = note.saved_to_disk ? "Remove from persistent disk" : "Save to persistent disk (/persist)";
  shieldBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>`;
  shieldBtn.onclick = (e) => {
    e.stopPropagation();
    togglePersistNote(note.id);
  };
  actionsBar.appendChild(shieldBtn);

  // 4. Bump to Top
  const bumpBtn = document.createElement("button");
  bumpBtn.className = "btn-icon";
  bumpBtn.title = "Bump note to top";
  bumpBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>`;
  bumpBtn.onclick = (e) => {
    e.stopPropagation();
    bumpNote(note.id);
  };
  actionsBar.appendChild(bumpBtn);

  // 5. Remind / Snooze
  const snoozeBtn = document.createElement("button");
  snoozeBtn.className = "btn-icon";
  snoozeBtn.title = "Remind me (Snooze)";
  snoozeBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;
  snoozeBtn.onclick = (e) => {
    e.stopPropagation();
    snoozeNotePrompt(note.id);
  };
  actionsBar.appendChild(snoozeBtn);

  // 6. QR Code Share
  const qrBtn = document.createElement("button");
  qrBtn.className = "btn-icon";
  qrBtn.title = "Share via QR code";
  qrBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm13-2h3v2h-3zm-3 2h3v2h-3zm3 2h3v2h-3zm-3 2h3v2h-3zm-2-4h2v2h-2zm4 4h2v2h-2z"/></svg>`;
  qrBtn.onclick = (e) => {
    e.stopPropagation();
    showQRCode(note);
  };
  actionsBar.appendChild(qrBtn);

  // 7. Split Workspace Toggle
  const splitBtn = document.createElement("button");
  splitBtn.className = "btn-icon";
  splitBtn.title = "Open in Split Workspace (or ⌘/Ctrl+Click)";
  splitBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 16H5V5h6v14zm8 0h-6V5h6v14z"/></svg>`;
  splitBtn.onclick = (e) => {
    e.stopPropagation();
    toggleSplitPane(note.id);
  };
  actionsBar.appendChild(splitBtn);

  // 8. Move to Workspace
  const wsBtn = document.createElement("button");
  wsBtn.className = "btn-icon";
  wsBtn.title = "Move to workspace";
  wsBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
  wsBtn.onclick = (e) => {
    e.stopPropagation();
    showMoveWorkspacePopover(note.id, wsBtn);
  };
  actionsBar.appendChild(wsBtn);

  // 9. Archive / Unarchive
  const archBtn = document.createElement("button");
  archBtn.className = "btn-icon";
  archBtn.title = note.is_archived ? "Unarchive" : "Archive";
  archBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.83 1H5.42l.82-1zM5 19V8h14v11H5zm7-2l5-5h-3.5V9h-3v3H7l5 5z"/></svg>`;
  archBtn.onclick = (e) => {
    e.stopPropagation();
    toggleNoteArchive(note.id, !note.is_archived);
  };
  actionsBar.appendChild(archBtn);

  // 10. Trash / Delete
  const trashBtn = document.createElement("button");
  trashBtn.className = "btn-icon";
  if (note.is_trash) {
    trashBtn.title = "Restore from Trash";
    trashBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>`;
    trashBtn.onclick = (e) => {
      e.stopPropagation();
      restoreNote(note.id);
    };
  } else {
    trashBtn.title = "Move to Trash";
    trashBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>`;
    trashBtn.onclick = (e) => {
      e.stopPropagation();
      trashNote(note.id);
    };
  }
  actionsBar.appendChild(trashBtn);

  card.appendChild(actionsBar);

  // Open note edit modal on card click (or toggle in split workspace if meta/ctrl clicked)
  card.onclick = (e) => {
    // If user clicked inside an interactive button/link/checkbox, don't open modal
    if (e.target.closest("button, a, input, .card-select-btn, .color-popover, .card-actions, .card-top-tools, .workspace-popover")) {
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleSplitPane(note.id);
      return;
    }
    openEditModal(note.id);
  };

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
      navigator.clipboard.writeText(codeBody);
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

// ── Multi-Select Batch Actions ─────────────────────────────────────────────
function toggleCardSelection(noteId, isShift = false) {
  if (selectedNoteIds.has(noteId)) {
    selectedNoteIds.delete(noteId);
  } else {
    selectedNoteIds.add(noteId);
  }
  updateSelectionBar();
  renderNotesGrid();
}

function updateSelectionBar() {
  const count = selectedNoteIds.size;
  if (count > 0) {
    mainHeader.style.display = "none";
    selectionBar.classList.add("active");
    selCountText.textContent = `${count} selected`;
  } else {
    selectionBar.classList.remove("active");
    mainHeader.style.display = "flex";
  }
}

function clearSelection() {
  selectedNoteIds.clear();
  updateSelectionBar();
  renderNotesGrid();
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
  if (activeVoiceRecorder) {
    activeVoiceRecorder.cancel();
    activeVoiceRecorder = null;
    composerVoiceBar.style.display = "none";
  }
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

async function saveComposerNote() {
  const title = composerTitleInput.value.trim();
  const content = composerRawMode ? composerRawTextarea.value : composerRichEditor.innerHTML.trim();

  // If completely empty with no files or checklist, just collapse
  if (
    !title &&
    !content &&
    composerPendingFiles.length === 0 &&
    composerChecklistItems.length === 0
  ) {
    collapseComposer();
    return;
  }

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
  modalColor = note.color || "default";
  modalIsPinned = Boolean(note.is_pinned);
  modalTags = new Set(note.tags || []);
  modalChecklistItems = note.checklist ? JSON.parse(JSON.stringify(note.checklist)) : [];
  modalPendingFiles = [];

  editModalCard.style.backgroundColor = paletteFor(modalColor);
  modalPinBtn.style.color = modalIsPinned ? "var(--accent)" : "inherit";

  renderModalTags();
  renderModalAttachments(note.attachments || []);

  if (note.is_checklist && modalChecklistItems.length > 0) {
    modalChecklistContainer.style.display = "block";
    renderChecklistEditor(modalChecklistContainer, modalChecklistItems, (updated) => {
      modalChecklistItems = updated;
    });
  } else {
    modalChecklistContainer.style.display = "none";
  }

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
    return;
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

  if (modalChecklistItems.length > 0) {
    payload.checklist = modalChecklistItems;
    payload.is_checklist = true;
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
      await loadNotes();
    }
  } catch (err) {
    showToast("Error updating note");
  }
}

// ── Multi-Pane Split Workspace (2–4 Notes) ──────────────────────────────────
function openInSplitWorkspace(noteId) {
  toggleSplitPane(noteId);
}

function toggleSplitPane(noteId) {
  if (editModalBackdrop.style.display === "flex") {
    editModalBackdrop.style.display = "none";
    currentEditingNoteId = null;
  }

  const existingIdx = openPanes.indexOf(noteId);
  if (existingIdx !== -1) {
    const paneEl = splitPanesContainer.querySelector(`[data-note-id="${noteId}"]`);
    if (paneEl) {
      paneEl.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      paneEl.classList.remove("split-pane-highlight");
      void paneEl.offsetWidth;
      paneEl.classList.add("split-pane-highlight");
      setTimeout(() => paneEl.classList.remove("split-pane-highlight"), 1600);
      const focusTarget = paneEl.querySelector(".split-title-input") || paneEl.querySelector(".split-rich-editor");
      if (focusTarget) focusTarget.focus();
    }
    return;
  }

  if (openPanes.length >= 4) {
    showToast("Maximum 4 split panes can be open simultaneously");
    return;
  }

  openPanes.push(noteId);
  renderSplitWorkspace();
}

function closeSplitPane(noteId) {
  openPanes = openPanes.filter((id) => id !== noteId);
  if (openPanes.length === 0) {
    splitWorkspaceModal.style.display = "none";
    if (splitCountBadge) splitCountBadge.textContent = "0 active";
  } else {
    renderSplitWorkspace();
  }
}

function closeAllSplitPanes() {
  openPanes = [];
  splitWorkspaceModal.style.display = "none";
  if (splitCountBadge) splitCountBadge.textContent = "0 active";
}

function renderSplitWorkspace() {
  if (openPanes.length === 0) {
    splitWorkspaceModal.style.display = "none";
    if (splitCountBadge) splitCountBadge.textContent = "0 active";
    return;
  }

  splitWorkspaceModal.style.display = "flex";
  if (splitCountBadge) {
    splitCountBadge.textContent = `${openPanes.length}/4 active`;
  }

  splitPanesContainer.innerHTML = "";

  openPanes.forEach((id) => {
    const note = allNotes.find((n) => n.id === id);
    if (!note) return;

    const pane = document.createElement("div");
    pane.className = "split-pane";
    pane.dataset.noteId = note.id;
    pane.style.backgroundColor = paletteFor(note.color);

    // Header
    const header = document.createElement("div");
    header.className = "split-pane-header";

    const titleInput = document.createElement("input");
    titleInput.className = "split-title-input";
    titleInput.value = note.title || "";
    titleInput.placeholder = "Untitled";

    const tools = document.createElement("div");
    tools.className = "split-pane-tools";

    // Pin Button
    const pinBtn = document.createElement("button");
    pinBtn.className = `btn-icon ${note.is_pinned ? "active" : ""}`;
    pinBtn.title = note.is_pinned ? "Unpin" : "Pin";
    pinBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 9V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>`;
    pinBtn.onclick = async () => {
      const newPinned = !note.is_pinned;
      note.is_pinned = newPinned;
      note.pinned = newPinned;
      pinBtn.classList.toggle("active", newPinned);
      pinBtn.title = newPinned ? "Unpin" : "Pin";
      await toggleNotePin(note.id, newPinned);
      renderNotesGrid();
    };
    tools.appendChild(pinBtn);

    // Color Swatch Button & Popover
    const colorWrapper = document.createElement("div");
    colorWrapper.style.position = "relative";
    colorWrapper.style.display = "inline-flex";

    const colorBtn = document.createElement("button");
    colorBtn.className = "btn-icon";
    colorBtn.title = "Change color";
    colorBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l1.9-1.9C9.27 19.59 10.58 20 12 20c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 15c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>`;

    const colorPopover = document.createElement("div");
    colorPopover.className = "color-popover";
    renderSwatches(colorPopover, async (c) => {
      note.color = c;
      pane.style.backgroundColor = paletteFor(c);
      await fetch(`/api/notes/${note.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...vaultHeaders() },
        body: JSON.stringify({ color: c }),
      });
      renderNotesGrid();
    });

    colorBtn.onclick = (e) => {
      e.stopPropagation();
      colorPopover.classList.toggle("show");
    };

    colorWrapper.appendChild(colorBtn);
    colorWrapper.appendChild(colorPopover);
    tools.appendChild(colorWrapper);

    // Persist Shield Button
    const shieldBtn = document.createElement("button");
    shieldBtn.className = `btn-icon ${note.is_vault ? "active" : ""}`;
    shieldBtn.title = note.is_vault ? "In Vault (Protected)" : "Move to Vault";
    shieldBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>`;
    shieldBtn.onclick = async () => {
      const newVault = !note.is_vault;
      note.is_vault = newVault;
      shieldBtn.classList.toggle("active", newVault);
      await fetch(`/api/notes/${note.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...vaultHeaders() },
        body: JSON.stringify({ is_vault: newVault }),
      });
      showToast(newVault ? "Protected in Vault" : "Moved out of Vault");
      renderNotesGrid();
    };
    tools.appendChild(shieldBtn);

    // Close × Button
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-icon";
    closeBtn.title = "Close pane";
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => closeSplitPane(note.id);
    tools.appendChild(closeBtn);

    header.appendChild(titleInput);
    header.appendChild(tools);
    pane.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "split-pane-body";

    let editor = null;
    let checklistItems = Array.isArray(note.checklist) ? [...note.checklist] : [];

    let saveTimeout = null;
    const debouncedSave = () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        const titleVal = titleInput.value.trim();
        const contentVal = note.is_checklist ? "" : (editor ? editor.innerHTML.trim() : "");
        note.title = titleVal;
        if (!note.is_checklist) {
          note.content = contentVal;
          note.text = contentVal;
        } else {
          note.checklist = checklistItems;
        }

        const payload = {
          title: titleVal,
          content: contentVal,
          text: contentVal,
        };
        if (note.is_checklist) {
          payload.checklist = checklistItems;
          payload.is_checklist = true;
        }

        await fetch(`/api/notes/${note.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...vaultHeaders() },
          body: JSON.stringify(payload),
        });

        const cardEl = document.querySelector(`.note-card[data-id="${note.id}"]`);
        if (cardEl) {
          const cardTitle = cardEl.querySelector(".card-title");
          if (cardTitle) cardTitle.textContent = titleVal || "";
          const cardContent = cardEl.querySelector(".card-content");
          if (cardContent && !note.is_checklist) cardContent.innerHTML = contentVal || "";
        }
      }, 600);
    };

    titleInput.addEventListener("input", debouncedSave);

    if (note.is_checklist) {
      const checkContainer = document.createElement("div");
      checkContainer.className = "checklist-container";

      const renderChecklist = () => {
        checkContainer.innerHTML = "";
        checklistItems.forEach((item, itemIdx) => {
          const row = document.createElement("div");
          row.className = "checklist-item-row";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = Boolean(item.checked);
          cb.onchange = () => {
            item.checked = cb.checked;
            itemText.classList.toggle("checked", cb.checked);
            debouncedSave();
          };

          const itemText = document.createElement("input");
          itemText.type = "text";
          itemText.className = `checklist-item-text ${item.checked ? "checked" : ""}`;
          itemText.value = item.text || "";
          itemText.oninput = () => {
            item.text = itemText.value;
            debouncedSave();
          };

          const delItemBtn = document.createElement("button");
          delItemBtn.className = "btn-icon";
          delItemBtn.textContent = "✕";
          delItemBtn.onclick = () => {
            checklistItems.splice(itemIdx, 1);
            renderChecklist();
            debouncedSave();
          };

          row.appendChild(cb);
          row.appendChild(itemText);
          row.appendChild(delItemBtn);
          checkContainer.appendChild(row);
        });

        const addRow = document.createElement("div");
        addRow.className = "checklist-item-row add-row";
        const addInput = document.createElement("input");
        addInput.type = "text";
        addInput.className = "checklist-item-text";
        addInput.placeholder = "+ Add item";
        addInput.onkeydown = (e) => {
          if (e.key === "Enter" && addInput.value.trim()) {
            checklistItems.push({ text: addInput.value.trim(), checked: false });
            renderChecklist();
            debouncedSave();
          }
        };
        addRow.appendChild(addInput);
        checkContainer.appendChild(addRow);
      };

      renderChecklist();
      body.appendChild(checkContainer);
    } else {
      editor = document.createElement("div");
      editor.className = "split-rich-editor";
      editor.contentEditable = "true";
      editor.innerHTML = note.content || "";
      setupCleanPaste(editor);
      setupInlineMath(editor);
      editor.addEventListener("input", debouncedSave);
      body.appendChild(editor);
    }

    if (note.attachments && note.attachments.length > 0) {
      const attachDiv = document.createElement("div");
      attachDiv.className = "card-attachments";
      attachDiv.style.marginTop = "auto";
      attachDiv.style.paddingTop = "8px";
      note.attachments.forEach((att) => {
        const pill = document.createElement("a");
        pill.className = "attachment-pill";
        pill.href = `/api/attachments/${att.filename}`;
        pill.target = "_blank";
        pill.innerHTML = `📎 <span>${escapeHtml(att.filename)}</span>`;
        attachDiv.appendChild(pill);
      });
      body.appendChild(attachDiv);
    }

    pane.appendChild(body);
    splitPanesContainer.appendChild(pane);
  });
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
          body: JSON.stringify({ ids, workspace: ws.id }),
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

  const systemActions = [
    { label: "New Note", shortcut: "C", action: () => { expandComposer(); composerTitleInput.focus(); } },
    { label: "New Checklist", shortcut: "L", action: () => { expandComposer(); composerChecklistToggleBtn.click(); } },
    { label: "Cycle Grid Density", shortcut: "D", action: () => cycleGridDensity() },
    { label: "View: All Notes", shortcut: "G N", action: () => navNotes.click() },
    { label: "View: Archive", shortcut: "G A", action: () => navArchive.click() },
    { label: "View: Trash (7-day purge)", shortcut: "G T", action: () => navTrash.click() },
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

  qrCopyBtn.onclick = () => {
    navigator.clipboard.writeText(shareText);
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
    const res = await fetch("/api/notes", { headers: vaultHeaders() });
    if (res.ok) {
      const raw = await res.json();
      allNotes = (Array.isArray(raw) ? raw : []).map(normalizeNote);
      renderSidebarTags();
      renderNotesGrid();
    }
  } catch (err) {
    console.error("Failed to load notes:", err);
  }
}

async function updateStats() {
  try {
    const res = await fetch("/api/stats");
    if (res.ok) {
      const stats = await res.json();
      ramUsageText.textContent = `${formatBytes(stats.ram_used)} RAM`;
    }
  } catch (err) {
    // ignore
  }
}

async function toggleNotePin(noteId, isPinned) {
  await fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ pinned: isPinned, is_pinned: isPinned }),
  });
  await loadNotes(false);
}

async function updateNoteColor(noteId, color) {
  await fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ color }),
  });
  await loadNotes(false);
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
}

async function trashNote(noteId) {
  await fetch(`/api/notes/${noteId}`, {
    method: "DELETE",
    headers: vaultHeaders(),
  });
  showToast("Moved to Trash (7d auto-purge)", async () => {
    await restoreNote(noteId);
  });
  await loadNotes(false);
}

async function restoreNote(noteId) {
  await fetch(`/api/notes/${noteId}/restore`, {
    method: "POST",
    headers: vaultHeaders(),
  });
  showToast("Note restored");
  await loadNotes(false);
}

async function emptyTrash() {
  if (!confirm("Permanently delete all notes in Trash? This cannot be undone.")) return;
  await fetch("/api/trash/empty", { method: "POST", headers: vaultHeaders() });
  showToast("Trash emptied");
  await loadNotes(false);
}

async function saveChecklistUpdate(noteId, checklist) {
  await fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...vaultHeaders() },
    body: JSON.stringify({ checklist }),
  });
  await loadNotes(false);
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
}

async function deleteAttachment(noteId, attachmentId) {
  await fetch(`/api/notes/${noteId}/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: vaultHeaders(),
  });
  showToast("Attachment removed");
  await loadNotes(false);
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

function promptVaultPassword(isSetup = false) {
  vaultModalTitle.textContent = isSetup ? "Set Vault Master Password" : "Unlock Vault";
  vaultModalDesc.textContent = isSetup
    ? "Create a master password using PBKDF2-SHA256 to protect your secret notes:"
    : "Enter your master password to unlock protected notes for this session:";
  vaultModalPassword.value = "";
  vaultModalError.style.display = "none";
  vaultModalSubmitBtn.textContent = isSetup ? "Set Password" : "Unlock";
  vaultModalBackdrop.style.display = "flex";
  vaultModalPassword.focus();

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
        promptVaultPassword(false);
      } else {
        vaultModalError.textContent = "Failed to set password";
        vaultModalError.style.display = "block";
      }
    } else {
      const res = await fetch("/api/vault/verify", {
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
      } else {
        vaultModalError.textContent = "Incorrect master password";
        vaultModalError.style.display = "block";
      }
    }
  };
}

// ── Event Listeners Setup ──────────────────────────────────────────────────
function setupEventListeners() {
  // Navigation
  [navNotes, navArchive, navTrash, navVault].forEach((btn) => {
    btn.onclick = () => {
      [navNotes, navArchive, navTrash, navVault].forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      if (btn === navNotes) currentNavView = "notes";
      else if (btn === navArchive) currentNavView = "archive";
      else if (btn === navTrash) currentNavView = "trash";
      else if (btn === navVault) currentNavView = "vault";

      trashBanner.style.display = currentNavView === "trash" ? "flex" : "none";
      updateVaultUI();
      renderNotesGrid();
    };
  });

  menuToggleBtn.onclick = () => {
    sidebar.classList.toggle("collapsed");
    mainContent.classList.toggle("sidebar-collapsed");
  };

  // Grid Density Switcher
  densityToggleBtn.onclick = cycleGridDensity;

  // Search and Flairs
  setupSearchFlairs();

  // Multi-Select Batch Actions
  selClearBtn.onclick = clearSelection;
  batchPinBtn.onclick = () => executeBatchAction("pin");
  batchArchiveBtn.onclick = () => executeBatchAction("archive");
  batchMergeBtn.onclick = () => executeBatchAction("merge");
  batchDownloadBtn.onclick = () => {
    const ids = Array.from(selectedNoteIds);
    window.location.href = `/api/notes/export?ids=${ids.join(",")}`;
    clearSelection();
  };
  batchTrashBtn.onclick = () => executeBatchAction("trash");

  batchColorBtn.onclick = (e) => {
    e.stopPropagation();
    batchColorPopover.classList.toggle("show");
  };
  renderSwatches(batchColorPopover, (color) => executeBatchAction("color", color));

  batchTagBtn.onclick = () => {
    openTagPromptModal((tag) => executeBatchAction("tag", tag));
  };

  batchWorkspaceBtn.onclick = (e) => {
    e.stopPropagation();
    if (batchWorkspacePopover.style.display === "flex") {
      batchWorkspacePopover.style.display = "none";
    } else {
      showBatchMoveWorkspacePopover();
    }
  };

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
  composerCloseBtn.onclick = collapseComposer;
  composerSaveBtn.onclick = saveComposerNote;

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

  composerFmtToggleBtn.onclick = (e) => {
    e.stopPropagation();
    composerFmtToolbar.classList.toggle("show");
  };
  modalFmtToggleBtn.onclick = (e) => {
    e.stopPropagation();
    modalFmtToolbar.classList.toggle("show");
  };

  // WYSIWYG Formatting Buttons (Composer)
  document.getElementById("fmt-c-bold").onclick = () => formatDoc("bold");
  document.getElementById("fmt-c-italic").onclick = () => formatDoc("italic");
  document.getElementById("fmt-c-underline").onclick = () => formatDoc("underline");
  document.getElementById("fmt-c-strike").onclick = () => formatDoc("strikeThrough");
  document.getElementById("fmt-c-hl-yellow").onclick = () => formatHighlight("#524816");
  document.getElementById("fmt-c-hl-cyan").onclick = () => formatHighlight("#16424d");
  document.getElementById("fmt-c-hl-pink").onclick = () => formatHighlight("#4d1637");
  document.getElementById("fmt-c-hl-green").onclick = () => formatHighlight("#1a4225");
  document.getElementById("fmt-c-hl-orange").onclick = () => formatHighlight("#4d2c16");
  document.getElementById("fmt-c-ul").onclick = () => formatDoc("insertUnorderedList");
  document.getElementById("fmt-c-ol").onclick = () => formatDoc("insertOrderedList");
  document.getElementById("fmt-c-code").onclick = () => formatInlineCode();
  document.getElementById("fmt-c-heading").onchange = (e) => applyTextStyle(e.target.value);

  // WYSIWYG Formatting Buttons (Modal)
  document.getElementById("fmt-m-bold").onclick = () => formatDoc("bold");
  document.getElementById("fmt-m-italic").onclick = () => formatDoc("italic");
  document.getElementById("fmt-m-underline").onclick = () => formatDoc("underline");
  document.getElementById("fmt-m-strike").onclick = () => formatDoc("strikeThrough");
  document.getElementById("fmt-m-hl-yellow").onclick = () => formatHighlight("#524816");
  document.getElementById("fmt-m-hl-cyan").onclick = () => formatHighlight("#16424d");
  document.getElementById("fmt-m-hl-pink").onclick = () => formatHighlight("#4d1637");
  document.getElementById("fmt-m-hl-green").onclick = () => formatHighlight("#1a4225");
  document.getElementById("fmt-m-hl-orange").onclick = () => formatHighlight("#4d2c16");
  document.getElementById("fmt-m-ul").onclick = () => formatDoc("insertUnorderedList");
  document.getElementById("fmt-m-ol").onclick = () => formatDoc("insertOrderedList");
  document.getElementById("fmt-m-code").onclick = () => formatInlineCode();
  document.getElementById("fmt-m-heading").onchange = (e) => applyTextStyle(e.target.value);

  // Raw Markdown Toggle (Composer)
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

  // Raw Markdown Toggle (Modal)
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

  // Color Pickers
  renderSwatches(composerColorPopover, (color) => {
    composerColor = color;
    captureBox.style.backgroundColor = paletteFor(color);
  });
  composerColorBtn.onclick = (e) => {
    e.stopPropagation();
    composerColorPopover.classList.toggle("show");
  };

  renderSwatches(modalColorPopover, (color) => {
    modalColor = color;
    editModalCard.style.backgroundColor = paletteFor(color);
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
      if (composerChecklistItems.length === 0) {
        composerChecklistItems.push({ text: "", checked: false, indent: 0 });
      }
      composerChecklistContainer.style.display = "block";
      renderChecklistEditor(composerChecklistContainer, composerChecklistItems, (updated) => {
        composerChecklistItems = updated;
      });
    } else {
      composerChecklistContainer.style.display = "none";
    }
  };

  // Voice Memo Recorder in Composer
  composerVoiceBtn.onclick = async () => {
    if (activeVoiceRecorder) return;
    try {
      activeVoiceRecorder = new VoiceMemoRecorder();
      await activeVoiceRecorder.start((seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = String(seconds % 60).padStart(2, "0");
        composerVoiceTimer.textContent = `${mins}:${secs}`;
      });
      composerVoiceBar.style.display = "flex";
      composerVoiceBtn.classList.add("active");
    } catch (err) {
      showToast("Microphone permission required for voice memo");
      activeVoiceRecorder = null;
    }
  };

  composerVoiceStopBtn.onclick = async () => {
    if (!activeVoiceRecorder) return;
    const blob = await activeVoiceRecorder.stop();
    composerVoiceBar.style.display = "none";
    composerVoiceBtn.classList.remove("active");
    activeVoiceRecorder = null;
    if (blob) {
      const stamp = formatDateTimeStamp();
      const file = new File([blob], `voice-memo-${stamp}.webm`, { type: "audio/webm" });
      composerPendingFiles.push(file);
      renderComposerPendingFiles();
      showToast("Voice memo recorded");
    }
  };

  composerVoiceCancelBtn.onclick = () => {
    if (!activeVoiceRecorder) return;
    activeVoiceRecorder.cancel();
    composerVoiceBar.style.display = "none";
    composerVoiceBtn.classList.remove("active");
    activeVoiceRecorder = null;
  };

  // File Attachments in Composer
  composerAttachBtn.onclick = () => composerFileInput.click();
  composerFileInput.onchange = () => {
    if (composerFileInput.files.length > 0) {
      Array.from(composerFileInput.files).forEach((f) => composerPendingFiles.push(f));
      renderComposerPendingFiles();
      composerFileInput.value = "";
    }
  };

  // Modal Attachments
  modalAttachBtn.onclick = () => modalFileInput.click();
  modalFileInput.onchange = async () => {
    if (modalFileInput.files.length > 0 && currentEditingNoteId) {
      await uploadFilesToNote(currentEditingNoteId, Array.from(modalFileInput.files));
      modalFileInput.value = "";
      const updated = allNotes.find((n) => n.id === currentEditingNoteId);
      if (updated) renderModalAttachments(updated.attachments || []);
    }
  };

  // Tags Prompt
  composerTagBtn.onclick = () => {
    openTagPromptModal((tag) => {
      composerTags.add(tag);
      renderComposerTags();
    });
  };

  modalPinBtn.onclick = () => {
    modalIsPinned = !modalIsPinned;
    modalPinBtn.style.color = modalIsPinned ? "var(--accent)" : "inherit";
  };

  modalOutlineToggleBtn.onclick = () => {
    modalOutlineRail.classList.toggle("collapsed");
  };

  modalSplitBtn.onclick = () => {
    if (currentEditingNoteId) toggleSplitPane(currentEditingNoteId);
  };

  modalQrBtn.onclick = () => {
    const note = allNotes.find((n) => n.id === currentEditingNoteId);
    if (note) showQRCode(note);
  };

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
    await trashNote(currentEditingNoteId);
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
    navigator.clipboard.writeText(cliSnippet1.textContent);
    cliCopy1.textContent = "Copied!";
    setTimeout(() => (cliCopy1.textContent = "Copy"), 2000);
  };
  cliCopy2.onclick = () => {
    navigator.clipboard.writeText(cliSnippet2.textContent);
    cliCopy2.textContent = "Copied!";
    setTimeout(() => (cliCopy2.textContent = "Copy"), 2000);
  };
  cliCopy3.onclick = () => {
    navigator.clipboard.writeText(cliSnippet3.textContent);
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
  vaultLockBtn.onclick = () => {
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
  window.addEventListener("dragenter", (e) => {
    if (e.dataTransfer.types && e.dataTransfer.types.includes("Files")) {
      dropOverlay.style.display = "flex";
    }
  });

  dropOverlay.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  dropOverlay.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) {
      dropOverlay.style.display = "none";
    }
  });

  dropOverlay.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropOverlay.style.display = "none";

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // If composer is open, add to composer attachments
    if (captureExpanded.style.display === "flex") {
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
      }
    } catch (err) {
      showToast("Failed to upload dropped files");
    }
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
    if (!e.target.closest(".card-ws-popover") && !e.target.closest("button[title='Move to workspace']")) {
      document.querySelectorAll(".card-ws-popover").forEach((el) => el.remove());
    }
  });

  // Spotlight Command Palette
  cmdPaletteInput.oninput = (e) => renderCommandPaletteList(e.target.value);
  cmdPaletteBackdrop.onclick = (e) => {
    if (e.target === cmdPaletteBackdrop) closeCommandPalette();
  };

  // Keyboard Shortcuts (⌘K, ⌘Enter, Esc)
  window.addEventListener("keydown", (e) => {
    // ⌘K or Ctrl+K -> Spotlight Command Palette
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openCommandPalette();
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

    // Escape -> Close modals / selection
    if (e.key === "Escape") {
      if (cmdPaletteBackdrop.style.display === "flex") {
        closeCommandPalette();
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
        collapseComposer();
      }
    }
  });

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

function openTagPromptModal(cb) {
  currentTagCallback = cb;
  tagPromptInput.value = "";
  tagPromptBackdrop.style.display = "flex";
  tagPromptInput.focus();
}

// ── Application Initialization ─────────────────────────────────────────────
async function initApp() {
  applyGridDensity(gridDensity);
  setupEventListeners();
  initLiveSync();
  await loadWorkspaces();
  await checkVaultStatus();
  await loadNotes();
  await updateStats();
}

document.addEventListener("DOMContentLoaded", initApp);
