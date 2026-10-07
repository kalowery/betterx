// Shared by the background worker, content script, popup and options page.
globalThis.XPE = {
  // Rules the user can configure. Probability comes from Jev (see probability()).
  RULES: {
    racist: "Racist",
    group_contempt: "Contempt for a nationality or immigrants",
    antisemitic: "Antisemitic",
    sexually_explicit: "Sexually explicit",
    insulting: "Insulting tone",
  },
  // Shorter names for the labels next to the author's name.
  SHORT: { group_contempt: "Group contempt" },
  ACTIONS: {
    none: "Do nothing",
    label: "Show label",
    dim: "Dim",
    blur: "Blur (click to show)",
    hide: "Hide (leave marker)",
  },
  SEVERITY: { none: 0, label: 1, dim: 2, blur: 3, hide: 4 },

  DEFAULTS: {
    enabled: true,
    chips: { tone: true, type: true, quality: true, kind: false },
    rules: {
      racist: { likely: { threshold: 0.7, action: "hide" }, possible: { threshold: 0.4, action: "label" } },
      group_contempt: { likely: { threshold: 0.7, action: "label" }, possible: { threshold: 0.4, action: "none" } },
      antisemitic: { likely: { threshold: 0.7, action: "hide" }, possible: { threshold: 0.4, action: "label" } },
      sexually_explicit: { likely: { threshold: 0.7, action: "blur" }, possible: { threshold: 0.4, action: "label" } },
      insulting: { likely: { threshold: 0.7, action: "label" }, possible: { threshold: 0.4, action: "none" } },
    },
    lowQuality: { action: "none", maxScore: 0.5 },
  },

  merge(base, over) {
    if (typeof base !== "object" || base === null || Array.isArray(base)) return over === undefined ? base : over;
    const out = {};
    for (const k of Object.keys(base)) out[k] = XPE.merge(base[k], over?.[k]);
    return out;
  },

  load(cb) {
    chrome.storage.local.get({ xpeSettings: {} }, ({ xpeSettings }) => cb(XPE.merge(XPE.DEFAULTS, xpeSettings)));
  },

  probability(rule, answers) {
    if (rule === "insulting") return answers.tone?.probabilities?.insulting ?? 0;
    return answers[rule]?.noul ?? 0;
  },

  // Which rules fire for a classified post, and the most severe resulting action.
  decide(settings, answers) {
    const reasons = [];
    for (const [rule, name] of Object.entries(XPE.RULES)) {
      const r = settings.rules[rule];
      const p = XPE.probability(rule, answers);
      const level = p >= r.likely.threshold ? "likely" : p >= r.possible.threshold ? "possible" : null;
      if (level && r[level].action !== "none") {
        reasons.push({ rule, name, short: XPE.SHORT[rule] || name, prob: p, level, action: r[level].action });
      }
    }
    const q = answers.argument_quality?.score;
    const lq = settings.lowQuality;
    if (lq.action !== "none" && q != null && q <= lq.maxScore) {
      reasons.push({ rule: "lowQuality", name: "Weak argument", short: "Weak argument", prob: null, level: "likely", action: lq.action });
    }
    const action = reasons.reduce((m, r) => (XPE.SEVERITY[r.action] > XPE.SEVERITY[m] ? r.action : m), "none");
    return { action, reasons };
  },

  pct: (p) => Math.round(p * 100) + "%",
};
