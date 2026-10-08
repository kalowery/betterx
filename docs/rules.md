# Page rules

How betterx finds posts and comments on a site is defined by a **rule file** (`rules/x.json`, `rules/facebook.json`), not code. `engine.js` is a fixed interpreter for these files. Rule files are data only: they choose elements, attributes, and text on the page. They can't run code, make network requests, or widen which pages are read. Private-message paths (`/messages` and similar) are excluded in code (`rules.js`) and can't be enabled by a rule file.

## Rule set

```json
{
  "schema": 1,
  "site": "facebook",
  "label": "Facebook",
  "version": "2026.10.08.1",
  "display": { "who": "{displayName|handle}" },
  "page": { "focalId": { "pathPattern": "/status/(\\d+)" } },
  "health": { ... },
  "units": [ ... ]
}
```

| Key | Meaning |
|---|---|
| `schema` | Format version; currently `1`. |
| `site` | `x` or `facebook`. |
| `version` | Dotted numbers, compared part by part; the newest valid, non-suspect version wins. |
| `display.who` | How markers name an author (template, see below). |
| `page` | Page variables: `{ "name": { "pathPattern": "regex" } }` sets `$page.name` to the first capture group of the URL path. |
| `health` | Health-check thresholds (see below). |
| `units` | One entry per kind of item (post, comment, …). |

## Units

```json
{
  "type": "post",
  "find": { "selector": "article[data-testid='tweet']" },
  "require": ["id"],
  "fields": { "id": { ... }, "text": { ... } },
  "host": { "select": "[data-testid='User-Name']" }
}
```

- **`find`** locates each item's root element (the one that gets hidden, blurred, or dimmed). Either:
  - `"selector"`: every match is a root; or
  - `"anchor"` + `"root": { "closest": "…" }`: find anchors, then climb to the nearest matching ancestor (duplicates dropped). `"anchorNotInside"` skips anchors inside a matching ancestor.
- **`require`**: items missing any of these fields are dropped (ads, placeholders).
- **`fields`**: evaluated in the order written; later fields can use earlier ones in templates. A field with `"late": true` is evaluated after all items of this type, so it can compare items with each other (see `relative`). Fields betterx uses: `id` (required), `text` (required), `handle`, `displayName`, `url`, `time`, `kind` (`post` / `reply` / `focal` / `parent`), `subkind`, `truncated`, `quotedText`, `parentText`, `socialContext`.
- **`host`**: the element betterx appends its labels to.

## Value specs

Every field is a value spec. Selection options apply within the item's root unless `scope` says otherwise.

| Spec | Result |
|---|---|
| `{ "select": "css" }` | The first matching element's value (`nth` picks another). |
| `{ "all": "css", "join": "\n" }` | All matching elements' values, joined. |
| `{ "exists": "css" }` | `true` if anything matches. |
| `{ "const": value }` | A fixed value. |
| `{ "template": "https://x.com/{handle}/status/{id}" }` | Text from earlier fields. `{a\|b}` uses the first non-empty; `{text:200}` truncates. |
| `{ "hash": "{handle}\|{text:200}" }` | A short stable hash of the template's result (fallback IDs). |
| `{ "first": [spec, spec, …] }` | The first non-empty result. |
| `{ "cases": [{ "if": predicate, "then": value }, { "else": value }] }` | The first matching case. |

**Selection options:** `scope` (`"anchor"`, `"document"`, or `{ "closest": "css" }`), `notInside` / `inside` (keep elements with / without an ancestor matching this selector, strictly inside the scope), `nonEmpty`, `maxChildren`, `textPattern` (regex on the element's text, case-insensitive).

**Value options:** `attr` (`"text"` = trimmed text content, default; or any attribute name), `text` (read visible text: `{ "skip": ["css"], "blockNewlines": true }`; keeps emoji alt text and line breaks, never reads betterx's own labels), `param` (URL query parameter of an `href`; a list is tried in order on the same URL), `handleFromUrl` (account handle from a profile URL: `{ "idPath", "idParam", "idPrefix", "multiSegment": [...] }`), `pattern` + `group` (regex capture), `patterns` (list: the first element whose value matches any pattern; `"keep": "value"` returns the whole value), `stripQuery`, `absolute`, `maxLength`, `prefix`, `default`.

**Predicates** for `cases`: `{ "exists": "css", … }`, `{ "closest": "css" }` (root is inside a match), `{ "page": "regex" }` (URL path), `{ "fieldEquals": ["field", "$page.var"] }`, `{ "relative": "after" | "before", "to": predicate }` (this item is after / before another item of the same type matching the predicate; needs `"late": true`).

## Health

```json
"health": {
  "contentSignal": { "selector": "div[dir='auto'], span[dir='auto']", "min": 40 },
  "requireTypes": ["post"],
  "minUnitsForRates": 3,
  "fields": { "text": 0.9, "handle": 0.9, "displayName": 0.9, "host": 0.9 }
}
```

After every scan the engine rates the active rules on the current page:

- **broken**: a rule failed (bad selector), or the page clearly has content (`contentSignal`) but no items of a `requireTypes` type were found;
- **degraded**: at least `minUnitsForRates` items were found, but a field in `fields` was filled for less than its threshold (a field filled only by its `default` counts as missing; `host` means labels have somewhere to go);
- **healthy** otherwise; **idle** when the page has no content to judge.

If the active rules stay broken or degraded for 4 seconds (3+ checks) and a **last known good** rule set is available, the engine runs it on the same page and switches to it if it does better.

Each tab reports its status to the background worker at most once a minute, and on changes. Reports contain only the rule version, status, reasons, item counts per type, and field fill rates — never post text, names, or URLs. The background worker:

- promotes a version to **last known good** after 3 healthy reports;
- marks a version **suspect** after 3 consecutive broken/degraded reports (when a last-known-good alternative exists) and stops serving it until it reports healthy again or a new version is installed.

## Sources

The background worker picks the newest valid, non-suspect version among: the rule set bundled with the extension, one installed from the settings page (later: downloaded from a rules server), and the last-known-good copy. Settings → **Page rules** shows each site's versions and latest health check, installs a pasted rule file, reverts to the built-in rules, and resets health history.
