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

  const cf = settings.country;
  $("#cEnabled").checked = cf.enabled;
  $("#cChip").checked = cf.chip;
  $("#cList").value = cf.countries.join("\n");
  $("#cScope").value = cf.scope;
  $("#cInaccurate").checked = cf.includeInaccurate;
  $("#cAction").replaceChildren(
    actionSelect(cf.action, (v) => {
      cf.action = v;
      save();
    }),
  );

  $("#lqMax").value = settings.lowQuality.maxScore;
  $("#lqAction").replaceChildren(
    actionSelect(settings.lowQuality.action, (v) => {
      settings.lowQuality.action = v;
      save();
    }),
  );
}

function refreshCacheInfo() {
  chrome.storage.local.get({ xpeClass: {}, xpeCountry: {} }, ({ xpeClass, xpeCountry }) => {
    const located = Object.values(xpeCountry);
    $("#cacheInfo").textContent =
      `${Object.keys(xpeClass).length} posts classified and ${located.length} account locations saved. `;

    // Countries seen, most common first, clickable to add to the filter list.
    const counts = {};
    for (const v of located) if (v.name) counts[v.name] = (counts[v.name] || 0) + 1;
    const seen = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!seen.length) return;
    $("#cSeen").replaceChildren(
      ...seen.map(([name, n]) => {
        const s = document.createElement("span");
        s.className = "seen";
        s.textContent = `${name} (${n})`;
        s.onclick = () => {
          if (!settings.country.countries.some((c) => c.toLowerCase() === name.toLowerCase())) {
            settings.country.countries.push(name);
            $("#cList").value = settings.country.countries.join("\n");
            save();
          }
        };
        return s;
      }),
    );
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
$("#clearCountries").onclick = () => chrome.runtime.sendMessage({ type: "clearCountries" }, refreshCacheInfo);
$("#clearStats").onclick = () => chrome.runtime.sendMessage({ type: "clearStats" }, refreshCacheInfo);

$("#cEnabled").onchange = (e) => {
  settings.country.enabled = e.target.checked;
  save();
};
$("#cChip").onchange = (e) => {
  settings.country.chip = e.target.checked;
  save();
};
$("#cInaccurate").onchange = (e) => {
  settings.country.includeInaccurate = e.target.checked;
  save();
};
$("#cScope").onchange = (e) => {
  settings.country.scope = e.target.value;
  save();
};
$("#cList").onchange = (e) => {
  settings.country.countries = [...new Set(e.target.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
  e.target.value = settings.country.countries.join("\n");
  save();
};
$("#cTest").onclick = () => {
  const handle = $("#cTestHandle").value.trim();
  if (!handle) return;
  $("#cTestResult").textContent = "Looking up…";
  chrome.runtime.sendMessage({ type: "countryTest", handle }, (res) => {
    if (!res?.ok) return ($("#cTestResult").textContent = "Failed: " + (res?.error || chrome.runtime.lastError?.message));
    const r = res.result;
    $("#cTestResult").textContent =
      r.state === "done"
        ? `Based in ${r.name}${r.accurate ? "" : " (X says this may be inaccurate)"}`
        : "X shows no location for this account.";
  });
};
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
