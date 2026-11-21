// ── KeepBoard v3: editor.js ─────────────────────────────────────────────────
// Rich-text WYSIWYG toolbar, Markdown/raw toggle, nested checklists, math & outline

export function formatDoc(cmd, val = null) {
  document.execCommand(cmd, false, val);
}

export function applyTextStyle(val) {
  if (val === "small") {
    document.execCommand("formatBlock", false, "<p>");
    document.execCommand("fontSize", false, "2");
  } else if (val === "large") {
    document.execCommand("formatBlock", false, "<p>");
    document.execCommand("fontSize", false, "5");
  } else if (val === "p" || val === "normal") {
    document.execCommand("formatBlock", false, "<p>");
    document.execCommand("fontSize", false, "3");
  } else if (val === "h1" || val === "h2" || val === "h3") {
    document.execCommand("fontSize", false, "3");
    document.execCommand("formatBlock", false, `<${val}>`);
  }
}

export function formatHighlight(color) {
  document.execCommand("hiliteColor", false, color);
}

export function formatInlineCode() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const code = document.createElement("code");
  code.textContent = range.toString() || "code";
  range.deleteContents();
  range.insertNode(code);
}

// Clean paste interceptor to strip external website junk styling
export function setupCleanPaste(editorEl) {
  if (!editorEl) return;
  editorEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");

    if (html) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      doc.querySelectorAll("*").forEach(el => {
        el.removeAttribute("class");
        el.removeAttribute("id");
        if (!["mark", "span"].includes(el.tagName.toLowerCase())) {
          el.removeAttribute("style");
        } else if (el.style.backgroundColor) {
          const bg = el.style.backgroundColor;
          el.removeAttribute("style");
          el.style.backgroundColor = bg;
        }
      });
      const cleanHtml = doc.body.innerHTML;
      document.execCommand("insertHTML", false, cleanHtml);
    } else if (text) {
      document.execCommand("insertText", false, text);
    }
  });
}

// Safe math evaluator: e.g. typing "1024 * 64 =" evaluates inline
export function safeEvalMath(expr) {
  if (!/^[\d\s\+\-\*\/\(\)\.\%]+$/.test(expr)) return null;
  try {
    const fn = new Function("return (" + expr + ")");
    const res = fn();
    if (typeof res === "number" && !isNaN(res) && isFinite(res)) {
      return Math.round(res * 100000) / 100000;
    }
  } catch (e) {}
  return null;
}

export function setupInlineMath(editorEl) {
  if (!editorEl) return;
  editorEl.addEventListener("keyup", (e) => {
    if (e.key === "=") {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;

      const text = node.textContent;
      const offset = sel.anchorOffset;
      const textBefore = text.substring(0, offset);
      const match = textBefore.match(/(?:^|[\s\n])([\d\.\s\+\-\*\/\(\)\%]+)=$/);
      if (match && match[1]) {
        const val = safeEvalMath(match[1].trim());
        if (val !== null) {
          document.execCommand("insertText", false, " " + val);
        }
      }
    }
  });
}

// Document Outline Extractor: extracts H1, H2, H3 with smooth scroll
export function extractDocumentOutline(editorEl, outlineContainer) {
  if (!editorEl || !outlineContainer) return;
  outlineContainer.innerHTML = "";
  const headings = editorEl.querySelectorAll("h1, h2, h3");

  if (headings.length === 0) {
    outlineContainer.innerHTML = `<div style="font-size:11.5px; color:var(--text-muted); font-style:italic; padding:4px;">No headings (use H1–H3)</div>`;
    return;
  }

  headings.forEach((h, index) => {
    const text = h.textContent.trim() || `Heading ${index + 1}`;
    const item = document.createElement("div");
    item.className = `outline-item ${h.tagName.toLowerCase()}`;
    item.textContent = text;
    item.title = text;
    item.onclick = () => {
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    outlineContainer.appendChild(item);
  });
}

// ── Nested Checklists & Progress Helpers ────────────────────────────────────

export function calculateChecklistProgress(items) {
  if (!items || items.length === 0) return null;
  const total = items.length;
  const checked = items.filter(it => it.checked).length;
  const pct = Math.round((checked / total) * 100);
  return { total, checked, pct };
}

export function uncheckAllItems(items) {
  return items.map(it => ({ ...it, checked: false }));
}

export function deleteCheckedItems(items) {
  return items.filter(it => !it.checked);
}

export function convertTextToChecklist(text) {
  if (!text) return [];
  // Strip simple HTML tags if present
  const clean = text.replace(/<br\s*[\/]?>/gi, "\n").replace(/<[^>]+>/g, "");
  const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.map(line => ({
    text: line.replace(/^[-*•\d\.\s\[\]x]+/, "").trim() || line,
    checked: false,
    indent: 0,
  }));
}

export function convertChecklistToText(items) {
  if (!items || items.length === 0) return "";
  return items.map(it => `<div>${it.checked ? "☑ " : "☐ "}${it.text || ""}</div>`).join("");
}

export function renderChecklistEditor(container, items, onChange) {
  if (!container) return;
  container.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.gap = "6px";
  wrapper.style.marginTop = "6px";

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.paddingLeft = `${(item.indent || 0) * 18}px`;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "checklist-checkbox";
    cb.checked = !!item.checked;
    cb.onchange = () => {
      item.checked = cb.checked;
      onChange(items);
    };

    const input = document.createElement("input");
    input.type = "text";
    input.className = "search-bar";
    input.style.height = "32px";
    input.style.borderRadius = "6px";
    input.style.padding = "0 10px";
    input.style.flex = "1";
    input.value = item.text || "";
    input.placeholder = "List item...";

    input.oninput = () => {
      item.text = input.value;
      onChange(items);
    };

    input.onkeydown = (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          item.indent = Math.max(0, (item.indent || 0) - 1);
        } else {
          item.indent = Math.min(3, (item.indent || 0) + 1);
        }
        renderChecklistEditor(container, items, onChange);
      } else if (e.key === "Enter") {
        e.preventDefault();
        items.splice(index + 1, 0, { text: "", checked: false, indent: item.indent || 0 });
        renderChecklistEditor(container, items, onChange);
        setTimeout(() => {
          const allInputs = container.querySelectorAll("input[type=text]");
          if (allInputs[index + 1]) allInputs[index + 1].focus();
        }, 50);
      } else if (e.key === "Backspace" && input.value === "" && items.length > 1) {
        e.preventDefault();
        items.splice(index, 1);
        renderChecklistEditor(container, items, onChange);
        setTimeout(() => {
          const allInputs = container.querySelectorAll("input[type=text]");
          if (allInputs[Math.max(0, index - 1)]) allInputs[Math.max(0, index - 1)].focus();
        }, 50);
      }
    };

    const delBtn = document.createElement("button");
    delBtn.className = "btn-icon";
    delBtn.style.width = "24px";
    delBtn.style.height = "24px";
    delBtn.innerHTML = "✕";
    delBtn.title = "Delete item";
    delBtn.onclick = () => {
      items.splice(index, 1);
      renderChecklistEditor(container, items, onChange);
    };

    row.appendChild(cb);
    row.appendChild(input);
    row.appendChild(delBtn);
    wrapper.appendChild(row);
  });

  const footerTools = document.createElement("div");
  footerTools.style.display = "flex";
  footerTools.style.alignItems = "center";
  footerTools.style.gap = "8px";
  footerTools.style.marginTop = "4px";

  const addBtn = document.createElement("button");
  addBtn.className = "btn-secondary";
  addBtn.style.padding = "4px 10px";
  addBtn.style.fontSize = "12px";
  addBtn.textContent = "+ List item";
  addBtn.onclick = () => {
    items.push({ text: "", checked: false, indent: 0 });
    renderChecklistEditor(container, items, onChange);
    setTimeout(() => {
      const allInputs = container.querySelectorAll("input[type=text]");
      if (allInputs[allInputs.length - 1]) allInputs[allInputs.length - 1].focus();
    }, 50);
  };
  footerTools.appendChild(addBtn);

  if (items.some(it => it.checked)) {
    const uncheckBtn = document.createElement("button");
    uncheckBtn.className = "checklist-tool-btn";
    uncheckBtn.textContent = "Uncheck all";
    uncheckBtn.onclick = () => {
      const updated = uncheckAllItems(items);
      onChange(updated);
      renderChecklistEditor(container, updated, onChange);
    };
    footerTools.appendChild(uncheckBtn);

    const deleteCheckedBtn = document.createElement("button");
    deleteCheckedBtn.className = "checklist-tool-btn";
    deleteCheckedBtn.textContent = "Delete checked";
    deleteCheckedBtn.onclick = () => {
      const updated = deleteCheckedItems(items);
      onChange(updated);
      renderChecklistEditor(container, updated, onChange);
    };
    footerTools.appendChild(deleteCheckedBtn);
  }

  wrapper.appendChild(footerTools);
  container.appendChild(wrapper);
}
