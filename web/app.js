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

// ---- Miss analyzer: baseplate that reads header metadata via the existing endpoint ----

function wireMissAnalyzer() {
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
}

async function handleMissReplayFile(file) {
  const info = $("#missReplayInfo");
  const status = $("#missStatus");
  const results = $("#missResults");
  info.classList.remove("hidden");
  info.textContent = "Uploading replay...";
  status.textContent = "";
  results.classList.add("hidden");

  try {
    const buf = await file.arrayBuffer();
    status.textContent = "Parsing replay + resolving beatmap (this can take a few seconds on a cold cache)...";
    const res = await fetch("/api/miss-analyzer/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    const text = await res.text();
    if (!res.ok) {
      // Server sends JSON for known-shape errors (wrong mode etc), plain text otherwise.
      try {
        const j = JSON.parse(text);
        throw new Error(j.error || text);
      } catch (e) {
        if (e.message && e.message !== text) throw e;
        throw new Error(text);
      }
    }
    const data = JSON.parse(text);
    renderMissResults(data);
    status.textContent = "";
  } catch (err) {
    info.textContent = `Couldn't analyze replay: ${err.message}`;
    status.textContent = "";
  }
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
      const cursor = m.cursor
        ? `cursor @ (${m.cursor.x.toFixed(0)}, ${m.cursor.y.toFixed(0)}), ${m.cursor.dist.toFixed(0)}px away at ${formatMs(m.cursor.t)}`
        : `no cursor frame captured near this object`;
      return `
        <li class="miss-list-item" data-miss-index="${i}">
          <div class="miss-item-top">
            <span class="miss-item-time">${formatMs(m.objectTime)}</span>
            <span class="miss-item-kind">${escapeHtml(m.kind)}</span>
          </div>
          <div class="miss-item-detail">obj #${m.objectIndex} @ (${m.objectX}, ${m.objectY}) &middot; ${cursor}</div>
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

function selectMiss(misses, index, stats) {
  document.querySelectorAll("#missList .miss-list-item").forEach((li, i) => {
    li.classList.toggle("selected", i === index);
  });
  const m = misses[index];
  if (!m) return;
  $("#missSelectedLabel").textContent = `#${m.objectIndex} @ ${formatMs(m.objectTime)}`;

  const svg = $("#missPlayfield");
  const r = stats.circleRadiusOsuPx;
  const ctx = m.context || { objects: [], cursor: [] };

  // Sort context objects so past objects render first (below) and the
  // missed one renders last (on top). Also lets us pick a per-object
  // style from its time relative to the miss.
  const objectsSorted = ctx.objects.slice().sort((a, b) => a.t - b.t);
  const missT = m.objectTime;

  // Cursor polyline for the whole context window. Highlight the segment
  // right around the miss's own hit time so the reader's eye lands there.
  const cursorPts = ctx.cursor;
  const preMiss = [], postMiss = [];
  for (const [t, x, y] of cursorPts) (t <= missT ? preMiss : postMiss).push([x, y]);
  const pathD = (pts) => pts.length ? "M " + pts.map(([x, y]) => `${x} ${y}`).join(" L ") : "";

  // Small tick marks on the cursor path every ~150ms so timing is legible.
  const tickMarks = [];
  let lastTickT = -Infinity;
  for (const [t, x, y] of cursorPts) {
    if (t - lastTickT >= 150) {
      tickMarks.push(`<circle cx="${x}" cy="${y}" r="1.5" fill="var(--text-dim)" opacity="0.55" />`);
      lastTickT = t;
    }
  }

  const parts = [];
  parts.push(`<rect x="0" y="0" width="512" height="384" fill="#0e0c14" />`);

  // Nearby hit objects: fade older-first, tint approaching ones by accent color.
  for (const o of objectsSorted) {
    const isMissed = o.i === m.objectIndex;
    const dt = o.t - missT; // negative = already past
    // Opacity: peaks near the miss time, fades either side of the ±1500ms window.
    const fadeIn = dt < 0 ? Math.max(0, 1 + dt / 1500) : Math.max(0, 1 - dt / 1500);
    const opacity = isMissed ? 1 : 0.25 + 0.55 * fadeIn;
    const stroke = isMissed ? "var(--accent)" : dt < 0 ? "#5a5273" : "#8f86ad";
    const fill = isMissed ? "rgba(255,102,171,0.15)" : "rgba(255,255,255,0.03)";

    if (o.k === "s" && o.cp && o.cp.length >= 2) {
      const body = "M " + o.cp.map(([x, y]) => `${x} ${y}`).join(" L ");
      parts.push(`<path d="${body}" fill="none" stroke="${stroke}" stroke-width="${r * 1.8}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity * 0.35}" />`);
      parts.push(`<path d="${body}" fill="none" stroke="${stroke}" stroke-width="1.5" opacity="${opacity}" />`);
      const end = o.cp[o.cp.length - 1];
      parts.push(`<circle cx="${end[0]}" cy="${end[1]}" r="${r * 0.5}" fill="none" stroke="${stroke}" stroke-width="1.5" opacity="${opacity}" />`);
    }

    parts.push(`<circle cx="${o.x}" cy="${o.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2" opacity="${opacity}" />`);
    // Small number in the middle showing order relative to the miss (0 for the miss itself).
    const label = isMissed ? "MISS" : String(o.i - m.objectIndex);
    parts.push(`<text x="${o.x}" y="${o.y + 3}" text-anchor="middle" font-size="9" font-family="Consolas, monospace" fill="${stroke}" opacity="${opacity}">${label}</text>`);
  }

  // Missed-object judgment radius (dashed, sits over top).
  parts.push(`<circle cx="${m.objectX}" cy="${m.objectY}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.85" />`);

  // Cursor path -- pre-miss dimmer, post-miss brighter.
  parts.push(...tickMarks);
  if (preMiss.length) parts.push(`<path d="${pathD(preMiss)}" fill="none" stroke="#66d9ff" stroke-width="1.5" opacity="0.5" />`);
  if (postMiss.length) parts.push(`<path d="${pathD(postMiss)}" fill="none" stroke="#66d9ff" stroke-width="1.8" opacity="0.95" />`);

  // Cursor's closest-approach marker.
  if (m.cursor) {
    parts.push(`<line x1="${m.objectX}" y1="${m.objectY}" x2="${m.cursor.x}" y2="${m.cursor.y}" stroke="#66d9ff" stroke-width="1" stroke-dasharray="3 2" opacity="0.8" />`);
    parts.push(`<circle cx="${m.cursor.x}" cy="${m.cursor.y}" r="4.5" fill="#66d9ff" stroke="#0e0c14" stroke-width="1.5" />`);
  }

  svg.innerHTML = parts.join("");
}

function formatMs(ms) {
  const total = Math.round(ms);
  const mm = Math.floor(total / 60000);
  const ss = Math.floor((total % 60000) / 1000).toString().padStart(2, "0");
  const rest = (total % 1000).toString().padStart(3, "0");
  return `${mm}:${ss}.${rest}`;
}

init();
