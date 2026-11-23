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

// Smart Markdown Typing in rich editors:
// Typing '# ' or '## ' or '### ' at line start converts into heading.
// Typing '- [ ] ' at line start converts into interactive checklist item.
export function setupSmartTyping(editorEl, onChecklistTrigger) {
  if (!editorEl) return;
  editorEl.addEventListener("keyup", (e) => {
    if (e.key !== " " && e.key !== "Spacebar") return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent;
    const offset = sel.anchorOffset;
    const textBefore = text.substring(0, offset);
    const lineStart = Math.max(textBefore.lastIndexOf("\n") + 1, 0);
    const lineText = textBefore.substring(lineStart);

    if (lineText === "# ") {
      node.textContent = text.substring(0, lineStart) + text.substring(offset);
      const newRange = document.createRange();
      newRange.setStart(node, lineStart);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      document.execCommand("formatBlock", false, "<h1>");
      return;
    }

    if (lineText === "## ") {
      node.textContent = text.substring(0, lineStart) + text.substring(offset);
      const newRange = document.createRange();
      newRange.setStart(node, lineStart);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      document.execCommand("formatBlock", false, "<h2>");
      return;
    }

    if (lineText === "### ") {
      node.textContent = text.substring(0, lineStart) + text.substring(offset);
      const newRange = document.createRange();
      newRange.setStart(node, lineStart);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      document.execCommand("formatBlock", false, "<h3>");
      return;
    }

    if (lineText === "- [ ] " || lineText === "- [] " || lineText === "* [ ] " || lineText === "* [] ") {
      node.textContent = text.substring(0, lineStart) + text.substring(offset);
      const newRange = document.createRange();
      newRange.setStart(node, lineStart);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      if (typeof onChecklistTrigger === "function") {
        onChecklistTrigger();
      } else {
        document.execCommand("insertHTML", false, '<div class="rich-todo-item" style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="margin-right:4px;"><span>&nbsp;</span></div>');
      }
      return;
    }
  });
}

// Document Outline Extractor: extracts H1, H2, H3 with smooth scroll
// Automatically collapses outline rail when 0 headings exist, expanding when present
export function extractDocumentOutline(editorEl, outlineContainer, railEl = null) {
  if (!editorEl || !outlineContainer) return;
  const rail = railEl || outlineContainer.closest(".outline-rail") || document.getElementById("modal-outline-rail");
  outlineContainer.innerHTML = "";
  const headings = editorEl.querySelectorAll("h1, h2, h3");

  if (headings.length === 0) {
    if (rail) rail.classList.add("collapsed");
    outlineContainer.innerHTML = `<div style="font-size:11.5px; color:var(--text-muted); font-style:italic; padding:4px;">No headings (use H1–H3)</div>`;
    return;
  }

  if (rail) rail.classList.remove("collapsed");

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
  const percent = total > 0 ? Math.round((checked / total) * 100) : 0;
  return { total, checked, percent, pct: percent };
}

export function uncheckAllItems(items) {
  return items.map(it => ({ ...it, checked: false }));
}

export function deleteCheckedItems(items) {
  return items.filter(it => !it.checked);
}

export function convertTextToChecklist(text) {
  if (!text) return [];
  // Strip simple HTML tags and break lines
  const clean = text.replace(/<br\s*[\/]?>/gi, "\n").replace(/<\/div>/gi, "\n").replace(/<[^>]+>/g, "");
  const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.map(line => {
    const isChecked = /^[☑✓✔]|^\s*[-*•]?\s*\[[xX]\]/.test(line);
    const cleanedText = line.replace(/^([☐☑✓✔✗✘\-\*\•\d\.]+|\[[ xX]?\])\s*/, "").trim();
    return {
      text: cleanedText || line,
      checked: isChecked,
      indent: 0,
    };
  });
}

export function convertChecklistToText(items) {
  if (!items || items.length === 0) return "";
  return items
    .map(it => {
      let t = (it.text || "").trim();
      // Cleanly strip any lingering checklist bullet markers
      t = t.replace(/^([☐☑✓✔✗✘\-\*\•\d\.]+|\[[ xX]?\])\s*/, "").trim();
      return `<div>${t || "&nbsp;"}</div>`;
    })
    .join("");
}

let checklistDebounceTimer = null;
function debouncedChecklistChange(items, onChange, ms = 450) {
  clearTimeout(checklistDebounceTimer);
  checklistDebounceTimer = setTimeout(() => onChange(items), ms);
}

export function renderChecklistEditor(container, items, onChange) {
  if (!container) return;
  container.innerHTML = "";

  if (container._completedExpanded === undefined) {
    container._completedExpanded = false;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "checklist-editor-wrapper";
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.gap = "4px";
  wrapper.style.marginTop = "4px";

  // Active items list
  const activeList = document.createElement("div");
  activeList.className = "checklist-active-list";
  activeList.style.display = "flex";
  activeList.style.flexDirection = "column";
  activeList.style.gap = "4px";

  // Build row element
  function createRow(item, index) {
    const row = document.createElement("div");
    row.className = `checklist-row ${item.checked ? "checked" : ""} ${item.indent ? "indented" : ""}`;
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.paddingLeft = item.indent ? "24px" : "0px";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "checklist-checkbox";
    cb.checked = !!item.checked;
    cb.onchange = () => {
      item.checked = cb.checked;
      // If checking a parent (indent 0), cascade check to immediate indented children (indent 1)
      if (item.checked && !item.indent) {
        let nextIdx = index + 1;
        while (nextIdx < items.length && items[nextIdx].indent === 1) {
          items[nextIdx].checked = true;
          nextIdx++;
        }
      }
      // Re-group: unchecked items first, checked items at bottom
      const active = items.filter(it => !it.checked);
      const done = items.filter(it => it.checked);
      items.length = 0;
      items.push(...active, ...done);
      onChange(items);
      renderChecklistEditor(container, items, onChange);
    };

    const input = document.createElement("input");
    input.type = "text";
    input.className = "search-bar checklist-input";
    input.style.height = "32px";
    input.style.borderRadius = "6px";
    input.style.padding = "0 10px";
    input.style.flex = "1";
    input.value = item.text || "";
    input.placeholder = "List item...";
    if (item.checked) {
      input.style.textDecoration = "line-through";
      input.style.opacity = "0.7";
    }

    input.oninput = () => {
      item.text = input.value;
      debouncedChecklistChange(items, onChange, 450);
    };

    input.onkeydown = (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        item.indent = e.shiftKey ? 0 : 1;
        onChange(items);
        renderChecklistEditor(container, items, onChange);
      } else if (e.key === "Enter") {
        e.preventDefault();
        items.splice(index + 1, 0, { text: "", checked: false, indent: item.indent || 0 });
        onChange(items);
        renderChecklistEditor(container, items, onChange);
        setTimeout(() => {
          const allInputs = container.querySelectorAll("input.checklist-input");
          if (allInputs[index + 1]) allInputs[index + 1].focus();
        }, 50);
      } else if (e.key === "Backspace" && input.value === "" && items.length > 1) {
        e.preventDefault();
        items.splice(index, 1);
        onChange(items);
        renderChecklistEditor(container, items, onChange);
        setTimeout(() => {
          const allInputs = container.querySelectorAll("input.checklist-input");
          if (allInputs[Math.max(0, index - 1)]) allInputs[Math.max(0, index - 1)].focus();
        }, 50);
      }
    };

    const actions = document.createElement("div");
    actions.className = "checklist-item-actions";
    actions.style.display = "flex";
    actions.style.alignItems = "center";
    actions.style.gap = "2px";

    // Indent / outdent toggle buttons
    if (!item.indent) {
      const indentBtn = document.createElement("button");
      indentBtn.type = "button";
      indentBtn.className = "btn-icon checklist-indent-btn";
      indentBtn.style.width = "24px";
      indentBtn.style.height = "24px";
      indentBtn.style.fontSize = "12px";
      indentBtn.title = "Indent (Tab)";
      indentBtn.innerHTML = "⇥";
      indentBtn.onclick = () => {
        item.indent = 1;
        onChange(items);
        renderChecklistEditor(container, items, onChange);
      };
      actions.appendChild(indentBtn);
    } else {
      const outdentBtn = document.createElement("button");
      outdentBtn.type = "button";
      outdentBtn.className = "btn-icon checklist-outdent-btn";
      outdentBtn.style.width = "24px";
      outdentBtn.style.height = "24px";
      outdentBtn.style.fontSize = "12px";
      outdentBtn.title = "Outdent (Shift+Tab)";
      outdentBtn.innerHTML = "⇤";
      outdentBtn.onclick = () => {
        item.indent = 0;
        onChange(items);
        renderChecklistEditor(container, items, onChange);
      };
      actions.appendChild(outdentBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-icon";
    delBtn.style.width = "24px";
    delBtn.style.height = "24px";
    delBtn.innerHTML = "✕";
    delBtn.title = "Delete item";
    delBtn.onclick = () => {
      items.splice(index, 1);
      onChange(items);
      renderChecklistEditor(container, items, onChange);
    };
    actions.appendChild(delBtn);

    row.appendChild(cb);
    row.appendChild(input);
    row.appendChild(actions);
    return row;
  }

  // Render unchecked (active) items
  items.forEach((item, index) => {
    if (!item.checked) {
      activeList.appendChild(createRow(item, index));
    }
  });
  wrapper.appendChild(activeList);

  // Add Item button below active list
  const activeTools = document.createElement("div");
  activeTools.style.display = "flex";
  activeTools.style.alignItems = "center";
  activeTools.style.gap = "8px";
  activeTools.style.marginTop = "4px";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn-secondary";
  addBtn.style.padding = "4px 10px";
  addBtn.style.fontSize = "12px";
  addBtn.textContent = "+ List item";
  addBtn.onclick = () => {
    const firstDoneIdx = items.findIndex(it => it.checked);
    const insertIdx = firstDoneIdx >= 0 ? firstDoneIdx : items.length;
    items.splice(insertIdx, 0, { text: "", checked: false, indent: 0 });
    onChange(items);
    renderChecklistEditor(container, items, onChange);
    setTimeout(() => {
      const allInputs = activeList.querySelectorAll("input.checklist-input");
      if (allInputs[allInputs.length - 1]) allInputs[allInputs.length - 1].focus();
    }, 50);
  };
  activeTools.appendChild(addBtn);
  wrapper.appendChild(activeTools);

  // Collapsible "Completed items" section
  const completedItems = items.filter(it => it.checked);
  if (completedItems.length > 0) {
    const compSection = document.createElement("div");
    compSection.className = "checklist-completed-section";
    compSection.style.marginTop = "12px";
    compSection.style.borderTop = "1px solid var(--border)";
    compSection.style.paddingTop = "8px";

    const compHeader = document.createElement("button");
    compHeader.type = "button";
    compHeader.className = "checklist-completed-toggle";
    compHeader.style.display = "flex";
    compHeader.style.alignItems = "center";
    compHeader.style.gap = "6px";
    compHeader.style.background = "transparent";
    compHeader.style.border = "none";
    compHeader.style.color = "var(--text-muted)";
    compHeader.style.fontSize = "12.5px";
    compHeader.style.fontWeight = "600";
    compHeader.style.cursor = "pointer";
    compHeader.style.padding = "4px 0";
    compHeader.innerHTML = `
      <span class="checklist-arrow">${container._completedExpanded ? "▾" : "▸"}</span>
      <span>${completedItems.length} completed ${completedItems.length === 1 ? "item" : "items"}</span>
    `;

    const compList = document.createElement("div");
    compList.className = "checklist-completed-list";
    compList.style.display = container._completedExpanded ? "flex" : "none";
    compList.style.flexDirection = "column";
    compList.style.gap = "4px";
    compList.style.marginTop = "6px";

    items.forEach((item, index) => {
      if (item.checked) {
        compList.appendChild(createRow(item, index));
      }
    });

    compHeader.onclick = () => {
      container._completedExpanded = !container._completedExpanded;
      compList.style.display = container._completedExpanded ? "flex" : "none";
      const arrow = compHeader.querySelector(".checklist-arrow");
      if (arrow) arrow.textContent = container._completedExpanded ? "▾" : "▸";
    };

    compSection.appendChild(compHeader);
    compSection.appendChild(compList);

    // Global tools (Uncheck all / Delete checked)
    const compTools = document.createElement("div");
    compTools.style.display = "flex";
    compTools.style.alignItems = "center";
    compTools.style.gap = "8px";
    compTools.style.marginTop = "8px";

    const uncheckBtn = document.createElement("button");
    uncheckBtn.type = "button";
    uncheckBtn.className = "checklist-tool-btn";
    uncheckBtn.textContent = "Uncheck all";
    uncheckBtn.onclick = () => {
      const updated = uncheckAllItems(items);
      onChange(updated);
      renderChecklistEditor(container, updated, onChange);
    };
    compTools.appendChild(uncheckBtn);

    const deleteCheckedBtn = document.createElement("button");
    deleteCheckedBtn.type = "button";
    deleteCheckedBtn.className = "checklist-tool-btn";
    deleteCheckedBtn.textContent = "Delete checked";
    deleteCheckedBtn.onclick = () => {
      const updated = deleteCheckedItems(items);
      onChange(updated);
      renderChecklistEditor(container, updated, onChange);
    };
    compTools.appendChild(deleteCheckedBtn);

    compSection.appendChild(compTools);
    wrapper.appendChild(compSection);
  }

  container.appendChild(wrapper);
}
