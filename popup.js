let settings;

function render() {
  chrome.storage.local.get({ xpePosts: {}, xpeClass: {}, xpeApiKey: "" }, ({ xpePosts, xpeClass, xpeApiKey }) => {
    const posts = Object.values(xpePosts).sort((a, b) => b.seenAt.localeCompare(a.seenAt));
    const classified = posts.filter((p) => xpeClass[p.id]);
    const flagged = classified.filter((p) => XPE.decide(settings, xpeClass[p.id].answers).action !== "none");
    document.getElementById("counts").textContent =
      `${posts.length} posts captured · ${classified.length} classified · ${flagged.length} matched a rule`;
    document.getElementById("warn").textContent = xpeApiKey ? "" : "No TypeSafe API key yet — open Settings to add one.";
    document.getElementById("enabled").checked = settings.enabled;

    // Prefer the posts on the active x.com tab, in page order; fall back to saved posts.
    const fallback = (note) => {
      const saved = posts.slice(0, 25).map((p) => ({ ...p, answers: xpeClass[p.id]?.answers || null }));
      renderList(`Recently captured on any tab${note ? " — " + note : ""}`, saved);
    };
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.url || !/^https:\/\/(x|twitter)\.com\//.test(tab.url)) return fallback("");
      chrome.tabs.sendMessage(tab.id, { type: "pagePosts" }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) return fallback("reload your x.com tab to see its posts here");
        renderList(`On this page (${res.posts.length})`, res.posts);
      });
    });
  });
}

function renderList(heading, posts) {
  document.getElementById("listHeading").textContent = heading;
  document.getElementById("list").replaceChildren(
    ...posts.map((p) => {
      const li = document.createElement("li");
      const meta = document.createElement("div");
      meta.className = "meta";
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = p.kind;
      meta.append(kind, ` · @${p.handle}`);
      if (p.country) meta.append(` · 📍 ${p.country}`);
      const a = p.answers;
      if (a) meta.append(` · ${a.tone.choice} · ${a.post_type.choice.replace("_", " ")} · arg ${a.argument_quality.score.toFixed(1)}`);
      const reasons = XPE.decide(settings, a, { country: p.country, kind: p.kind }).reasons;
      if (reasons.length) {
        const f = document.createElement("span");
        f.className = "flag";
        f.textContent = " · " + reasons.map((r) => r.short || r.name).join(", ");
        meta.append(f);
      }
      const text = document.createElement("div");
      text.textContent = p.text.slice(0, 200) || "(no text)";
      li.append(meta, text);
      return li;
    }),
  );
}

document.getElementById("settings").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("mood").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
document.getElementById("enabled").onchange = (e) => {
  settings.enabled = e.target.checked;
  chrome.storage.local.set({ xpeSettings: settings });
};
document.getElementById("export").onclick = () => {
  chrome.storage.local.get({ xpePosts: {}, xpeClass: {} }, ({ xpePosts, xpeClass }) => {
    const rows = Object.values(xpePosts).map((p) => (xpeClass[p.id] ? { ...p, jev: xpeClass[p.id] } : p));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `x-posts-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`;
    a.click();
  });
};
document.getElementById("clear").onclick = () => chrome.storage.local.set({ xpePosts: {} }, render);

XPE.load((s) => {
  settings = s;
  render();
});
