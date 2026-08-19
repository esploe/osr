const state = {
  config: null,
  replayFile: null,
  replayMeta: null,
  scoreUrlMode: false,
  skins: [],
  jobsDetail: { es: null, jobId: null },
};

const $ = (sel) => document.querySelector(sel);

async function init() {
  const res = await fetch("/api/config");
  state.config = await res.json();
  $("#versionBadge").textContent = `v ${state.config.version}`;
  buildSettingsForm();
  refreshShowIfFromDOM();
  await loadSkins();
  await loadProfilesList();
  wireTabs();
  wireMainTabs();
  wireReplayInput();
  wireSkinUpload();
  wireRenderButton();
  wireShareButtons();
  wireProfileButtons();
  wireJobsTab();
  wireMissAnalyzer();
  wireMissPlayer();
  wireMissZoom();
}

// ---- Miss playfield zoom / pan ----
// Applies a transform to #missZoomGroup. Coordinates are in the SVG's
// own viewBox units (-128..640 x, -96..480 y). Wheel zooms toward the
// pointer; drag pans; the buttons zoom toward the playfield centre.
const missZoom = { scale: 1, tx: 0, ty: 0 };
const MISS_VB = { x: -128, y: -96, w: 768, h: 576 };

function applyMissZoom() {
  const g = document.getElementById("missZoomGroup");
  if (g) g.setAttribute("transform", `translate(${missZoom.tx} ${missZoom.ty}) scale(${missZoom.scale})`);
}

function resetMissZoom() {
  missZoom.scale = 1; missZoom.tx = 0; missZoom.ty = 0;
  applyMissZoom();
}

// Convert a client-space (pixel) point on the SVG element into the SVG's
// viewBox coordinate space, accounting for preserveAspectRatio letterboxing.
function svgPointFromClient(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  // The SVG uses xMidYMid meet -> uniform scale, centred. Work out the
  // rendered content box inside the element.
  const scale = Math.min(rect.width / MISS_VB.w, rect.height / MISS_VB.h);
  const renderW = MISS_VB.w * scale;
  const renderH = MISS_VB.h * scale;
  const offX = (rect.width - renderW) / 2;
  const offY = (rect.height - renderH) / 2;
  const vx = MISS_VB.x + (clientX - rect.left - offX) / scale;
  const vy = MISS_VB.y + (clientY - rect.top - offY) / scale;
  return { x: vx, y: vy };
}

function zoomAt(vx, vy, factor) {
  const newScale = Math.min(8, Math.max(1, missZoom.scale * factor));
  const f = newScale / missZoom.scale;
  // Keep the point (vx,vy) fixed under the transform:
  //   screen = translate + scale*point  ->  solve new translate.
  missZoom.tx = vx - (vx - missZoom.tx) * f;
  missZoom.ty = vy - (vy - missZoom.ty) * f;
  missZoom.scale = newScale;
  if (newScale === 1) { missZoom.tx = 0; missZoom.ty = 0; } // snap back to framed
  applyMissZoom();
}

function wireMissZoom() {
  const svg = $("#missPlayfield");

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { x, y } = svgPointFromClient(svg, e.clientX, e.clientY);
    zoomAt(x, y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  let dragging = false, lastX = 0, lastY = 0;
  svg.addEventListener("pointerdown", (e) => {
    if (missZoom.scale <= 1) return; // nothing to pan when framed
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / MISS_VB.w, rect.height / MISS_VB.h);
    // Convert pixel delta to viewBox units.
    missZoom.tx += (e.clientX - lastX) / scale;
    missZoom.ty += (e.clientY - lastY) / scale;
    lastX = e.clientX; lastY = e.clientY;
    applyMissZoom();
  });
  const endDrag = (e) => { dragging = false; try { svg.releasePointerCapture(e.pointerId); } catch {} };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  const centre = { x: MISS_VB.x + MISS_VB.w / 2, y: MISS_VB.y + MISS_VB.h / 2 };
  $("#missZoomIn").addEventListener("click", () => zoomAt(centre.x, centre.y, 1.4));
  $("#missZoomOut").addEventListener("click", () => zoomAt(centre.x, centre.y, 1 / 1.4));
  $("#missZoomReset").addEventListener("click", resetMissZoom);
}

function wireMainTabs() {
  document.querySelectorAll(".main-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.mainTab;
      document.querySelectorAll(".main-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".main-tab-content").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.mainTabContent !== tab);
      });
      if (tab === "jobs") loadJobsList();
      if (tab !== "jobs") closeJobsDetail();
    });
  });
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      state.scoreUrlMode = tab === "url";
      document.querySelectorAll(".tab-content").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.tabContent !== tab);
      });
      updateRenderButtonState();
    });
  });
}

function wireReplayInput() {
  const dz = $("#dropzone");
  const input = $("#replayFile");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files[0]) handleReplayFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => {
    if (input.files[0]) handleReplayFile(input.files[0]);
  });

  $("#scoreUrl").addEventListener("input", updateRenderButtonState);
}

async function handleReplayFile(file) {
  state.replayFile = file;
  const info = $("#replayInfo");
  info.classList.remove("hidden");
  info.textContent = "Reading replay header...";
  try {
    const buf = await file.arrayBuffer();
    // Ask the server to parse the header so we share one parser implementation.
    const res = await fetch("/api/replay/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    if (!res.ok) throw new Error(await res.text());
    const meta = await res.json();
    state.replayMeta = meta;
    info.innerHTML = `<b>${escapeHtml(meta.playerName)}</b> &middot; ${meta.mode} &middot; ${meta.modsString}<br>` +
      `beatmap hash: ${meta.beatmapHash.slice(0, 12)}&hellip;`;
  } catch (err) {
    info.textContent = `Couldn't read replay: ${err.message}`;
    state.replayMeta = null;
  }
  updateRenderButtonState();
}

async function loadSkins() {
  const res = await fetch("/api/skins");
  state.skins = await res.json();
  const sel = $("#skinSelect");
  sel.innerHTML = state.skins.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
}

function wireSkinUpload() {
  const input = $("#skinFile");
  const status = $("#skinUploadStatus");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    status.textContent = "Uploading skin...";
    const fd = new FormData();
    fd.append("skin", file);
    try {
      const res = await fetch("/api/skins", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const skin = await res.json();
      status.textContent = `Added "${skin.name}"`;
      await loadSkins();
      $("#skinSelect").value = skin.id;
    } catch (err) {
      status.textContent = `Upload failed: ${err.message}`;
    }
  });
}

function buildSettingsForm() {
  const root = $("#settingsGroups");
  root.innerHTML = "";
  for (const group of state.config.groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "opt-group";
    const h3 = document.createElement("h3");
    h3.textContent = group.label;
    groupEl.appendChild(h3);

    for (const field of group.fields) {
      if (field.key === "skinName") continue; // rendered separately in the input panel
      const row = document.createElement("div");
      row.className = "opt-row";
      row.dataset.fieldKey = field.key;
      const label = document.createElement("label");
      label.className = "opt-label";
      label.textContent = field.label;
      label.title = field.help || "";
      row.appendChild(label);

      const control = document.createElement("div");
      control.className = "opt-control";
      control.appendChild(buildControl(field));
      row.appendChild(control);
      groupEl.appendChild(row);

      if (field.showIf) applyShowIf(row, field.showIf);
    }
    root.appendChild(groupEl);
  }
}

function buildControl(field) {
  const id = `f_${field.key}`;
  if (field.type === "bool") {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.id = id;
    el.checked = Boolean(field.default);
    el.addEventListener("change", () => notifyShowIfWatchers(field.key, el.checked));
    return el;
  }
  if (field.type === "select") {
    const el = document.createElement("select");
    el.id = id;
    for (const opt of field.options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === field.default) o.selected = true;
      el.appendChild(o);
    }
    el.addEventListener("change", () => notifyShowIfWatchers(field.key, el.value));
    return el;
  }
  if (field.type === "range" || field.type === "number") {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";
    const el = document.createElement("input");
    el.type = field.type === "range" ? "range" : "number";
    el.id = id;
    el.min = field.min;
    el.max = field.max;
    el.step = field.step ?? 1;
    el.value = field.default;
    wrap.appendChild(el);
    if (field.type === "range") {
      const val = document.createElement("span");
      val.className = "range-value";
      val.textContent = field.default;
      el.addEventListener("input", () => (val.textContent = el.value));
      wrap.appendChild(val);
    }
    return wrap;
  }
  const el = document.createElement("input");
  el.type = "text";
  el.id = id;
  el.value = field.default ?? "";
  return el;
}

const showIfWatchers = [];
function applyShowIf(row, showIf) {
  const [depKey, expected] = Object.entries(showIf)[0];
  const allowed = Array.isArray(expected) ? expected : [expected];
  const evaluate = (val) => { row.style.display = allowed.includes(val) ? "" : "none"; };
  showIfWatchers.push({ depKey, evaluate });
}
function notifyShowIfWatchers(key, val) {
  for (const w of showIfWatchers) if (w.depKey === key) w.evaluate(val);
}
function refreshShowIfFromDOM() {
  for (const group of state.config.groups) {
    for (const field of group.fields) {
      if (field.type !== "bool" && field.type !== "select") continue;
      const el = document.getElementById(`f_${field.key}`);
      if (!el) continue;
      notifyShowIfWatchers(field.key, field.type === "bool" ? el.checked : el.value);
    }
  }
}

function collectSettingsValues() {
  const values = {};
  for (const group of state.config.groups) {
    for (const field of group.fields) {
      if (field.key === "skinName") continue;
      const el = document.getElementById(`f_${field.key}`);
      if (!el) continue;
      if (field.type === "bool") values[field.key] = el.checked;
      else values[field.key] = el.value;
    }
  }
  values.skinName = $("#skinSelect").value;
  return values;
}

// Reverse of collectSettingsValues -- pushes a saved profile's values back
// into the live form controls.
function applySettingsToForm(settings) {
  for (const group of state.config.groups) {
    for (const field of group.fields) {
      if (!(field.key in settings)) continue;
      const value = settings[field.key];
      if (field.key === "skinName") {
        if ([...$("#skinSelect").options].some((o) => o.value === value)) $("#skinSelect").value = value;
        continue;
      }
      const el = document.getElementById(`f_${field.key}`);
      if (!el) continue;
      if (field.type === "bool") el.checked = Boolean(value);
      else el.value = value;
      if (field.type === "range") {
        const valueLabel = el.parentElement?.querySelector(".range-value");
        if (valueLabel) valueLabel.textContent = el.value;
      }
    }
  }
  refreshShowIfFromDOM();
}

async function loadProfilesList() {
  const res = await fetch("/api/profiles");
  const names = await res.json();
  const sel = $("#profileSelect");
  sel.innerHTML =
    `<option value="">-- load a saved profile --</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
}

function wireProfileButtons() {
  const status = $("#profileStatus");

  $("#saveProfileBtn").addEventListener("click", async () => {
    const name = $("#profileNameInput").value.trim();
    if (!name) {
      status.textContent = "Enter a name first.";
      return;
    }
    status.textContent = "Saving...";
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, settings: collectSettingsValues() }),
      });
      if (!res.ok) throw new Error(await res.text());
      status.textContent = `Saved "${name}".`;
      $("#profileNameInput").value = "";
      await loadProfilesList();
      $("#profileSelect").value = name;
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
    }
  });

  $("#loadProfileBtn").addEventListener("click", async () => {
    const name = $("#profileSelect").value;
    if (!name) {
      status.textContent = "Pick a profile to load first.";
      return;
    }
    status.textContent = "Loading...";
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await res.text());
      applySettingsToForm(await res.json());
      status.textContent = `Loaded "${name}".`;
    } catch (err) {
      status.textContent = `Load failed: ${err.message}`;
    }
  });

  $("#deleteProfileBtn").addEventListener("click", async () => {
    const name = $("#profileSelect").value;
    if (!name) {
      status.textContent = "Pick a profile to delete first.";
      return;
    }
    if (!confirm(`Delete profile "${name}"?`)) return;
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      status.textContent = `Deleted "${name}".`;
      await loadProfilesList();
    } catch (err) {
      status.textContent = `Delete failed: ${err.message}`;
    }
  });
}

function updateRenderButtonState() {
  const btn = $("#renderBtn");
  if (state.scoreUrlMode) {
    btn.disabled = !$("#scoreUrl").value.trim();
  } else {
    btn.disabled = !state.replayFile;
  }
}

function wireRenderButton() {
  $("#renderBtn").addEventListener("click", startRender);
}

async function startRender() {
  const btn = $("#renderBtn");
  btn.disabled = true;
  $("#jobIdle").classList.add("hidden");
  $("#jobActive").classList.remove("hidden");
  $("#jobResult").classList.add("hidden");
  $("#shareRow").classList.add("hidden");
  $("#jobLog").textContent = "";
  $("#progressFill").style.width = "0%";
  $("#jobStage").textContent = "submitting";
  updateEta(null);

  const fd = new FormData();
  fd.append("settings", JSON.stringify(collectSettingsValues()));
  if (state.scoreUrlMode) {
    fd.append("scoreUrl", $("#scoreUrl").value.trim());
  } else {
    fd.append("replay", state.replayFile);
  }

  try {
    const res = await fetch("/api/render", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const { jobId } = await res.json();
    watchJob(jobId);
  } catch (err) {
    appendLog(`Failed to start render: ${err.message}`);
    btn.disabled = false;
  }
}

function watchJob(jobId) {
  const es = new EventSource(`/api/render/${jobId}/events`);
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data).line));
  es.addEventListener("stage", (e) => {
    const { stage, progress, eta, speed } = JSON.parse(e.data);
    $("#jobStage").textContent = stage;
    if (typeof progress === "number") $("#progressFill").style.width = `${progress}%`;
    updateEta(eta, speed);
  });
  es.addEventListener("share", (e) => showShareLink(JSON.parse(e.data)));
  es.addEventListener("status", (e) => {
    const status = JSON.parse(e.data);
    if (status === "done") {
      es.close();
      $("#progressFill").style.width = "100%";
      $("#jobStage").textContent = "done";
      updateEta(null);
      const video = $("#resultVideo");
      const link = $("#downloadLink");
      video.src = `/api/render/${jobId}/download`;
      link.href = `/api/render/${jobId}/download`;
      $("#jobResult").classList.remove("hidden");
      $("#renderBtn").disabled = false;
    } else if (status === "error") {
      es.close();
      $("#jobStage").textContent = "error";
      $("#renderBtn").disabled = false;
    }
  });
  es.onerror = () => { /* connection will retry automatically until closed above */ };
}

function updateEta(eta, speed) {
  const el = $("#jobEta");
  if (eta) {
    el.textContent = speed ? `~${eta} left · ${speed}x` : `~${eta} left`;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function appendLog(line) {
  const el = $("#jobLog");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

function showShareLink(url) {
  $("#shareLink").value = url;
  $("#openShareLink").href = url;
  $("#shareRow").classList.remove("hidden");
}

function wireShareButtons() {
  $("#copyShareBtn").addEventListener("click", async () => {
    const btn = $("#copyShareBtn");
    try {
      await navigator.clipboard.writeText($("#shareLink").value);
      btn.textContent = "Copied!";
    } catch {
      $("#shareLink").select();
      btn.textContent = "Select + Ctrl-C";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Jobs tab: render history + live log/progress for any job ----

function wireJobsTab() {
  $("#jobsRefreshBtn").addEventListener("click", loadJobsList);
}

async function loadJobsList() {
  const hint = $("#jobsListHint");
  const list = $("#jobsList");
  hint.textContent = "Loading...";
  try {
    const res = await fetch("/api/render");
    if (!res.ok) throw new Error(await res.text());
    const jobs = await res.json();
    if (!jobs.length) {
      hint.textContent = "No jobs yet.";
      list.innerHTML = "";
      return;
    }
    hint.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"}, newest first.`;
    list.innerHTML = jobs.map(renderJobRowHtml).join("");
    list.querySelectorAll(".job-row").forEach((row) => {
      row.addEventListener("click", () => selectJob(row.dataset.jobId));
    });
    // Preserve selection highlight if the previously-viewed job is still in the list.
    if (state.jobsDetail.jobId) {
      const row = list.querySelector(`.job-row[data-job-id="${state.jobsDetail.jobId}"]`);
      if (row) row.classList.add("selected");
    }
  } catch (err) {
    hint.textContent = `Failed to load jobs: ${err.message}`;
  }
}

function renderJobRowHtml(job) {
  const meta = job.meta || {};
  const player = meta.playerName ? escapeHtml(meta.playerName) : `<span class="job-row-id">${escapeHtml(job.id)}</span>`;
  const metaLine = meta.playerName
    ? `${escapeHtml(meta.mode || "")} · ${escapeHtml(meta.modsString || "")} · ${escapeHtml(job.id)}`
    : "(replay metadata pending)";
  const when = new Date(job.createdAt).toLocaleString();
  return `
    <div class="job-row" data-job-id="${escapeHtml(job.id)}">
      <div class="job-row-top">
        <span class="job-row-player">${player}</span>
        <span class="job-row-status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
      </div>
      <div class="job-row-meta">${metaLine}</div>
      <div class="job-row-meta">${escapeHtml(job.stage || "")} · ${when}</div>
    </div>
  `;
}

function selectJob(jobId) {
  closeJobsDetail();
  document.querySelectorAll("#jobsList .job-row").forEach((r) => {
    r.classList.toggle("selected", r.dataset.jobId === jobId);
  });
  state.jobsDetail.jobId = jobId;

  $("#jobsDetailEmpty").classList.add("hidden");
  $("#jobsDetail").classList.remove("hidden");
  $("#jobsDetailTitle").textContent = `Job ${jobId}`;
  $("#jobsDetailStage").textContent = "connecting...";
  $("#jobsDetailProgressFill").style.width = "0%";
  $("#jobsDetailLog").textContent = "";
  $("#jobsDetailResult").classList.add("hidden");
  $("#jobsDetailShareRow").classList.add("hidden");
  $("#jobsDetailEta").classList.add("hidden");

  const es = new EventSource(`/api/render/${jobId}/events`);
  state.jobsDetail.es = es;

  es.addEventListener("log", (e) => {
    const el = $("#jobsDetailLog");
    el.textContent += JSON.parse(e.data).line + "\n";
    el.scrollTop = el.scrollHeight;
  });
  es.addEventListener("stage", (e) => {
    const { stage, progress, eta, speed } = JSON.parse(e.data);
    $("#jobsDetailStage").textContent = stage;
    if (typeof progress === "number") $("#jobsDetailProgressFill").style.width = `${progress}%`;
    const etaEl = $("#jobsDetailEta");
    if (eta) {
      etaEl.textContent = speed ? `~${eta} left · ${speed}x` : `~${eta} left`;
      etaEl.classList.remove("hidden");
    } else {
      etaEl.classList.add("hidden");
    }
  });
  es.addEventListener("share", (e) => {
    const url = JSON.parse(e.data);
    $("#jobsDetailShareLink").value = url;
    $("#jobsDetailOpenShare").href = url;
    $("#jobsDetailShareRow").classList.remove("hidden");
  });
  es.addEventListener("status", (e) => {
    const status = JSON.parse(e.data);
    if (status === "done") {
      $("#jobsDetailProgressFill").style.width = "100%";
      $("#jobsDetailStage").textContent = "done";
      $("#jobsDetailVideo").src = `/api/render/${jobId}/download`;
      $("#jobsDetailDownload").href = `/api/render/${jobId}/download`;
      $("#jobsDetailResult").classList.remove("hidden");
      closeJobsDetail();
    } else if (status === "error") {
      $("#jobsDetailStage").textContent = "error";
      closeJobsDetail();
    }
  });
  es.onerror = () => { /* let it retry until we close */ };
}

function closeJobsDetail() {
  if (state.jobsDetail.es) {
    state.jobsDetail.es.close();
    state.jobsDetail.es = null;
  }
}

// ---- Miss analyzer ----

function wireMissAnalyzer() {
  // Source tabs (Upload .osr / Score URL).
  document.querySelectorAll(".miss-src-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const src = btn.dataset.missSrc;
      document.querySelectorAll(".miss-src-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".miss-src-content").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.missSrcContent !== src);
      });
    });
  });

  const dz = $("#missDropzone");
  const input = $("#missReplayFile");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files[0]) handleMissReplayFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => {
    if (input.files[0]) handleMissReplayFile(input.files[0]);
  });

  const urlBtn = $("#missAnalyzeUrlBtn");
  urlBtn.addEventListener("click", handleMissScoreUrl);
  $("#missScoreUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleMissScoreUrl();
  });
}

// Shared result/error handling for both analysis entry points. `doFetch`
// returns the fetch Response promise; everything else (status text,
// error parsing, rendering) is identical.
async function runMissAnalysis(doFetch) {
  const info = $("#missReplayInfo");
  const status = $("#missStatus");
  const results = $("#missResults");
  info.classList.remove("hidden");
  info.textContent = "Analyzing...";
  status.textContent = "Parsing replay + resolving beatmap (this can take a few seconds on a cold cache)...";
  results.classList.add("hidden");

  try {
    const res = await doFetch();
    const text = await res.text();
    if (!res.ok) {
      // Error body is JSON ({error}) for known-shape failures, plain text
      // for 500s. Prefer the JSON message; fall back to the raw text.
      let msg = text;
      try {
        const j = JSON.parse(text);
        if (j && j.error) msg = j.error;
      } catch { /* not JSON -- use the raw text as-is */ }
      throw new Error(msg);
    }
    renderMissResults(JSON.parse(text));
    status.textContent = "";
  } catch (err) {
    info.textContent = `Couldn't analyze replay: ${err.message}`;
    status.textContent = "";
  }
}

async function handleMissReplayFile(file) {
  const buf = await file.arrayBuffer();
  await runMissAnalysis(() =>
    fetch("/api/miss-analyzer/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    })
  );
}

async function handleMissScoreUrl() {
  const url = $("#missScoreUrl").value.trim();
  if (!url) {
    $("#missStatus").textContent = "Paste a score URL first.";
    return;
  }
  await runMissAnalysis(() =>
    fetch("/api/miss-analyzer/analyze-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scoreUrl: url }),
    })
  );
}

function renderMissResults(data) {
  const { header, beatmap, misses, stats, warning } = data;
  $("#missReplayInfo").innerHTML =
    `<b>${escapeHtml(header.playerName)}</b> &middot; ${escapeHtml(beatmap.artist)} - ${escapeHtml(beatmap.title)} [${escapeHtml(beatmap.version)}]<br>` +
    `mods ${escapeHtml(header.modsString)} &middot; combo ${header.maxCombo}${header.perfectCombo ? " (FC)" : ""} &middot; ` +
    `header reports <b>${header.counts.countMiss}</b> miss${header.counts.countMiss === 1 ? "" : "es"}`;

  const detected = misses.length;
  const reported = header.counts.countMiss;
  const summary = `Detected <b>${detected}</b> miss${detected === 1 ? "" : "es"} on hit-circles/slider-heads.`;
  const delta = detected === reported ? "matches replay header." : `(header says ${reported} -- differences are usually slider-body drops or spinner losses that this analyzer intentionally skips.)`;
  $("#missSummaryText").innerHTML = summary;
  $("#missSummaryStats").innerHTML =
    `${delta}<br>` +
    `Effective OD ${stats.effectiveOD.toFixed(2)} (50-window &plusmn;${stats.hitWindow50Ms.toFixed(1)}ms), ` +
    `effective CS ${stats.effectiveCS.toFixed(2)} (radius ${stats.circleRadiusOsuPx.toFixed(1)}px). ` +
    `Judged ${stats.judgedObjects} objects, skipped ${stats.spinnersSkipped} spinner${stats.spinnersSkipped === 1 ? "" : "s"}.` +
    (warning ? `<br><span style="color:var(--err)">${escapeHtml(warning)}</span>` : "");

  const list = $("#missList");
  if (!detected) {
    list.innerHTML = `<li class="miss-list-empty">No missed hit-circles or slider-heads detected. Nice.</li>`;
  } else {
    list.innerHTML = misses.map((m, i) => {
      const cat = m.diagnosis?.category || "unknown";
      const catLabel = {
        no_tap: "no tap",
        aim_miss: "aim off",
        early_tap: "early",
        late_tap: "late",
        both_off: "both off",
        unknown: "?",
      }[cat] || cat;
      return `
        <li class="miss-list-item" data-miss-index="${i}" data-category="${cat}">
          <div class="miss-item-top">
            <span class="miss-item-time">${formatMs(m.objectTime)}</span>
            <span class="miss-item-cat cat-${cat}">${escapeHtml(catLabel)}</span>
          </div>
          <div class="miss-item-detail">${escapeHtml(m.diagnosis?.text || "no diagnosis")}</div>
        </li>
      `;
    }).join("");
    list.querySelectorAll(".miss-list-item").forEach((li) => {
      li.addEventListener("click", () => selectMiss(misses, Number(li.dataset.missIndex), stats));
    });
    selectMiss(misses, 0, stats);
  }

  $("#missResults").classList.remove("hidden");
}

// Miss-playback state -- one player instance shared across all misses so
// switching between them cancels the previous rAF loop cleanly.
const missPlayer = {
  miss: null,
  stats: null,
  cursor: [], // [[t,x,y],...] already sorted by t (server emits in order)
  objects: [], // context objects sorted by hit-time
  tMin: 0,
  tMax: 0,
  playStart: 0,
  currentT: 0,
  playing: false,
  speed: 0.5,
  lastRafWall: 0,
  rafId: 0,
};

function selectMiss(misses, index, stats) {
  document.querySelectorAll("#missList .miss-list-item").forEach((li, i) => {
    li.classList.toggle("selected", i === index);
  });
  const m = misses[index];
  if (!m) return;
  $("#missSelectedLabel").textContent = `#${m.objectIndex} @ ${formatMs(m.objectTime)}`;

  // Diagnosis line -- the one-glance "why did this miss happen".
  const diagEl = $("#missDiagnosis");
  if (m.diagnosis) {
    diagEl.dataset.category = m.diagnosis.category;
    diagEl.textContent = m.diagnosis.text;
    diagEl.classList.remove("hidden");
  } else {
    diagEl.classList.add("hidden");
  }

  const ctx = m.context || { objects: [], cursor: [], windowStart: m.objectTime - 1500, windowEnd: m.objectTime + 500 };
  const tMin = ctx.windowStart ?? m.objectTime - 3000;
  const tMax = ctx.windowEnd ?? m.objectTime + 1500;
  // Where Play/Restart begin -- just the approach into the miss, not 3s
  // of empty lead-in. Scrub can still reach the full tMin..tMax range.
  const preempt = stats.preemptMs || 1200;
  const playStart = Math.max(tMin, m.objectTime - preempt - 300);

  // Stop any in-flight playback from the previously-selected miss.
  if (missPlayer.playing) {
    missPlayer.playing = false;
    cancelAnimationFrame(missPlayer.rafId);
  }

  Object.assign(missPlayer, {
    miss: m,
    stats,
    cursor: ctx.cursor.slice().sort((a, b) => a[0] - b[0]),
    objects: ctx.objects.slice().sort((a, b) => a.t - b.t),
    tMin,
    tMax,
    playStart,
    // Land ON the miss moment, paused. This is the "money frame": the
    // note, the cursor's approach into it, and the tap(s) are all right
    // there to read without pressing anything.
    currentT: m.objectTime,
    lastRafWall: 0,
  });
  $("#missPlayBtn").textContent = "▶ Play";

  renderTimingStrip();
  resetMissZoom();

  const scrub = $("#missScrub");
  scrub.min = tMin;
  scrub.max = tMax;
  scrub.step = 5;
  scrub.value = m.objectTime;

  renderMissPlayback();
}

function togglePlay() {
  missPlayer.playing = !missPlayer.playing;
  $("#missPlayBtn").textContent = missPlayer.playing ? "⏸ Pause" : "▶ Play";
  if (missPlayer.playing) {
    missPlayer.lastRafWall = performance.now();
    missPlayer.rafId = requestAnimationFrame(tickPlayback);
  } else {
    cancelAnimationFrame(missPlayer.rafId);
  }
}

function tickPlayback(now) {
  if (!missPlayer.playing) return;
  const dtWall = now - missPlayer.lastRafWall;
  missPlayer.lastRafWall = now;
  // Advance replay time by real-time * speed. Clamp to window end and
  // auto-pause when we reach it so the user isn't stuck watching a
  // frozen frame that they thought was still playing.
  missPlayer.currentT = Math.min(missPlayer.tMax, missPlayer.currentT + dtWall * missPlayer.speed);
  $("#missScrub").value = missPlayer.currentT;
  renderMissPlayback();
  if (missPlayer.currentT >= missPlayer.tMax) {
    missPlayer.playing = false;
    $("#missPlayBtn").textContent = "▶ Play";
    return;
  }
  missPlayer.rafId = requestAnimationFrame(tickPlayback);
}

// Single windowed renderer. Everything is drawn relative to the current
// playhead with a moderate fade window -- like a sane approach rate, not
// the AR0 "everything on screen forever" clutter and not the old
// too-fast 200ms flash. A paused frame shows the ~1s around the playhead:
// the notes in play, the cursor's recent path, and the taps that happened
// nearby -- enough to read the miss, little enough to stay legible.
const TRAIL_MS = 650;       // how far back the cursor trail reaches
const OBJ_FADE_OUT_MS = 450; // how long an object lingers after its hit window
const TAP_FADE_MS = 900;     // how long a tap marker stays visible after it happens

function renderMissPlayback() {
  const { miss: m, stats, cursor, objects, currentT } = missPlayer;
  if (!m) return;
  const r = stats.circleRadiusOsuPx;
  const preempt = stats.preemptMs || 1200;
  const hw50 = stats.hitWindow50Ms || 150;

  const parts = [];
  parts.push(`<rect x="-128" y="-96" width="768" height="576" fill="#0e0c14" />`);
  parts.push(`<rect x="0" y="0" width="512" height="384" fill="none" stroke="var(--border)" stroke-width="1" opacity="0.45" />`);

  // Objects within the visible window (approach -> shortly after hit).
  for (const o of objects) {
    const showFrom = o.t - preempt;
    const objEnd = (o.k === "s" ? (o.et ?? o.t) : o.t) + hw50;
    const showUntil = objEnd + OBJ_FADE_OUT_MS;
    if (currentT < showFrom || currentT > showUntil) continue;

    const isMissed = o.i === m.objectIndex;
    const fadeIn = Math.min(1, (currentT - showFrom) / 250);
    const fadeOut = currentT > objEnd ? Math.max(0, 1 - (currentT - objEnd) / OBJ_FADE_OUT_MS) : 1;
    const op = fadeIn * fadeOut;
    const missedAndPast = isMissed && currentT > o.t + hw50;
    const stroke = missedAndPast ? "#ff4646" : isMissed ? "var(--accent)" : "#9b93bd";

    if (o.k === "s" && o.cp && o.cp.length >= 2) {
      const body = "M " + o.cp.map(([x, y]) => `${x} ${y}`).join(" L ");
      parts.push(`<path d="${body}" fill="none" stroke="${stroke}" stroke-width="${r * 1.9}" stroke-linecap="round" stroke-linejoin="round" opacity="${op * 0.25}" />`);
      parts.push(`<path d="${body}" fill="none" stroke="${stroke}" stroke-width="1.2" opacity="${op * 0.85}" />`);
      const end = o.cp[o.cp.length - 1];
      parts.push(`<circle cx="${end[0]}" cy="${end[1]}" r="${r * 0.6}" fill="none" stroke="${stroke}" stroke-width="1.2" opacity="${op * 0.75}" />`);
    }
    parts.push(`<circle cx="${o.x}" cy="${o.y}" r="${r}" fill="${isMissed ? "rgba(255,102,171,0.12)" : "rgba(200,196,224,0.04)"}" stroke="${stroke}" stroke-width="2" opacity="${op}" />`);

    // Approach ring (4r -> r) while the note is still approaching.
    if (currentT < o.t) {
      const appR = r + 3 * r * ((o.t - currentT) / preempt);
      parts.push(`<circle cx="${o.x}" cy="${o.y}" r="${appR}" fill="none" stroke="${stroke}" stroke-width="1.3" opacity="${op * 0.7}" />`);
    }
    if (missedAndPast) {
      parts.push(`<text x="${o.x}" y="${o.y + 4}" text-anchor="middle" font-size="12" font-weight="700" font-family="Consolas, monospace" fill="#ff4646" opacity="${op}">MISS</text>`);
    }
  }

  // Cursor trail: last TRAIL_MS, opacity decaying with age. Held-key
  // segments draw thicker/whiter so tapping is visible in the motion.
  const trailFrom = currentT - TRAIL_MS;
  let prevPt = null;
  for (const f of cursor) {
    if (f[0] < trailFrom) { prevPt = f; continue; }
    if (f[0] > currentT) break;
    if (prevPt) {
      const age = (currentT - f[0]) / TRAIL_MS; // 0 = now, 1 = oldest
      const op = 0.15 + 0.7 * (1 - age);
      const held = (prevPt[3] & 0b1111) !== 0;
      parts.push(
        `<line x1="${prevPt[1]}" y1="${prevPt[2]}" x2="${f[1]}" y2="${f[2]}" ` +
          `stroke="${held ? "#ffffff" : "#66d9ff"}" stroke-width="${held ? 2.4 : 1.4}" ` +
          `opacity="${held ? Math.min(1, op + 0.2) : op}" stroke-linecap="round" />`
      );
    }
    prevPt = f;
  }

  // Tap markers within TAP_FADE_MS of the playhead -- diamonds at the
  // exact tap position, fading as they age so they linger long enough to
  // read but don't pile up into permanent clutter. Green = aim on the
  // note, red (+ leader line) = off.
  for (const tap of (m.taps || [])) {
    const age = currentT - tap.t;
    if (age < 0 || age > TAP_FADE_MS) continue;
    const op = 0.25 + 0.75 * (1 - age / TAP_FADE_MS);
    const color = tap.inRadius ? "#6ee7a0" : "#ff4d6d";
    const d = 7;
    parts.push(
      `<path d="M ${tap.x} ${tap.y - d} L ${tap.x + d} ${tap.y} L ${tap.x} ${tap.y + d} L ${tap.x - d} ${tap.y} Z" ` +
        `fill="${color}" fill-opacity="${op * 0.3}" stroke="${color}" stroke-width="1.8" opacity="${op}" />`
    );
    if (!tap.inRadius) {
      parts.push(`<line x1="${tap.x}" y1="${tap.y}" x2="${m.objectX}" y2="${m.objectY}" stroke="${color}" stroke-width="0.9" stroke-dasharray="3 3" opacity="${op * 0.55}" />`);
    }
    parts.push(`<text x="${tap.x}" y="${tap.y - d - 3}" text-anchor="middle" font-size="9" font-family="Consolas, monospace" fill="${color}" opacity="${op}">${tap.dOffset >= 0 ? "+" : ""}${tap.dOffset}ms</text>`);
  }

  // Live cursor dot at the playhead.
  const cursorAt = cursorPositionAt(cursor, currentT);
  const keysNow = cursorKeysAt(cursor, currentT);
  if (cursorAt) {
    const held = (keysNow & 0b1111) !== 0;
    const dotR = held ? 6 : 5;
    parts.push(`<circle cx="${cursorAt.x}" cy="${cursorAt.y}" r="${dotR}" fill="${held ? "#ffffff" : "#66d9ff"}" stroke="#0e0c14" stroke-width="1.5" />`);
    if (held) parts.push(`<circle cx="${cursorAt.x}" cy="${cursorAt.y}" r="${dotR + 4}" fill="none" stroke="#ffffff" stroke-width="1.4" opacity="0.85" />`);
  }

  document.getElementById("missBaseGroup").innerHTML = parts.join("");
  document.getElementById("missOverlayGroup").innerHTML = "";
  $("#missPlayTime").textContent = `t = ${formatOffsetMs(currentT - m.objectTime)} (${formatMs(currentT)})`;
  updateTimingStripPlayhead();
}

// Timing strip below the scrub bar: colored hit-window bands + tap
// tick marks + playhead. This is what turns "did they tap or not" and
// "was the tap early / late / aimed off" into a single glance.
function renderTimingStrip() {
  const { miss: m, stats } = missPlayer;
  const svg = $("#missTimingStrip");
  if (!m || !stats) { svg.innerHTML = ""; return; }
  const hw50 = stats.hitWindow50Ms;
  // Fixed time span so the visual scale is comparable across misses:
  // ±300ms around the object's own hit time.
  const span = 300;
  const w = 1000, h = 44;
  const objectPx = w / 2;
  const pxPerMs = (w / 2) / span;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#161320" rx="6" />`);

  // Hit-window bands from the OD-derived numbers. Widths are the
  // canonical std values relative to the 50 window:
  //   hw300 = 80 - 6*OD   (≈ 0.4x hw50)
  //   hw100 = 140 - 8*OD  (≈ 0.7x hw50)
  //   hw50  = 200 - 10*OD
  const OD = stats.effectiveOD;
  const hw300 = Math.max(0, 80 - 6 * OD);
  const hw100 = Math.max(0, 140 - 8 * OD);
  const band = (winMs, color, opacity) => {
    const x = objectPx - winMs * pxPerMs;
    const bw = winMs * 2 * pxPerMs;
    parts.push(`<rect x="${x}" y="6" width="${bw}" height="${h - 12}" fill="${color}" opacity="${opacity}" rx="3" />`);
  };
  band(hw50, "#ff8a3d", 0.20);   // 50 = orange
  band(hw100, "#ffd23d", 0.28);  // 100 = yellow
  band(hw300, "#6ee7a0", 0.32);  // 300 = green

  // Center line = the object's ideal hit time.
  parts.push(`<line x1="${objectPx}" y1="4" x2="${objectPx}" y2="${h - 4}" stroke="var(--accent)" stroke-width="1.4" />`);

  // Every tap in the ±TAP_LOOKAROUND (≥ ±span here) as a tick,
  // colored by whether the aim was on the note.
  for (const tap of (m.taps || [])) {
    if (Math.abs(tap.dOffset) > span) continue;
    const x = objectPx + tap.dOffset * pxPerMs;
    const color = tap.inRadius ? "#6ee7a0" : "#ff4d6d";
    parts.push(`<line x1="${x}" y1="4" x2="${x}" y2="${h - 4}" stroke="${color}" stroke-width="2" opacity="0.95" />`);
    parts.push(`<circle cx="${x}" cy="${h - 4}" r="2.2" fill="${color}" />`);
  }

  // Placeholder for the playhead (updated separately without a full re-render).
  parts.push(`<line id="missTimingPlayhead" x1="-99" y1="0" x2="-99" y2="${h}" stroke="#ffffff" stroke-width="1.2" opacity="0.85" />`);

  // Legend anchor points (labels are tiny, hint text under the strip
  // spells them out for anyone who can't read the color).
  parts.push(`<text x="6" y="${h - 6}" font-size="9" fill="var(--text-dim)" font-family="Consolas, monospace">-${span}ms</text>`);
  parts.push(`<text x="${w - 6}" y="${h - 6}" font-size="9" fill="var(--text-dim)" font-family="Consolas, monospace" text-anchor="end">+${span}ms</text>`);

  svg.innerHTML = parts.join("");
}

function updateTimingStripPlayhead() {
  const { miss: m, currentT } = missPlayer;
  const ph = document.getElementById("missTimingPlayhead");
  if (!ph || !m) return;
  const span = 300;
  const w = 1000;
  const x = (w / 2) + (currentT - m.objectTime) * ((w / 2) / span);
  if (x < 0 || x > w) { ph.setAttribute("x1", -99); ph.setAttribute("x2", -99); return; }
  ph.setAttribute("x1", x);
  ph.setAttribute("x2", x);
}

function cursorKeysAt(cursor, t) {
  if (!cursor.length) return 0;
  // Walk to the latest frame at or before t.
  let lo = 0, hi = cursor.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cursor[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return cursor[lo][3] || 0;
}

function cursorPositionAt(cursor, t) {
  if (!cursor.length) return null;
  if (t <= cursor[0][0]) return { x: cursor[0][1], y: cursor[0][2] };
  if (t >= cursor[cursor.length - 1][0]) {
    const last = cursor[cursor.length - 1];
    return { x: last[1], y: last[2] };
  }
  // Binary search for the first frame with time > t.
  let lo = 0, hi = cursor.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cursor[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  const [t1, x1, y1] = cursor[lo - 1];
  const [t2, x2, y2] = cursor[lo];
  const a = t2 === t1 ? 0 : (t - t1) / (t2 - t1);
  return { x: x1 + (x2 - x1) * a, y: y1 + (y2 - y1) * a };
}

function formatOffsetMs(ms) {
  const sign = ms >= 0 ? "+" : "−";
  return `${sign}${Math.abs(ms / 1000).toFixed(2)}s`;
}

function wireMissPlayer() {
  $("#missPlayBtn").addEventListener("click", () => {
    if (!missPlayer.miss) return;
    // Starting a fresh play from a resting/ended position rewinds to the
    // approach start so you watch the run-in, not zero seconds from wherever.
    if (!missPlayer.playing && missPlayer.currentT >= missPlayer.tMax - 1) {
      missPlayer.currentT = missPlayer.playStart;
      $("#missScrub").value = missPlayer.playStart;
      renderMissPlayback();
    }
    togglePlay();
  });
  $("#missRestartBtn").addEventListener("click", () => {
    if (!missPlayer.miss) return;
    missPlayer.currentT = missPlayer.playStart;
    $("#missScrub").value = missPlayer.playStart;
    renderMissPlayback();
    if (!missPlayer.playing) togglePlay();
  });
  $("#missSpeed").addEventListener("change", (e) => {
    missPlayer.speed = Number(e.target.value) || 0.5;
  });
  $("#missScrub").addEventListener("input", (e) => {
    if (!missPlayer.miss) return;
    // Pause during manual scrub so playback doesn't fight the user's drag.
    if (missPlayer.playing) togglePlay();
    missPlayer.currentT = Number(e.target.value);
    renderMissPlayback();
  });
}

function formatMs(ms) {
  const total = Math.round(ms);
  const mm = Math.floor(total / 60000);
  const ss = Math.floor((total % 60000) / 1000).toString().padStart(2, "0");
  const rest = (total % 1000).toString().padStart(3, "0");
  return `${mm}:${ss}.${rest}`;
}

init();
