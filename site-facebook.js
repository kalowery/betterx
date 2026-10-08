// Site adapter for facebook.com: finds posts and comments in the rendered page.
// Facebook's class names are generated and change often, so this relies on the few stable
// markers in its markup:
//   post text      [data-ad-rendering-role="story_message"]
//   post author    [data-ad-rendering-role="profile_name"]
//   post container the nearest ancestor with aria-labelledby
//   comment        [role="article"] containing a link with comment_id= (and reply_comment_id= for replies)
// core.js does everything else (classification, rules, labels, hiding, saving).

(() => {
  const MSG = '[data-ad-rendering-role="story_message"]';
  const NAME = '[data-ad-rendering-role="profile_name"]';

  // Visible text, keeping emoji (<img alt>) and line breaks, skipping buttons such as "See more".
  function readText(el) {
    let out = "";
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
      else if (node.nodeType !== Node.ELEMENT_NODE) return;
      else if (node.getAttribute("role") === "button") return;
      else if (node.nodeName === "IMG") out += node.getAttribute("alt") || "";
      else if (node.nodeName === "BR") out += "\n";
      else {
        const block = node.nodeName === "DIV" && out && !out.endsWith("\n");
        if (block) out += "\n";
        node.childNodes.forEach(walk);
      }
    };
    walk(el);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  const hasSeeMore = (el) => [...el.querySelectorAll('[role="button"]')].some((b) => /^see more$/i.test(b.textContent.trim()));

  // "facebook.com/jane.doe?..." -> "jane.doe"; "profile.php?id=123" -> "id:123"; pages and groups keep their path.
  function handleFrom(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.pathname === "/profile.php") return "id:" + (u.searchParams.get("id") || "");
      const parts = u.pathname.split("/").filter(Boolean);
      if (!parts.length) return null;
      if (["groups", "people", "pages"].includes(parts[0])) return parts.slice(0, 2).join("/");
      return parts[0];
    } catch {
      return null;
    }
  }

  // Small stable hash for posts without a permalink in the page.
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  }

  const isComment = (el) => el.matches?.('[role="article"]') && !!el.querySelector('a[href*="comment_id="]');
  const insideComment = (el, root) => {
    const c = el.closest('[role="article"]');
    return c && c !== root && root.contains(c) && isComment(c);
  };

  function postId(unit) {
    const PATTERNS = [
      /\/posts\/(pfbid\w+|\d+)/,
      /[?&]story_fbid=(pfbid\w+|\d+)/,
      /\/permalink\/(\d+)/,
      /\/videos\/pcb\.(\d+)/,
      /\/photos\/[^/]+\/pcb\.(\d+)/,
      /\/reel\/(\d+)/,
    ];
    for (const a of unit.querySelectorAll("a[href]")) {
      if (insideComment(a, unit)) continue;
      const href = a.getAttribute("href");
      for (const p of PATTERNS) {
        const m = href.match(p);
        if (m) return { id: m[1], url: href.split("?")[0] };
      }
    }
    return null;
  }

  function extractPost(unit) {
    const msgs = [...unit.querySelectorAll(MSG)].filter((m) => !insideComment(m, unit));
    const nameEl = [...unit.querySelectorAll(NAME)].find((n) => !insideComment(n, unit));
    if (!msgs.length || !nameEl) return null; // photo/video-only posts have no text to classify
    const authorLink = nameEl.querySelector("a[href]");
    const handle = (authorLink && handleFrom(authorLink.getAttribute("href"))) || "unknown";
    const text = readText(msgs[0]);
    const pid = postId(unit);
    return {
      id: "fb:" + (pid?.id || "h" + hash(handle + "|" + text.slice(0, 200))),
      site: "facebook",
      url: pid ? new URL(pid.url, location.origin).href : null,
      handle,
      // The name link only: the rest of the line can hold "is with…", places, and our own labels.
      displayName: authorLink?.textContent.trim() || nameEl.textContent.trim() || null,
      kind: unit.closest('[role="dialog"]') ? "focal" : "post",
      text,
      truncated: hasSeeMore(msgs[0]) || hasSeeMore(msgs[0].parentElement || msgs[0]),
      quotedText: msgs[1] ? readText(msgs[1]) : null, // a shared post's own text
      page: location.pathname,
      seenAt: new Date().toISOString(),
    };
  }

  function extractComment(article) {
    const links = [...article.querySelectorAll('a[href*="comment_id="]')].map((a) => a.getAttribute("href"));
    let cid = null;
    for (const h of links) {
      const u = new URL(h, location.origin);
      cid = u.searchParams.get("reply_comment_id") || u.searchParams.get("comment_id");
      if (cid) break;
    }
    if (!cid) return null;
    const isReply = links.some((h) => h.includes("reply_comment_id="));
    // Author: the first visible link with text (the avatar link before it is aria-hidden and empty).
    const authorLink = [...article.querySelectorAll('a[role="link"]')].find(
      (a) => a.getAttribute("aria-hidden") !== "true" && a.textContent.trim(),
    );
    // Body: the div[dir=auto] blocks inside the span[lang] wrapper; fall back to any not inside a link.
    let blocks = [...article.querySelectorAll('span[lang] div[dir="auto"]')];
    if (!blocks.length) blocks = [...article.querySelectorAll('div[dir="auto"]')].filter((d) => !d.closest("a"));
    const text = blocks.map((b) => readText(b)).filter(Boolean).join("\n");
    if (!text) return null; // sticker/image-only comment
    // Context for Jev: the post this comment belongs to.
    const unit = article.closest("div[aria-labelledby]");
    const postMsg = unit && [...unit.querySelectorAll(MSG)].find((m) => !insideComment(m, unit));
    return {
      unit: {
        host: authorLink?.parentElement || null,
      },
      rec: {
        id: "fbc:" + cid,
        site: "facebook",
        url: links[0] ? new URL(links[0], location.origin).href : null,
        handle: (authorLink && handleFrom(authorLink.getAttribute("href"))) || "unknown",
        displayName: authorLink?.textContent.trim() || null,
        kind: "reply",
        subkind: isReply ? "reply" : "comment",
        text,
        truncated: blocks.some((b) => hasSeeMore(b)) || hasSeeMore(article),
        parentText: postMsg ? readText(postMsg).slice(0, 2000) : null, // context only
        page: location.pathname,
        seenAt: new Date().toISOString(),
      },
    };
  }

  globalThis.XPE_SITE = {
    name: "facebook",
    label: "Facebook",
    who: (rec) => rec.displayName || rec.handle,

    // Every post and comment on the page: { el (hide/blur/dim target), host (labels), rec }.
    units() {
      const out = [];
      const seenEls = new Set();
      // Posts: find each post's text, then its container.
      for (const msg of document.querySelectorAll(MSG)) {
        const unit = msg.closest("div[aria-labelledby]");
        const inComment = msg.closest('[role="article"]');
        if (!unit || seenEls.has(unit) || (inComment && isComment(inComment))) continue;
        seenEls.add(unit);
        const rec = extractPost(unit);
        if (!rec) continue;
        const nameEl = [...unit.querySelectorAll(NAME)].find((n) => !insideComment(n, unit));
        // Labels go right after the author's name link.
        const host = nameEl?.querySelector("a[href]")?.parentElement || nameEl || null;
        out.push({ el: unit, host, rec });
      }
      // Comments and replies.
      for (const article of document.querySelectorAll('[role="article"]')) {
        if (!isComment(article)) continue;
        const c = extractComment(article);
        if (c) out.push({ el: article, host: c.unit.host, rec: c.rec });
      }
      return out;
    },
  };
})();
