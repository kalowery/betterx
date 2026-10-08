// Site-independent part of the content script. The rule engine (engine.js) finds the posts on
// the page from the site's rule set, each as
// { el: element to hide/blur/dim, host: element to put labels in, rec: extracted record }.
// This file classifies records via the background worker and applies the user's rules.
// Site capabilities that aren't page reading (X's account-location lookup) come from
// XPE_SITE_CAPS, defined by site-x.js.
// Sites render client-side and recycle DOM nodes while scrolling, so we watch for mutations
// and key everything by post ID rather than by element.

let SITE = null; // set at startup: { name, label, who(rec), units(), lookupCountry? }
const MAX_STORED = 2000;
const ERROR_RETRY_MS = 30000;

const seen = new Map(); // id -> extracted record
const cls = new Map(); // id -> { state: "pending" | "done" | "error", result?, error?, at? }
const revealed = new Set(); // ids the user chose to show despite a hide/blur rule
let units = []; // the latest scan's units, in page order
let settings = XPE.DEFAULTS;
let pendingSave = false;

const siteOn = () => !!SITE && settings.sites?.[SITE.name] !== false;
const countryOn = () => !!SITE?.lookupCountry && settings.country.enabled;

// ---------- classification ----------

function requestClassification(rec) {
  if (!settings.enabled || !rec.text) return;
  const cur = cls.get(rec.id);
  if (cur?.state === "pending") return;
  if (cur?.state === "done" && !(cur.result.truncated && !rec.truncated)) return;
  if (cur?.state === "error" && Date.now() - cur.at < ERROR_RETRY_MS) return;

  cls.set(rec.id, { state: "pending" });
  const post = {
    id: rec.id, site: rec.site, text: rec.text, quotedText: rec.quotedText, parentText: rec.parentText,
    handle: rec.handle, kind: rec.kind, truncated: rec.truncated,
  };
  chrome.runtime.sendMessage({ type: "classify", post }, (res) => {
    if (chrome.runtime.lastError || !res) {
      cls.set(rec.id, { state: "error", error: chrome.runtime.lastError?.message || "No response", at: Date.now() });
    } else if (res.ok) {
      cls.set(rec.id, { state: "done", result: res.result });
    } else {
      cls.set(rec.id, { state: "error", error: res.error, at: Date.now() });
    }
    rerenderId(rec.id);
  });
}

// ---------- account location (sites with SITE.lookupCountry, i.e. X) ----------
// info: { state: "pending" | "done" | "none" | "error", name?, accurate?, at?, error? }

const COUNTRY_TTL_MS = 30 * 24 * 3600 * 1000;
const LOOKUP_GAP_MS = 1500;
const MAX_LOOKUP_QUEUE = 200;
const countries = new Map(); // handle (lowercased) -> info

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lookupQueue = [];
let lookupRunning = false;
let pausedUntil = 0;
let consecutiveErrors = 0;

function requestCountry(handle) {
  if (!countryOn()) return;
  const h = handle.toLowerCase();
  const cur = countries.get(h);
  if (cur && (cur.state !== "error" || Date.now() - cur.at < 4 * ERROR_RETRY_MS)) return;
  countries.set(h, { state: "pending" });
  lookupQueue.push(h);
  if (lookupQueue.length > MAX_LOOKUP_QUEUE) countries.delete(lookupQueue.shift()); // re-requested if seen again
  pumpLookups();
}

// Accounts whose posts are on screen go first; otherwise the most recently seen.
function nextLookup() {
  const visible = new Set();
  for (const u of units) {
    if (!u.el.isConnected) continue;
    const r = u.el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) visible.add(u.rec.handle.toLowerCase());
  }
  for (let i = lookupQueue.length - 1; i >= 0; i--) {
    if (visible.has(lookupQueue[i])) return lookupQueue.splice(i, 1)[0];
  }
  return lookupQueue.pop();
}

// One lookup at a time, spaced out; waits out rate limits and backs off on errors.
async function pumpLookups() {
  if (lookupRunning) return;
  lookupRunning = true;
  try {
    while (lookupQueue.length && countryOn()) {
      if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
      const h = nextLookup();
      let info;
      try {
        info = await SITE.lookupCountry(h);
        consecutiveErrors = 0;
      } catch (e) {
        if (e instanceof XPE.RateLimited) {
          pausedUntil = e.cause;
          lookupQueue.push(h);
          continue;
        }
        info = { state: "error", error: String(e.message || e), at: Date.now() };
        if (++consecutiveErrors >= 5) pausedUntil = Date.now() + 10 * 60e3;
      }
      countries.set(h, info);
      saveCountry(h, info);
      rerenderHandle(h);
      await sleep(LOOKUP_GAP_MS);
    }
  } finally {
    lookupRunning = false;
  }
}

const countryDirty = new Map();
let countrySaveTimer = null;
function saveCountry(h, info) {
  if (info.state !== "done" && info.state !== "none") return;
  countryDirty.set(h, info);
  clearTimeout(countrySaveTimer);
  countrySaveTimer = setTimeout(() => {
    chrome.storage.local.get({ xpeCountry: {} }, ({ xpeCountry }) => {
      for (const [k, v] of countryDirty) xpeCountry[k] = v;
      countryDirty.clear();
      for (const [k, v] of Object.entries(xpeCountry)) if (Date.now() - v.at > COUNTRY_TTL_MS) delete xpeCountry[k];
      chrome.storage.local.set({ xpeCountry });
    });
  }, 2000);
}

// ---------- messages from the popup and settings page ----------

// The posts this tab is showing now, in page order.
function pagePosts() {
  const out = [];
  const ids = new Set();
  for (const u of units) {
    const rec = seen.get(u.rec.id);
    if (!rec || ids.has(rec.id) || !u.el.isConnected) continue;
    ids.add(rec.id);
    const c = cls.get(rec.id);
    const k = countries.get(rec.handle.toLowerCase());
    out.push({ ...rec, answers: c?.state === "done" ? c.result.answers : null, country: k?.state === "done" ? k.name : null });
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === "pagePosts") {
    return send({ ok: true, site: SITE?.name, posts: SITE ? pagePosts() : [], rules: XPE_ENGINE.status(), url: location.href });
  }
  if (msg.type === "countryTest" && SITE?.lookupCountry) {
    SITE.lookupCountry(msg.handle.trim().replace(/^@/, "").toLowerCase()).then(
      (result) => send({ ok: true, result }),
      (e) => send({ ok: false, error: String(e.message || e) }),
    );
    return true;
  }
});

// ---------- rendering ----------

const stop = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

function chip(text, className, title) {
  const s = document.createElement("span");
  s.className = "xpe-chip " + (className || "");
  s.textContent = text;
  if (title) s.title = title;
  return s;
}

function chips(rec, c, decision, isRevealed) {
  const box = document.createElement("span");
  box.className = "xpe-chips";
  if (settings.chips.kind) box.append(chip(rec.subkind || rec.kind, "xpe-kind"));
  const showCountry = countryOn() && settings.country.chip;
  if (showCountry) {
    const k = countries.get(rec.handle.toLowerCase());
    if (k?.state === "done") {
      const title = k.accurate ? `Account based in ${k.name}` : `Account based in ${k.name}; X says this may be inaccurate (e.g. VPN)`;
      box.append(chip(`📍 ${k.name}${k.accurate ? "" : " ?"}`, "xpe-country", title));
    } else if (!k || k.state === "pending") {
      const paused = pausedUntil > Date.now() ? ` Paused until ${new Date(pausedUntil).toLocaleTimeString()}.` : "";
      box.append(chip("📍…", "xpe-pending", `Looking up where the account is based (${lookupQueue.length} accounts waiting, about 1.5 s each).${paused}`));
    } else if (k.state === "error") {
      box.append(chip("📍!", "xpe-error", k.error));
    }
  }
  // Country matches are already visible in the 📍 label; show other rule labels below.
  const ruleLabels = decision.reasons.filter((r) => !(showCountry && r.rule === "country"));
  if (!settings.enabled || !rec.text) {
    for (const r of ruleLabels) box.append(chip(r.short, "xpe-flag xpe-likely", r.name));
    return box;
  }

  if (!c || c.state === "pending") {
    box.append(chip("…", "xpe-pending", "Classifying"));
  } else if (c.state === "error") {
    box.append(chip("!", "xpe-error", c.error));
  } else {
    const a = c.result.answers;
    if (settings.chips.tone) box.append(chip(a.tone.choice, "xpe-tone-" + a.tone.choice, `Tone · ${XPE.pct(a.tone.confidence)} confidence`));
    if (settings.chips.type) box.append(chip(a.post_type.choice.replace("_", " "), "xpe-type", "Post type"));
    if (settings.chips.quality) box.append(chip(`arg ${a.argument_quality.score.toFixed(1)}/4`, "xpe-quality", "Argument quality (0–4)"));
    for (const r of ruleLabels) {
      const title = (r.level === "likely" ? "Likely: " : "Possibly: ") + r.name.toLowerCase();
      box.append(chip(r.short + (r.prob != null ? " " + XPE.pct(r.prob) : ""), "xpe-flag xpe-" + r.level, title));
    }
    if (isRevealed) {
      const h = chip("hide again", "xpe-rehide", "Re-apply your hide/blur setting");
      h.addEventListener("click", (e) => {
        stop(e);
        revealed.delete(rec.id);
        rerenderId(rec.id);
      });
      box.append(h);
    }
  }
  return box;
}

function marker(rec, reasons, action) {
  const m = document.createElement("div");
  m.className = "xpe-marker";
  const why = reasons
    .filter((r) => XPE.SEVERITY[r.action] >= XPE.SEVERITY[action])
    .map((r) => r.name + (r.prob != null ? ` (${XPE.pct(r.prob)})` : ""))
    .join(", ");
  const what = rec.subkind || (rec.kind === "reply" ? "reply" : "post");
  const t = document.createElement("span");
  t.textContent = `${action === "hide" ? "Hidden" : "Blurred"} ${what} by ${SITE.who(rec)} — ${why}`;
  const b = document.createElement("button");
  b.textContent = "Show";
  b.addEventListener("click", (e) => {
    stop(e);
    revealed.add(rec.id);
    rerenderId(rec.id);
  });
  m.append(t, b);
  m.addEventListener("click", stop); // clicking the marker shouldn't open the post
  return m;
}

// Elements that actually draw a box: blur/opacity on a `display: contents` wrapper (which
// Facebook uses) has no effect, so walk down past such wrappers.
function boxTargets(el) {
  const out = [];
  const queue = [...el.children].filter((c) => !c.classList.contains("xpe-marker"));
  for (let guard = 0; queue.length && guard < 300; guard++) {
    const c = queue.shift();
    if (getComputedStyle(c).display === "contents") queue.push(...c.children);
    else out.push(c);
  }
  return out;
}

function clearDecorations(el, host) {
  delete el.dataset.xpeSig;
  delete el.dataset.xpeAction;
  el.querySelectorAll("[data-xpe-fx]").forEach((n) => delete n.dataset.xpeFx);
  el.querySelector(":scope > .xpe-marker")?.remove();
  host?.querySelector(":scope > .xpe-chips")?.remove();
}

function render({ el, host, rec: extracted }) {
  const rec = seen.get(extracted.id) || extracted;
  if (!siteOn()) return clearDecorations(el, host);
  const c = cls.get(rec.id);
  const k = countries.get(rec.handle.toLowerCase());
  const answers = settings.enabled && c?.state === "done" ? c.result.answers : null;
  const ctx = { country: k?.state === "done" ? k.name : null, accurate: k?.accurate, kind: rec.kind };
  const decision = XPE.decide(settings, answers, ctx);
  const isRevealed = revealed.has(rec.id);
  let action = decision.action;
  if (isRevealed && (action === "hide" || action === "blur")) action = "label";

  // Skip DOM work when nothing changed (also keeps our own edits from retriggering the observer).
  const sig = [
    rec.id, c?.state, action, isRevealed, settings.enabled, JSON.stringify(settings.chips), countryOn() && settings.country.chip,
    `${k?.state}:${k?.name}`, decision.reasons.map((r) => r.rule + r.level).join(),
  ].join("|");
  const needsMarker = action === "hide" || action === "blur";
  const needsFx = action === "blur" || action === "dim";
  const intact =
    (!host || host.querySelector(":scope > .xpe-chips")) &&
    needsMarker === !!el.querySelector(":scope > .xpe-marker") &&
    needsFx === !!el.querySelector("[data-xpe-fx]");
  if (el.dataset.xpeSig === sig && intact) return;
  el.dataset.xpeSig = sig;

  if (["hide", "blur", "dim"].includes(action)) el.dataset.xpeAction = action;
  else delete el.dataset.xpeAction;
  el.querySelectorAll("[data-xpe-fx]").forEach((n) => delete n.dataset.xpeFx);
  if (needsFx) for (const t of boxTargets(el)) t.dataset.xpeFx = action;

  el.querySelector(":scope > .xpe-marker")?.remove();
  if (needsMarker) el.prepend(marker(rec, decision.reasons, action));

  host?.querySelector(":scope > .xpe-chips")?.remove();
  host?.appendChild(chips(rec, c, decision, isRevealed));
}

function rerenderId(id) {
  for (const u of units) if (u.rec.id === id && u.el.isConnected) render(u);
}

function rerenderHandle(h) {
  for (const u of units) if (u.rec.handle.toLowerCase() === h && u.el.isConnected) render(u);
}

function rerenderAll() {
  for (const u of units) delete u.el.dataset.xpeSig;
  scan();
}

// ---------- main loop ----------

function scan() {
  if (!SITE) return;
  units = SITE.units();
  if (!siteOn()) {
    for (const u of units) clearDecorations(u.el, u.host);
    return;
  }
  let added = 0;
  for (const u of units) {
    const prev = seen.get(u.rec.id);
    // Re-record if previously truncated and now expanded, or kind became known.
    if (!prev || (prev.truncated && !u.rec.truncated) || prev.kind !== u.rec.kind) {
      seen.set(u.rec.id, u.rec);
      added++;
    }
    const cur = seen.get(u.rec.id);
    requestClassification(cur);
    requestCountry(cur.handle);
    render(u);
  }
  if (added) scheduleSave();
}

function scheduleSave() {
  if (pendingSave) return;
  pendingSave = true;
  setTimeout(() => {
    pendingSave = false;
    chrome.storage.local.get({ xpePosts: {} }, ({ xpePosts }) => {
      for (const [id, rec] of seen) xpePosts[id] = rec;
      const ids = Object.keys(xpePosts);
      if (ids.length > MAX_STORED) {
        ids
          .sort((a, b) => xpePosts[a].seenAt.localeCompare(xpePosts[b].seenAt))
          .slice(0, ids.length - MAX_STORED)
          .forEach((id) => delete xpePosts[id]);
      }
      chrome.storage.local.set({ xpePosts });
    });
  }, 1000);
}

// ---------- startup (last, so everything above is defined) ----------

(async () => {
  const site = await XPE_ENGINE.init();
  if (!site) return; // no rule set for this site
  SITE = {
    ...site,
    who: (rec) => XPE_ENGINE.who(rec),
    units: () => XPE_ENGINE.units(),
    ...(globalThis.XPE_SITE_CAPS?.[site.name] || {}),
  };

  XPE.load((s) => {
    settings = s;
    rerenderAll();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.xpeSettings) XPE.load((s) => ((settings = s), rerenderAll()));
  });
  if (SITE.lookupCountry) {
    chrome.storage.local.get({ xpeCountry: {} }, ({ xpeCountry }) => {
      for (const [h, v] of Object.entries(xpeCountry)) if (Date.now() - v.at < COUNTRY_TTL_MS) countries.set(h, v);
      rerenderAll();
    });
  }

  // Debounced rescan on DOM changes; both sites are single-page apps, so this also covers navigation.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 250);
  }).observe(document.body, { childList: true, subtree: true });

  scan();
})();
