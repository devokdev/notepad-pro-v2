/**
 * popup.js — Notepad Pro
 *
 * STORAGE KEYS:
 *   np_tabs        → [{id, label, content}, ...]
 *   np_activeTabId → string
 *   np_theme       → "dark" | "light"
 *   np_opacity     → number 20–100
 *   np_textColor   → hex string or ""
 *
 * Single chrome.storage.local.get on load; debounced writes for content;
 * immediate writes for settings.
 */

"use strict";

/* ── Constants ──────────────────────────────────── */
const SK = {
  TABS: "np_tabs",
  ACTIVE: "np_activeTabId",
  THEME: "np_theme",
  OPACITY: "np_opacity",
  COLOR: "np_textColor",
};

const AUTOSAVE_MS = 700;

const EMOJIS = [
  "😀", "😂", "😊", "😍", "🥰", "😎", "🤔", "😅", "😭", "🙏",
  "👍", "👎", "❤️", "💔", "🔥", "⚡", "✨", "🎉", "🎊", "🎈",
  "📝", "📌", "📎", "💡", "🔑", "🏆", "⭐", "🌟", "💫", "🚀",
  "💻", "📱", "🖥️", "⌨️", "📷", "🎵", "🎶", "🎸", "🎹", "🥁",
  "🍕", "🍔", "🍣", "☕", "🍺", "🥂", "🎂", "🍰", "🍩", "🍫",
  "🌍", "🌈", "☀️", "🌙", "⛅", "❄️", "🌊", "🏔️", "🌺", "🌸",
  "😴", "🤯", "😤", "🥳", "🤩", "👻", "💀", "🤖", "👾", "🎃",
  "🐶", "🐱", "🦊", "🐻", "🐼", "🦁", "🐸", "🦋", "🌻", "🌴",
  "✅", "❌", "⚠️", "ℹ️", "🔴", "🟡", "🟢", "🔵", "⬛", "⬜",
  "👋", "✌️", "👏", "💪", "🤝", "🫡", "🫶", "👌", "🤌", "☝️",
];

/* ── State ──────────────────────────────────────── */
let state = {
  tabs: [],
  activeTabId: null,
  theme: "dark",
  opacity: 100,
  textColor: "",
};

let isDirty = false;
let saveTimer = null;
let renameTarget = null;

/* ── DOM cache ──────────────────────────────────── */
const el = {};

function cacheEl() {
  const ids = [
    "app", "editor", "tab-bar", "btn-add-tab", "btn-save", "btn-theme",
    "btn-clear", "btn-opacity-toggle", "btn-color-toggle",
    "controls-panel", "opacity-row", "color-row",
    "slider-opacity", "opacity-value", "input-color", "color-label",
    "char-count", "save-status", "unsaved-dot",
    "btn-emoji", "emoji-panel", "emoji-search", "emoji-grid",
    "rename-modal", "rename-input", "rename-ok", "rename-cancel",
    "clear-modal", "clear-ok", "clear-cancel",
  ];
  ids.forEach(id => {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // camelCase
    el[key] = document.getElementById(id);
    if (!el[key]) console.warn("Missing element:", id);
  });
}

/* ── Storage ────────────────────────────────────── */
function loadAll() {
  return new Promise(resolve => {
    chrome.storage.local.get(Object.values(SK), raw => {
      const tabs = raw[SK.TABS];
      const seed = makeTab("Note 1");
      resolve({
        tabs: Array.isArray(tabs) && tabs.length ? tabs : [seed],
        activeTabId: raw[SK.ACTIVE] || null,
        theme: raw[SK.THEME] || "dark",
        opacity: raw[SK.OPACITY] ?? 100,
        textColor: raw[SK.COLOR] || "",
      });
    });
  });
}

function saveTabs() {
  chrome.storage.local.set({
    [SK.TABS]: state.tabs,
    [SK.ACTIVE]: state.activeTabId,
  });
}

function savePref(key, val) {
  chrome.storage.local.set({ [key]: val });
}

/* ── Tab helpers ────────────────────────────────── */
function uid() {
  return "t" + Date.now() + Math.random().toString(36).slice(2, 6);
}

function makeTab(label) {
  return { id: uid(), label, content: "" };
}

function activeTab() {
  return state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0];
}

function flushEditor() {
  const t = activeTab();
  if (t) t.content = el.editor.value;
}

/* ── Render tabs ────────────────────────────────── */
function renderTabs() {
  el.tabBar.querySelectorAll(".tab").forEach(n => n.remove());
  const frag = document.createDocumentFragment();

  state.tabs.forEach(tab => {
    const div = document.createElement("div");
    div.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
    div.dataset.id = tab.id;

    const lbl = document.createElement("span");
    lbl.className = "tab-label";
    lbl.textContent = tab.label;
    lbl.title = tab.label;
    lbl.addEventListener("dblclick", e => {
      e.stopPropagation();
      showRenameModal(tab.id, tab.label);
    });

    const cls = document.createElement("span");
    cls.className = "tab-close";
    cls.textContent = "✕";
    cls.title = "Close";
    cls.addEventListener("click", e => {
      e.stopPropagation();
      removeTab(tab.id);
    });

    div.appendChild(lbl);
    div.appendChild(cls);
    div.addEventListener("click", () => switchTab(tab.id));
    frag.appendChild(div);
  });

  el.tabBar.insertBefore(frag, el.btnAddTab);
}

/* ── Tab actions ────────────────────────────────── */
function switchTab(id) {
  flushEditor();
  state.activeTabId = id;
  const t = activeTab();
  el.editor.value = t ? t.content : "";
  renderTabs();
  updateCount();
  setClean();
}

function addTab() {
  flushEditor();
  const t = makeTab("Note ");
  state.tabs.push(t);
  state.activeTabId = t.id;
  el.editor.value = "";
  renderTabs();
  updateCount();
  setClean();
  saveTabs();
  el.editor.focus();
}

function removeTab(id) {
  if (state.tabs.length <= 1) return; // keep at least 1
  const idx = state.tabs.findIndex(t => t.id === id);
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    state.activeTabId = next.id;
    el.editor.value = next.content;
    updateCount();
    setClean();
  }
  renderTabs();
  saveTabs();
}

function renameTab(id, label) {
  const t = state.tabs.find(x => x.id === id);
  if (t && label.trim()) { t.label = label.trim(); renderTabs(); saveTabs(); }
}

/* ── Save logic ─────────────────────────────────── */

// Called on every keypress — debounces auto-save
function onInput() {
  setDirty();
  updateCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => doSave(false), AUTOSAVE_MS);
}

// Core save: flush → storage → UI update
function doSave(manual) {
  flushEditor();
  saveTabs();
  setClean();
  if (manual) {
    el.saveStatus.textContent = "Saved!";
    setTimeout(() => { el.saveStatus.textContent = "All saved"; }, 1400);
  }
}

function setDirty() {
  if (isDirty) return;
  isDirty = true;
  el.unsavedDot.hidden = false;
  el.saveStatus.textContent = "Unsaved…";
  el.saveStatus.className = "unsaved";
}

function setClean() {
  isDirty = false;
  el.unsavedDot.hidden = true;
  el.saveStatus.textContent = "All saved";
  el.saveStatus.className = "saved";
}

/* ── Theme ──────────────────────────────────────── */
function applyTheme(t) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  el.btnTheme.textContent = t === "dark" ? "☼" : "☼";
  el.btnTheme.title = t === "dark" ? "Light mode" : "Dark mode";
  savePref(SK.THEME, t);
}
function toggleTheme() { applyTheme(state.theme === "dark" ? "light" : "dark"); }

/* ── Opacity ────────────────────────────────────── */
function applyOpacity(v) {
  state.opacity = v;
  el.editor.style.opacity = v / 100;
  el.sliderOpacity.value = v;
  el.opacityValue.textContent = v + "%";
  savePref(SK.OPACITY, v);
}

/* ── Text colour ────────────────────────────────── */
function applyColor(hex) {
  state.textColor = hex;
  el.editor.style.color = hex || "";
  el.inputColor.value = hex || "#e2e0d6";
  el.colorLabel.textContent = hex || "Default";
  savePref(SK.COLOR, hex);
}

/* ── Controls panel: toggle rows ────────────────── */
let showOpacity = false;
let showColor = false;

function toggleOpacityRow() {
  showOpacity = !showOpacity;
  showColor = false;
  el.opacityRow.classList.toggle("hidden", !showOpacity);
  el.colorRow.classList.add("hidden");
  el.controlsPanel.classList.toggle("hidden", !showOpacity && !showColor);
}

function toggleColorRow() {
  showColor = !showColor;
  showOpacity = false;
  el.colorRow.classList.toggle("hidden", !showColor);
  el.opacityRow.classList.add("hidden");
  el.controlsPanel.classList.toggle("hidden", !showOpacity && !showColor);
}

/* ── Char count ─────────────────────────────────── */
function updateCount() {
  const n = el.editor.value.length;
  el.charCount.textContent = n.toLocaleString() + (n === 1 ? " char" : " chars");
}

/* ── Clear ──────────────────────────────────────── */
function clearNote() {
  el.editor.value = "";
  flushEditor();
  saveTabs();
  updateCount();
  setClean();
}

/* ── Emoji ──────────────────────────────────────── */
function buildEmojiGrid(filter) {
  const list = filter
    ? EMOJIS.filter(e => e.includes(filter.trim()))
    : EMOJIS;

  el.emojiGrid.innerHTML = "";
  const frag = document.createDocumentFragment();
  list.forEach(em => {
    const b = document.createElement("button");
    b.className = "emoji-btn";
    b.textContent = em;
    b.addEventListener("click", () => insertEmoji(em));
    frag.appendChild(b);
  });
  el.emojiGrid.appendChild(frag);
}

function insertEmoji(em) {
  const ta = el.editor;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + em + ta.value.slice(e);
  ta.setSelectionRange(s + em.length, s + em.length);
  ta.focus();
  onInput();
}

function toggleEmoji() {
  const hidden = el.emojiPanel.classList.toggle("hidden");
  if (!hidden) {
    el.emojiSearch.value = "";
    buildEmojiGrid("");
    el.emojiSearch.focus();
  }
}

/* ── Rename modal ───────────────────────────────── */
function showRenameModal(id, label) {
  renameTarget = id;
  el.renameInput.value = label;
  el.renameModal.classList.remove("hidden");
  el.renameInput.focus();
  el.renameInput.select();
}
function hideRenameModal() { el.renameModal.classList.add("hidden"); renameTarget = null; }
function confirmRename() { if (renameTarget) { renameTab(renameTarget, el.renameInput.value); } hideRenameModal(); }

/* ── Clear modal ────────────────────────────────── */
function showClearModal() { el.clearModal.classList.remove("hidden"); }
function hideClearModal() { el.clearModal.classList.add("hidden"); }

/* ── Event wiring ───────────────────────────────── */
function wire() {
  // Editor
  el.editor.addEventListener("input", onInput);
  el.editor.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); doSave(true); }
  });

  // Toolbar
  el.btnSave.addEventListener("click", () => doSave(true));
  el.btnTheme.addEventListener("click", toggleTheme);
  el.btnClear.addEventListener("click", showClearModal);
  el.btnOpacityToggle.addEventListener("click", toggleOpacityRow);
  el.btnColorToggle.addEventListener("click", toggleColorRow);

  // Tabs
  el.btnAddTab.addEventListener("click", addTab);

  // Sliders & pickers
  el.sliderOpacity.addEventListener("input", e => applyOpacity(+e.target.value));
  el.inputColor.addEventListener("input", e => applyColor(e.target.value));

  // Emoji
  el.btnEmoji.addEventListener("click", e => { e.stopPropagation(); toggleEmoji(); });
  el.emojiSearch.addEventListener("input", e => buildEmojiGrid(e.target.value));

  // Rename modal
  el.renameOk.addEventListener("click", confirmRename);
  el.renameCancel.addEventListener("click", hideRenameModal);
  el.renameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") confirmRename();
    if (e.key === "Escape") hideRenameModal();
  });

  // Clear modal
  el.clearOk.addEventListener("click", () => { clearNote(); hideClearModal(); });
  el.clearCancel.addEventListener("click", hideClearModal);

  // Click outside emoji panel to close
  document.addEventListener("click", e => {
    if (!el.emojiPanel.classList.contains("hidden") &&
      !el.emojiPanel.contains(e.target) &&
      e.target !== el.btnEmoji) {
      el.emojiPanel.classList.add("hidden");
    }
  });

  // Escape closes any open overlay
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!el.renameModal.classList.contains("hidden")) hideRenameModal();
    if (!el.clearModal.classList.contains("hidden")) hideClearModal();
    if (!el.emojiPanel.classList.contains("hidden")) el.emojiPanel.classList.add("hidden");
  });
}

/* ── Init ───────────────────────────────────────── */
async function init() {
  cacheEl();

  const saved = await loadAll();
  Object.assign(state, saved);

  // Validate activeTabId
  if (!state.tabs.find(t => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
  }

  // Apply persisted settings
  applyTheme(state.theme);
  applyOpacity(state.opacity);
  if (state.textColor) applyColor(state.textColor);

  // Render UI
  renderTabs();
  const t = activeTab();
  el.editor.value = t ? t.content : "";
  updateCount();
  setClean();

  wire();
  el.editor.focus();
}

document.addEventListener("DOMContentLoaded", init);
