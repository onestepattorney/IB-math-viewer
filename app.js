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
async function loadAsset(rel) { // -> Blob
  const cache = await caches.open(CACHE).catch(() => null);
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
function setImage(img, rel) {
  if (!rel) { img.removeAttribute("src"); return; }
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
  setupSolution(q);
  $("now").innerHTML = `<b>${label(q)}</b> · ${esc(q.subtopic_name || "")}${q.difficulty ? " · " + TIER_NAMES[tier(q.difficulty)] : ""}`;
  updateMarkUI();
  renderList();
  $("viewer").scrollTop = 0;
  showViewer($("p-body"));
}
// The markscheme sits next to the question (below it on a phone) and stays covered until asked for.
function updateCover() { $("ms-cover").hidden = !$("ms-img").hidden || !$("sol-panel").hidden; }
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
  $("toggle-sol").hidden = !has; $("no-sol").hidden = has;
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
