"use strict";

// ── State ──────────────────────────────────────────────────────────────────
let libraries       = [];   // [{name, url}, ...]
let selectedFile    = null;
let bookCount       = 0;
let allBooks        = [];   // all to-read books parsed from CSV
let results         = [];
let runLibraries    = [];   // snapshot of libraries used in the current run
let abortController = null;

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();

  // One-time button wiring (not inside renderLibraries so listeners don't stack)
  document.getElementById("add-lib-btn").addEventListener("click", () => {
    libraries.push({ name: "", url: "" });
    renderLibraries();
    const inputs = document.querySelectorAll(".lib-name-input");
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById("save-btn").addEventListener("click", saveConfig);
  document.getElementById("download-btn").addEventListener("click", downloadMarkdown);

  setupDropZone();
  setupFileInput();
  setupDelaySlider();

  document.getElementById("run-btn").addEventListener("click", startRun);
  document.getElementById("stop-btn").addEventListener("click", stopRun);
  document.getElementById("skip-ku").addEventListener("change", () => {
    toggleKuCard(!document.getElementById("skip-ku").checked);
  });
  document.getElementById("limit-input").addEventListener("input", updateFilteredCount);
  document.getElementById("filter-format").addEventListener("change", updateFilteredCount);
});

// ── Config ─────────────────────────────────────────────────────────────────
const CONFIG_KEY = "libraryConfig";

async function loadConfig() {
  // Prefer localStorage (client-side, survives server redeploys)
  const stored = localStorage.getItem(CONFIG_KEY);
  if (stored) {
    try {
      const cfg = JSON.parse(stored);
      libraries = Array.isArray(cfg.libraries) ? cfg.libraries : [];
      renderLibraries();
      updateRunBtn();
      return;
    } catch {}
  }
  // Migration path: fetch from server config once, then it lives in localStorage
  try {
    const res = await fetch("/config");
    const cfg = await res.json();
    libraries = Array.isArray(cfg.libraries) ? cfg.libraries : [];
  } catch {
    libraries = [];
  }
  renderLibraries();
  updateRunBtn();
}

function saveConfig() {
  const saveBtn  = document.getElementById("save-btn");
  const statusEl = document.getElementById("save-status");
  saveBtn.disabled = true;

  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ libraries }));
    statusEl.className   = "save-status";
    statusEl.textContent = "Saved ✓";
    setTimeout(() => (statusEl.textContent = ""), 2500);
  } catch {
    statusEl.className   = "save-status error";
    statusEl.textContent = "Save failed";
  }
  saveBtn.disabled = false;
}

// ── Library list ───────────────────────────────────────────────────────────
function renderLibraries() {
  const list = document.getElementById("library-list");
  list.innerHTML = "";

  libraries.forEach((lib, idx) => {
    const key      = extractLibbyKey(lib.url || "");
    const keyValid = Boolean(key);

    const entry = document.createElement("div");
    entry.className = "library-entry";
    entry.innerHTML = `
      <div class="library-entry-top">
        <input class="lib-name-input" type="text" placeholder="Library name"
          value="${esc(lib.name || "")}" data-idx="${idx}" data-field="name">
        <span class="lib-key-badge ${keyValid ? "" : "invalid"}"
          id="key-badge-${idx}">${keyValid ? esc(key) : "no key"}</span>
        <button class="btn-remove" data-idx="${idx}" title="Remove library">×</button>
      </div>
      <input class="lib-url-input" type="url"
        placeholder="https://libbyapp.com/library/your-key"
        value="${esc(lib.url || "")}" data-idx="${idx}" data-field="url">
    `;

    // Live-update library data + badge on input
    entry.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        const i     = Number(e.target.dataset.idx);
        const field = e.target.dataset.field;
        libraries[i][field] = e.target.value;

        if (field === "url") {
          const k     = extractLibbyKey(e.target.value);
          const badge = document.getElementById(`key-badge-${i}`);
          badge.textContent = k || "no key";
          badge.className   = `lib-key-badge ${k ? "" : "invalid"}`;
        }
        updateRunBtn();
      });
    });

    entry.querySelector(".btn-remove").addEventListener("click", (e) => {
      libraries.splice(Number(e.target.dataset.idx), 1);
      renderLibraries();
      updateRunBtn();
    });

    list.appendChild(entry);
  });
}

// ── File handling ──────────────────────────────────────────────────────────
function setupDropZone() {
  const zone = document.getElementById("drop-zone");

  zone.addEventListener("dragover",  (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", ()  => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  // The zone is a <label for="file-input">, so tapping it natively opens the picker on Android.
  // No JS click handler needed.
}

function setupFileInput() {
  const inp = document.getElementById("file-input");
  inp.addEventListener("change", () => {
    if (inp.files[0]) handleFile(inp.files[0]);
  });
}

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    alert("Please select a .csv file.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    alert("CSV file is too large (max 5 MB).");
    return;
  }
  selectedFile = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    allBooks = parseAllToReadBooks(e.target.result);
    showFileSelected(file.name, allBooks.length);
    updateFilteredCount();
  };
  reader.readAsText(file);
}

function parseAllToReadBooks(csvText) {
  const lines    = csvText.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers  = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const shelfIdx = headers.indexOf("read status");
  const dateIdx  = headers.indexOf("date added");
  const fmtIdx   = headers.indexOf("format");
  const titleIdx = headers.indexOf("title");
  const authIdx  = headers.indexOf("authors");
  if (shelfIdx === -1) return [];
  const books = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if ((cols[shelfIdx] || "").trim().toLowerCase() !== "to-read") continue;
    books.push({
      title:     (cols[titleIdx] || "").trim(),
      author:    (cols[authIdx]  || "").split(",")[0].trim(),
      dateAdded: (cols[dateIdx]  || "").trim(),
      format:    (cols[fmtIdx]   || "").trim().toLowerCase(),
    });
  }
  return books;
}

function getFilteredBooks() {
  const formatFilter = document.getElementById("filter-format").value;
  const limitVal     = parseInt(document.getElementById("limit-input").value, 10);
  const limit        = !isNaN(limitVal) && limitVal > 0 ? limitVal : Infinity;

  let filtered = allBooks.filter((book) => {
    if (formatFilter !== "all") {
      const digital  = ["digital", "ebook"];
      const physical = ["hardcover", "paperback"];
      if (formatFilter === "digital"  && !digital.includes(book.format))  return false;
      if (formatFilter === "audio"    && book.format !== "audio")          return false;
      if (formatFilter === "physical" && !physical.includes(book.format))  return false;
    }
    return true;
  });

  if (limit !== Infinity) filtered = filtered.slice(0, limit);
  return filtered;
}

function updateFilteredCount() {
  bookCount = allBooks.length ? getFilteredBooks().length : 0;
  const countEl = document.querySelector(".book-count");
  if (countEl) {
    const suffix = bookCount !== allBooks.length ? ` of ${allBooks.length}` : "";
    countEl.textContent = `${bookCount}${suffix} to-read book${bookCount !== 1 ? "s" : ""} found`;
  }
  updateRunBtn();
}

// Minimal RFC-4180-compliant CSV line parser
function parseCSVLine(line) {
  const result = [];
  let field = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      result.push(field); field = "";
    } else {
      field += c;
    }
  }
  result.push(field);
  return result;
}

function showFileSelected(name, count) {
  const zone = document.getElementById("drop-zone");
  zone.innerHTML = `
    <div class="file-selected">
      <div>
        <div class="file-name">📄 ${esc(name)}</div>
        <div class="book-count">${count} to-read book${count !== 1 ? "s" : ""} found</div>
      </div>
      <button class="btn-clear" id="clear-btn" title="Remove file">×</button>
    </div>
  `;
  document.getElementById("clear-btn").addEventListener("click", (e) => {
    e.preventDefault(); // prevent the label from opening the file picker
    e.stopPropagation();
    clearFile();
  });
}

function clearFile() {
  selectedFile = null;
  bookCount    = 0;
  allBooks     = [];
  document.getElementById("file-input").value = "";
  document.getElementById("drop-zone").innerHTML = `
    <div class="drop-zone-inner">
      <div class="icon">📂</div>
      <p class="drop-hint-desktop">Drop your Storygraph CSV here, or <span class="link">browse</span></p>
      <p class="drop-hint-mobile">Tap to upload your Storygraph CSV</p>
    </div>
  `;
  updateRunBtn();
}

// ── Options ────────────────────────────────────────────────────────────────
function setupDelaySlider() {
  const slider = document.getElementById("delay-slider");
  const valEl  = document.getElementById("delay-val");
  slider.addEventListener("input", () => {
    valEl.textContent = parseFloat(slider.value).toFixed(1) + "s";
  });
}

function toggleKuCard(show) {
  const card = document.getElementById("ku-summary-card");
  const grid = document.getElementById("summary-grid");
  card.classList.toggle("hidden", !show);
  grid.classList.toggle("no-ku", !show);
}

// ── Run button ─────────────────────────────────────────────────────────────
function updateRunBtn() {
  const hasFile = Boolean(selectedFile);
  const hasLibs = libraries.some((l) => l.name.trim() && extractLibbyKey(l.url || ""));
  document.getElementById("run-btn").disabled = !(hasFile && hasLibs);
}

// ── Run ────────────────────────────────────────────────────────────────────
async function startRun() {
  results      = [];
  runLibraries = libraries.filter((l) => l.name.trim() && extractLibbyKey(l.url || ""));

  const skipKu       = document.getElementById("skip-ku").checked;
  const formatFilter = document.getElementById("filter-format").value;
  const limitVal     = parseInt(document.getElementById("limit-input").value, 10);
  const limit        = !isNaN(limitVal) && limitVal > 0 ? limitVal : 0;

  abortController = new AbortController();

  // Reset UI
  document.getElementById("run-btn").disabled = true;
  document.getElementById("stop-btn").classList.remove("hidden");
  document.getElementById("progress-panel").classList.remove("hidden");
  document.getElementById("results-panel").classList.add("hidden");
  document.getElementById("results-tbody").innerHTML = "";
  resetSummary();
  buildTableHead(runLibraries, skipKu);
  toggleKuCard(!skipKu);

  const formData = new FormData();
  formData.append("csv",           selectedFile);
  formData.append("skip_ku",       String(skipKu));
  formData.append("delay",         document.getElementById("delay-slider").value);
  formData.append("libraries",     JSON.stringify(runLibraries));
  formData.append("format_filter", formatFilter);
  formData.append("limit",         String(limit));

  let total = 0;

  try {
    const response = await fetch("/run", {
      method: "POST",
      body:   formData,
      signal: abortController.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      alert("Error: " + (err.error || `HTTP ${response.status}`));
      return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop(); // keep any incomplete event

      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          if (data.type === "total")    { total = data.count; setProgress(0, total, ""); }
          if (data.type === "progress") { setProgress(data.i - 1, total, `Checking: ${data.title}`); }
          if (data.type === "result")   {
            setProgress(data.i, total, `✓ ${data.title}`);
            appendResult(data, skipKu);
            // Reveal results as they arrive so the user doesn't wait until the end
            document.getElementById("results-panel").classList.remove("hidden");
          }
          if (data.type === "done")     { setProgress(total, total, "Done!"); }
        } catch { /* ignore malformed event */ }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      setProgress(results.length, total || results.length,
        `Stopped — showing ${results.length} of ${total} book${total !== 1 ? "s" : ""}`);
    } else {
      alert("Connection error: " + err.message);
    }
  } finally {
    abortController = null;
    document.getElementById("run-btn").disabled = false;
    document.getElementById("stop-btn").classList.add("hidden");
    document.getElementById("results-panel").classList.remove("hidden");
    setTimeout(() => document.getElementById("progress-panel").classList.add("hidden"), results.length ? 3000 : 1200);
  }
}

// ── Stop ───────────────────────────────────────────────────────────────────
function stopRun() {
  if (abortController) abortController.abort();
}

// ── Progress ───────────────────────────────────────────────────────────────
function setProgress(done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById("progress-fill").style.width    = pct + "%";
  document.getElementById("progress-label").textContent   = label;
  document.getElementById("progress-fraction").textContent = total > 0 ? `${done} / ${total}` : "";
}

// ── Results table ──────────────────────────────────────────────────────────
function buildTableHead(libs, skipKu) {
  let html = "<tr><th>Book</th>";
  for (const lib of libs) html += `<th>${esc(lib.name)}</th>`;
  if (!skipKu) html += "<th>Kindle Unlimited</th>";
  html += "</tr>";
  document.getElementById("results-thead").innerHTML = html;
}

function appendResult(data, skipKu) {
  results.push(data);

  const tr = document.createElement("tr");
  let html = `
    <td>
      <div class="book-title">${esc(data.title)}</div>
      <div class="book-author">${esc(data.author)}</div>
    </td>
  `;
  for (const lib of runLibraries) {
    html += `<td>${libbyBadge(data.libby[lib.name])}</td>`;
  }
  if (!skipKu) {
    html += `<td>${kuBadge(data.ku)}</td>`;
  }
  tr.innerHTML = html;
  document.getElementById("results-tbody").appendChild(tr);

  updateSummary();
}

function libbyBadge(res) {
  if (!res) return `<span class="badge badge-error">⚠ Error</span>`;
  const ebook = res.ebook    || { status: "not_found", url: "" };
  const audio = res.audiobook || { status: "not_found", url: "" };
  const parts = [
    fmtLibbySubBadge(ebook, "eBook"),
    fmtLibbySubBadge(audio, "Audio"),
  ].filter(Boolean);
  return parts.length
    ? parts.join(" ")
    : `<span class="badge badge-notfound">Not found</span>`;
}

function fmtLibbySubBadge(sub, label) {
  switch (sub.status) {
    case "available": return badge("available", sub.url, `✓ ${label}`);
    case "waitlist":  return badge("waitlist",  sub.url, `⏳ ${label}`);
    case "error":     return `<span class="badge badge-error" title="${esc(sub.message || "")}">⚠ ${label}</span>`;
    default:          return null; // "not_found" → omit
  }
}

function kuBadge(res) {
  switch (res.status) {
    case "available": return badge("ku",       res.url, "✓ KU");
    case "not_found": return `<span class="badge badge-notfound">Not on KU</span>`;
    case "error":     return `<span class="badge badge-error" title="${esc(res.message || "")}">⚠ KU error</span>`;
    case "skipped":   return `<span class="badge-skipped">—</span>`;
    default:          return "—";
  }
}

function badge(cls, url, text) {
  if (url) return `<a href="${esc(url)}" target="_blank" rel="noopener" class="badge badge-${cls}">${esc(text)}</a>`;
  return `<span class="badge badge-${cls}">${esc(text)}</span>`;
}

// ── Summary cards ──────────────────────────────────────────────────────────
function resetSummary() {
  document.getElementById("count-available").textContent = "0";
  document.getElementById("count-waitlist").textContent  = "0";
  document.getElementById("count-ku").textContent        = "0";
}

function updateSummary() {
  let avail = 0, wait = 0, ku = 0;
  for (const r of results) {
    const vals = Object.values(r.libby);
    const isAvail = vals.some((v) =>
      v?.ebook?.status === "available" || v?.audiobook?.status === "available"
    );
    const isWait = !isAvail && vals.some((v) =>
      v?.ebook?.status === "waitlist" || v?.audiobook?.status === "waitlist"
    );
    if (isAvail) avail++;
    else if (isWait) wait++;
    if (r.ku.status === "available") ku++;
  }
  document.getElementById("count-available").textContent = avail;
  document.getElementById("count-waitlist").textContent  = wait;
  document.getElementById("count-ku").textContent        = ku;
}

// ── Download markdown ──────────────────────────────────────────────────────
function downloadMarkdown() {
  if (!results.length) return;

  const skipKu  = document.getElementById("skip-ku").checked;
  const libNames = runLibraries.map((l) => l.name);
  const now      = new Date().toLocaleString();

  let md = `# Book Availability Report\n\n`;
  md += `**Generated:** ${now}  \n`;
  md += `**Libraries:** ${libNames.join(", ")}  \n`;
  md += `**Books checked:** ${results.length}\n\n---\n\n`;

  for (const r of results) {
    md += `## ${r.title}\n*by ${r.author}*\n\n`;
    md += `| Source | Status |\n|--------|--------|\n`;
    for (const name of libNames) {
      md += `| ${name} | ${mdLibby(r.libby[name] || { status: "error" })} |\n`;
    }
    if (!skipKu) md += `| Kindle Unlimited | ${mdKu(r.ku)} |\n`;
    md += "\n";
  }

    const hasAvail = (r) => Object.values(r.libby).some(
    (v) => v?.ebook?.status === "available" || v?.audiobook?.status === "available"
  );
  const hasWait  = (r) => Object.values(r.libby).some(
    (v) => v?.ebook?.status === "waitlist" || v?.audiobook?.status === "waitlist"
  );
  const avail = results.filter(hasAvail);
  const wait  = results.filter((r) => !hasAvail(r) && hasWait(r));
  const ku = results.filter((r) => r.ku.status === "available");

  md += `---\n\n## Summary\n\n`;
  md += `### ✅ Available on Libby now (${avail.length})\n`;
  md += (avail.length ? avail.map((r) => `- **${r.title}** by ${r.author}`).join("\n") : "- *None*") + "\n";
  md += `\n### ⏳ On Libby waitlist (${wait.length})\n`;
  md += (wait.length ? wait.map((r) => `- **${r.title}** by ${r.author}`).join("\n") : "- *None*") + "\n";
  if (!skipKu) {
    md += `\n### 📖 On Kindle Unlimited (${ku.length})\n`;
    md += (ku.length ? ku.map((r) => `- **${r.title}** by ${r.author}`).join("\n") : "- *None*") + "\n";
  }

  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href:     url,
    download: `book_availability_${new Date().toISOString().slice(0, 10)}.md`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function mdLibby(res) {
  if (!res) return "⚠️ Error";
  const fmtSub = (sub, label) => {
    if (!sub) return null;
    switch (sub.status) {
      case "available": return `✅ ${label}`;
      case "waitlist":  return `⏳ ${label} (waitlist)`;
      case "error":     return `⚠️ ${label} error`;
      default:          return null;
    }
  };
  const parts = [fmtSub(res.ebook, "eBook"), fmtSub(res.audiobook, "Audio")].filter(Boolean);
  return parts.length ? parts.join(" / ") : "❌ Not found";
}
function mdKu(res) {
  switch (res.status) {
    case "available": return "✅ On Kindle Unlimited";
    case "not_found": return "❌ Not on KU";
    case "error":     return "⚠️ Check failed";
    case "skipped":   return "— Skipped";
    default:          return res.status;
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function extractLibbyKey(url) {
  if (!url) return "";
  const m = url.match(/libbyapp\.com\/library\/([^/?#\s]+)/);
  return m ? m[1] : url.trim().replace(/\/+$/, "");
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
