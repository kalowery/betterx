// Page-rule helpers shared by the background worker, settings page, and content scripts.
// No DOM access here. The rule format itself is documented in docs/rules.md.

globalThis.XPE_RULES = {
  SCHEMA: 1,
  MAX_BYTES: 200_000,

  // Which rule set applies to a page. Paths where betterx must never read content (private
  // messages) are fixed here, in code, so a rule file can't widen what gets read.
  SITES: {
    x: { hosts: ["x.com", "twitter.com"], neverRead: ["^/messages", "^/i/chat", "^/i/grok"] },
    facebook: { hosts: ["www.facebook.com"], neverRead: ["^/messages", "^/messenger"] },
  },

  siteForHost(host) {
    return Object.entries(this.SITES).find(([, s]) => s.hosts.includes(host))?.[0] || null;
  },

  isPrivatePath(site, path) {
    return (this.SITES[site]?.neverRead || []).some((p) => new RegExp(p).test(path));
  },

  // "2026.10.08.1" style versions, compared numerically part by part.
  compareVersions(a, b) {
    const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  },

  // Structural check; selectors and patterns are checked again where they run. Returns a list of problems.
  validate(rs) {
    const problems = [];
    const fail = (m) => problems.push(m);
    if (!rs || typeof rs !== "object") return ["not a JSON object"];
    if (rs.schema !== this.SCHEMA) fail(`schema must be ${this.SCHEMA}`);
    if (!this.SITES[rs.site]) fail(`unknown site "${rs.site}"`);
    if (typeof rs.version !== "string" || !/^\d+([.-]\d+)*$/.test(rs.version)) fail("version must look like 2026.10.08.1");
    if (!Array.isArray(rs.units) || !rs.units.length) fail("units must be a non-empty list");
    for (const [i, u] of (rs.units || []).entries()) {
      const where = `units[${i}]`;
      if (!u.type) fail(`${where}: missing type`);
      if (!u.find || !(u.find.selector || u.find.anchor)) fail(`${where}: find needs a selector or an anchor`);
      if (!u.fields || typeof u.fields !== "object") fail(`${where}: missing fields`);
      else if (!u.fields.id) fail(`${where}: fields.id is required`);
      else if (!u.fields.text) fail(`${where}: fields.text is required`);
    }
    // Patterns must compile.
    const walk = (o, path) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if ((k === "pattern" || k === "textPattern" || k === "page") && typeof v === "string") {
          try {
            new RegExp(v);
          } catch {
            fail(`${path}.${k}: invalid regular expression`);
          }
        }
        if (k === "patterns" && Array.isArray(v)) v.forEach((p, j) => walk({ pattern: p }, `${path}.patterns[${j}]`));
        if (typeof v === "object") walk(v, `${path}.${k}`);
      }
    };
    walk(rs, "rules");
    if (JSON.stringify(rs).length > this.MAX_BYTES) fail(`larger than ${this.MAX_BYTES} bytes`);
    return problems;
  },
};
