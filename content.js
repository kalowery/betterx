// Extracts posts from the rendered x.com DOM, classifies them via the background worker,
// and labels, dims, blurs, or hides them according to the user's settings.
// X renders posts client-side and recycles DOM nodes while scrolling, so we watch for
// mutations and key everything by post ID rather than by element.

const SEL = {
  post: 'article[data-testid="tweet"]',
  text: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"]',
  showMore: '[data-testid="tweet-text-show-more-link"]',
  socialContext: '[data-testid="socialContext"]',
};
const MAX_STORED = 2000;
const ERROR_RETRY_MS = 30000;

const seen = new Map(); // id -> extracted record
const cls = new Map(); // id -> { state: "pending" | "done" | "error", result?, error?, at? }
const revealed = new Set(); // ids the user chose to show despite a hide/blur rule
let settings = XPE.DEFAULTS;
let pendingSave = false;

// Account locations from X's "About this account" (handle, lowercased -> info).
// info: { state: "pending" | "done" | "none" | "error", name?, accurate?, at?, error? }
const COUNTRY_TTL_MS = 30 * 24 * 3600 * 1000;
const LOOKUP_GAP_MS = 1500;
const MAX_LOOKUP_QUEUE = 200;
const countries = new Map();
chrome.storage.local.get({ xpeCountry: {} }, ({ xpeCountry }) => {
  for (const [h, v] of Object.entries(xpeCountry)) if (Date.now() - v.at < COUNTRY_TTL_MS) countries.set(h, v);
  rerenderAll();
});

XPE.load((s) => {
  settings = s;
  rerenderAll();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.xpeSettings) XPE.load((s) => ((settings = s), rerenderAll()));
});

// ---------- extraction ----------

// Visible text of a tweetText node, keeping emoji (rendered as <img alt>) and link text.
function readText(el) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
    else if (node.nodeName === "IMG") out += node.getAttribute("alt") || "";
    else if (node.nodeName === "BR") out += "\n";
    else node.childNodes.forEach(walk);
  };
  walk(el);
  return out.trim();
}

// The permalink is the <a> wrapping the post's own <time>; the first one in the article
// belongs to the post itself (a quoted post's time comes later, inside its link box).
function permalink(article) {
  const time = article.querySelector("a[href*='/status/'] time");
  const a = time?.closest("a");
  const m = a?.getAttribute("href")?.match(/^\/([^/]+)\/status\/(\d+)/);
  return m ? { handle: m[1], id: m[2], time: time.getAttribute("datetime") } : null;
}

// Quoted posts render inside a nested element with role="link"; the post's own text doesn't.
function isInsideQuote(el, article) {
  const box = el.closest('[role="link"]');
  return !!box && article.contains(box) && box !== article;
}

const focalIdFromUrl = () => location.pathname.match(/\/status\/(\d+)/)?.[1] || null;

function classifyKind(article, id, focalId) {
  if (focalId) {
    if (id === focalId) return "focal";
    // On a thread page, posts rendered after the focal post are replies; before it, ancestors.
    const focal = [...document.querySelectorAll(SEL.post)].find((a) => permalink(a)?.id === focalId);
    if (focal) {
      return focal.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING ? "reply" : "parent";
    }
  }
  // In feeds, replies show a "Replying to @x" line above the text.
  const replyingTo = [...article.querySelectorAll("div")].some(
    (d) => d.childElementCount <= 3 && /^Replying to\b/.test(d.textContent.trim()) && !isInsideQuote(d, article),
  );
  return replyingTo ? "reply" : "post";
}

function extract(article, focalId) {
  const link = permalink(article);
  if (!link) return null; // ads/placeholders without a permalink

  const texts = [...article.querySelectorAll(SEL.text)];
  const ownText = texts.find((t) => !isInsideQuote(t, article));
  const quoteText = texts.find((t) => isInsideQuote(t, article));
  const nameBlock = article.querySelector(SEL.userName);

  return {
    id: link.id,
    url: `https://x.com/${link.handle}/status/${link.id}`,
    handle: link.handle,
    displayName: nameBlock?.querySelector("span")?.textContent?.trim() || null,
    time: link.time,
    kind: classifyKind(article, link.id, focalId),
    text: ownText ? readText(ownText) : "",
    truncated: !!article.querySelector(SEL.showMore),
    quotedText: quoteText ? readText(quoteText) : null,
    socialContext: article.querySelector(SEL.socialContext)?.textContent?.trim() || null, // e.g. "Alice reposted"
    page: location.pathname,
    seenAt: new Date().toISOString(),
  };
}

// ---------- classification ----------

function requestClassification(rec) {
  if (!settings.enabled || !rec.text) return;
  const cur = cls.get(rec.id);
  if (cur?.state === "pending") return;
  if (cur?.state === "done" && !(cur.result.truncated && !rec.truncated)) return;
  if (cur?.state === "error" && Date.now() - cur.at < ERROR_RETRY_MS) return;

  cls.set(rec.id, { state: "pending" });
  const post = { id: rec.id, text: rec.text, quotedText: rec.quotedText, handle: rec.handle, kind: rec.kind, truncated: rec.truncated };
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

// ---------- account location ("About this account") ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bearer token and query ID come from X's own scripts (via the background worker).
let xConfigPromise = null;
function xConfig() {
  if (xConfigPromise) return xConfigPromise;
  const scripts = [...document.scripts];
  const mainUrl = scripts.map((s) => s.src).find((s) => /\/client-web\/main\.[0-9a-f]+\.js/.test(s));
  const runtime = scripts.map((s) => s.textContent).find((t) => t.includes("loader.AboutAccount")) || "";
  let chunkUrl = null;
  const m = runtime.match(/(\d+):"(shared~bundle\.UserAbout~loader\.AboutAccount)"/);
  const hash = m && runtime.match(new RegExp(`[,{]${m[1]}:"([0-9a-f]{16})"`))?.[1];
  if (hash) chunkUrl = `https://abs.twimg.com/responsive-web/client-web/${m[2]}.${hash}a.js`;
  xConfigPromise = new Promise((resolve, reject) =>
    chrome.runtime.sendMessage({ type: "xconfig", mainUrl, chunkUrl }, (res) => {
      if (res?.ok) return resolve(res.result);
      xConfigPromise = null;
      reject(new Error(res?.error || chrome.runtime.lastError?.message || "Couldn't read X's configuration"));
    }),
  );
  return xConfigPromise;
}

class RateLimited extends Error {}

async function lookupCountry(handle) {
  const cfg = await xConfig();
  const ct0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
  if (!ct0) throw new Error("Not logged in to x.com");
  const vars = encodeURIComponent(JSON.stringify({ screenName: handle }));
  const res = await fetch(`/i/api/graphql/${cfg.queryId}/AboutAccountQuery?variables=${vars}`, {
    credentials: "include",
    headers: {
      authorization: `Bearer ${cfg.bearer}`,
      "x-csrf-token": ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": document.documentElement.lang || "en",
      "content-type": "application/json",
    },
  });
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    throw new RateLimited(`Rate limited by X until ${new Date(reset ? reset * 1000 : Date.now() + 15 * 60e3).toLocaleTimeString()}`, {
      cause: reset ? reset * 1000 : Date.now() + 15 * 60e3,
    });
  }
  if (!res.ok) throw new Error(`X returned HTTP ${res.status} for the account lookup`);
  const about = (await res.json())?.data?.user_result_by_screen_name?.result?.about_profile;
  if (!about?.account_based_in) return { state: "none", at: Date.now() };
  return { state: "done", name: about.account_based_in, accurate: about.location_accurate !== false, at: Date.now() };
}

const lookupQueue = [];
let lookupRunning = false;
let pausedUntil = 0;
let consecutiveErrors = 0;

function requestCountry(handle) {
  if (!settings.country.enabled) return;
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
  for (const a of document.querySelectorAll(SEL.post)) {
    const r = a.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) {
      const h = seen.get(permalink(a)?.id)?.handle.toLowerCase();
      if (h) visible.add(h);
    }
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
    while (lookupQueue.length && settings.country.enabled) {
      if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
      const h = nextLookup();
      let info;
      try {
        info = await lookupCountry(h);
        consecutiveErrors = 0;
      } catch (e) {
        if (e instanceof RateLimited) {
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

// The popup asks the active tab for the posts it's showing now, in page order.
function pagePosts() {
  const out = [];
  const ids = new Set();
  for (const article of document.querySelectorAll(SEL.post)) {
    const id = permalink(article)?.id;
    const rec = id && seen.get(id);
    if (!rec || ids.has(id)) continue;
    ids.add(id);
    const c = cls.get(id);
    const k = countries.get(rec.handle.toLowerCase());
    out.push({ ...rec, answers: c?.state === "done" ? c.result.answers : null, country: k?.state === "done" ? k.name : null });
  }
  return out;
}

// Test button on the settings page (forwarded here by the background worker).
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === "pagePosts") return send({ ok: true, posts: pagePosts(), url: location.href });
  if (msg.type !== "countryTest") return;
  lookupCountry(msg.handle.trim().replace(/^@/, "").toLowerCase()).then(
    (result) => send({ ok: true, result }),
    (e) => send({ ok: false, error: String(e.message || e) }),
  );
  return true;
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
  if (settings.chips.kind) box.append(chip(rec.kind, "xpe-kind"));
  const showCountry = settings.country.enabled && settings.country.chip;
  if (showCountry) {
    const k = countries.get(rec.handle.toLowerCase());
    if (k?.state === "done") {
      const title = k.accurate ? `Account based in ${k.name}` : `Account based in ${k.name}; X says this may be inaccurate (e.g. VPN)`;
      box.append(chip(`📍 ${k.name}${k.accurate ? "" : " ?"}`, "xpe-country", title));
    } else if (!k || k.state === "pending") {
      const waiting = lookupQueue.length;
      const paused = pausedUntil > Date.now() ? ` Paused until ${new Date(pausedUntil).toLocaleTimeString()}.` : "";
      box.append(chip("📍…", "xpe-pending", `Looking up where the account is based (${waiting} accounts waiting, about 1.5 s each).${paused}`));
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
  const t = document.createElement("span");
  t.textContent = `${action === "hide" ? "Hidden" : "Blurred"} post by @${rec.handle} — ${why}`;
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

function render(article, rec) {
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
    c?.state, action, isRevealed, settings.enabled, JSON.stringify(settings.chips), settings.country.enabled && settings.country.chip,
    `${k?.state}:${k?.name}`, decision.reasons.map((r) => r.rule + r.level).join(),
  ].join("|");
  const host = article.querySelector(SEL.userName);
  const needsMarker = action === "hide" || action === "blur";
  const intact =
    (!host || host.querySelector(".xpe-chips")) && needsMarker === !!article.querySelector(":scope > .xpe-marker");
  if (article.dataset.xpeSig === sig && intact) return;
  article.dataset.xpeSig = sig;

  if (["hide", "blur", "dim"].includes(action)) article.dataset.xpeAction = action;
  else delete article.dataset.xpeAction;

  article.querySelector(":scope > .xpe-marker")?.remove();
  if (needsMarker) article.prepend(marker(rec, decision.reasons, action));

  host?.querySelector(".xpe-chips")?.remove();
  host?.appendChild(chips(rec, c, decision, isRevealed));
}

function rerenderId(id) {
  for (const article of document.querySelectorAll(SEL.post)) {
    if (permalink(article)?.id === id && seen.has(id)) render(article, seen.get(id));
  }
}

function rerenderHandle(h) {
  for (const article of document.querySelectorAll(SEL.post)) {
    const id = permalink(article)?.id;
    if (id && seen.get(id)?.handle.toLowerCase() === h) render(article, seen.get(id));
  }
}

function rerenderAll() {
  document.querySelectorAll(SEL.post).forEach((a) => delete a.dataset.xpeSig);
  scan();
}

// ---------- main loop ----------

function scan() {
  const focalId = focalIdFromUrl();
  let added = 0;
  for (const article of document.querySelectorAll(SEL.post)) {
    const rec = extract(article, focalId);
    if (!rec) continue;
    const prev = seen.get(rec.id);
    // Re-record if previously truncated and now expanded, or kind became known.
    if (!prev || (prev.truncated && !rec.truncated) || prev.kind !== rec.kind) {
      seen.set(rec.id, rec);
      added++;
    }
    const cur = seen.get(rec.id);
    requestClassification(cur);
    requestCountry(cur.handle);
    render(article, cur);
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

// Debounced rescan on DOM changes; X is a single-page app, so this also covers navigation.
let timer = null;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scan, 250);
}).observe(document.body, { childList: true, subtree: true });

scan();
