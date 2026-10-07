// Calls TypeSafe's Jev classifier for posts found by the content script.
// Runs here (not in the page) so the API key stays out of x.com and CORS doesn't apply.
importScripts("settings.js");

const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const QUESTIONS_VERSION = 2; // bump when QUESTIONS change so cached answers are refreshed
const MAX_CACHE = 5000;
const MAX_CONCURRENT = 6;

const CONTEXT =
  "The state is a post from X (Twitter). Judge only `post_text`, which the author wrote. " +
  "`quoted_post_text`, if present, is someone else's post being quoted and is context only.";

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
  racist: {
    type: "noul",
    instructions: `${CONTEXT} Is the author's text racist?`,
    criteria: {
      true: "Demeans, stereotypes, or expresses hostility toward people based on race or ethnicity",
      false: "No racist content (discussing or criticizing racism is not itself racist)",
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
    return entry;
  });
  inflight.set(post.id, p);
  p.catch(() => {}).finally(() => inflight.delete(post.id));
  return p;
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
  if (msg.type === "clearCache") {
    cache = {};
    return reply(chrome.storage.local.set({ xpeClass: {} }));
  }
});
