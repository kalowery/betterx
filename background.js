// Calls TypeSafe's Jev classifier for posts found by the content script.
// Runs here (not in the page) so the API key stays out of x.com and CORS doesn't apply.
importScripts("settings.js", "rules.js");

const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const QUESTIONS_VERSION = 4;
const STATS_DAYS = 90; // bump when QUESTIONS change so cached answers are refreshed
const MAX_CACHE = 5000;
const MAX_CONCURRENT = 6;

// Wording changes here don't bump QUESTIONS_VERSION; cached answers stay valid.
const CONTEXT =
  "The state is a post or comment from a social network (X or Facebook). Judge only `post_text`, which the author wrote. " +
  "`quoted_post_text` (someone else's post being quoted) and `replying_to_post_text` (the post a comment replies to), " +
  "if present, are context only.";

const QUESTIONS = {
  tone: {
    type: "choice",
    instructions: `${CONTEXT} What is the tone of the author's text?`,
    criteria: {
      insulting: "Insulting, contemptuous, name-calling, mocking, or dehumanizing",
      critical: "Disagrees, criticizes, or argues forcefully, but without insults",
      neutral: "Matter-of-fact or informational, without strong feeling either way",
      friendly: "Warm, supportive, appreciative, or good-humored",
    },
  },
  post_type: {
    type: "choice",
    instructions: `${CONTEXT} What kind of post is this?`,
    criteria: {
      opinion: "Argues a view, judgment, or interpretation",
      factual_claim: "Asserts something as fact that could be checked",
      news: "Reports or shares a news event or announcement",
      joke: "Humor, sarcasm, satire, or a meme",
      personal: "About the author's own life, feelings, or plans",
      other: "None of the above (e.g. promotion, question, one-word reaction)",
    },
  },
  argument_quality: {
    type: "score",
    instructions: `${CONTEXT} How well does the author support what they say?`,
    criteria: [
      "No argument: assertion, insult, or reaction only",
      "Weak: a claim with little or misleading support",
      "Fair: some reasoning or evidence, with gaps",
      "Good: clear reasoning or relevant evidence",
      "Strong: careful, well-supported, acknowledges complexity",
    ],
  },
  // Narrow on purpose: an earlier, broader definition flagged ordinary immigration-policy posts.
  racist: {
    type: "noul",
    instructions:
      `${CONTEXT} Is the author's text racist, in the narrow sense defined by the criteria? ` +
      "Positions on immigration, borders, deportation, or crime are not racism unless the text also contains the racist content described.",
    criteria: {
      true: {
        means: "The text attacks people because of their race or ethnicity",
        includes: [
          "claims that a race or ethnic group is superior, inferior, less intelligent, or less human",
          "racial or ethnic slurs",
          "attributing crime, violence, or bad character to an entire race or ethnicity as an inherent trait",
          "calls to harm, expel, or exclude people because of their race or ethnicity",
        ],
      },
      false: {
        means: "No racist content",
        includes: [
          "opposing immigration, illegal immigration, or open borders",
          "supporting deportation or stricter enforcement",
          "reporting, condemning, or wanting punishment for crimes by specific people, including immigrants",
          "criticizing a country, religion, ideology, party, or government",
          "insults or anger not based on race or ethnicity",
          "discussing or criticizing racism or antisemitism",
        ],
      },
    },
  },
  group_contempt: {
    type: "noul",
    instructions: `${CONTEXT} Does the author's text dehumanize or express contempt for immigrants or people from particular countries as a group?`,
    criteria: {
      true: {
        means: "Contempt for immigrants or nationalities as groups",
        includes: [
          "dehumanizing labels such as invaders, vermin, animals, or subhuman applied to immigrants or a nationality as a group",
          "calling their countries of origin shitholes or similar",
          "blaming all immigrants or a nationality for crime or social problems",
        ],
      },
      false: {
        means: "No group contempt",
        includes: [
          "policy disagreement about immigration, borders, or enforcement",
          "supporting deportation of people in the country illegally",
          "neutral or legal terms such as illegal immigrant or illegal alien",
          "criticizing or condemning specific individuals for specific crimes",
        ],
      },
    },
  },
  antisemitic: {
    type: "noul",
    instructions: `${CONTEXT} Is the author's text antisemitic?`,
    criteria: {
      true: "Demeans, stereotypes, or expresses hostility toward Jews, or uses antisemitic tropes or conspiracy theories",
      false: "No antisemitic content (criticizing a government's policies is not by itself antisemitic)",
    },
  },
  rage_bait: {
    type: "noul",
    instructions:
      `${CONTEXT} Is this post rage bait: written mainly to provoke anger or outrage in readers, ` +
      "for example to drive replies and shares? Judge the intended effect on readers, not the author's own tone; " +
      "a calm post can be rage bait and an angry post may not be.",
    criteria: {
      true: {
        means: "Designed to make readers angry",
        includes: [
          "inflammatory framing or exaggeration of an outrage",
          "an incident presented selectively or without context to stoke us-versus-them anger",
          "deliberately provocative claims or questions meant to bait angry replies",
          "explicit invitations to be outraged",
          "taunting or mocking a group to provoke a reaction",
        ],
      },
      false: {
        means: "Not mainly designed to provoke anger",
        includes: [
          "a sincere opinion or argument, even if strongly worded",
          "straightforward news reporting",
          "personal updates, questions, or humor without a target",
          "the author venting their own anger without trying to inflame others",
        ],
      },
    },
  },
  sexually_explicit: {
    type: "noul",
    instructions: `${CONTEXT} Is the author's text sexually explicit?`,
    criteria: {
      true: "Graphic sexual content or explicit descriptions of sexual acts",
      false: "Not sexually explicit (mentioning sex, relationships, or reproduction in non-graphic terms is fine)",
    },
  },
};

function stateFor(p) {
  const s = { post_text: p.text, author: "@" + p.handle };
  if (p.quotedText) s.quoted_post_text = p.quotedText;
  if (p.parentText) s.replying_to_post_text = p.parentText;
  if (p.kind === "reply") s.is_reply = true;
  if (p.truncated) s.note = "post_text was cut off by the site; judge what is shown";
  return s;
}

// --- cache (id -> entry), persisted to chrome.storage.local ---
let cache = null;
let saveTimer = null;
async function loadCache() {
  if (!cache) cache = (await chrome.storage.local.get({ xpeClass: {} })).xpeClass;
  return cache;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ids = Object.keys(cache);
    if (ids.length > MAX_CACHE) {
      ids.sort((a, b) => cache[a].at - cache[b].at).slice(0, ids.length - MAX_CACHE).forEach((id) => delete cache[id]);
    }
    chrome.storage.local.set({ xpeClass: cache });
  }, 1000);
}

// --- simple concurrency limiter ---
let active = 0;
const waiting = [];
const slot = () => new Promise((r) => (active < MAX_CONCURRENT ? (active++, r()) : waiting.push(r)));
const release = () => (waiting.length ? waiting.shift()() : active--);

async function callJev(post) {
  const { xpeApiKey } = await chrome.storage.local.get("xpeApiKey");
  if (!xpeApiKey) throw new Error("No TypeSafe API key set. Open the extension's settings to add one.");
  await slot();
  try {
    const t0 = performance.now();
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${xpeApiKey}` },
      body: JSON.stringify({ model: MODEL, state: stateFor(post), questions: QUESTIONS }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${body.slice(0, 200)}`);
    const { answers, model, usage } = JSON.parse(body);
    return { v: QUESTIONS_VERSION, answers, model, usage, ms: Math.round(performance.now() - t0), truncated: !!post.truncated, at: Date.now() };
  } finally {
    release();
  }
}

const inflight = new Map();
async function classify(post) {
  const c = await loadCache();
  const hit = c[post.id];
  // Reuse a cached answer unless it was made from truncated text and we now have the full text.
  if (hit && hit.v === QUESTIONS_VERSION && !(hit.truncated && !post.truncated)) return hit;
  if (inflight.has(post.id)) return inflight.get(post.id);
  const p = callJev(post).then((entry) => {
    c[post.id] = entry;
    scheduleSave();
    recordStats(post, entry);
    return entry;
  });
  inflight.set(post.id, p);
  p.catch(() => {}).finally(() => inflight.delete(post.id));
  return p;
}

// --- feed-mood statistics ---
// One compact record per classified post, in a bucket per day ("xpeStats:YYYY-MM-DD"), so
// writes only touch today's bucket. The dashboard applies the user's thresholds when viewing.
const r2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : null);
let statsBucket = null; // { key, ready: Promise<data> }, shared so concurrent writers use one object
let statsTimer = null;

async function recordStats(post, entry) {
  const a = entry.answers;
  const key = "xpeStats:" + new Date().toISOString().slice(0, 10);
  if (statsBucket?.key !== key) statsBucket = { key, ready: chrome.storage.local.get({ [key]: {} }).then((r) => r[key]) };
  const data = await statsBucket.ready;
  data[post.id] = {
    at: entry.at,
    s: post.site || "x",
    k: post.kind,
    h: post.handle?.toLowerCase(),
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
  clearTimeout(statsTimer);
  statsTimer = setTimeout(async () => {
    await chrome.storage.local.set({ [key]: data });
    // Drop buckets older than STATS_DAYS.
    const cutoff = "xpeStats:" + new Date(Date.now() - STATS_DAYS * 864e5).toISOString().slice(0, 10);
    const old = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("xpeStats:") && k < cutoff);
    if (old.length) await chrome.storage.local.remove(old);
  }, 1500);
}

// --- page rules: bundled defaults, installed rule sets, last known good, health ---
// Sources, newest version wins: the rule set bundled with the extension, one installed by the
// user (later: downloaded from a rules server), and the last known good copy. A version that
// keeps reporting broken/degraded is marked suspect and skipped while another is available.
// A version that reports healthy repeatedly becomes the last known good.
const PROMOTE_AFTER = 3; // healthy reports
const SUSPECT_AFTER = 3; // consecutive broken/degraded reports
const bundledRules = {};

async function bundled(site) {
  if (!bundledRules[site]) bundledRules[site] = await (await fetch(chrome.runtime.getURL(`rules/${site}.json`))).json();
  return bundledRules[site];
}

async function rulesStore(site) {
  const keys = { [`xpeRulesInstalled:${site}`]: null, [`xpeRulesLKG:${site}`]: null, [`xpeRulesHealth:${site}`]: { versions: {} } };
  const st = await chrome.storage.local.get(keys);
  return {
    installed: st[`xpeRulesInstalled:${site}`],
    lkg: st[`xpeRulesLKG:${site}`],
    health: st[`xpeRulesHealth:${site}`],
  };
}

async function getRules(site) {
  if (!XPE_RULES.SITES[site]) throw new Error(`unknown site ${site}`);
  const { installed, lkg, health } = await rulesStore(site);
  const b = await bundled(site);
  const byVersion = new Map();
  for (const rs of [installed, b, lkg]) {
    if (rs && !XPE_RULES.validate(rs).length && !byVersion.has(rs.version)) byVersion.set(rs.version, rs);
  }
  const candidates = [...byVersion.values()].sort((x, y) => XPE_RULES.compareVersions(y.version, x.version));
  const active = candidates.find((rs) => !health.versions[rs.version]?.suspect) || candidates[0];
  const fallback = lkg && lkg.version !== active.version && !XPE_RULES.validate(lkg).length ? lkg : null;
  const source = active === installed ? "installed" : active === b ? "bundled" : "last known good";
  return { active, fallback, source };
}

async function rulesHealth(msg) {
  const key = `xpeRulesHealth:${msg.site}`;
  const { [key]: h } = await chrome.storage.local.get({ [key]: { versions: {} } });
  const v = (h.versions[msg.version] ||= { healthy: 0, degraded: 0, broken: 0, badStreak: 0, suspect: false });
  v[msg.status] = (v[msg.status] || 0) + 1;
  v.badStreak = msg.status === "healthy" ? 0 : v.badStreak + 1;
  Object.assign(v, { lastStatus: msg.status, lastReasons: msg.reasons, lastUnits: msg.units, lastRates: msg.rates, lastAt: Date.now() });
  h.last = { version: msg.version, status: msg.status, reasons: msg.reasons, usingFallback: msg.usingFallback, at: Date.now() };

  const { installed, lkg } = await rulesStore(msg.site);
  const b = await bundled(msg.site);
  const rs = [installed, b, lkg].find((x) => x?.version === msg.version);
  if (msg.status === "healthy" && v.healthy >= PROMOTE_AFTER && rs && lkg?.version !== rs.version) {
    await chrome.storage.local.set({ [`xpeRulesLKG:${msg.site}`]: rs });
  }
  // Only mark a version suspect if there is something else to use.
  if (v.badStreak >= SUSPECT_AFTER && lkg && lkg.version !== msg.version) v.suspect = true;
  if (msg.status === "healthy") v.suspect = false;
  await chrome.storage.local.set({ [key]: h });
}

async function rulesStatus() {
  const out = {};
  for (const site of Object.keys(XPE_RULES.SITES)) {
    const { installed, lkg, health } = await rulesStore(site);
    const { active, fallback, source } = await getRules(site);
    out[site] = {
      bundled: (await bundled(site)).version,
      installed: installed?.version || null,
      lastKnownGood: lkg?.version || null,
      active: active.version,
      activeSource: source,
      fallback: fallback?.version || null,
      versions: health.versions,
      last: health.last || null,
    };
  }
  return out;
}

async function rulesInstall(rs) {
  const problems = XPE_RULES.validate(rs);
  if (problems.length) throw new Error("Invalid rules: " + problems.join("; "));
  const key = `xpeRulesHealth:${rs.site}`;
  const { [key]: h } = await chrome.storage.local.get({ [key]: { versions: {} } });
  delete h.versions[rs.version]; // a reinstalled version starts with a clean record
  await chrome.storage.local.set({ [`xpeRulesInstalled:${rs.site}`]: rs, [key]: h });
  return { site: rs.site, version: rs.version };
}

// "Use built-in rules": drop the installed set, and its copy as last known good if it is one.
async function rulesRemove(site) {
  const { installed, lkg } = await rulesStore(site);
  const keys = [`xpeRulesInstalled:${site}`];
  if (installed && lkg?.version === installed.version) keys.push(`xpeRulesLKG:${site}`);
  await chrome.storage.local.remove(keys);
}

async function rulesResetHealth(site) {
  await chrome.storage.local.remove([`xpeRulesHealth:${site}`, `xpeRulesLKG:${site}`]);
}

// --- X web-client config for the "About this account" lookup ---
// The web app's bearer token is public (embedded in X's main script for every visitor) and the
// persisted query ID changes with deploys, so both are read from X's own scripts at runtime.
const FALLBACK_ABOUT_QUERY_ID = "TzOG2twZEfhr9KmClvVVqA"; // AboutAccountQuery as of 2026-10-08

async function xConfig({ mainUrl, chunkUrl }) {
  const { xpeXConfig } = await chrome.storage.local.get("xpeXConfig");
  if (xpeXConfig?.bearer && xpeXConfig.mainUrl === mainUrl && xpeXConfig.chunkUrl === chunkUrl) return xpeXConfig;
  if (!mainUrl) throw new Error("Couldn't find X's main script on the page");
  const main = await (await fetch(mainUrl)).text();
  const bearer = main.match(/"Bearer (AAAA[A-Za-z0-9%]+)"/)?.[1];
  if (!bearer) throw new Error("Couldn't find X's web access token in its main script");
  let queryId = FALLBACK_ABOUT_QUERY_ID;
  if (chunkUrl) {
    try {
      const chunk = await (await fetch(chunkUrl)).text();
      queryId = chunk.match(/id:"([\w-]+)",metadata:\{\},name:"AboutAccountQuery"/)?.[1] || queryId;
    } catch {}
  }
  const cfg = { mainUrl, chunkUrl, bearer, queryId, at: Date.now() };
  await chrome.storage.local.set({ xpeXConfig: cfg });
  return cfg;
}

// The lookup must run in an x.com tab (it uses the logged-in session), so the settings
// page's test button is forwarded to one.
async function countryTest(handle) {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!tabs.length) throw new Error("Open x.com in a tab first, then test again.");
  // Tabs opened before the extension was (re)loaded have no content script; try each, active first.
  tabs.sort((a, b) => b.active - a.active || b.lastAccessed - a.lastAccessed);
  for (const tab of tabs) {
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "countryTest", handle });
    } catch {
      continue; // no content script in this tab
    }
    if (!res?.ok) throw new Error(res?.error || "The x.com tab didn't return a result.");
    return res.result;
  }
  throw new Error("Your x.com tab is running an older copy of the extension. Reload the x.com tab and try again.");
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  const reply = (promise) => {
    promise.then((result) => send({ ok: true, result }), (e) => send({ ok: false, error: String(e?.message || e) }));
    return true; // keep the channel open for the async reply
  };
  if (msg.type === "classify") return reply(classify(msg.post));
  if (msg.type === "test") {
    return reply(callJev({ id: "test", handle: "test", text: msg.text || "Thanks everyone for the kind words today!" }));
  }
  if (msg.type === "getRules") return reply(getRules(msg.site));
  if (msg.type === "rulesHealth") return reply(rulesHealth(msg));
  if (msg.type === "rulesStatus") return reply(rulesStatus());
  if (msg.type === "rulesInstall") return reply(rulesInstall(msg.rules));
  if (msg.type === "rulesRemove") return reply(rulesRemove(msg.site));
  if (msg.type === "rulesResetHealth") return reply(rulesResetHealth(msg.site));
  if (msg.type === "xconfig") return reply(xConfig(msg));
  if (msg.type === "countryTest") return reply(countryTest(msg.handle));
  if (msg.type === "clearCountries") return reply(chrome.storage.local.set({ xpeCountry: {} }));
  if (msg.type === "clearStats") {
    statsBucket = null;
    return reply(
      chrome.storage.local.get(null).then((all) => chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("xpeStats:")))),
    );
  }
  if (msg.type === "clearCache") {
    cache = {};
    return reply(chrome.storage.local.set({ xpeClass: {} }));
  }
});
