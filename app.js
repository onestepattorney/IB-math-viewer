"use strict";
const $ = (id) => document.getElementById(id);
let questions = [], topics = {}, current = null, shown = [];

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
// Manual tag edits (Tag editor) and "review later" marks, both kept in this browser's localStorage.
const OKEY = "ibmath.overrides.v1", FKEY = "ibmath.flags.v1", SKEY = "ibmath.overrides.setaside.v1";
// Tag edits saved before the subtopic list was reorganised (no `tax` stamp, older than STALE_BEFORE) refer to old subtopic
// numbers and would show the wrong subtopic now. They are set aside (kept, not deleted) and the user is told once.
const TAX = 2, STALE_BEFORE = 1791634312917;
let overrides = lsGet(OKEY), flags = lsGet(FKEY), current_r = null, rShown = [];
const PAGE = 200;  // list rows rendered at a time
let listLimit = PAGE, rListLimit = PAGE;

// ---- assets: local relative paths, or (link mode) fetched on demand from the private repo via the GitHub API ----
const REMOTE = window.IB_REMOTE || null;
const TKEY = "ibmath.token", CACHE = "ibmath-assets-v1";
const getToken = () => { try { return localStorage.getItem(TKEY) || ""; } catch { return ""; } };
class AssetError extends Error {}
function apiUrl(rel) {
  return `${REMOTE.apiBase}/repos/${REMOTE.owner}/${REMOTE.repo}/contents/${(REMOTE.base || "") + rel}?ref=${encodeURIComponent(REMOTE.ref)}`;
}
function explain(status, res) {
  if (status === 401) return "GitHub rejected the token (expired, revoked or mistyped). Create a new one and reconnect.";
  if (status === 403) return res && res.headers.get("x-ratelimit-remaining") === "0"
    ? "GitHub API rate limit reached. Wait a while and retry." : "The token has no read access to this repository (needs Contents: Read-only for IB-math).";
  if (status === 404) return "File not found in the repository. Check the branch/path in data/config.js, and that the token can see the private repo.";
  return `GitHub returned HTTP ${status}.`;
}
async function loadAsset(rel, fresh) { // -> Blob; fresh = skip the cache (scripts that change on the branch)
  const cache = fresh ? null : await caches.open(CACHE).catch(() => null);
  const key = apiUrl(rel).replace(/^https:\/\/[^/]+/, "https://cache.local");
  const hit = cache && await cache.match(key);
  if (hit) return hit.blob();
  const token = getToken();
  if (!token) throw new AssetError("Not connected: add a GitHub token first.");
  let res;
  try { res = await fetch(apiUrl(rel), { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.raw+json" } }); }
  catch { throw new AssetError("Network error while contacting GitHub."); }
  if (!res.ok) throw new AssetError(explain(res.status, res));
  const blob = await res.blob();
  if (cache) cache.put(key, new Response(blob.slice(), { headers: { "content-type": blob.type || "application/octet-stream" } })).catch(() => {});
  return blob;
}
const imgTokens = new WeakMap();
// Question images: empty bands (page-break gaps, dotted answer boxes; data/qcut.js from tools/qcut.py) are hidden by
// showing the image as stacked slices; the <img> itself stays (loading, retry) but is hidden while slices are shown.
function qMapY(cuts, y) { let d = 0; for (const [a, b] of cuts) { if (y >= b) d += b - a; else if (y > a) return a - d; else break; } return y - d; }
function buildCut(img, own) { // own: the bands to hide instead of the stored ones (a video keeps the answer space its notes use)
  const old = img.nextElementSibling; if (old && old.classList.contains("qcut")) old.remove();
  img.style.display = ""; img._cuts = null;
  const cuts = img._rel && img.getAttribute("src") && (own || (window.IB_QCUT || {})[img._rel]);
  if (!cuts || !img.naturalWidth) return;
  const W = img.naturalWidth, H = img.naturalHeight, box = document.createElement("div"); let y = 0;
  box.className = "qcut"; box.style.maxWidth = `min(100%, ${W}px)`;
  for (const [a, b] of [...cuts, [H, H]]) {
    if (a > y) { const d = document.createElement("div"), im = document.createElement("img");
      d.style.aspectRatio = `${W} / ${a - y}`; im.src = img.src; im.alt = ""; im.style.marginTop = `${-y / W * 100}%`; d.appendChild(im); box.appendChild(d); }
    y = b;
  }
  img.after(box); img.style.display = "none"; img._cuts = cuts; img._h2 = H - cuts.reduce((m, [a, b]) => m + b - a, 0);
}
function setImage(img, rel) {
  img._rel = rel; if (!img._cutL) { img._cutL = 1; img.addEventListener("load", () => buildCut(img, img.id === "q-img" && $("panes").classList.contains("vid-on") ? vVideoCuts() : undefined)); }
  if (!rel) { img.removeAttribute("src"); buildCut(img); return; }
  if (!REMOTE) { img.src = rel; return; }
  const n = (imgTokens.get(img) || 0) + 1; imgTokens.set(img, n);
  img.removeAttribute("src"); img.alt = "Loading…"; img.classList.add("loading"); img.classList.remove("failed");
  loadAsset(rel).then((b) => {
    if (imgTokens.get(img) !== n) return;
    if (img._url) URL.revokeObjectURL(img._url);
    img._url = URL.createObjectURL(b); img.src = img._url; img.classList.remove("loading");
  }).catch((e) => {
    if (imgTokens.get(img) !== n) return;
    img.classList.remove("loading"); img.classList.add("failed");
    img.alt = "Couldn't load: " + e.message; img.title = "Click to retry"; img.onclick = () => { img.onclick = null; setImage(img, rel); };
  });
}
async function openAsset(rel, hash) { // PDFs: open in a new tab
  if (!REMOTE) { window.open(rel + (hash || ""), "_blank", "noopener"); return; }
  const w = window.open("", "_blank");
  try { const b = await loadAsset(rel); const u = URL.createObjectURL(new Blob([b], { type: "application/pdf" })); if (w) w.location = u + (hash || ""); }
  catch (e) { if (w) w.close(); alert(e.message); }
}
// Link mode: private scripts (video id list and year files, hidden-band rows) come from the private repo like the images,
// so the public shell holds code only. They are run as <script> from a blob URL; the pen-note font is loaded the same way.
async function loadRemoteScript(rel) {
  const text = await (await loadAsset(rel, true)).text();
  const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  await new Promise((ok, bad) => { const el = document.createElement("script"); el.src = url; el.onload = ok; el.onerror = bad; document.head.appendChild(el); });
  URL.revokeObjectURL(url);
}
async function loadRemoteExtras() { // video id list and hidden bands; the app works without them
  if (!REMOTE || !getToken()) return;
  await Promise.all(["data/videos/index.js", "data/qcut.js"].map((r) => loadRemoteScript(r).catch(() => {})));
}
let vFontDone = false;
function vLoadFont() { // Kalam for the pen notes (style.css points at vendor/kalam/, which the public shell does not ship)
  if (!REMOTE || vFontDone || !window.FontFace) return; vFontDone = true;
  loadAsset("vendor/kalam/kalam-subset.woff2").then((b) => b.arrayBuffer())
    .then((buf) => new FontFace("Kalam", buf, { weight: "400" }).load()).then((f) => document.fonts.add(f)).catch(() => { vFontDone = false; });
}
function prefetch(rels) { if (REMOTE && getToken()) rels.filter(Boolean).forEach((r) => loadAsset(r).catch(() => {})); }

async function connectCard() { // returns when connected (local mode: immediately)
  if (!REMOTE || getToken()) return;
  const card = $("connect"); card.hidden = false;
  await new Promise((done) => {
    $("c-test").onclick = async () => {
      const t = $("c-token").value.trim(), msg = $("c-msg");
      if (!t) { msg.textContent = "Paste your token first."; return; }
      msg.textContent = "Testing…";
      try {
        const res = await fetch(apiUrl("data/topics.json"), { headers: { Authorization: "Bearer " + t, Accept: "application/vnd.github.raw+json" } });
        if (!res.ok) { msg.textContent = explain(res.status, res); return; }
        try { localStorage.setItem(TKEY, t); } catch {}
        $("c-token").value = ""; card.hidden = true; done();
      } catch { msg.textContent = "Network error while contacting GitHub."; }
    };
  });
}

const subName = (subject, id) => {
  for (const t of topics[subject] || []) for (const s of t.subtopics) if (s.id === id) return s.name;
  return null;
};
const topicName = (id) => (topics.AA.find((t) => t.id === id) || {}).name || null;
const subOptions = (q) => { // subtopics a question may use: course list, no HL-only items on SL papers
  const t = (topics[q.subject] || []).find((x) => x.id === (q._topic || q.topic));
  return t ? t.subtopics.filter((s) => q.level === "HL" || !s.hl_only) : [];
};
function applyOverride(q) {
  if (!q.orig) q.orig = { topic: q.topic, subtopic: q.subtopic, extra: q.extra || [], difficulty: q.difficulty, reviewed: !!q.reviewed };
  const o = overrides[q.id];
  q.topic = q.orig.topic; q.subtopic = q.orig.subtopic; q.extra = q.orig.extra; q.difficulty = q.orig.difficulty;
  q.reviewed = q.orig.reviewed; q.edited = false;
  if (o) {
    if (o.topic) { q.topic = o.topic; q.subtopic = o.subtopic; q.extra = o.extra || []; q.difficulty = o.difficulty; q.edited = true; }
    if (o.reviewed) q.reviewed = true;
  }
  q.topic_name = topicName(q.topic); q.subtopic_name = subName(q.subject, q.subtopic);
}

// Difficulty is stored 1-5 in the data; the app shows three levels.
const TIER_NAMES = ["", "Easy", "Medium", "Hard"];
const tier = (d) => (d == null ? 0 : d <= 2 ? 1 : d === 3 ? 2 : 3);
const tierToDiff = (t, cur) => (tier(cur) === t ? cur : [null, 2, 3, 4][t]);  // keep the stored value when the level is unchanged
const tierPill = (q) => (q.difficulty ? `<span class="tier t${tier(q.difficulty)}">${TIER_NAMES[tier(q.difficulty)]}</span>` : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const label = (q) => `${q.year} ${q.month.slice(0, 3)} ${q.level} ${q.subject} P${q.paper}${q.tz === "TZ0" ? "" : " " + q.tz} Q${q.q}`;
const isMarked = (q) => !!flags[q.id];
const isNarrow = () => window.matchMedia("(max-width: 800px)").matches;
const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);

function fillSelect(sel, items, keep = "") {
  const prev = sel.value;
  sel.innerHTML = '<option value="">All</option>' + items.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("");
  sel.value = items.some(([v]) => v === prev) ? prev : keep;
}

// The list/viewer panels: on a wide screen the list collapses to the left; on a phone it swaps with the viewer.
function placePanel(split) { // phone: the open list is a box under the toolbar that never covers the whole screen
  const side = split.querySelector(".side"), bar = split.querySelector(".toolbar");
  if (!isNarrow() || !split.classList.contains("list-open") || !bar) { side.style.top = side.style.maxHeight = ""; return; }
  let r = bar.getBoundingClientRect();
  if (r.top > innerHeight * 0.45) { bar.scrollIntoView({ block: "start" }); r = bar.getBoundingClientRect(); }
  side.style.top = r.bottom + 4 + "px";
  side.style.maxHeight = Math.max(160, Math.min(innerHeight * 0.5, innerHeight - r.bottom - 16)) + "px";
}
function openList(split, open) { split.classList.toggle(isNarrow() ? "list-open" : "collapsed", isNarrow() ? open : !open); placePanel(split); }
function toggleList(split) { openList(split, isNarrow() ? !split.classList.contains("list-open") : split.classList.contains("collapsed")); }
function showViewer(split) { split.classList.remove("list-open"); placePanel(split); window.scrollTo(0, 0); }
function setPosition(bar, labelEl, idx, n, fallback) { // "3 / 12" and a thin progress line under the toolbar
  labelEl.textContent = idx >= 0 ? `${idx + 1} / ${n}` : fallback;
  bar.style.width = idx >= 0 && n ? `${(100 * (idx + 1)) / n}%` : "0";
}
document.addEventListener("pointerdown", (e) => { // tap outside the open list box closes it
  for (const sp of document.querySelectorAll(".split.list-open")) {
    if (isNarrow() && !e.target.closest(".side") && !e.target.closest("#list-toggle, #r-list-toggle")) { sp.classList.remove("list-open"); placePanel(sp); }
  }
});
for (const ev of ["scroll", "resize"]) window.addEventListener(ev, () => document.querySelectorAll(".split.list-open").forEach(placePanel), { passive: true });

// ---------------- practice: filters ----------------
const FILTER_IDS = ["f-subject", "f-level", "f-topic", "f-subtopic", "f-paper", "f-diff", "f-year", "f-month", "f-tz"];

function refreshTopicFilters() {
  // Topic ids/names are shared by AA and AI; subtopics depend on the course.
  fillSelect($("f-topic"), topics.AA.map((t) => [t.id, `${t.id}. ${t.name}`]));
  refreshSubtopics();
}
function refreshSubtopics() {
  const tid = $("f-topic").value;
  const pool = $("f-subject").value === "AI" ? topics.AI : topics.AA;
  const subs = tid ? pool.filter((t) => t.id === tid).flatMap((t) => t.subtopics) : [];
  fillSelect($("f-subtopic"), subs.map((s) => [s.name, `${s.id} ${s.name}${s.hl_only ? " (HL)" : ""}`]));
}

// The controls only edit a draft. The list is built from `applied`, which changes only when "Show questions" is pressed,
// so the list on screen always matches the filters it says it was built from.
const EMPTY_F = { level: "", subject: "", paper: "", topic: "", sub: "", diff: 0, year: "", month: "", tz: "", qnum: "", marked: false };
let applied = null, appliedText = "";  // null until the first "Show questions"
const readDraft = () => ({
  level: $("f-level").value, subject: $("f-subject").value, paper: $("f-paper").value,
  topic: $("f-topic").value, sub: $("f-subtopic").value, diff: +$("f-diff").value,
  year: $("f-year").value, month: $("f-month").value, tz: $("f-tz").value, qnum: $("f-qnum").value,
  marked: $("f-marked").checked,
});
const matcher = (f) => (q) =>
  (!f.level || q.level === f.level) && (!f.subject || q.subject === f.subject) &&
  (!f.paper || String(q.paper) === f.paper) && (!f.year || String(q.year) === f.year) &&
  (!f.month || q.month === f.month) && (!f.tz || q.tz === f.tz) && (!f.qnum || String(q.q) === f.qnum) &&
  (!f.topic || q.topic === f.topic) && (!f.sub || q.subtopic_name === f.sub) &&
  (!f.diff || tier(q.difficulty) === f.diff) && (!f.marked || isMarked(q));
const filtered = () => (applied ? questions.filter(matcher(applied)) : []);
function draftText() {
  const parts = FILTER_IDS.filter((id) => $(id).value).map((id) => $(id).selectedOptions[0].text);
  if ($("f-qnum").value) parts.push("Q" + $("f-qnum").value);
  if ($("f-marked").checked) parts.push("⚑ only");
  return parts.length ? parts.join(" · ") : "All questions";
}
function updateDraftUI() { // live count on the button + a line saying which filters the list shows
  const f = readDraft(), n = questions.filter(matcher(f)).length, b = $("apply");
  b.disabled = n === 0;
  b.textContent = n ? `Show ${n} question${n === 1 ? "" : "s"}` : "No questions match";
  const pending = JSON.stringify(f) !== JSON.stringify(applied || EMPTY_F), el = $("fb-summary");
  const mark = pending ? '<span class="pending">Not applied yet</span> · ' : "";  // first, so a phone's truncated line still shows it
  if (applied) el.innerHTML = `${mark}Showing: ${esc(appliedText)} — ${shown.length}`;
  else el.innerHTML = pending ? `${mark}press “Show”` : "Choose filters, then press “Show”.";
}
function setFiltersOpen(o) { $("filterbar").classList.toggle("open", o); $("fb-toggle").setAttribute("aria-expanded", String(o)); $("fb-toggle").innerHTML = o ? "Filters &#9652;" : "Filters &#9662;"; }
function clearViewer() {
  current = null; $("question").hidden = true; $("empty").hidden = false; $("now").textContent = "";
  setImage($("q-img"), null); setImage($("ms-img"), null); showMs(false); setImage($("sol-img"), null); updateMarkUI();
}
function applyFilters({ first = false } = {}) {
  applied = readDraft(); appliedText = draftText();
  clearViewer();  // the previous question belongs to the previous filters
  renderList(true);
  setFiltersOpen(false);
  if (first && shown.length) { openQuestion(shown[0]); return; }
  if (isNarrow()) requestAnimationFrame(() => openList($("p-body"), true)); else $("p-body").classList.remove("collapsed");
}
function clearAll() { // back to the state when Practice is first opened
  for (const id of FILTER_IDS) $(id).value = "";
  $("f-qnum").value = ""; $("f-marked").checked = false;
  refreshTopicFilters();
  applied = null; appliedText = "";
  clearViewer();
  if (isNarrow()) { openList($("p-body"), false); setFiltersOpen(true); }
  renderList(true);
}

function renderList(reset) {
  shown = filtered();
  if (reset) listLimit = PAGE;
  const n = shown.length, idx = shown.findIndex((q) => current && q.id === current.id);
  $("count").textContent = !applied ? "No list yet" : `${n} question${n === 1 ? "" : "s"}` + (idx >= 0 ? ` · ${n - idx - 1} left after this one` : "");
  setPosition($("pos-bar"), $("list-label"), idx, n, applied ? `List (${n})` : "List");
  const rows = shown.slice(0, listLimit).map((q, i) =>
    `<li data-i="${i}" class="${current && current.id === q.id ? "sel" : ""}"><span class="r">${isMarked(q) ? '<span class="flag">⚑</span>' : ""}${q.marks}m</span>` +
    `${label(q)}<br><small>${esc(q.title || "(untagged)")}${q.difficulty ? " · " + TIER_NAMES[tier(q.difficulty)] : ""}</small></li>`);
  if (n > listLimit) rows.push(`<li class="more" data-more>Show ${Math.min(PAGE, n - listLimit)} more (${n - listLimit} left)</li>`);
  $("list").innerHTML = rows.join("") || `<li class="muted">${applied ? "No questions match these filters." : "Choose filters above, then press “Show”."}</li>`;
  if (!current) $("empty").textContent = !applied ? "Choose filters above, then press “Show” to get a list of questions." : n ? `${n} question${n === 1 ? "" : "s"} found — pick one from the list.` : "No questions match these filters — loosen a filter and press “Show” again.";
  updateDraftUI();
  const sel = $("list").querySelector("li.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
}

function openQuestion(q) {
  current = q;
  $("empty").hidden = true; $("question").hidden = false;
  setImage($("q-img"), q.img); setImage($("ms-img"), q.ms_img); showMs(false);
  const nx = shown[shown.findIndex((x) => x.id === q.id) + 1]; if (nx) prefetch([nx.img]);
  $("meta").innerHTML = `<b>${label(q)}</b> <span>${q.marks} marks${q.section ? " · Section " + esc(q.section) : ""}</span>` +
    (q.topic_name ? ` <span>${esc(q.topic_name)} › ${esc(q.subtopic_name)}</span> ${tierPill(q)}` : "") +
    (q.edited ? ' <span class="badge edited">edited</span>' : "");
  setupSolution(q); setupVideo(q);
  $("now").innerHTML = `<b>${label(q)}</b> · ${esc(q.subtopic_name || "")}${q.difficulty ? " · " + TIER_NAMES[tier(q.difficulty)] : ""}`;
  updateMarkUI();
  renderList();
  $("viewer").scrollTop = 0;
  showViewer($("p-body"));
}
// The markscheme sits next to the question (below it on a phone) and stays covered until asked for.
function updateCover() { $("ms-cover").hidden = !$("ms-img").hidden || !$("sol-panel").hidden || !$("vid-panel").hidden; }
function showMs(on) {
  $("ms-img").hidden = !on; updateCover();
  $("toggle-ms").textContent = on ? "Hide markscheme" : "Show markscheme";
  $("toggle-ms").classList.toggle("primary", !on);
}
function step(d) {
  if (!shown.length) return;
  const i = shown.findIndex((q) => current && q.id === current.id);
  openQuestion(shown[i < 0 ? (d > 0 ? 0 : shown.length - 1) : (i + d + shown.length) % shown.length]);
}

// ---- review-later marks ----
function updateMarkUI() {
  const on = !!(current && isMarked(current));
  for (const id of ["mark", "mark2"]) {
    const b = $(id); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    b.innerHTML = on ? "&#9873; Marked" : "&#9873; Review later";
  }
}
function toggleMark() {
  if (!current) return;
  if (flags[current.id]) delete flags[current.id]; else flags[current.id] = Date.now();
  lsSet(FKEY, flags); updateMarkUI(); renderList();
}

// ---- own solution PDF (data/solutions/*.pdf), opened at the page where the question starts ----
function setupSolution(q) {
  const has = !!q.my_solution;
  $("toggle-sol").hidden = !has;
  $("toggle-sol").textContent = "Show my solution";
  $("sol-panel").hidden = true; setImage($("sol-img"), null); $("toggle-sol").classList.add("primary"); updateCover();
  if (!has) return;
  const p = q.my_solution_pages;
  $("sol-note").textContent = p ? `My solution for this question only (PDF page${p[0] === p[1] ? " " + p[0] : "s " + p[0] + "–" + p[1]} of ${p[2]}).` : "";
}
function toggleSolution() {
  if (!current || !current.my_solution) return;
  const panel = $("sol-panel"), show = panel.hidden;
  panel.hidden = !show;
  $("toggle-sol").textContent = show ? "Hide my solution" : "Show my solution";
  $("toggle-sol").classList.toggle("primary", !show);
  if (show) setImage($("sol-img"), current.my_solution_img || null);
  updateCover();
}


// ---- video explanation (data/videos/<year>.js, loaded on demand; one script per question; the question image is highlighted, a board shows the maths) ----
const VLKEY = "ib.video";
const vPref = () => { try { return JSON.parse(localStorage.getItem(VLKEY)) || {}; } catch { return {}; } };
const vSave = () => { try { localStorage.setItem(VLKEY, JSON.stringify({ lang: $("vid-lang").value, sub: $("vid-sub").value, rate: $("vid-rate").value, voice: $("vid-voice").checked })); } catch {} };
// Pausable timers: pausing freezes them (and the pen animations and the voice) so playback continues exactly where it stopped.
let vTimers = new Map(), vTid = 0, vPaused = false, vSpeech = null, vFrozen = [];
function vAfter(fn, ms) {
  const id = ++vTid, t = { fn, due: performance.now() + ms, left: ms, h: null }; vTimers.set(id, t);
  if (!vPaused) t.h = setTimeout(() => { vTimers.delete(id); fn(); }, ms);
  return id;
}
function vCancel(id) { const t = vTimers.get(id); if (t) { clearTimeout(t.h); vTimers.delete(id); } }
function vCancelAll() { for (const t of vTimers.values()) clearTimeout(t.h); vTimers.clear(); }
function vPause() {
  vPaused = true; const now = performance.now();
  for (const t of vTimers.values()) { clearTimeout(t.h); t.left = Math.max(0, t.due - now); }
  vFrozen = document.getAnimations().filter((a) => { const el = a.effect && a.effect.target; return a.playState === "running" && el && el.closest && el.closest("#vid-panel, #qwrap"); });
  vFrozen.forEach((a) => a.pause());
  if (vSpeech) vSpeech.pause();
  vSetPlay(false);
}
function vResume() {
  vPaused = false; const now = performance.now();
  for (const [id, t] of vTimers) { t.due = now + t.left; t.h = setTimeout(() => { vTimers.delete(id); t.fn(); }, t.left); }
  vFrozen.forEach((a) => a.play()); vFrozen = [];
  if (vSpeech) vSpeech.resume();
  vSetPlay(true);
}
let vInkT = [], vFlat = [], vScript = null, vTok = 0, vPlaying = false, vPos = { s: 0, i: 0 }, vTimer = null, vVoices = [];
const vOf = (q) => (window.IB_VIDEOS && q && window.IB_VIDEOS[q.id]) || null;
// Scripts live in one file per exam year (data/videos/<year>.js, year = first four characters of the id); only the id list
// data/videos/index.js is loaded with the page. A year file is added as a <script> (works from file://) on the first
// "Watch video" of that year. vYearState[year] = array of waiting callbacks while loading, true when loaded.
const vYearState = {};
const vHas = (q) => !!(vOf(q) || (q && window.IB_VIDEO_IDS && window.IB_VIDEO_IDS.includes(q.id)));
function vLoadYear(id, done) {
  const y = id.slice(0, 4), st = vYearState[y];
  if (window.IB_VIDEOS && window.IB_VIDEOS[id]) return done(true);
  if (st === true) return done(false);
  if (Array.isArray(st)) { st.push(done); return; }
  const wait = vYearState[y] = [done];
  const finish = (ok) => { vYearState[y] = ok ? true : undefined; wait.forEach((f) => f(ok && !!(window.IB_VIDEOS && window.IB_VIDEOS[id]))); };
  vLoadFont();
  if (REMOTE) { loadRemoteScript(`data/videos/${y}.js`).then(() => finish(true), () => finish(false)); return; }
  const el = document.createElement("script");
  el.src = `data/videos/${y}.js`; el.onload = () => finish(true); el.onerror = () => { el.remove(); finish(false); };
  document.head.appendChild(el);
}
let vCurQ = null;
function setupVideo(q) {
  vCurQ = q; vStop(); vScript = vOf(q); vBuild();
  const btn = $("toggle-vid"); btn.hidden = !vHas(q); btn.disabled = false; btn.textContent = "Watch video"; btn.classList.add("primary");
  $("vid-panel").hidden = true; $("panes").classList.remove("vid-on"); vClearHl(); vInkClear(); updateCover();
}
function toggleVideo() {
  if (!vScript) {
    const q = vCurQ, btn = $("toggle-vid");
    if (!vHas(q) || btn.disabled) return;
    btn.disabled = true; btn.textContent = "Loading video…";
    vLoadYear(q.id, (ok) => {
      if (vCurQ !== q) return; // another question was opened meanwhile
      btn.disabled = false; vScript = vOf(q);
      if (!ok || !vScript) { btn.textContent = "Video could not be loaded"; return; }
      vBuild(); btn.textContent = "Watch video"; toggleVideo();
    });
    return;
  }
  const show = $("vid-panel").hidden;
  $("vid-panel").hidden = !show;
  $("toggle-vid").textContent = show ? "Hide video" : "Watch video";
  $("toggle-vid").classList.toggle("primary", !show);
  $("panes").classList.toggle("vid-on", show); buildCut($("q-img"), show ? vVideoCuts() : undefined); if (!show) $("qscroll").scrollTop = 0; else vFitQ(true);
  updateCover();
  if (show) { vPos = { s: 0, i: 0 }; vRender(0, 0); vSetPlay(false); vSceneLabel(); } else { vStop(); vClearHl(); vInkClear(); }
}
function vInitVoices() { if (window.speechSynthesis) vVoices = speechSynthesis.getVoices(); }
// Phones (iOS Safari above all) allow speech only when the first speak() runs inside the tap itself, and often give an
// empty voice list at first: vUnlockSpeech() speaks a silent utterance during the tap that starts playing, vVoice() asks
// for the list again, and the first sentence waits up to 1 s for it; with still no list only subtitles are shown.
const vBadVoices = new Set(); // voices that failed on this device (Android: a network voice may fail): skipped from then on
let vSpeechUnlocked = false, vVoicesWaited = false; // vVoicesWaited: waited once (up to 1 s) for the list
// Some phone browsers (Android) never list their voices but still speak with the system voice when only the language is
// set: then a "default voice" (no u.voice) is tried; if it does not start within 3 s or fails, only subtitles are shown.
const vDefaultBad = {};
function vDefaultVoice(lang) { return vDefaultBad[lang] ? null : { def: true, name: "", lang: lang === "ko" ? "ko-KR" : "en-US" }; }
function vUnlockSpeech() {
  if (vSpeechUnlocked || !window.speechSynthesis) return;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); vSpeechUnlocked = true; } catch {}
}
function vVoice(lang) {
  if (!vVoices.length) vInitVoices();
  const pre = lang === "ko" ? ["ko"] : ["en-US", "en-GB", "en"];
  for (const p of pre) { const v = vVoices.filter((x) => x.lang && x.lang.replace("_", "-").startsWith(p) && !vBadVoices.has(x.name)); if (v.length) return v.find((x) => !x.localService) || v[0]; }
  return null;
}
function vBuild() { // flat list of (scene, sentence) positions + chips
  vFlat = []; if (!vScript) return;
  vScript.scenes.forEach((sc, s) => sc.sentences.forEach((_, i) => vFlat.push({ s, i })));
  $("vid-seek").max = Math.max(0, vFlat.length - 1); $("vid-seek").value = 0;
  $("vid-chips").innerHTML = vScript.scenes.map((sc, s) => sc.chip ? `<button type="button" data-s="${s}"></button>` : "").join("");
  const first = []; vScript.scenes.forEach((_, s) => first.push(vFlat.findIndex((p) => p.s === s)));
  $("vid-ticks").innerHTML = first.slice(1).map((k) => `<i style="left:${vFlat.length > 1 ? (k / (vFlat.length - 1)) * 100 : 0}%"></i>`).join("");
  $("vid-chips").querySelectorAll("button").forEach((b) => (b.onclick = () => vSeekTo(+b.dataset.s, 0)));
}
function vIdx() { return vFlat.findIndex((p) => p.s === vPos.s && p.i === vPos.i); }
function vSeekTo(s, i) {
  const was = vPlaying; vStop(); vPos = { s, i }; vRender(s, i); vSceneLabel(); if (was) vRun();
}
const vLang = () => $("vid-lang").value;
const vSubLang = () => { const s = $("vid-sub").value; return s === "same" ? vLang() : s; };
function vShowCap(sent) {
  const sl = vSubLang(), cap = $("vid-cap");
  cap.classList.toggle("off", sl === "off");
  cap.textContent = sent ? (sent[sl === "off" ? vLang() : sl] || sent.en || "") : "";
}
function vClearHl() { $("vid-hl").hidden = true; vHlNow = null; }
function vBarH() { const t = $("random") && $("random").closest(".toolbar"); return t ? t.getBoundingClientRect().height : 0; } // sticky toolbar of the practice view
function vFitQ(open) { // size the question box: it stays on screen (sticky under the toolbar) next to / above the board
  const pn = $("panes"); if (!pn.classList.contains("vid-on")) return;
  const top = Math.round(vBarH()) + 4, phone = innerWidth <= 800, h3 = pn.querySelector(".pane h3"), hh = h3 ? h3.getBoundingClientRect().height + 6 : 0;
  pn.style.setProperty("--qtop", top + "px");
  if (open && !phone) { const y = pn.getBoundingClientRect().top + scrollY - top; if (scrollY < y) window.scrollTo(0, y); } // desktop: question and board start at the top together
  const qt = Math.max(pn.getBoundingClientRect().top, top); // where the question box starts on screen (the page may not scroll far enough)
  pn.style.setProperty("--qmax", Math.max(200, phone ? Math.round(innerHeight * 0.38) : Math.round(innerHeight - qt - hh - 12)) + "px");
  const p1 = pn.querySelector(".pane"); pn.style.setProperty("--vtop", (phone && p1 ? top + Math.round(p1.getBoundingClientRect().height) : top) + "px"); // the part header stays visible under the question box
}
addEventListener("resize", () => vFitQ()); addEventListener("scroll", () => vFitQ(), { passive: true });
let vHlNow = null; // image rows of the highlight on screen
function vFocus(y0, y1, smooth, must) { // must = [m0, m1]: rows that have to be visible if y0..y1 does not fit // scroll the question box (not the page) so image rows y0..y1 are in view
  const sc = $("qscroll"), img = $("q-img"); if (!sc || !$("panes").classList.contains("vid-on") || sc.scrollHeight <= sc.clientHeight + 2) return;
  const bar = [...document.querySelectorAll(".toolbar")].map((e) => e.getBoundingClientRect()).filter((r) => r.height && r.top <= 0.5 && r.bottom > 0).reduce((m, r) => Math.max(m, r.bottom), 0); // sticky bar covering the top
  const R = sc.getBoundingClientRect(), off = Math.max(0, bar - R.top); // part of the box hidden above
  const k = $("qwrap").clientHeight / vH(), a = vY(y0) * k, b = vY(y1) * k, top = sc.scrollTop + off, vh = Math.max(80, Math.min(R.bottom, innerHeight) - Math.max(R.top, bar));
  if (must && b - a > vh - 30) return vFocus(must[0], must[1], smooth);
  if (a >= top + 8 && b <= top + vh - 8) return;
  const to = (b - a > vh - 40 ? a - 20 : a - Math.max(20, (vh - (b - a)) * 0.3)) - off;
  sc.scrollTo({ top: Math.max(0, to), behavior: smooth ? "smooth" : "auto" });
}
function vInkY(it) { // top and bottom image rows a pen mark covers
  if (it.box) return [it.box[1], it.box[1] + it.box[3]]; if (it.p) { const ys = it.p.filter((_, i) => i % 2); return [Math.min(...ys), Math.max(...ys)]; }
  if (it.y1 !== undefined) return [it.y1, it.y2]; const s = it.size || 24; return it.t === "math" ? [it.y, it.y + s * 2] : [it.y - s, it.y + 4];
}
function vHl(box, smooth) {
  const el = $("vid-hl");
  if (!box || box === "none") { el.hidden = true; vHlNow = null; return; }
  const W = vScript.size[0], H = vH(), [x, y, w, h] = box; vHlNow = [y, y + h]; vFocus(y, y + h, smooth);
  el.style.left = (x / W * 100) + "%"; el.style.top = (vY(y) / H * 100) + "%"; el.style.width = (w / W * 100) + "%"; el.style.height = ((vY(y + h) - vY(y)) / H * 100) + "%"; el.hidden = false;
}
// Teacher's pen on the question image: an SVG in image pixels. Items: line, ul (underline), circle (box), brace, right (angle mark), text.
const SVGNS = "http://www.w3.org/2000/svg";
function vInkClear() { vInkT.forEach(vCancel); vInkT = []; $("vid-ink").innerHTML = ""; }
function vInkEl(it) {
  it = vMapIt(it);
  const mk = (n, a) => { const e = document.createElementNS(SVGNS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const col = it.c || "#e03131";
  if (it.t === "math") { // real maths (KaTeX) written in pen colour
    const W = 700, fo = mk("foreignObject", { x: it.anchor === "end" ? it.x - W : it.x, y: it.y, width: W, height: (it.size || 22) * 4, class: "ink-math" });
    const d = document.createElementNS("http://www.w3.org/1999/xhtml", "div"); d.style.fontSize = (it.size || 22) + "px"; d.style.color = col;
    if (it.anchor === "end") d.style.cssFloat = "right";
    vKatex(it.tex, d, false); fo.appendChild(d); return fo;
  }
  if (it.t === "text") {
    const t = mk("text", { x: it.x, y: it.y, fill: col, "font-size": it.size || 26, class: "ink-text" + (it.anchor ? "" : ""), "text-anchor": it.anchor || "start" });
    t.textContent = it.s; return t;
  }
  let d = "";
  if (it.t === "line") { d = `M${it.p[0]},${it.p[1]}`; for (let i = 2; i + 1 < it.p.length; i += 2) d += ` L${it.p[i]},${it.p[i + 1]}`; } // p: 2 or more points (a polyline draws a curve by hand)
  else if (it.t === "ul") { const y = it.y; d = `M${it.x1},${y} Q${(it.x1 + it.x2) / 2},${y + 4} ${it.x2},${y - 1}`; }
  else if (it.t === "circle") { const [x, y, w, h] = it.box, cx = x + w / 2, cy = y + h / 2, rx = w / 2 + 6, ry = h / 2 + 6;
    d = `M${cx + rx},${cy} A${rx},${ry} 0 1 1 ${cx + rx - 1},${cy - 6}`; }
  else if (it.t === "brace") { const { x, y1, y2 } = it, s = it.side === "right" ? 1 : -1, m = (y1 + y2) / 2, w = 14 * s;
    d = `M${x},${y1} q${w},0 ${w},12 L${x + w},${m - 10} q0,10 ${w},10 q${-w},0 ${-w},10 L${x + w},${y2 - 12} q0,12 ${-w},12`; }
  else if (it.t === "right") { const { x, y } = it, s = it.size || 16, dx = it.dx || 1, dy = it.dy || 1; d = `M${x + s * dx},${y} L${x + s * dx},${y + s * dy} L${x},${y + s * dy}`; }
  const p = mk("path", { d, fill: "none", stroke: col, "stroke-width": it.w || 3.5, "stroke-linecap": "round", "stroke-linejoin": "round" });
  if (it.dash) p.setAttribute("stroke-dasharray", "9 7");
  return p;
}
function vInkDraw(it, animate) {
  const svg = $("vid-ink"), el = vInkEl(it); svg.appendChild(el);
  if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (el.tagName === "path" && !it.dash) {
    const L = el.getTotalLength(); el.style.strokeDasharray = L; el.style.strokeDashoffset = L;
    el.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: Math.min(900, 250 + L * 1.2), fill: "forwards", easing: "ease-in-out" });
  } else if (el.tagName === "foreignObject") vWrite(el.firstChild);
  else el.animate([{ clipPath: "inset(-20% 100% -20% 0)", opacity: .3 }, { clipPath: "inset(-20% 0 -20% 0)", opacity: 1 }], { duration: 700, fill: "forwards", easing: "ease-out" });
}
// "Writing": the maths appears from left to right behind a moving pen.
function vWrite(el) {
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const w = el.getBoundingClientRect().width || 200, ms = Math.max(450, Math.min(1600, w * 5));
  el.animate([{ clipPath: "inset(-40% 100% -40% -4%)" }, { clipPath: "inset(-40% -4% -40% -4%)" }], { duration: ms, easing: "linear", fill: "forwards" });
  const pen = document.createElement("span"); pen.className = "pen"; pen.textContent = "\u270E"; el.appendChild(pen);
  pen.animate([{ left: "0%", opacity: 1 }, { left: "100%", opacity: 1, offset: .95 }, { left: "100%", opacity: 0 }], { duration: ms, easing: "linear", fill: "forwards" }).onfinish = () => pen.remove();
}
function vKatex(tex, el, display) {
  try { window.katex ? katex.render(tex, el, { throwOnError: false, displayMode: display, trust: false }) : (el.textContent = tex); } catch { el.textContent = tex; }
}
function vInkSize() { if (vScript) $("vid-ink").setAttribute("viewBox", `0 0 ${vScript.size[0]} ${vH()}`); }
// Scripts use rows of the full image; with hidden bands (buildCut) every row is moved up by the bands above it.
// While a video plays, a hidden band that holds the video's pen notes (working written in the answer space) is shortened
// so the notes stay visible: the band then starts 30 px below the lowest note in it.
function vVideoCuts() {
  const im = $("q-img"), base = im && (window.IB_QCUT || {})[im._rel]; if (!base || !vScript) return base;
  const c = base.map((r) => r.slice());
  for (const sc of vScript.scenes) for (const s of sc.sentences) for (const it of s.ink || []) {
    const [y0, y1] = vInkY(it); for (const r of c) if (y0 < r[1] && y1 > r[0]) r[0] = Math.max(r[0], Math.min(r[1], y1 + 30));
  }
  return c.filter(([a, b]) => b - a > 10);
}
function vCuts() { const im = $("q-img"); return im && im._cuts && vScript && im.naturalHeight === vScript.size[1] ? im._cuts : null; }
function vY(y) { const c = vCuts(); return c ? qMapY(c, y) : y; }
function vH() { const c = vCuts(); return c ? $("q-img")._h2 : vScript.size[1]; }
function vMapIt(it) {
  if (!vCuts()) return it; const m = { ...it };
  if (it.p) m.p = it.p.map((v, i) => (i % 2 ? vY(v) : v));
  if (it.y !== undefined) m.y = vY(it.y);
  if (it.y1 !== undefined) { m.y1 = vY(it.y1); m.y2 = vY(it.y2); }
  if (it.box) { const [x, y, w, h] = it.box; m.box = [x, vY(y), w, vY(y + h) - vY(y)]; }
  return m;
}
function vFit() { // a part with a lot of working: grow the board (up to a limit) so it still fits in two columns
  const bd = $("vid-board"); if (getComputedStyle(bd).columnCount === "auto") return;
  let h = bd.clientHeight;
  while (bd.scrollWidth > bd.clientWidth + 2 && h < 760) { h += 40; bd.style.height = h + "px"; }
}
function vReveal(el) { // keep the newest line in view inside the board only (never scrolls the page)
  vFit();
  const bd = $("vid-board"), b = bd.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.right > b.right - 4) bd.scrollLeft += r.right - b.right + 12;
  if (getComputedStyle(bd).overflowY !== "hidden" && r.bottom > b.bottom - 4) bd.scrollTop += r.bottom - b.bottom + 12;
}
// GDC screen on the board (Paper 2 only): a graph (curves, asymptotes, shading, marked points) and/or command lines with results.
function vFn(s) { try { return new Function("x", "with (Math) { return (" + s + "); }"); } catch { return () => NaN; } }
function vGdc(g) {
  const d = document.createElement("div"); d.className = "ln " + (g.sketch ? "sketch" : "gdc");
  d.innerHTML = g.sketch ? `<div class="sk-top">${esc(g.title || "Sketch")}</div>` : `<div class="gdc-top"><span>GDC</span><span>${esc(g.title || "")}</span></div>`;
  const scr = document.createElement("div"); scr.className = "gdc-scr"; d.appendChild(scr);
  if (g.plot) scr.appendChild(vPlot(g));
  for (const [inp, out] of g.lines || []) {
    const row = document.createElement("div"); row.className = "gdc-row";
    const a = document.createElement("span"); vKatex(inp, a, false); row.appendChild(a);
    if (out !== undefined) { const b = document.createElement("span"); b.className = "out"; vKatex(out, b, false); row.appendChild(b); }
    scr.appendChild(row);
  }
  return d;
}
function vPlot(g) {
  const W = 230, H = 140, [x0, x1] = g.x, [y0, y1] = g.y, mk = (n, a) => { const e = document.createElementNS(SVGNS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const X = (x) => ((x - x0) / (x1 - x0)) * W, Y = (y) => H - ((y - y0) / (y1 - y0)) * H;
  const svg = mk("svg", { viewBox: `0 0 ${W} ${H}`, class: "gdc-plot" });
  const clip = "gp" + Math.random().toString(36).slice(2, 8);
  const defs = mk("defs", {}); const cp = mk("clipPath", { id: clip }); cp.appendChild(mk("rect", { x: 0, y: 0, width: W, height: H })); defs.appendChild(cp); svg.appendChild(defs);
  const G = mk("g", { "clip-path": `url(#${clip})` }); svg.appendChild(G);
  if (g.shade) { // region between top and bottom from a to b
    const T = vFn(g.shade.top), B = vFn(g.shade.bot), pts = [], N = 60, { a, b } = g.shade;
    for (let i = 0; i <= N; i++) { const x = a + ((b - a) * i) / N; pts.push(`${X(x)},${Y(T(x))}`); }
    for (let i = N; i >= 0; i--) { const x = a + ((b - a) * i) / N; pts.push(`${X(x)},${Y(B(x))}`); }
    G.appendChild(mk("polygon", { points: pts.join(" "), fill: "rgba(224,49,49,.28)", stroke: "none" }));
  }
  if (y0 < 0 && y1 > 0) G.appendChild(mk("line", { x1: 0, x2: W, y1: Y(0), y2: Y(0), class: "ax" }));
  if (x0 < 0 && x1 > 0) G.appendChild(mk("line", { x1: X(0), x2: X(0), y1: 0, y2: H, class: "ax" }));
  for (const v of g.vl || []) G.appendChild(mk("line", { x1: X(v), x2: X(v), y1: 0, y2: H, class: "asy" }));
  for (const c of g.plot) {
    const F = vFn(c.f), N = 300; let d = "", prev = null;
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N, y = F(x), sy = Y(y);
      const ok = isFinite(y) && sy > -H * 3 && sy < H * 4 && !(prev !== null && Math.abs(sy - prev) > H * 1.2);
      d += ok ? `${prev === null ? "M" : "L"}${X(x).toFixed(1)},${sy.toFixed(1)} ` : ""; prev = ok ? sy : null;
    }
    G.appendChild(mk("path", { d, fill: "none", stroke: c.c || "#1d3a8a", "stroke-width": c.w || 1.8, "stroke-dasharray": c.dash ? "4 3" : "none" }));
  }
  for (const p of g.pts || []) {
    G.appendChild(mk("circle", { cx: X(p.x), cy: Y(p.y), r: 3.2, fill: "#e03131" }));
    if (p.t) { const tx = mk("text", { x: X(p.x) + (p.dx ?? 5), y: Y(p.y) + (p.dy ?? -5), class: "gl", "text-anchor": p.anchor || "start" }); tx.textContent = p.t; G.appendChild(tx); }
  }
  for (const l of g.labels || []) { const tx = mk("text", { x: X(l.x), y: Y(l.y), class: "gl gl2", "text-anchor": l.anchor || "start" }); tx.textContent = l.t; G.appendChild(tx); }
  return svg;
}
function vTex(tex) { const d = document.createElement("div"); d.className = "ln" + (tex.startsWith("\\quad") ? " cont" : ""); vKatex(tex, d, true); return d; } // "\\quad..." = continuation of the line above: keep it in the same column
// Board items: a maths line, the given facts of a part in one row, a "sol)" label, or a numbered step.
function vBoardAdd(t, board) {
  if (typeof t === "string") return board.appendChild(vTex(t));
  if (t.given) {
    let row = [...board.querySelectorAll(".given")].pop();
    if (!row || row.dataset.part !== t.given) {
      row = document.createElement("div"); row.className = "ln given"; row.dataset.part = t.given;
      row.innerHTML = `<b class="glabel">${esc(t.given)}</b>`; board.appendChild(row);
    } else if (!t.find) row.appendChild(Object.assign(document.createElement("span"), { className: "gsep", textContent: "," }));
    const piece = document.createElement("span"); piece.className = "gpiece" + (t.find ? " find" : ""); vKatex(t.add, piece, false);
    return row.appendChild(piece);
  }
  if (t.gdc) return board.appendChild(vGdc(t.gdc));
  if (t.grow !== undefined) { // a working that grows step by step (long / synthetic division): replaces the previous growing line
    const el = vTex(t.grow); el.dataset.grow = "1";
    const last = [...board.children].reverse().find((e) => e.dataset && e.dataset.grow);
    if (last && !t.fresh) { last.replaceWith(el); return el; }
    return board.appendChild(el);
  }
  const d = document.createElement("div");
  if (t.label) { d.className = "ln lbl"; d.textContent = t.label; }
  else if (t.step) { d.className = "ln step"; d.innerHTML = `<b>Step ${esc(t.step)}</b> `; const s = document.createElement("span"); vKatex(t.tex || "", s, false); d.appendChild(s); }
  return board.appendChild(d);
}
function vApply(sent, board, animate) { // acts of one sentence: board lines + highlight + pen
  if (sent.clear) { board.innerHTML = ""; board.style.height = ""; }
  if (sent.inkclear) vInkClear();
  if (sent.ink) {
    if (!animate) sent.ink.forEach((it) => vInkDraw(it, false));
    else sent.ink.forEach((it, k) => vInkT.push(vAfter(() => vInkDraw(it, true), 300 + k * 900)));
  }
  if (sent.hl !== undefined) vHl(sent.hl, animate);
  if ((!sent.hl || sent.hl === "none") && sent.ink && sent.ink.length) { const ys = sent.ink.map(vInkY), m0 = Math.min(...ys.map((r) => r[0])), m1 = Math.max(...ys.map((r) => r[1])); // the new pen marks, together with the highlight if both fit
    if (vHlNow && !$("vid-hl").hidden) vFocus(Math.min(m0, vHlNow[0]), Math.max(m1, vHlNow[1]), animate, [m0, m1]); else vFocus(m0, m1, animate); }
  (sent.tex || []).forEach((t, k) => {
    if (!animate) { vBoardAdd(t, board); return; }
    vAfter(() => { board.querySelector(".empty")?.remove(); const el = vBoardAdd(t, board); vReveal(el); vWrite(el); }, 250 + k * 1300);
  });
}
function vRender(s, i) { $("vid-note").hidden = true; // rebuild the state just before sentence i of scene s, then show its caption
  const board = $("vid-board"); board.innerHTML = ""; board.style.height = ""; vHl("none"); vInkClear(); vInkSize();
  const sc = vScript.scenes;
  for (let a = 0; a <= s; a++) for (let b = 0; b < (a < s ? sc[a].sentences.length : i); b++) { const t = sc[a].sentences[b]; vApply(t, board); }
  board.querySelectorAll(".ln").forEach((n) => (n.style.animation = "none"));
  if (!board.children.length) board.innerHTML = '<div class="empty">Notes will appear here.</div>';
  vFit(); board.scrollTop = getComputedStyle(board).overflowY === "hidden" ? 0 : board.scrollHeight; board.scrollLeft = board.scrollWidth;
  vShowCap(sc[s].sentences[i]);
}
function vSceneLabel() {
  const L = vLang(), sc = vScript.scenes[vPos.s];
  $("vid-scene").textContent = `${vPos.s + 1} / ${vScript.scenes.length} · ${sc.name[L] || sc.name.en}`;
  $("vid-part").innerHTML = sc.part ? `<b>${esc(sc.part[L] || sc.part.en)}</b>` + (sc.pq ? ` <span>${esc(sc.pq[L] || sc.pq.en)}</span>` : "") : "";
  $("vid-part").dataset.part = sc.part ? sc.part.en : "";
  $("vid-chips").querySelectorAll("button").forEach((b) => {
    const k = vScript.scenes[+b.dataset.s], c = k.chip === true ? k.name : k.chip; b.textContent = c[L] || c.en;
    b.classList.toggle("on", +b.dataset.s === vPos.s); b.setAttribute("aria-current", +b.dataset.s === vPos.s ? "true" : "false");
  });
  const k = vIdx(); if (k >= 0) $("vid-seek").value = k;
}
function vSetPlay(on) { vPlaying = on; $("vid-play").innerHTML = on ? "&#10074;&#10074;" : "&#9654;"; $("vid-play").setAttribute("aria-label", on ? "Pause" : "Play"); }
function vStop() { vCancelAll(); vInkT = []; vFrozen = []; vPaused = false; vSpeech = null; vTok++; vPlaying = false; if (window.speechSynthesis) speechSynthesis.cancel(); if ($("vid-play")) vSetPlay(false); }
function vSleep(ms, tok) { return new Promise((res) => vAfter(res, ms)).then(() => tok === vTok); }
// What the voice actually reads: the "say" text if the script has one, otherwise the subtitle with maths symbols spelled out.
// Trig names are read in full (a browser voice reads "sec" as "second"); f′ is read "f prime".
const V_SAY = {
  en: [[/([²³])d([a-z])\b/g, "$1 d $2"], [/([²³⁴])(?=[A-Za-zθπ(])/g, "$1 "], [/(\d)([a-z])(?![a-z])/g, "$1 $2"], [/⁻¹/g, " inverse"], [/ = /g, " equals "], [/ \+ /g, " plus "], [/ < /g, " is less than "], [/ > /g, " is greater than "], [/\bwhere a\b/g, "where ay"], [/\^\(([^)]*)\)/g, " to the power $1,"], [/\^(\w+)/g, " to the $1"], [/\bcosec\b|\bcsc\b/g, "cosecant"], [/\bsec\b/g, "secant"], [/\bcot\b/g, "cotangent"], [/\barctan\b/g, "arc tangent"], [/\barcsin\b/g, "arc sine"], [/\barccos\b/g, "arc cosine"], [/\b([Ss])in(?=\b|[²³⁻(θπ\d])/g, "$1ine "], [/\b([Cc])os(?=\b|[²³⁻(θπ\d])/g, "$1osine "], [/\b([Tt])an(?=\b|[²³⁻(θπ\d])/g, "$1angent "], [/\barc tan\b/g, "arc tangent"], [/\bsines\b/g, "sines"], [/\bln\b/g, "l n"],
       [/′′|″/g, " double prime"], [/′/g, " prime"], [/([A-Za-z])'(?=\()/g, "$1 prime"], [/√\(/g, "root of ("], [/√/g, "root "], [/²/g, " squared"], [/³/g, " cubed"], [/⁴/g, " to the 4"], [/ⁿ⁻¹/g, " to the n minus 1"], [/ⁿ/g, " to the n"], [/ᵀ/g, " to the T"],
       [/×/g, " times "], [/÷/g, " divided by "], [/−/g, " minus "], [/≤/g, " at most "], [/≥/g, " at least "], [/≠/g, " is not "], [/→/g, " goes to "], [/∞/g, "infinity"],
       [/∫/g, " the integral of "], [/θ/g, "theta"], [/π/g, "pi"], [/ω/g, "omega"], [/λ/g, "lambda"], [/μ/g, "mu"], [/σ/g, "sigma"], [/\|([^|]+)\|/g, "the modulus of $1"], [/(\w)\/(\w)/g, "$1 over $2"], [/\s*\/\s*/g, " over "], [/[₀]/g, " nought"]],
  ko: [[/\^\(([^)]*)\)/g, "의 $1 제곱"], [/\^(\w+)/g, "의 $1 제곱"], [/\bcosec\b|\bcsc\b/g, "코시컨트"], [/\bsec\b/g, "시컨트"], [/\bcot\b/g, "코탄젠트"], [/\barctan\b/g, "아크탄젠트"], [/\barcsin\b/g, "아크사인"], [/\btan\b/g, "탄젠트"], [/\bsin\b/g, "사인"], [/\bcos\b/g, "코사인"], [/\bln\b/g, "로그"],
       [/′′|″/g, " 이계도함수"], [/′/g, " 프라임"], [/([A-Za-z])'(?=\()/g, "$1 프라임"], [/√/g, "루트 "], [/²/g, " 제곱"], [/³/g, " 세제곱"], [/×/g, " 곱하기 "], [/÷/g, " 나누기 "], [/−/g, " 마이너스 "], [/≤/g, " 이하 "], [/≥/g, " 이상 "], [/≠/g, " 아님 "], [/→/g, " 에서 "],
       [/∫/g, " 적분 "], [/θ/g, "세타"], [/π/g, "파이"], [/ω/g, "오메가"], [/λ/g, "람다"], [/μ/g, "뮤"], [/σ/g, "시그마"], [/\|([^|]+)\|/g, "절댓값 $1"], [/(\w)\/(\w)/g, "$1 나누기 $2"], [/\s*\/\s*/g, " 나누기 "]],
};
const V_LETTER = { b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "gee", h: "aitch", j: "jay", k: "kay", l: "el", m: "em", n: "en", o: "oh", p: "pee", q: "cue", r: "ar", s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zed" };
const V_MATHWORD = "over|plus|minus|times|equals|squared|cubed|to the|root|and|by|than|is|of|at|with|into";
function vSayText(sent, lang) {
  let t = (sent.say && sent.say[lang]) || sent[lang] || sent.en;
  for (const [re, by] of V_SAY[lang] || V_SAY.en) t = t.replace(re, by);
  if (lang !== "ko") {
    t = t.replace(/(^|[^A-Za-z'’])([b-hj-z])(?![A-Za-z'’])/g, (m, pre, l) => pre + V_LETTER[l]);
    t = t.replace(/\b([Pp]arts?) a\b/g, "$1 ay").replace(/\b(and) a\b(?= (to|show|find|write|use))/g, "$1 ay");
    // "a" as a variable (next to a maths word or a number), not the article
    t = t.replace(new RegExp(`\\b(${V_MATHWORD}|\\d+) a\\b(?= (${V_MATHWORD}|over|[,.]|$))|\\ba\\b(?= (over|plus|minus|times|equals|squared|cubed|to the)\\b)|\\b(over|plus|minus|times|equals|root) a\\b(?! (?!(over|plus|minus|times|equals|squared|cubed|to|and|is)\\b)[a-z]{2,})`, "g"),
      (m) => m.replace(/\ba$/, "ay").replace(/^a\b/, "ay"));
  }
  return t.replace(/\s+/g, " ").trim();
}
function vSpeak(sent, tok) { // resolves true when the sentence is finished and still current
  const lang = vLang(), rate = parseFloat($("vid-rate").value) || 1;
  const text = vSayText(sent, lang);
  const est = Math.max(1500, text.length * (lang === "ko" ? 170 : 62)) / rate;
  let voice = $("vid-voice").checked && window.speechSynthesis ? vVoice(lang) : null;
  if (!voice && $("vid-voice").checked && window.speechSynthesis && !vVoices.length && !vVoicesWaited) { // list not ready yet (phones)
    vVoicesWaited = true;
    return (async () => { for (let k = 0; k < 10 && !vVoices.length; k++) { if (!(await vSleep(100, tok))) return false; vInitVoices(); } return vSpeak(sent, tok); })();
  }
  if (!voice && $("vid-voice").checked && window.speechSynthesis) voice = vDefaultVoice(lang);
  $("vid-note").hidden = !($("vid-voice").checked && !voice);
  $("vid-note").textContent = $("vid-voice").checked && !voice ? `No ${lang === "ko" ? "Korean" : "English"} voice was found on this device, so only subtitles are shown.` : "";
  if (!voice) return vSleep(est, tok);
  // Pause = stop the voice at the current word; resume = speak again from that word (speechSynthesis.pause() is unreliable across voices).
  return new Promise((res) => {
    let done = false, from = 0, gen = 0, fb = 0, started = false, sw = 0;
    const fin = (ok) => { if (!done) { done = true; vCancel(fb); vCancel(sw); if (vSpeech === ctl) vSpeech = null; res(ok); } };
    const noVoice = () => { // no voice works: subtitles only, timed like speech
      gen++; speechSynthesis.cancel();
      $("vid-note").hidden = false; $("vid-note").textContent = `No working ${lang === "ko" ? "Korean" : "English"} voice on this device, so only subtitles are shown.`;
      vCancel(fb); fb = vAfter(() => fin(tok === vTok), est);
    };
    const say = (start) => {
      if (!voice) return; // no voice left: the subtitles timer finishes the sentence
      const my = ++gen, u = new SpeechSynthesisUtterance(text.slice(start)); if (!voice.def) u.voice = voice; u.lang = voice.lang; u.rate = rate;
      u.onstart = () => { started = true; vCancel(sw); };
      u.onboundary = (e) => { if (my === gen && e.name !== "sentence") from = start + e.charIndex; };
      u.onend = () => { if (my === gen) fin(tok === vTok); };
      u.onerror = (e) => {
        if (my !== gen) return;
        if (e.error === "interrupted" || e.error === "canceled") { fin(false); return; } // stopped by pause or a jump
        if (voice.def) vDefaultBad[lang] = true; else vBadVoices.add(voice.name); // the voice failed: try the next one, else subtitles only
        voice = vVoice(lang) || vDefaultVoice(lang);
        if (voice) { vAfter(() => { if (!done && tok === vTok) say(from); }, 60); return; }
        noVoice();
      };
      speechSynthesis.speak(u);
    };
    const ctl = { pause() { gen++; vCancel(sw); speechSynthesis.cancel(); }, resume() { vAfter(() => { if (!done && tok === vTok) say(from); }, 60); } };
    vSpeech = ctl;
    fb = vAfter(() => fin(tok === vTok), est * 1.8 + 2000); // some voices never fire onend
    vAfter(() => { if (tok === vTok) say(0); else fin(false); }, 60);
    if (voice.def) sw = vAfter(() => { if (!started && !done && tok === vTok) { vDefaultBad[lang] = true; noVoice(); } }, 3000); // silent: never started
  });
}
async function vRun() {
  const tok = ++vTok; vSetPlay(true);
  if (window.speechSynthesis) speechSynthesis.cancel();
  vUnlockSpeech(); // still inside the tap/key press that started playing
  const sc = vScript.scenes;
  for (let s = vPos.s; s < sc.length; s++) {
    for (let i = s === vPos.s ? vPos.i : 0; i < sc[s].sentences.length; i++) {
      if (tok !== vTok) return;
      vPos = { s, i }; vSceneLabel();
      const sent = sc[s].sentences[i];
      if (i === 0 && s !== 0 && sent.clear === undefined) { /* keep the board across scenes unless asked to clear */ }
      vApply(sent, $("vid-board"), true); $("vid-board").querySelector(".empty")?.remove(); vShowCap(sent);

      if (!(await vSpeak(sent, tok))) return;
      if (sent.wait) {
        const cap = $("vid-cap");
        for (let t = sent.wait; t > 0; t--) { cap.textContent = (vSubLang() === "ko" ? "직접 풀어 보세요… " : "Try it yourself… ") + t; if (!(await vSleep(1000, tok))) return; }
        vShowCap(sent);
      }
    }
  }
  if (tok === vTok) { vSetPlay(false); vPos = { s: 0, i: 0 }; vRender(0, 0); vSceneLabel(); }
}
function vToggle() { if (vPaused) vResume(); else if (vPlaying) vPause(); else vRun(); }
function vJump(d) {
  const was = vPlaying; vStop();
  const n = vScript.scenes.length; vPos = { s: Math.min(n - 1, Math.max(0, vPos.s + d)), i: 0 };
  vRender(vPos.s, 0); vSceneLabel(); if (was) vRun();
}
function vStep(d) { // one sentence back / forward
  if (!vFlat.length) return;
  const k = Math.min(vFlat.length - 1, Math.max(0, vIdx() + d)), p = vFlat[k]; vSeekTo(p.s, p.i);
}
let vLastSub = "same";
function vCcUI() { const on = $("vid-sub").value !== "off"; $("vid-cc").setAttribute("aria-pressed", String(on)); $("vid-cc").classList.toggle("off", !on); }
function vCc() {
  const s = $("vid-sub");
  if (s.value === "off") s.value = vLastSub || "same"; else { vLastSub = s.value; s.value = "off"; }
  s.onchange();
}
function vKeys(e) { // while the video is open: Space, arrows and C control the video, not the question list
  if ($("vid-panel").hidden || $("practice").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target, tag = t && t.tagName;
  if ((tag === "INPUT" && t.type !== "range" && t.type !== "checkbox") || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
  const k = e.key;
  if (k === " " || k === "Spacebar") vToggle();
  else if (k === "ArrowRight") vStep(1);
  else if (k === "ArrowLeft") vStep(-1);
  else if (k === "c" || k === "C") vCc();
  else return;
  e.preventDefault(); e.stopPropagation();
}
function initVideoUI() {
  const p = vPref();
  if (p.lang) $("vid-lang").value = p.lang; else $("vid-lang").value = (navigator.language || "").startsWith("ko") ? "ko" : "en";
  if (p.sub) $("vid-sub").value = p.sub; vCcUI(); if (p.rate) $("vid-rate").value = p.rate; if (p.voice === false) $("vid-voice").checked = false;
  vInitVoices(); if (window.speechSynthesis) speechSynthesis.onvoiceschanged = vInitVoices;
  $("toggle-vid").onclick = toggleVideo; $("vid-play").onclick = () => { vToggle(); $("vid-play").blur(); };
  $("vid-prev").onclick = () => vJump(-1); $("vid-next").onclick = () => vJump(1);
  $("vid-cc").onclick = () => { vCc(); $("vid-cc").blur(); };
  window.addEventListener("keydown", vKeys, true);
  $("vid-seek").oninput = () => { const p = vFlat[+$("vid-seek").value]; if (p) vSeekTo(p.s, p.i); };
  for (const id of ["vid-lang", "vid-sub", "vid-rate", "vid-voice"]) $(id).onchange = () => {
    vSave(); vCcUI(); if (!vScript || $("vid-panel").hidden) return;
    const was = vPlaying; vStop(); vRender(vPos.s, vPos.i); vSceneLabel(); if (was) vRun();
  };
}

// ---------------- tag editor ----------------
const REVIEW_FILTERS = { edited: (q) => q.edited, all: () => true };
function rFiltered() {
  const f = $("r-filter").value, lv = $("r-level").value, sj = $("r-subject").value, pp = $("r-paper").value, yr = $("r-year").value;
  return questions.filter((q) => REVIEW_FILTERS[f](q) && (!lv || q.level === lv) && (!sj || q.subject === sj) &&
    (!pp || String(q.paper) === pp) && (!yr || String(q.year) === yr));
}
function renderReviewList(reset) {
  rShown = rFiltered();
  if (reset) rListLimit = PAGE;
  const n = rShown.length, i = rShown.findIndex((q) => current_r && q.id === current_r.id);
  $("r-count").textContent = `${n} question${n === 1 ? "" : "s"}` + (i >= 0 ? ` · ${n - i - 1} left after this one` : "");
  setPosition($("r-pos-bar"), $("r-list-label"), i, n, `List (${n})`);
  const rows = rShown.slice(0, rListLimit).map((q, k) =>
    `<li data-i="${k}" class="${current_r && current_r.id === q.id ? "sel" : ""}"><span class="r">` +
    `${q.edited ? "edited" : ""}</span>${label(q)}<br>` +
    `<small>${esc(q.subtopic_name || "(untagged)")} · ${TIER_NAMES[tier(q.difficulty)]}</small></li>`);
  if (n > rListLimit) rows.push(`<li class="more" data-more>Show ${Math.min(PAGE, n - rListLimit)} more (${n - rListLimit} left)</li>`);
  $("r-list").innerHTML = rows.join("") || '<li class="muted">Nothing to show with these filters.</li>';
  const sel = $("r-list").querySelector("li.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
}
function fillEditSubs(q, topic, sub, extra) {
  const probe = { ...q, _topic: topic };
  const opts = subOptions(probe);
  $("e-sub").innerHTML = opts.map((s) => `<option value="${s.id}">${s.id} ${esc(s.name)}${s.hl_only ? " (HL)" : ""}</option>`).join("");
  $("e-sub").value = opts.some((s) => s.id === sub) ? sub : (opts[0] || {}).id;
  const all = (topics[q.subject] || []).flatMap((t) => t.subtopics).filter((s) => q.level === "HL" || !s.hl_only);
  $("e-extra").innerHTML = all.map((s) => `<option value="${s.id}">${s.id} ${esc(s.name)}</option>`).join("");
  for (const o of $("e-extra").options) o.selected = (extra || []).includes(o.value);
}
function setDiffButtons(t) {
  $("e-diff").innerHTML = [1, 2, 3].map((n) => `<button type="button" data-t="${n}" class="${n === t ? "on" : ""}">${TIER_NAMES[n]}</button>`).join("");
}
const curTier = () => +(($("e-diff").querySelector("button.on") || {}).dataset || {}).t || null;
function openReview(q) {
  current_r = q;
  $("r-empty").hidden = true; $("r-detail").hidden = false;
  setImage($("r-q-img"), q.img); setImage($("r-ms-img"), q.ms_img);
  $("r-meta").innerHTML = `<b>${label(q)}</b> · ${q.marks} marks ` + (q.edited ? '<span class="badge edited">edited</span>' : "");
  $("r-note").textContent = q.review_note || "";
  $("r-now").innerHTML = `<b>${label(q)}</b> · ${esc(q.subtopic_name || "")}`;
  $("e-topic").innerHTML = topics[q.subject].map((t) => `<option value="${t.id}">${t.id}. ${esc(t.name)}</option>`).join("");
  $("e-topic").value = q.topic;
  fillEditSubs(q, q.topic, q.subtopic, q.extra);
  setDiffButtons(tier(q.difficulty));
  $("r-saved").textContent = "";
  renderReviewList();
  $("r-main").scrollTop = 0;
  showViewer($("review"));
}
function saveOverride(patch) {
  const q = current_r; if (!q) return;
  overrides[q.id] = { ...(overrides[q.id] || {}), ...patch, ts: Date.now(), tax: TAX };
  lsSet(OKEY, overrides);
  applyOverride(q);
  renderList();
}
function reviewStep(d) {
  if (!rShown.length) return;
  const i = rShown.findIndex((q) => current_r && q.id === current_r.id);
  openReview(rShown[i < 0 ? (d > 0 ? 0 : rShown.length - 1) : (i + d + rShown.length) % rShown.length]);
}
function setupReview() {
  const refresh = () => renderReviewList(true);
  for (const id of ["r-filter", "r-level", "r-subject", "r-paper", "r-year"]) $(id).addEventListener("change", refresh);
  $("r-list").addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) { rListLimit += PAGE; renderReviewList(); return; }
    const li = e.target.closest("li[data-i]"); if (li) openReview(rShown[+li.dataset.i]);
  });
  $("r-list-toggle").onclick = () => toggleList($("review"));
  $("r-list-close").onclick = () => openList($("review"), false);
  $("e-topic").addEventListener("change", () => fillEditSubs(current_r, $("e-topic").value, null, []));
  $("e-diff").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setDiffButtons(+b.dataset.t); });
  $("r-save").onclick = () => {
    const extra = [...$("e-extra").selectedOptions].map((o) => o.value).filter((v) => v !== $("e-sub").value);
    saveOverride({ topic: $("e-topic").value, subtopic: $("e-sub").value, extra, difficulty: tierToDiff(curTier() || tier(current_r.difficulty), current_r.difficulty), reviewed: true });
    openReview(current_r);
    $("r-saved").textContent = "Saved.";
  };
  $("r-reset").onclick = () => { delete overrides[current_r.id]; lsSet(OKEY, overrides); applyOverride(current_r); openReview(current_r); renderList(); $("r-saved").textContent = "Reset to the original tags."; };
  $("r-prev").onclick = () => reviewStep(-1); $("r-next").onclick = () => reviewStep(1);
  $("edit-tags").onclick = () => {
    if (!current) return;
    $("r-filter").value = "all"; $("r-subject").value = current.subject; $("r-level").value = current.level;
    $("r-paper").value = String(current.paper); $("r-year").value = String(current.year);
    $("settings").hidden = true; showView("review"); openReview(current);
  };
  document.addEventListener("keydown", (e) => {
    if ($("review").hidden || !current_r || typing(e) || !$("settings").hidden) return;
    if (e.key === "ArrowRight") reviewStep(1);
    else if (e.key === "ArrowLeft") reviewStep(-1);
    else if (/^[1-3]$/.test(e.key)) setDiffButtons(+e.key);
  });
}

// ---------------- settings sheet ----------------
function retireStale() { // -> ids of tag edits that were set aside
  const stale = Object.entries(overrides).filter(([, o]) => o.topic && !o.tax && (o.ts || 0) < STALE_BEFORE);
  if (!stale.length) return [];
  const aside = lsGet(SKEY);
  for (const [id, o] of stale) { aside[id] = o; delete overrides[id]; }
  lsSet(SKEY, aside); lsSet(OKEY, overrides);
  return stale.map(([id]) => id);
}
function showNotice(ids) {
  if (!ids.length) return;
  $("notice-text").textContent = `${ids.length} of your earlier tag edit${ids.length === 1 ? " was" : "s were"} made before the subtopic list was reorganised, ` +
    `so ${ids.length === 1 ? "it was" : "they were"} set aside (not deleted) and the questions show their current tags again: ` +
    ids.slice(0, 5).map((id) => id.replace(/-(AA|AI)-/, " $1 ")).join(", ") + (ids.length > 5 ? ` and ${ids.length - 5} more` : "") + ".";
  $("notice").hidden = false;
}
function openSettings() {
  $("review-stats").textContent = `${questions.filter((q) => q.edited).length} tag edits by you · ${Object.keys(flags).length} questions marked ⚑`;
  const inPractice = !!(!$("practice").hidden && current);
  $("edit-tags").hidden = $("set-q-label").hidden = !inPractice;
  if (inPractice) $("set-q-label").textContent = `Open question: ${label(current)} — ${current.topic_name} › ${current.subtopic_name}`;
  $("settings").hidden = false;
}
function setupSettings() {
  $("open-settings").onclick = openSettings;
  $("open-editor").onclick = () => { $("settings").hidden = true; showView("review"); };
  $("settings-close").onclick = () => { $("settings").hidden = true; };
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("settings").hidden = true; });
  const afterChange = () => { questions.forEach(applyOverride); renderList(); renderReviewList(); if (!$("browse").hidden) renderBrowse(); openSettings(); };
  $("export-overrides").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exported_at: new Date().toISOString(), overrides, flags, set_aside: lsGet(SKEY) }, null, 1)], { type: "application/json" }));
    a.download = "tag_overrides.json"; a.click();
  };
  $("import-overrides").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text()), ids = new Set(questions.map((q) => q.id));
      const ov = Object.entries(data.overrides || {}).filter(([id]) => ids.has(id));
      const fl = Object.entries(data.flags || {}).filter(([id]) => ids.has(id));
      overrides = { ...overrides, ...Object.fromEntries(ov) }; lsSet(OKEY, overrides);
      flags = { ...flags, ...Object.fromEntries(fl) }; lsSet(FKEY, flags);
      const aside = retireStale();
      afterChange();
      alert(`Imported ${ov.length} tag edits and ${fl.length} marks.`);
      showNotice(aside);
    } catch { alert("That file is not a valid export from this app."); }
    e.target.value = "";
  });
  $("clear-marks").onclick = () => { if (confirm("Remove all ⚑ review-later marks?")) { flags = {}; lsSet(FKEY, flags); updateMarkUI(); afterChange(); } };
  $("reset-overrides").onclick = () => {
    if (confirm("Discard all your tag edits? (Export first if you want to keep them.)")) { overrides = {}; lsSet(OKEY, overrides); afterChange(); }
  };
  $("notice-close").onclick = () => { $("notice").hidden = true; };
  if (window.IB_VERSION) { $("version").textContent = "Version: " + window.IB_VERSION; $("version").hidden = false; }
  $("conn-box").hidden = !REMOTE;
  $("disconnect").onclick = () => { try { localStorage.removeItem(TKEY); } catch {} location.reload(); };
  $("clear-cache").onclick = () => caches.delete(CACHE).then(() => alert("Cached images cleared."));
}

const VIEWS = ["browse", "practice", "review"];
function showView(v) {
  if (!VIEWS.includes(v)) v = "browse";
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
  for (const id of VIEWS) $(id).hidden = id !== v;
  $("nav-review").hidden = v !== "review";  // the Tag editor tab only shows while you are in it
  try { localStorage.setItem("ibmath.view", v); } catch {}
  if (v === "review") { renderReviewList(); if (!current_r && isNarrow()) openList($("review"), true); }
  if (v === "browse") renderBrowse();
  window.scrollTo(0, 0);
}

// ---------------- browse tab: topic index with counts ----------------
let bScope = "HL|AA";
function renderBrowse() {
  const [level, subject] = bScope.split("|");
  document.querySelectorAll("#b-scope button").forEach((b) => b.classList.toggle("on", b.dataset.scope === bScope));
  const pool = questions.filter((q) => q.level === level && q.subject === subject);
  const markedN = Object.keys(flags).length;
  $("b-summary").textContent = `${pool.length} questions — tap a subtopic to practise it.`;
  const mb = $("b-marked"); mb.hidden = !markedN; mb.innerHTML = `&#9873; Review marked (${markedN})`;
  $("b-cards").innerHTML = topics[subject].map((t) => {
    const tq = pool.filter((q) => q.topic === t.id);
    const rows = t.subtopics.filter((s) => level === "HL" || !s.hl_only).map((s) => {
      const sq = tq.filter((q) => q.subtopic === s.id);
      const dist = [1, 2, 3].map((d) => sq.filter((q) => tier(q.difficulty) === d).length);
      const bar = sq.length ? dist.map((n, i) => n ? `<i class="d${i + 1}" style="width:${100 * n / sq.length}%" title="${TIER_NAMES[i + 1]}: ${n}"></i>` : "").join("") : "";
      return `<div class="srow ${sq.length ? "" : "zero"}" data-topic="${t.id}" data-sub="${s.id}"><span>${s.id} ${esc(s.name)}${s.hl_only ? '<span class="hl">HL</span>' : ""}</span>` +
        `<span class="n">${sq.length}</span><span class="dbar">${bar}</span></div>`;
    }).join("");
    return `<div class="card"><h3 data-topic="${t.id}">${t.id}. ${esc(t.name)}<small>${tq.length} questions</small></h3>${rows}</div>`;
  }).join("");
}
function goPractice({ level, subject, topic, sub, marked }) {
  for (const id of FILTER_IDS) $(id).value = "";
  $("f-qnum").value = ""; $("f-marked").checked = !!marked;
  $("f-level").value = level || ""; $("f-subject").value = subject || "";
  refreshTopicFilters(); $("f-topic").value = topic || ""; refreshSubtopics();
  if (sub) $("f-subtopic").value = subName(subject, sub) || "";
  showView("practice"); applyFilters({ first: true });
}
function setupBrowse() {
  $("b-scope").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { bScope = b.dataset.scope; try { localStorage.setItem("ibmath.scope", bScope); } catch {} renderBrowse(); } });
  $("b-cards").addEventListener("click", (e) => {
    const [level, subject] = bScope.split("|");
    const row = e.target.closest(".srow"), head = e.target.closest("h3");
    if (row && !row.classList.contains("zero")) goPractice({ level, subject, topic: row.dataset.topic, sub: row.dataset.sub });
    else if (head) goPractice({ level, subject, topic: head.dataset.topic });
  });
  $("b-marked").onclick = () => goPractice({ marked: true });
}
function setupPractice() {
  const fbOpen = () => setFiltersOpen(!$("filterbar").classList.contains("open"));
  $("fb-toggle").onclick = fbOpen; $("fb-summary").onclick = fbOpen;
  const more = $("more-toggle");
  more.onclick = () => { const h = $("more-filters").hidden; $("more-filters").hidden = !h; more.setAttribute("aria-expanded", String(h)); more.innerHTML = h ? "More &#9652;" : "More &#9662;"; };
  $("clear-filters").onclick = clearAll;
  $("apply").onclick = () => applyFilters();
  for (const id of FILTER_IDS) $(id).addEventListener("change", () => { if (id === "f-subject") refreshTopicFilters(); else if (id === "f-topic") refreshSubtopics(); updateDraftUI(); });
  $("f-marked").addEventListener("change", updateDraftUI);
  $("f-qnum").addEventListener("input", updateDraftUI);
  $("f-qnum").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("apply").disabled) applyFilters(); });
  $("list").addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) { listLimit += PAGE; renderList(); return; }
    const li = e.target.closest("li[data-i]"); if (li) openQuestion(shown[+li.dataset.i]);
  });
  $("list-toggle").onclick = () => toggleList($("p-body"));
  $("p-list-close").onclick = () => openList($("p-body"), false);
  $("random").onclick = () => { if (shown.length) openQuestion(shown[Math.floor(Math.random() * shown.length)]); };
  $("prev").onclick = $("prev2").onclick = () => step(-1);
  $("next").onclick = $("next2").onclick = () => step(1);
  $("mark").onclick = $("mark2").onclick = toggleMark;
  $("toggle-ms").onclick = () => showMs($("ms-img").hidden);
  $("toggle-sol").onclick = toggleSolution;
  initVideoUI();
  document.addEventListener("keydown", (e) => {
    if ($("practice").hidden || typing(e) || !$("settings").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "m" || e.key === "M") toggleMark();
  });
}

async function loadData() {
  if (window.IB_DATA) return window.IB_DATA;  // data/data.js (works when index.html is opened by double-click)
  const [questions, topics, log] = await Promise.all(["questions", "topics", "review_log"].map((n) => fetch(`data/${n}.json`).then((r) => r.json())));
  return { questions, topics, reviewLog: log };
}

async function init() {
  try {
    const d = await loadData();
    questions = d.questions; topics = d.topics;
    const boot = document.getElementById("boot-msg"); if (boot) boot.remove();
  } catch (e) {
    const boot = document.getElementById("boot-msg"); if (boot) boot.remove();
    document.body.insertAdjacentHTML("afterbegin", '<p class="load-error">Could not load the question data. Run <code>python3 tools/merge_tags.py</code> to create <code>app/data/data.js</code>, or serve the folder with <code>python3 -m http.server</code> and open <code>/app/</code>.</p>');
    return;
  }
  await connectCard();
  await loadRemoteExtras();
  const aside = retireStale();
  questions.forEach(applyOverride);
  const years = [...new Set(questions.map((q) => q.year))].sort().map((y) => [String(y), String(y)]);
  fillSelect($("f-year"), years); fillSelect($("r-year"), years);
  refreshTopicFilters();
  document.querySelectorAll("nav button").forEach((b) => b.onclick = () => showView(b.dataset.view));
  setupPractice(); setupReview(); setupBrowse(); setupSettings();
  showNotice(aside);
  renderList(true);
  try { bScope = localStorage.getItem("ibmath.scope") || bScope; } catch {}
  let v = "browse"; try { v = localStorage.getItem("ibmath.view") || "browse"; } catch {}
  showView(v);
}
init();
