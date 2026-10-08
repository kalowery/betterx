// Rule engine: turns a page-rule set (rules/*.json, see docs/rules.md) into posts and comments
// found in the page, measures how well the rules are working, and falls back to the last
// rule set that worked when they don't.
//
// Rules are data only; this file is the fixed interpreter. Rule files can only choose
// elements, attributes, and text on the page - they can't run code or send data anywhere.

(() => {
  const R = globalThis.XPE_RULES;
  const MAX_TEXT = 20000;

  // ---------- text and element helpers ----------

  // Visible text: keeps emoji (<img alt>) and line breaks; never reads betterx's own labels.
  function readText(el, opt = {}) {
    const skip = opt.skip || [];
    let out = "";
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return void (out += node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList.contains("xpe-chips") || node.classList.contains("xpe-marker")) return;
      if (skip.some((s) => node.matches(s))) return;
      if (node.nodeName === "IMG") return void (out += node.getAttribute("alt") || "");
      if (node.nodeName === "BR") return void (out += "\n");
      if (opt.blockNewlines && node.nodeName === "DIV" && out && !out.endsWith("\n")) out += "\n";
      node.childNodes.forEach(walk);
    };
    walk(el);
    if (opt.blockNewlines) out = out.replace(/\n{3,}/g, "\n\n");
    return out.trim().slice(0, MAX_TEXT);
  }

  // "facebook.com/jane.doe?..." -> "jane.doe"; "profile.php?id=123" -> "id:123"; groups keep two segments.
  function handleFromUrl(href, opt) {
    try {
      const u = new URL(href, location.origin);
      if (opt.idPath && u.pathname === opt.idPath) return (opt.idPrefix || "") + (u.searchParams.get(opt.idParam || "id") || "");
      const parts = u.pathname.split("/").filter(Boolean);
      if (!parts.length) return null;
      if ((opt.multiSegment || []).includes(parts[0])) return parts.slice(0, 2).join("/");
      return parts[0];
    } catch {
      return null;
    }
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  }

  // Thrown for a bad selector or pattern in a rule file, so health checks can report it.
  class RuleError extends Error {}
  const qsa = (scope, sel) => {
    try {
      return [...scope.querySelectorAll(sel)];
    } catch {
      throw new RuleError(`invalid selector: ${sel}`);
    }
  };
  const matches = (el, sel) => {
    try {
      return el.matches(sel);
    } catch {
      throw new RuleError(`invalid selector: ${sel}`);
    }
  };
  const regexCache = new Map();
  const re = (p, flags = "") => {
    const k = p + "/" + flags;
    if (!regexCache.has(k)) regexCache.set(k, new RegExp(p, flags));
    return regexCache.get(k);
  };

  // True if an ancestor strictly between `el` and `scope` matches `sel`.
  function between(el, scope, sel) {
    for (let a = el.parentElement; a && a !== scope; a = a.parentElement) if (matches(a, sel)) return true;
    return false;
  }

  function scopeOf(spec, ctx) {
    if (!spec.scope) return ctx.root;
    if (spec.scope === "anchor") return ctx.anchor;
    if (spec.scope === "document") return document;
    if (spec.scope.closest) return ctx.root.closest(spec.scope.closest);
    return ctx.root;
  }

  function selectAll(scope, spec, sel) {
    if (!scope) return [];
    let els = qsa(scope, sel);
    if (spec.notInside) els = els.filter((e) => !between(e, scope, spec.notInside));
    if (spec.inside) els = els.filter((e) => between(e, scope, spec.inside));
    if (spec.nonEmpty) els = els.filter((e) => e.textContent.trim());
    if (spec.maxChildren != null) els = els.filter((e) => e.childElementCount <= spec.maxChildren);
    if (spec.textPattern) els = els.filter((e) => re(spec.textPattern, "i").test(e.textContent.trim()));
    return els;
  }

  // ---------- values ----------

  const empty = (v) => v == null || v === "" || v === false;

  function fill(template, ctx) {
    return template.replace(/\{([^}]+)\}/g, (_, expr) => {
      for (const alt of expr.split("|")) {
        const [name, n] = alt.split(":");
        const v = ctx.fields[name];
        if (!empty(v)) return n ? String(v).slice(0, Number(n)) : String(v);
      }
      return "";
    });
  }

  function rawFrom(el, spec) {
    if (spec.text) return readText(el, spec.text);
    const attr = spec.attr || "text";
    if (attr === "text") return el.textContent.trim();
    const v = el.getAttribute(attr);
    if (v == null) return null;
    if (attr !== "href") return v;
    if (spec.param) {
      // One name, or a list tried in order on the same URL.
      try {
        const params = new URL(v, location.origin).searchParams;
        for (const p of [].concat(spec.param)) if (params.get(p)) return params.get(p);
        return null;
      } catch {
        return null;
      }
    }
    if (spec.handleFromUrl) return handleFromUrl(v, spec.handleFromUrl);
    return v;
  }

  function finishUrl(v, spec) {
    if (typeof v !== "string") return v;
    if (spec.stripQuery) v = v.split("?")[0];
    if (spec.absolute) {
      try {
        v = new URL(v, location.origin).href;
      } catch {}
    }
    return v;
  }

  function evalValue(spec, ctx) {
    if (spec == null) return null;
    let v = null;
    if ("const" in spec) v = spec.const;
    else if (spec.first) {
      for (const s of spec.first) {
        v = evalValue(s, ctx);
        if (!empty(v)) break;
      }
    } else if (spec.template) v = fill(spec.template, ctx);
    else if (spec.hash) v = hash(fill(spec.hash, ctx));
    else if (spec.cases) {
      for (const c of spec.cases) {
        if ("else" in c) {
          v = c.else;
          break;
        }
        if (test(c.if, ctx)) {
          v = c.then;
          break;
        }
      }
    } else if (spec.exists) v = selectAll(scopeOf(spec, ctx), spec, spec.exists).length > 0;
    else if (spec.select || spec.all) {
      const els = selectAll(scopeOf(spec, ctx), spec, spec.select || spec.all);
      if (spec.all) {
        const vals = els.map((e) => rawFrom(e, spec)).filter((x) => !empty(x));
        v = vals.length ? vals.join(spec.join ?? "\n") : null;
      } else if (spec.patterns) {
        // First element whose value matches any pattern (patterns tried in order per element).
        outer: for (const e of els) {
          const raw = rawFrom(e, spec);
          if (typeof raw !== "string") continue;
          for (const p of spec.patterns) {
            const m = raw.match(re(p));
            if (m) {
              v = spec.keep === "value" ? raw : (m[spec.group ?? 1] ?? m[0]);
              break outer;
            }
          }
        }
      } else {
        const e = els[spec.nth || 0];
        v = e ? rawFrom(e, spec) : null;
        if (typeof v === "string" && spec.pattern) {
          const m = v.match(re(spec.pattern));
          v = m ? (m[spec.group ?? 1] ?? m[0]) : null;
        }
      }
      v = finishUrl(v, spec);
    }
    if (typeof v === "string") {
      if (spec.maxLength) v = v.slice(0, spec.maxLength);
      if (spec.prefix && v) v = spec.prefix + v;
    }
    if (empty(v) && "default" in spec) {
      v = spec.default;
      ctx.defaults?.add(ctx.field);
    }
    return v;
  }

  function resolveRef(ref, ctx) {
    if (typeof ref === "string" && ref.startsWith("$page.")) return ctx.page[ref.slice(6)] ?? null;
    return ref;
  }

  function test(pred, ctx) {
    if (!pred) return false;
    if (pred.closest) return !!ctx.root.closest(pred.closest);
    if (pred.exists) return selectAll(scopeOf(pred, ctx), pred, pred.exists).length > 0;
    if (pred.page) return re(pred.page).test(location.pathname);
    if (pred.fieldEquals) {
      const [f, ref] = pred.fieldEquals;
      const want = resolveRef(ref, ctx);
      return want != null && ctx.fields[f] === want;
    }
    if (pred.relative) {
      const other = ctx.peers.find((p) => p !== ctx.self && test(pred.to, { ...ctx, fields: p.fields, root: p.root }));
      if (!other) return false;
      const pos = other.root.compareDocumentPosition(ctx.root);
      return pred.relative === "after" ? !!(pos & Node.DOCUMENT_POSITION_FOLLOWING) : !!(pos & Node.DOCUMENT_POSITION_PRECEDING);
    }
    return false;
  }

  function evalElement(spec, ctx) {
    if (!spec) return null;
    if (spec.first) {
      for (const s of spec.first) {
        const e = evalElement(s, ctx);
        if (e) return e;
      }
      return null;
    }
    const e = selectAll(scopeOf(spec, ctx), spec, spec.select)[spec.nth || 0] || null;
    return e && spec.parent ? e.parentElement : e;
  }

  // ---------- finding units ----------

  function findRoots(unit) {
    const f = unit.find;
    if (f.selector) return qsa(document, f.selector).map((el) => ({ root: el, anchor: el }));
    const out = [];
    const seen = new Set();
    for (const a of qsa(document, f.anchor)) {
      if (f.anchorNotInside && a.closest(f.anchorNotInside)) continue;
      const root = f.root?.closest ? a.closest(f.root.closest) : a;
      if (!root || seen.has(root)) continue;
      seen.add(root);
      out.push({ root, anchor: a });
    }
    return out;
  }

  function pageVars(rs) {
    const vars = {};
    for (const [k, v] of Object.entries(rs.page || {})) {
      vars[k] = v.pathPattern ? location.pathname.match(re(v.pathPattern))?.[1] ?? null : null;
    }
    return vars;
  }

  // All units for a rule set: [{ el, host, rec, meta: { type, defaults } }], in page order.
  function extract(rs) {
    const page = pageVars(rs);
    const out = [];
    for (const unit of rs.units) {
      const items = [];
      const fieldNames = Object.keys(unit.fields);
      for (const { root, anchor } of findRoots(unit)) {
        const ctx = { root, anchor, page, fields: {}, defaults: new Set(), peers: items };
        for (const name of fieldNames) {
          if (unit.fields[name].late) continue;
          ctx.field = name;
          ctx.fields[name] = evalValue(unit.fields[name], ctx);
        }
        ctx.self = ctx;
        items.push(ctx);
      }
      // Second pass for fields that compare units with each other (e.g. replies after the focal post).
      for (const ctx of items) {
        for (const name of fieldNames) {
          if (!unit.fields[name].late) continue;
          ctx.field = name;
          ctx.fields[name] = evalValue(unit.fields[name], ctx);
        }
      }
      for (const ctx of items) {
        if ((unit.require || []).some((f) => empty(ctx.fields[f]))) continue;
        const rec = {
          ...ctx.fields,
          handle: ctx.fields.handle || "",
          text: ctx.fields.text || "",
          truncated: !!ctx.fields.truncated,
          site: rs.site,
          page: location.pathname,
          seenAt: new Date().toISOString(),
        };
        out.push({ el: ctx.root, host: evalElement(unit.host, ctx), rec, meta: { type: unit.type, defaults: ctx.defaults } });
      }
    }
    return out;
  }

  // ---------- health ----------

  function completeness(u, fields) {
    if (!fields.length) return 1;
    return fields.filter((f) => (f === "host" ? !!u.host : !empty(u.rec[f]) && !u.meta.defaults.has(f))).length / fields.length;
  }

  function evaluate(rs, units, error) {
    const h = rs.health || {};
    const fields = Object.keys(h.fields || {});
    const content = h.contentSignal ? document.querySelectorAll(h.contentSignal.selector).length >= h.contentSignal.min : true;
    const n = units.length;
    const types = {};
    for (const u of rs.units) types[u.type] = 0;
    for (const u of units) types[u.meta.type] = (types[u.meta.type] || 0) + 1;
    const rates = {};
    for (const f of fields) rates[f] = n ? units.filter((u) => completeness(u, [f]) === 1).length / n : null;
    let status = "healthy";
    const reasons = [];
    // Types that every page with content should have (e.g. posts; comments only appear when opened).
    const missing = content ? (h.requireTypes || []).filter((t) => !types[t]) : [];
    if (error) {
      status = "broken";
      reasons.push(error);
    } else if (missing.length) {
      status = "broken";
      reasons.push(`no ${missing.join(" or ")} found on a page with content`);
    } else if (!n) {
      if (content) {
        status = "broken";
        reasons.push("nothing found on a page with content");
      } else status = "idle";
    } else if (n >= (h.minUnitsForRates || 3)) {
      for (const f of fields) {
        if (rates[f] < h.fields[f]) {
          status = "degraded";
          reasons.push(`${f} found for ${Math.round(rates[f] * 100)}% of posts (expected at least ${Math.round(h.fields[f] * 100)}%)`);
        }
      }
    }
    const score = units.reduce((s, u) => s + completeness(u, fields), 0);
    return { status, reasons, units: n, types, rates, score };
  }

  // ---------- engine state: active rules, fallback, monitoring ----------

  let site = null;
  let active = null; // rule set in use on this page
  let fallback = null; // last known good, if different
  let usingFallback = false;
  let badSince = null; // when the active rules started looking broken/degraded, continuously
  let badChecks = 0;
  let lastReported = { status: null, at: 0 };
  let lastEval = null;

  function report(ev, force = false) {
    const now = Date.now();
    if (!force && ev.status === lastReported.status && now - lastReported.at < 60000) return;
    if (ev.status === "idle") return;
    lastReported = { status: ev.status, at: now };
    // Content-free: rule version, status, counts, and rates only.
    chrome.runtime.sendMessage({
      type: "rulesHealth",
      site,
      version: active.version,
      usingFallback,
      status: ev.status,
      reasons: ev.reasons,
      units: ev.units,
      types: ev.types,
      rates: ev.rates,
    });
  }

  function safeExtract(rs) {
    try {
      return { units: extract(rs), error: null };
    } catch (e) {
      if (e instanceof RuleError) return { units: [], error: e.message };
      throw e;
    }
  }

  globalThis.XPE_ENGINE = {
    // Loads the rule sets for this page's site from the background worker.
    async init(siteOverride /* tests only */) {
      site = siteOverride || R.siteForHost(location.hostname);
      if (!site) return null;
      const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "getRules", site }, resolve));
      if (!res?.ok || !res.result?.active) return null;
      active = res.result.active;
      fallback = res.result.fallback || null;
      return { name: site, label: active.label || site };
    },

    who(rec) {
      return fill(active?.display?.who || "{displayName|handle}", { fields: rec });
    },

    // The posts on the page right now, or [] on pages betterx must not read.
    units() {
      if (!active || R.isPrivatePath(site, location.pathname)) return [];
      const { units, error } = safeExtract(active);
      if (!this.observe(units, error)) return units;
      // Switched to the last known good rules: use them for this scan too.
      const again = safeExtract(active);
      this.observe(again.units, again.error);
      return again.units;
    },

    // Health check after each scan. If the active rules look broken for a few seconds and the
    // last known good rules do better on this same page, switch to them for this page.
    observe(units, error) {
      const ev = evaluate(active, units, error);
      lastEval = ev;
      // Pages take a moment to render, so only act on problems that persist for a few seconds.
      if (ev.status === "broken" || ev.status === "degraded") {
        badSince ??= Date.now();
        badChecks++;
      } else if (ev.status === "healthy") {
        badSince = null;
        badChecks = 0;
      }
      const bad = badSince != null && Date.now() - badSince >= 4000 && badChecks >= 3;
      if (bad && fallback && !usingFallback) {
        const alt = safeExtract(fallback);
        const altEv = evaluate(fallback, alt.units, alt.error);
        if (altEv.status !== "broken" && altEv.score > ev.score) {
          console.info(`[betterx] ${site} rules ${active.version} look ${ev.status}; switching to last known good ${fallback.version}`, ev.reasons);
          report({ ...ev, reasons: [...ev.reasons, `switched to ${fallback.version}`] }, true);
          [active, fallback] = [fallback, active];
          usingFallback = true;
          badSince = null;
          badChecks = 0;
          lastReported = { status: null, at: 0 }; // report the fallback's health right away
          return true;
        }
      }
      report(ev);
      return false;
    },

    status() {
      return active
        ? { site, version: active.version, usingFallback, ...(lastEval ? { status: lastEval.status, reasons: lastEval.reasons, units: lastEval.units } : {}) }
        : null;
    },

    // Exposed for tests and the settings page.
    _extract: (rs) => safeExtract(rs),
    _evaluate: evaluate,
  };
})();
