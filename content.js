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
  if (!settings.enabled || !rec.text) return box;

  if (!c || c.state === "pending") {
    box.append(chip("…", "xpe-pending", "Classifying"));
  } else if (c.state === "error") {
    box.append(chip("!", "xpe-error", c.error));
  } else {
    const a = c.result.answers;
    if (settings.chips.tone) box.append(chip(a.tone.choice, "xpe-tone-" + a.tone.choice, `Tone · ${XPE.pct(a.tone.confidence)} confidence`));
    if (settings.chips.type) box.append(chip(a.post_type.choice.replace("_", " "), "xpe-type", "Post type"));
    if (settings.chips.quality) box.append(chip(`arg ${a.argument_quality.score.toFixed(1)}/4`, "xpe-quality", "Argument quality (0–4)"));
    for (const r of decision.reasons) {
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
  const decision = settings.enabled && c?.state === "done" ? XPE.decide(settings, c.result.answers) : { action: "none", reasons: [] };
  const isRevealed = revealed.has(rec.id);
  let action = decision.action;
  if (isRevealed && (action === "hide" || action === "blur")) action = "label";

  // Skip DOM work when nothing changed (also keeps our own edits from retriggering the observer).
  const sig = [c?.state, action, isRevealed, settings.enabled, JSON.stringify(settings.chips), decision.reasons.map((r) => r.rule + r.level).join()].join("|");
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
