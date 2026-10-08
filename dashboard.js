// Feed-mood dashboard: aggregates the per-post records the background worker saves
// ("xpeStats:YYYY-MM-DD" buckets) and applies the user's current thresholds.

const $ = (s) => document.querySelector(s);
const state = { days: 7, scope: "all" };
let settings = XPE.DEFAULTS;
let records = []; // [{ id, at, k, h, tone, type, q, p: {...} }]
let countries = {}; // handle -> { name }

const TONES = [
  ["insulting", "Insulting"],
  ["critical", "Critical"],
  ["neutral", "Neutral"],
  ["friendly", "Friendly"],
];
const TYPES = [
  ["opinion", "Opinion"],
  ["factual_claim", "Factual claim"],
  ["news", "News"],
  ["joke", "Joke"],
  ["personal", "Personal"],
  ["other", "Other"],
];
const QUALITY = ["0 · No argument", "1 · Weak", "2 · Fair", "3 · Good", "4 · Strong"];
const FLAGS = ["racist", "group_contempt", "antisemitic", "sexually_explicit", "insulting", "rage_bait"];

const pct = (n, d) => (d ? (100 * n) / d : 0);
const fmtPct = (x) => (x > 0 && x < 1 ? "<1%" : Math.round(x) + "%");
const fmtInt = (n) => n.toLocaleString();

// ---------- data ----------

function compactFromAnswers(a, at) {
  const r2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : null);
  return {
    at,
    tone: a.tone?.choice,
    type: a.post_type?.choice,
    q: a.argument_quality ? Math.round(a.argument_quality.score * 10) / 10 : null,
    p: {
      racist: r2(a.racist?.noul),
      group_contempt: r2(a.group_contempt?.noul),
      antisemitic: r2(a.antisemitic?.noul),
      sexually_explicit: r2(a.sexually_explicit?.noul),
      rage_bait: r2(a.rage_bait?.noul),
      insulting: r2(a.tone?.probabilities?.insulting),
    },
  };
}

async function load() {
  const all = await chrome.storage.local.get(null);
  const byId = new Map();
  for (const [key, bucket] of Object.entries(all)) {
    if (!key.startsWith("xpeStats:")) continue;
    for (const [id, r] of Object.entries(bucket)) {
      const prev = byId.get(id);
      if (!prev || r.at > prev.at) byId.set(id, { id, ...r });
    }
  }
  // Posts classified before statistics existed: fill in from the classification cache.
  const posts = all.xpePosts || {};
  for (const [id, c] of Object.entries(all.xpeClass || {})) {
    if (byId.has(id) || !c.answers) continue;
    byId.set(id, { id, k: posts[id]?.kind, h: posts[id]?.handle?.toLowerCase(), ...compactFromAnswers(c.answers, c.at) });
  }
  records = [...byId.values()];
  countries = all.xpeCountry || {};
  render();
}

function filtered() {
  const since = state.days === 1 ? new Date().setHours(0, 0, 0, 0) : Date.now() - state.days * 864e5;
  return records.filter((r) => {
    if (r.at < since) return false;
    if (state.scope === "replies") return r.k === "reply";
    if (state.scope === "posts") return r.k !== "reply";
    return true;
  });
}

// ---------- rendering helpers ----------

const tip = $("#tip");
function showTip(e, valueText, labelText) {
  tip.replaceChildren();
  const s = document.createElement("strong");
  s.textContent = valueText;
  const l = document.createElement("span");
  l.textContent = labelText;
  tip.append(s, l);
  tip.style.display = "block";
  const r = (e.currentTarget || e.target).getBoundingClientRect();
  const x = e.clientX ?? r.left + 160;
  const y = e.clientY ?? r.top;
  tip.style.left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + "px";
}
const hideTip = () => (tip.style.display = "none");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// rows: [{ name, parts: [{ n, weak? }], denom, tipLabel }]
function barChart(title, desc, rows, { legend } = {}) {
  const card = el("section", "card");
  card.append(el("h2", null, title), el("p", "desc", desc));
  if (legend) {
    const lg = el("div", "legend");
    for (const [label, weak] of legend) {
      const item = el("span");
      const sw = el("i");
      sw.style.background = weak ? "var(--bar-weak)" : "var(--bar)";
      item.append(sw, label);
      lg.append(item);
    }
    card.append(lg);
  }
  const shares = rows.map((r) => r.parts.reduce((s, p) => s + pct(p.n, r.denom), 0));
  const max = Math.max(5, ...shares); // keep small values from filling the track
  if (!rows.some((r) => r.denom)) {
    card.append(el("div", "empty", "No posts in this range yet."));
    return card;
  }
  rows.forEach((r, i) => {
    if (!r.denom) {
      // e.g. a category added after these posts were classified
      const row = el("div", "row");
      const track = el("div", "track");
      track.append(el("span", "val muted", "not scored yet"));
      row.append(el("div", "name", r.name), track);
      card.append(row);
      return;
    }
    const row = el("div", "row");
    row.tabIndex = 0;
    const name = el("div", "name", r.name);
    name.title = r.name;
    const track = el("div", "track");
    const nonzero = r.parts.filter((p) => p.n > 0);
    r.parts.forEach((p) => {
      if (!p.n) return;
      const b = el("div", "bar" + (p.weak ? " weak" : "") + (p === nonzero.at(-1) ? " end" : ""));
      b.style.width = `${(pct(p.n, r.denom) / max) * 82}%`; // leave room for the value label
      track.append(b);
    });
    const val = el("span", "val", fmtPct(shares[i]));
    track.append(val);
    row.append(name, track);
    const text = r.parts.map((p) => `${fmtInt(p.n)} ${p.label || ""}`.trim()).join(" + ");
    const onTip = (e) => showTip(e, `${fmtPct(shares[i])} · ${text}`, `of ${fmtInt(r.denom)} ${r.tipLabel || "posts"} — ${r.name}`);
    row.addEventListener("pointermove", onTip);
    row.addEventListener("focus", onTip);
    row.addEventListener("pointerleave", hideTip);
    row.addEventListener("blur", hideTip);
    card.append(row);
  });
  return card;
}

function tile(label, value, note) {
  const t = el("div", "tile");
  t.append(el("div", "label", label), el("div", "value", value));
  if (note) t.append(el("div", "note", note));
  return t;
}

// ---------- main render ----------

function render() {
  const rs = filtered();
  const n = rs.length;
  const rules = settings.rules;
  const level = (rule, p) => (p == null ? null : p >= rules[rule].likely.threshold ? "likely" : p >= rules[rule].possible.threshold ? "possible" : "none");
  const scored = (rule) => rs.filter((r) => r.p?.[rule] != null);
  const likelyCount = (rule) => scored(rule).filter((r) => level(rule, r.p[rule]) === "likely").length;

  const rangeName = { 1: "today", 7: "in the last 7 days", 30: "in the last 30 days", 90: "in the last 90 days" }[state.days];
  const scopeName = { all: "posts and replies", posts: "posts", replies: "replies" }[state.scope];
  $("#summary").textContent = `${fmtInt(n)} ${scopeName} classified ${rangeName} (${fmtInt(records.length)} in total).`;

  // KPI row
  const hateRules = ["racist", "group_contempt", "antisemitic", "sexually_explicit"];
  const anyHate = rs.filter((r) => hateRules.some((k) => level(k, r.p?.[k]) === "likely")).length;
  const rb = scored("rage_bait");
  $("#kpis").replaceChildren(
    tile("Posts analyzed", fmtInt(n), scopeName),
    tile("Rage bait", rb.length ? fmtPct(pct(likelyCount("rage_bait"), rb.length)) : "–", rb.length < n ? `of ${fmtInt(rb.length)} posts scored for it` : "likely"),
    tile("Insulting tone", fmtPct(pct(rs.filter((r) => r.tone === "insulting").length, n)), "most likely tone"),
    tile("Flagged content", fmtPct(pct(anyHate, n)), "likely racist, group contempt, antisemitic, or explicit"),
  );

  const charts = [];
  charts.push(
    barChart(
      "Tone",
      "Share of posts by their most likely tone.",
      TONES.map(([k, name]) => ({ name, parts: [{ n: rs.filter((r) => r.tone === k).length }], denom: n })),
    ),
  );
  charts.push(
    barChart(
      "Content flags",
      "Share of posts likely or possibly in each category, at your Settings thresholds.",
      FLAGS.map((rule) => {
        const s = scored(rule);
        return {
          name: XPE.SHORT[rule] || XPE.RULES[rule],
          parts: [
            { n: s.filter((r) => level(rule, r.p[rule]) === "likely").length, label: "likely" },
            { n: s.filter((r) => level(rule, r.p[rule]) === "possible").length, label: "possible", weak: true },
          ],
          denom: s.length,
          tipLabel: s.length < n ? "posts scored for it" : "posts",
        };
      }),
      { legend: [["Likely", false], ["Possible", true]] },
    ),
  );
  charts.push(
    barChart(
      "Post type",
      "Share of posts by kind.",
      TYPES.map(([k, name]) => ({ name, parts: [{ n: rs.filter((r) => r.type === k).length }], denom: n })),
    ),
  );
  const withQ = rs.filter((r) => r.q != null);
  const avgQ = withQ.length ? withQ.reduce((s, r) => s + r.q, 0) / withQ.length : 0;
  charts.push(
    barChart(
      "Argument quality",
      `How well posts support what they say (0–4). Average ${avgQ.toFixed(1)}.`,
      QUALITY.map((name, i) => ({ name, parts: [{ n: withQ.filter((r) => Math.round(r.q) === i).length }], denom: withQ.length })),
    ),
  );

  // Countries, if location lookups are on and have data.
  const located = rs.map((r) => countries[r.h]?.name).filter(Boolean);
  if (located.length) {
    const counts = {};
    for (const c of located) counts[c] = (counts[c] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 8);
    const other = sorted.slice(8).reduce((s, [, v]) => s + v, 0);
    if (other) top.push(["Other countries", other]);
    charts.push(
      barChart(
        "Where authors are based",
        `Share of posts by the author's country, for the ${fmtInt(located.length)} of ${fmtInt(n)} posts with a known location.`,
        top.map(([name, c]) => ({ name, parts: [{ n: c }], denom: located.length, tipLabel: "posts with a known location" })),
      ),
    );
  }
  $("#charts").replaceChildren(...charts);
  renderTable(rs, level, scored);
}

function renderTable(rs, level, scored) {
  const n = rs.length;
  const t = el("table");
  const head = el("tr");
  ["Measure", "Count", "Of", "Share"].forEach((h) => head.append(el("th", null, h)));
  t.append(head);
  const add = (name, count, of) => {
    const tr = el("tr");
    tr.append(el("td", null, name), el("td", "num", fmtInt(count)), el("td", "num", fmtInt(of)), el("td", "num", fmtPct(pct(count, of))));
    t.append(tr);
  };
  for (const [k, name] of TONES) add(`Tone: ${name}`, rs.filter((r) => r.tone === k).length, n);
  for (const [k, name] of TYPES) add(`Type: ${name}`, rs.filter((r) => r.type === k).length, n);
  for (const rule of FLAGS) {
    const s = scored(rule);
    add(`${XPE.RULES[rule]}: likely`, s.filter((r) => level(rule, r.p[rule]) === "likely").length, s.length);
    add(`${XPE.RULES[rule]}: possible`, s.filter((r) => level(rule, r.p[rule]) === "possible").length, s.length);
  }
  const withQ = rs.filter((r) => r.q != null);
  QUALITY.forEach((name, i) => add(`Argument quality ${name}`, withQ.filter((r) => Math.round(r.q) === i).length, withQ.length));
  $("#table").replaceChildren(t);
}

// ---------- controls & live updates ----------

function bindSeg(id, key, parse) {
  for (const b of document.querySelectorAll(`#${id} button`)) {
    b.onclick = () => {
      document.querySelectorAll(`#${id} button`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      state[key] = parse(b);
      render();
    };
  }
}
bindSeg("range", "days", (b) => Number(b.dataset.days));
bindSeg("scope", "scope", (b) => b.dataset.scope);

let reloadTimer = null;
chrome.storage.onChanged.addListener((changes) => {
  if (changes.xpeSettings) XPE.load((s) => ((settings = s), render()));
  if (Object.keys(changes).some((k) => k.startsWith("xpeStats:") || k === "xpeCountry")) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 1000); // running totals update while you browse
  }
});

XPE.load((s) => {
  settings = s;
  load();
});
