// Site adapter for x.com: finds posts in the rendered page and turns them into records.
// core.js does everything else (classification, rules, labels, hiding, saving).

(() => {
  const SEL = {
    post: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    showMore: '[data-testid="tweet-text-show-more-link"]',
    socialContext: '[data-testid="socialContext"]',
  };

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

  function classifyKind(article, id, focalId, focalEl) {
    if (focalId) {
      if (id === focalId) return "focal";
      // On a thread page, posts rendered after the focal post are replies; before it, ancestors.
      if (focalEl) return focalEl.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING ? "reply" : "parent";
    }
    // In feeds, replies show a "Replying to @x" line above the text.
    const replyingTo = [...article.querySelectorAll("div")].some(
      (d) => d.childElementCount <= 3 && /^Replying to\b/.test(d.textContent.trim()) && !isInsideQuote(d, article),
    );
    return replyingTo ? "reply" : "post";
  }

  function extract(article, focalId, focalEl) {
    const link = permalink(article);
    if (!link) return null; // ads/placeholders without a permalink
    const texts = [...article.querySelectorAll(SEL.text)];
    const ownText = texts.find((t) => !isInsideQuote(t, article));
    const quoteText = texts.find((t) => isInsideQuote(t, article));
    const nameBlock = article.querySelector(SEL.userName);
    return {
      id: link.id,
      site: "x",
      url: `https://x.com/${link.handle}/status/${link.id}`,
      handle: link.handle,
      displayName: nameBlock?.querySelector("span")?.textContent?.trim() || null,
      time: link.time,
      kind: classifyKind(article, link.id, focalId, focalEl),
      text: ownText ? readText(ownText) : "",
      truncated: !!article.querySelector(SEL.showMore),
      quotedText: quoteText ? readText(quoteText) : null,
      socialContext: article.querySelector(SEL.socialContext)?.textContent?.trim() || null, // e.g. "Alice reposted"
      page: location.pathname,
      seenAt: new Date().toISOString(),
    };
  }

  // ---------- account location ("About this account") ----------

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
      const until = reset ? reset * 1000 : Date.now() + 15 * 60e3;
      throw new XPE.RateLimited(`Rate limited by X until ${new Date(until).toLocaleTimeString()}`, { cause: until });
    }
    if (!res.ok) throw new Error(`X returned HTTP ${res.status} for the account lookup`);
    const about = (await res.json())?.data?.user_result_by_screen_name?.result?.about_profile;
    if (!about?.account_based_in) return { state: "none", at: Date.now() };
    return { state: "done", name: about.account_based_in, accurate: about.location_accurate !== false, at: Date.now() };
  }

  globalThis.XPE_SITE = {
    name: "x",
    label: "X",
    who: (rec) => "@" + rec.handle,

    // Every post on the page: { el (gets the hide/blur/dim treatment), host (gets the labels), rec }.
    units() {
      const articles = [...document.querySelectorAll(SEL.post)];
      const focalId = location.pathname.match(/\/status\/(\d+)/)?.[1] || null;
      const focalEl = focalId ? articles.find((a) => permalink(a)?.id === focalId) : null;
      const out = [];
      for (const el of articles) {
        const rec = extract(el, focalId, focalEl);
        if (rec) out.push({ el, host: el.querySelector(SEL.userName), rec });
      }
      return out;
    },

    lookupCountry,
  };
})();
