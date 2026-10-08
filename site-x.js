// X-specific capabilities that aren't page reading (page reading is in rules/x.json).
// Currently: the "About this account" location lookup, which calls X's own web API with the
// user's session, so it has to be code rather than a rule.

(() => {
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

  globalThis.XPE_SITE_CAPS = { ...(globalThis.XPE_SITE_CAPS || {}), x: { lookupCountry } };
})();
