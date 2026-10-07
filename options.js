const $ = (s) => document.querySelector(s);
let settings;

function save() {
  chrome.storage.local.set({ xpeSettings: settings });
  const s = $("#status");
  s.classList.add("on");
  clearTimeout(save.t);
  save.t = setTimeout(() => s.classList.remove("on"), 900);
}

function actionSelect(value, onchange) {
  const sel = document.createElement("select");
  for (const [k, v] of Object.entries(XPE.ACTIONS)) sel.append(new Option(v, k));
  sel.value = value;
  sel.onchange = () => onchange(sel.value);
  return sel;
}

function pctInput(value, onchange) {
  const i = document.createElement("input");
  i.type = "number";
  i.min = 1;
  i.max = 99;
  i.value = Math.round(value * 100);
  i.onchange = () => {
    const v = Math.min(99, Math.max(1, Math.round(+i.value || 1)));
    i.value = v;
    onchange(v / 100);
  };
  const wrap = document.createElement("span");
  wrap.append(i, "%");
  return wrap;
}

function render() {
  $("#enabled").checked = settings.enabled;
  document.querySelectorAll("[data-chip]").forEach((cb) => (cb.checked = settings.chips[cb.dataset.chip]));

  const body = $("#rules");
  body.replaceChildren();
  for (const [rule, name] of Object.entries(XPE.RULES)) {
    const r = settings.rules[rule];
    const tr = document.createElement("tr");
    const warn = document.createElement("td");
    warn.className = "warn";
    const check = () => (warn.textContent = r.possible.threshold > r.likely.threshold ? "“Possible” should be lower than “likely”" : "");
    const cell = (el) => {
      const td = document.createElement("td");
      td.append(el);
      return td;
    };
    const set = (level, key) => (v) => {
      r[level][key] = v;
      check();
      save();
    };
    tr.append(
      cell(name),
      cell(pctInput(r.likely.threshold, set("likely", "threshold"))),
      cell(actionSelect(r.likely.action, set("likely", "action"))),
      cell(pctInput(r.possible.threshold, set("possible", "threshold"))),
      cell(actionSelect(r.possible.action, set("possible", "action"))),
      warn,
    );
    check();
    body.append(tr);
  }

  $("#lqMax").value = settings.lowQuality.maxScore;
  $("#lqAction").replaceChildren(
    actionSelect(settings.lowQuality.action, (v) => {
      settings.lowQuality.action = v;
      save();
    }),
  );
}

function refreshCacheInfo() {
  chrome.storage.local.get({ xpeClass: {} }, ({ xpeClass }) => {
    $("#cacheInfo").textContent = `${Object.keys(xpeClass).length} posts classified and saved. `;
  });
}

$("#enabled").onchange = (e) => {
  settings.enabled = e.target.checked;
  save();
};
document.querySelectorAll("[data-chip]").forEach(
  (cb) =>
    (cb.onchange = () => {
      settings.chips[cb.dataset.chip] = cb.checked;
      save();
    }),
);
$("#lqMax").onchange = (e) => {
  settings.lowQuality.maxScore = Math.min(4, Math.max(0, +e.target.value || 0));
  e.target.value = settings.lowQuality.maxScore;
  save();
};

$("#saveKey").onclick = () => {
  const key = $("#apiKey").value.trim();
  chrome.storage.local.set({ xpeApiKey: key }, () => {
    $("#testResult").textContent = key ? "Key saved." : "Key cleared.";
  });
};
$("#testKey").onclick = () => {
  $("#testResult").textContent = "Testing…";
  chrome.runtime.sendMessage({ type: "test" }, (res) => {
    if (!res?.ok) return ($("#testResult").textContent = "Failed: " + (res?.error || chrome.runtime.lastError?.message));
    const a = res.result.answers;
    $("#testResult").textContent = `Works: ${res.result.model}, ${res.result.ms} ms (sample tone: ${a.tone.choice})`;
  });
};
$("#clearCache").onclick = () => chrome.runtime.sendMessage({ type: "clearCache" }, refreshCacheInfo);
$("#resetSettings").onclick = () => {
  settings = structuredClone(XPE.DEFAULTS);
  save();
  render();
};

chrome.storage.local.get("xpeApiKey", ({ xpeApiKey }) => ($("#apiKey").value = xpeApiKey || ""));
XPE.load((s) => {
  settings = s;
  render();
});
refreshCacheInfo();
