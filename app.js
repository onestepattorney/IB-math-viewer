"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "ibmath.results.v1";
let questions = [], topics = {}, current = null, shown = [];

const store = {
  load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } },
  save(r) { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch {} },
};
let results = store.load();

// ---- tag overrides (manual review edits), kept in localStorage and applied over questions.json ----
const OKEY = "ibmath.overrides.v1";
const ostore = {
  load() { try { return JSON.parse(localStorage.getItem(OKEY)) || {}; } catch { return {}; } },
  save(o) { try { localStorage.setItem(OKEY, JSON.stringify(o)); } catch {} },
};
let overrides = ostore.load(), reviewLog = {}, current_r = null, rShown = [];


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
function buildTags(q) {
  const w = [String(q.year), q.month, q.level, q.subject, `P${q.paper}`, `paper${q.paper}`, q.tz, `Q${q.q}`, q.topic_name, q.subtopic_name];
  for (const e of q.extra || []) w.push(subName(q.subject, e));
  q.tags = [...new Set(w.filter(Boolean).map((x) => x.toLowerCase()))].sort();
}
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
  buildTags(q);
}

const status = (q) => {
  const r = results[q.id];
  return !r ? "new" : r.score >= r.max ? "done" : "wrong";
};
const label = (q) => `${q.year} ${q.month.slice(0, 3)} ${q.level} ${q.subject} P${q.paper}${q.tz === "TZ0" ? "" : " " + q.tz} Q${q.q}`;

function fillSelect(sel, items, keep = "") {
  const prev = sel.value;
  sel.innerHTML = '<option value="">All</option>' + items.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  sel.value = items.some(([v]) => v === prev) ? prev : keep;
}

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

function filtered() {
  const f = {
    level: $("f-level").value, subject: $("f-subject").value, paper: $("f-paper").value,
    topic: $("f-topic").value, sub: $("f-subtopic").value,
    dmin: +$("f-dmin").value, dmax: +$("f-dmax").value, status: $("f-status").value,
    year: $("f-year").value, month: $("f-month").value, tz: $("f-tz").value, qnum: $("f-qnum").value,
    terms: $("f-search").value.toLowerCase().split(/\s+/).filter(Boolean),
  };
  return questions.filter((q) =>
    (!f.level || q.level === f.level) && (!f.subject || q.subject === f.subject) &&
    (!f.paper || String(q.paper) === f.paper) && (!f.year || String(q.year) === f.year) &&
    (!f.month || q.month === f.month) && (!f.tz || q.tz === f.tz) && (!f.qnum || String(q.q) === f.qnum) &&
    f.terms.every((t) => q.tags.includes(t) || q.code.toLowerCase().includes(t) || (t.length >= 4 && q.tags.some((x) => x.includes(t)))) &&
    (!f.topic || q.topic === f.topic) && (!f.sub || q.subtopic_name === f.sub) &&
    (q.difficulty == null || (q.difficulty >= f.dmin && q.difficulty <= f.dmax)) &&
    (!f.status || status(q) === f.status));
}

function renderList() {
  shown = filtered();
  $("count").textContent = `${shown.length} question${shown.length === 1 ? "" : "s"}`;
  $("list").innerHTML = shown.slice(0, 400).map((q, i) => {
    const r = results[q.id];
    return `<li data-i="${i}" class="${status(q)} ${current && current.id === q.id ? "sel" : ""}">
      <span class="s">${r ? r.score + "/" + r.max : q.marks + "m"}</span>${label(q)}<br><small>${q.title || "(untagged)"}${q.difficulty ? " · D" + q.difficulty : ""}</small></li>`;
  }).join("");
}

function openQuestion(q) {
  current = q;
  $("empty").hidden = true; $("question").hidden = false;
  setImage($("q-img"), q.img); setImage($("ms-img"), q.ms_img); $("ms-img").hidden = true;
  const nx = shown[shown.findIndex((x) => x.id === q.id) + 1]; if (nx) prefetch([nx.img]);
  $("toggle-ms").textContent = "Show markscheme";
  $("meta").innerHTML = `<b>${label(q)}</b> <small>${q.code}</small> · ${q.marks} marks${q.section ? " · Section " + q.section : ""}` +
    (q.topic_name ? ` · ${q.topic_name} › ${q.subtopic_name} · Difficulty ${q.difficulty}/5` : "") +
    (q.edited ? ' <span class="badge edited">edited</span>' : q.reviewed ? ' <span class="badge reviewed">reviewed</span>' : "");
  setupSolution(q);
  $("max").textContent = q.marks;
  $("score").max = q.marks; $("score").value = results[q.id] ? results[q.id].score : 0;
  $("saved").textContent = "";
  renderList();
  $("viewer").scrollTop = 0;
}

// ---- own solution PDF (data/solutions/*.pdf), opened at the page where the question starts ----
function solutionUrl(q) { return q.my_solution + (q.my_solution_pages ? "#page=" + q.my_solution_pages[0] : ""); }
function setupSolution(q) {
  const has = !!q.my_solution;
  $("toggle-sol").hidden = !has; $("my-sol").hidden = !has; $("no-sol").hidden = has;
  $("toggle-sol").textContent = "Show my solution";
  $("sol-panel").hidden = true; setImage($("sol-img"), null);
  if (!has) return;
  $("my-sol").href = REMOTE ? "#" : solutionUrl(q);
  $("my-sol").onclick = REMOTE ? (e) => { e.preventDefault(); openAsset(q.my_solution, q.my_solution_pages ? "#page=" + q.my_solution_pages[0] : ""); } : null;
  const p = q.my_solution_pages;
  $("sol-note").textContent = p ? `My solution for this question only (PDF page${p[0] === p[1] ? " " + p[0] : "s " + p[0] + "–" + p[1]} of ${p[2]}).` : "";
}
function toggleSolution() {
  if (!current || !current.my_solution) return;
  const panel = $("sol-panel"), show = panel.hidden;
  panel.hidden = !show;
  $("toggle-sol").textContent = show ? "Hide my solution" : "Show my solution";
  if (show) { setImage($("sol-img"), current.my_solution_img || null); panel.scrollIntoView({ behavior: "smooth", block: "start" }); }
}

function save() {
  if (!current) return;
  const score = Math.max(0, Math.min(current.marks, +$("score").value || 0));
  const prev = results[current.id];
  results[current.id] = { score, max: current.marks, attempts: (prev ? prev.attempts : 0) + 1, ts: Date.now() };
  store.save(results);
  $("saved").textContent = `Saved: ${score}/${current.marks}`;
  renderList();
}

function next() {
  const i = shown.findIndex((q) => current && q.id === current.id);
  if (shown.length) openQuestion(shown[(i + 1) % shown.length]);
}

function renderStats() {
  $("review-stats").textContent = `${questions.filter((q) => q.reviewed).length} of ${questions.length} questions reviewed · ${questions.filter((q) => q.edited).length} edited by you`;
  const agg = {};
  for (const q of questions) {
    const key = q.topic_name ? `${q.subject} · ${q.topic_name}` : "Untagged";
    const a = (agg[key] ||= { n: 0, tried: 0, got: 0, max: 0 });
    a.n++;
    const r = results[q.id];
    if (r) { a.tried++; a.got += r.score; a.max += r.max; }
  }
  $("stats-table").innerHTML = '<tr><th>Topic</th><th class="num">Attempted</th><th class="num">Score</th><th></th></tr>' +
    Object.entries(agg).sort().map(([k, a]) => {
      const pct = a.max ? Math.round((100 * a.got) / a.max) : 0;
      return `<tr><td>${k}</td><td class="num">${a.tried}/${a.n}</td><td class="num">${a.max ? pct + "%" : "–"}</td><td><span class="pbar" style="width:${pct}px"></span></td></tr>`;
    }).join("");
}


// ---------------- review tab ----------------
const REVIEW_FILTERS = {
  low: (q) => q.low_confidence && !q.reviewed,
  unreviewed: (q) => !q.reviewed,
  changed: (q) => !!reviewLog[q.id],
  edited: (q) => q.edited,
  all: () => true,
};
function rFiltered() {
  const f = $("r-filter").value, lv = $("r-level").value, sj = $("r-subject").value;
  const terms = $("r-search").value.toLowerCase().split(/\s+/).filter(Boolean);
  return questions.filter((q) => REVIEW_FILTERS[f](q) && (!lv || q.level === lv) && (!sj || q.subject === sj) &&
    terms.every((t) => q.tags.includes(t) || q.code.toLowerCase().includes(t) || (t.length >= 4 && q.tags.some((x) => x.includes(t)))));
}
function renderReviewList() {
  rShown = rFiltered();
  const done = questions.filter((q) => q.reviewed).length;
  $("r-count").textContent = `${rShown.length} shown · ${done} of ${questions.length} reviewed`;
  $("r-progress").max = questions.length; $("r-progress").value = done;
  $("r-list").innerHTML = rShown.slice(0, 400).map((q, i) =>
    `<li data-i="${i}" class="${q.edited ? "edited" : q.reviewed ? "reviewed" : ""} ${current_r && current_r.id === q.id ? "sel" : ""}">` +
    `<span class="b">${q.edited ? "edited" : q.reviewed ? "reviewed" : q.low_confidence ? "low conf." : ""}</span>${label(q)}<br><small>${q.subtopic_name || "(untagged)"} · D${q.difficulty}</small></li>`).join("");
}
function fillEditSubs(q, topic, sub, extra) {
  const probe = { ...q, _topic: topic };
  const opts = subOptions(probe);
  $("e-sub").innerHTML = opts.map((s) => `<option value="${s.id}">${s.id} ${s.name}${s.hl_only ? " (HL)" : ""}</option>`).join("");
  $("e-sub").value = opts.some((s) => s.id === sub) ? sub : (opts[0] || {}).id;
  const all = (topics[q.subject] || []).flatMap((t) => t.subtopics).filter((s) => q.level === "HL" || !s.hl_only);
  $("e-extra").innerHTML = all.map((s) => `<option value="${s.id}">${s.id} ${s.name}</option>`).join("");
  for (const o of $("e-extra").options) o.selected = (extra || []).includes(o.value);
}
function setDiffButtons(d) {
  $("e-diff").innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" data-d="${n}" class="${n === d ? "on" : ""}">${n}</button>`).join("");
}
const curDiff = () => +(($("e-diff").querySelector("button.on") || {}).dataset || {}).d || null;
function openReview(q) {
  current_r = q;
  $("r-empty").hidden = true; $("r-detail").hidden = false;
  setImage($("r-q-img"), q.img); setImage($("r-ms-img"), q.ms_img);
  $("r-meta").innerHTML = `<b>${label(q)}</b> <small>${q.code}</small> · ${q.marks} marks` +
    (q.edited ? ' <span class="badge edited">edited</span>' : q.reviewed ? ' <span class="badge reviewed">reviewed</span>' : "");
  const lg = reviewLog[q.id] || [];
  $("r-note").innerHTML = (q.low_confidence ? '<span class="low">Low confidence.</span> ' : "") + (q.review_note || "") +
    (q.ms_steps != null ? ` <small>(method marks counted: ${q.ms_steps})</small>` : "") +
    (lg.length ? "<br><small>Changed by review pass: " + lg.map((x) => `${x.field} ${x.before}→${x.after}${x.reason ? " (" + x.reason + ")" : ""}`).join("; ") + "</small>" : "");
  $("e-topic").innerHTML = topics[q.subject].map((t) => `<option value="${t.id}">${t.id}. ${t.name}</option>`).join("");
  $("e-topic").value = q.topic;
  fillEditSubs(q, q.topic, q.subtopic, q.extra);
  setDiffButtons(q.difficulty);
  $("r-saved").textContent = "";
  renderReviewList();
  $("r-main").scrollTop = 0;
}
function saveOverride(patch) {
  const q = current_r; if (!q) return;
  overrides[q.id] = { ...(overrides[q.id] || {}), ...patch, ts: Date.now() };
  ostore.save(overrides);
  applyOverride(q);
  renderList();
}
function reviewStep(d) {
  if (!rShown.length) return;
  const i = rShown.findIndex((q) => current_r && q.id === current_r.id);
  openReview(rShown[(i + d + rShown.length) % rShown.length]);
}
function setupReview() {
  for (const id of ["r-filter", "r-level", "r-subject"]) $(id).addEventListener("change", renderReviewList);
  $("r-search").addEventListener("input", renderReviewList);
  $("r-list").addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) openReview(rShown[+li.dataset.i]); });
  $("e-topic").addEventListener("change", () => fillEditSubs(current_r, $("e-topic").value, null, []));
  $("e-diff").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setDiffButtons(+b.dataset.d); });
  $("r-ok").onclick = () => {
    const i = rShown.findIndex((q) => q.id === current_r.id), nextQ = rShown[i + 1];  // pick the next item before the list changes
    saveOverride({ reviewed: true });
    if (nextQ) openReview(nextQ); else { openReview(current_r); }
    $("r-saved").textContent = "Marked as reviewed.";
  };
  $("r-save").onclick = () => {
    const extra = [...$("e-extra").selectedOptions].map((o) => o.value).filter((v) => v !== $("e-sub").value);
    saveOverride({ topic: $("e-topic").value, subtopic: $("e-sub").value, extra, difficulty: curDiff() || current_r.difficulty, reviewed: true });
    openReview(current_r);
    $("r-saved").textContent = "Saved.";
  };
  $("r-reset").onclick = () => { delete overrides[current_r.id]; ostore.save(overrides); applyOverride(current_r); openReview(current_r); renderList(); $("r-saved").textContent = "Reset to the original tags."; };
  $("r-prev").onclick = () => reviewStep(-1); $("r-next").onclick = () => reviewStep(1);
  $("edit-tags").onclick = () => {
    if (!current) return;
    $("r-filter").value = "all"; $("r-level").value = ""; $("r-subject").value = ""; $("r-search").value = current.code;
    showView("review"); openReview(current);
  };
  document.addEventListener("keydown", (e) => {
    if ($("review").hidden || !current_r || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") reviewStep(1);
    else if (e.key === "ArrowLeft") reviewStep(-1);
    else if (e.key === "Enter") $("r-ok").click();
    else if (/^[1-5]$/.test(e.key)) setDiffButtons(+e.key);
  });
  $("export-overrides").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exported_at: new Date().toISOString(), overrides }, null, 1)], { type: "application/json" }));
    a.download = "tag_overrides.json"; a.click();
  };
  $("import-overrides").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text()), incoming = data.overrides || {};
      const ids = new Set(questions.map((q) => q.id));
      const ok = Object.entries(incoming).filter(([id]) => ids.has(id));
      overrides = { ...overrides, ...Object.fromEntries(ok) }; ostore.save(overrides);
      questions.forEach(applyOverride); renderList(); renderStats();
      alert(`Imported ${ok.length} of ${Object.keys(incoming).length} entries.`);
    } catch { alert("That file is not a valid tag overrides export."); }
    e.target.value = "";
  });
  $("reset-overrides").onclick = () => {
    if (confirm("Discard all your tag edits and review marks? (Export first if you want to keep them.)")) {
      overrides = {}; ostore.save(overrides); questions.forEach(applyOverride); renderList(); renderReviewList(); renderStats();
    }
  };
}
const VIEWS = ["browse", "practice", "review", "stats"];
function showView(v) {
  if (!VIEWS.includes(v)) v = "browse";
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
  for (const id of VIEWS) $(id).hidden = id !== v;
  try { localStorage.setItem("ibmath.view", v); } catch {}
  if (v === "stats") renderStats();
  if (v === "review") renderReviewList();
  if (v === "browse") renderBrowse();
}

// ---------------- browse tab: topic index with counts ----------------
let bScope = "HL|AA";
function renderBrowse() {
  const [level, subject] = bScope.split("|");
  document.querySelectorAll("#b-scope button").forEach((b) => b.classList.toggle("on", b.dataset.scope === bScope));
  const pool = questions.filter((q) => q.level === level && q.subject === subject);
  const acc = (list) => { let g = 0, m = 0; for (const q of list) { const r = results[q.id]; if (r) { g += r.score; m += r.max; } } return m ? Math.round(100 * g / m) + "%" : "–"; };
  const lowN = pool.filter((q) => q.low_confidence).length;
  $("b-summary").textContent = `${pool.length} questions · ${pool.filter((q) => results[q.id]).length} attempted` + (lowN ? ` · ${lowN} with tags still uncertain` : "") +
    " — click a subtopic to practise it.";
  $("b-cards").innerHTML = topics[subject].map((t) => {
    const tq = pool.filter((q) => q.topic === t.id);
    const rows = t.subtopics.filter((s) => level === "HL" || !s.hl_only).map((s) => {
      const sq = tq.filter((q) => q.subtopic === s.id);
      const dist = [1, 2, 3, 4, 5].map((d) => sq.filter((q) => q.difficulty === d).length);
      const bar = sq.length ? dist.map((n, i) => n ? `<i class="d${i + 1}" style="width:${100 * n / sq.length}%" title="Difficulty ${i + 1}: ${n}"></i>` : "").join("") : "";
      return `<div class="srow ${sq.length ? "" : "zero"}" data-topic="${t.id}" data-sub="${s.id}"><span>${s.id} ${s.name}${s.hl_only ? '<span class="hl">HL</span>' : ""}</span>` +
        `<span class="n">${sq.length}</span><span class="dbar">${bar}</span><span class="acc">${acc(sq)}</span></div>`;
    }).join("");
    return `<div class="card"><h3 data-topic="${t.id}" style="cursor:pointer">${t.id}. ${t.name}<small>${tq.length} questions</small></h3>${rows}</div>`;
  }).join("");
}
function goPractice({ level, subject, topic, sub }) {
  $("f-level").value = level || ""; $("f-subject").value = subject || "";
  refreshTopicFilters(); $("f-topic").value = topic || ""; refreshSubtopics();
  if (sub) {
    const name = subName(subject, sub);
    $("f-subtopic").value = name || "";
  }
  $("f-search").value = ""; $("f-qnum").value = ""; $("f-year").value = ""; $("f-month").value = ""; $("f-paper").value = ""; $("f-tz").value = ""; $("f-status").value = "";
  showView("practice"); renderList();
  if (shown.length) openQuestion(shown[0]);
}
function setupBrowse() {
  $("b-scope").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { bScope = b.dataset.scope; try { localStorage.setItem("ibmath.scope", bScope); } catch {} renderBrowse(); } });
  $("b-cards").addEventListener("click", (e) => {
    const [level, subject] = bScope.split("|");
    const row = e.target.closest(".srow"), head = e.target.closest("h3");
    if (row && !row.classList.contains("zero")) goPractice({ level, subject, topic: row.dataset.topic, sub: row.dataset.sub });
    else if (head) goPractice({ level, subject, topic: head.dataset.topic });
  });
  const more = $("more-toggle");
  more.onclick = () => { const h = $("more-filters").hidden; $("more-filters").hidden = !h; more.setAttribute("aria-expanded", String(h)); more.innerHTML = h ? "More filters &#9652;" : "More filters &#9662;"; };
  $("clear-filters").onclick = () => {
    for (const id of ["f-level", "f-subject", "f-topic", "f-subtopic", "f-status", "f-year", "f-month", "f-paper", "f-tz"]) $(id).value = "";
    $("f-search").value = ""; $("f-qnum").value = ""; $("f-dmin").value = 1; $("f-dmax").value = 5;
    refreshTopicFilters(); renderList();
  };
  $("list-toggle").onclick = () => { const c = $("p-body").classList.toggle("collapsed"); $("list-toggle").textContent = c ? "»" : "«"; };
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
    for (const x of d.reviewLog || []) (reviewLog[x.id] ||= []).push(x);
  } catch (e) {
    const boot = document.getElementById("boot-msg"); if (boot) boot.remove();
    document.body.insertAdjacentHTML("afterbegin", '<p class="load-error">Could not load the question data. Run <code>python3 tools/merge_tags.py</code> to create <code>app/data/data.js</code>, or serve the folder with <code>python3 -m http.server</code> and open <code>/app/</code>.</p>');
    return;
  }
  await connectCard();
  questions.forEach(applyOverride);
  const dsel = (id, v) => { $(id).innerHTML = [1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join(""); $(id).value = v; };
  dsel("f-dmin", 1); dsel("f-dmax", 5);
  fillSelect($("f-year"), [...new Set(questions.map((q) => q.year))].sort().map((y) => [String(y), String(y)]));
  refreshTopicFilters();
  for (const id of ["f-level", "f-subject", "f-paper", "f-subtopic", "f-dmin", "f-dmax", "f-year", "f-month", "f-tz", "f-status"])
    $(id).addEventListener("change", () => { if (id === "f-subject") refreshTopicFilters(); renderList(); });
  $("f-topic").addEventListener("change", () => { refreshSubtopics(); renderList(); });
  for (const id of ["f-search", "f-qnum"]) $(id).addEventListener("input", renderList);
  $("list").addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) openQuestion(shown[+li.dataset.i]); });
  $("random").onclick = () => { if (shown.length) openQuestion(shown[Math.floor(Math.random() * shown.length)]); };
  $("toggle-ms").onclick = () => { const h = $("ms-img").hidden; $("ms-img").hidden = !h; $("toggle-ms").textContent = h ? "Hide markscheme" : "Show markscheme"; };
  $("save").onclick = save; $("next").onclick = next; $("toggle-sol").onclick = toggleSolution;
  document.querySelectorAll("nav button").forEach((b) => b.onclick = () => showView(b.dataset.view));
  setupReview(); setupBrowse();
  $("export").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(results, null, 1)], { type: "application/json" }));
    a.download = "ib-math-progress.json"; a.click();
  };
  $("import-progress").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => { const r = JSON.parse(t); if (r && typeof r === "object") { results = { ...results, ...r }; store.save(results); renderStats(); renderList(); } }).catch(() => alert("Not a valid progress file."));
  };
  $("conn-box").hidden = !REMOTE;
  $("disconnect").onclick = () => { try { localStorage.removeItem(TKEY); } catch {} location.reload(); };
  $("clear-cache").onclick = () => caches.delete(CACHE).then(() => alert("Cached images cleared."));
  $("reset").onclick = () => { if (confirm("Delete all saved progress?")) { results = {}; store.save(results); renderStats(); renderList(); } };
  renderList();
  try { bScope = localStorage.getItem("ibmath.scope") || bScope; } catch {}
  let v = "browse"; try { v = localStorage.getItem("ibmath.view") || "browse"; } catch {}
  showView(v);
}
init();
