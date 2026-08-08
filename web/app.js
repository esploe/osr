const state = {
  config: null,
  replayFile: null,
  replayMeta: null,
  scoreUrlMode: false,
  skins: [],
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
  wireReplayInput();
  wireSkinUpload();
  wireRenderButton();
  wireShareButtons();
  wireProfileButtons();
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
    const { stage, progress } = JSON.parse(e.data);
    $("#jobStage").textContent = stage;
    if (typeof progress === "number") $("#progressFill").style.width = `${progress}%`;
  });
  es.addEventListener("share", (e) => showShareLink(JSON.parse(e.data)));
  es.addEventListener("status", (e) => {
    const status = JSON.parse(e.data);
    if (status === "done") {
      es.close();
      $("#progressFill").style.width = "100%";
      $("#jobStage").textContent = "done";
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

init();
