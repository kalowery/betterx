# betterx

A Chrome/Brave extension that reads posts and replies as you browse x.com, classifies each one with [TypeSafe](https://typesafe.ai)'s low-latency **Jev** classifier, and labels, dims, blurs, or hides it according to rules you choose. You can see what a post is before reading it.

For each post Jev answers eight questions in one request (about 150–250 ms):

| Question | Answer |
|---|---|
| Tone | insulting / critical / neutral / friendly |
| Post type | opinion / factual claim / news / joke / personal / other |
| Argument quality | score from 0 (none) to 4 (strong) |
| Racist | likelihood 0–100% |
| Contempt for a nationality or immigrants | likelihood 0–100% |
| Antisemitic | likelihood 0–100% |
| Sexually explicit | likelihood 0–100% |
| Rage bait | likelihood 0–100% that the post is designed to make readers angry, whatever its own tone |

The author's own text is judged; a quoted post is passed along as context only.

"Racist" is defined narrowly: claims of racial or ethnic superiority or inferiority, slurs, treating crime or bad character as inherent to a race, and calls to harm or exclude people because of race. Positions on immigration, borders, deportation, or crime don't count on their own. Contempt for immigrants or nationalities as groups ("invaders", "shithole countries") is a separate category, so you can treat it differently.

## What you see

- **Labels** next to the author's name: tone, post type, argument quality, and any rule that matched (red = likely, amber = possible). Hover a label for details.
- **Hidden** posts collapse to a bar like *"Hidden post by @someone — Racist (93%)"* with a **Show** button.
- **Blurred** posts are blurred under the same kind of bar.
- **Dimmed** posts fade until you hover over them.

## Settings

Open the toolbar popup → **Settings…** (or right-click the extension icon → Options).

- **Content rules.** For each category (racist, contempt for a nationality or immigrants, antisemitic, sexually explicit, insulting tone, rage bait) choose a *likely* threshold and a *possible* threshold, and what to do at each: nothing, label, dim, blur, or hide. When several rules match, the strongest action wins (hide > blur > dim > label).
- **Weak arguments.** Optionally dim, blur, or hide posts with argument quality at or below a score you pick.
- **Labels.** Show or hide the tone, post type, and argument quality labels.
- **Account location.** Optionally look up where each account is based (from X's "About this account") and label, dim, blur, or hide posts — or only replies — from countries you list. See below.
- **API key, on/off switch, Test button, and data reset.**

Defaults:

| Category | Likely (≥70%) | Possible (≥40%) |
|---|---|---|
| Racist | Hide | Label |
| Contempt for a nationality or immigrants | Label | Nothing |
| Antisemitic | Hide | Label |
| Sexually explicit | Blur | Label |
| Insulting tone | Label | Nothing |
| Rage bait | Label at ≥80% | Nothing (≥60%) |

Rage bait starts at a higher threshold because it is common: in testing on a political feed, about a third of posts scored 70% or more.

## Feed mood dashboard

Click the extension icon → **Feed mood…** for running totals of everything betterx has classified: the share of posts by tone, post type, and argument quality, the share likely or possibly in each content category, and (if the location filter is on) where authors are based. Filter by today, the last 7, 30, or 90 days, and by posts, replies, or both. Hover a bar for exact counts; a data table lists every number. Totals update live while you browse.

Each post counts once, however often you see it. Percentages use your current thresholds, so changing a threshold in Settings re-computes the dashboard without re-classifying anything. Statistics stay on your device for 90 days and can be cleared in Settings.

## Account location filter (optional, off by default)

X's "About this account" page shows where an account is based. With this option on, betterx looks that up for each account it sees and shows it as a 📍 label (with "?" when X says the location may be inaccurate, e.g. because of a VPN). You can then filter posts or replies from accounts based in countries you list, using the same actions as the content rules. The settings page lists the countries seen so far, so you can click to add them, and has a test box for checking a single handle.

How it works: the lookup calls the same `AboutAccountQuery` GraphQL request the X web app uses, from the x.com tab with your logged-in session. The web app's public access token and the current query ID are read from X's own scripts at runtime. Each account is looked up once and saved for 30 days; lookups run one at a time, 1.5 s apart, pause when X reports a rate limit, and back off after repeated errors.

**Caveats:** this is an undocumented, unofficial interface. It adds requests to your account beyond normal browsing, so X could rate-limit or flag it, and it can stop working whenever X changes the API. Use it at your own risk.

## Install

1. Get a TypeSafe API key from [typesafe.ai](https://typesafe.ai).
2. Clone this repo: `git clone https://github.com/kalowery/betterx.git`
3. Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click **Load unpacked**, and choose the cloned `betterx` folder.
4. Click the extension icon → **Settings…**, paste your key, click **Save key**, then **Test**.
5. Reload x.com.

To update, `git pull` and click the reload arrow on the extension's card in `chrome://extensions`.

## How it works

```
x.com page                         extension background worker          TypeSafe
content.js ── post text ─────────► background.js ── POST /v1/systemone ─► Jev
  finds posts in the page            cache + 6 concurrent requests
  applies your rules ◄── answers ───
```

- **`content.js`** finds posts in the live page (`article[data-testid="tweet"]`), extracts author, text, quoted text, and whether it's a reply, then labels or hides the post. X reuses page elements while you scroll, so everything is keyed by post ID and re-applied as the page changes.
- **`background.js`** calls Jev. The API key lives only here, in the extension's local storage, and is never exposed to x.com. Each post is classified once and cached (most recent 5,000); a post first seen cut off by "Show more" is reclassified when its full text appears.
- **`settings.js`** holds the defaults and the rule logic shared by every part of the extension.
- **`options.html/js`** is the settings page; **`popup.html/js`** shows counts, recent posts with their labels, and exports captured posts as JSON; **`dashboard.html/js`** is the feed-mood dashboard, built from compact per-post records the background worker saves in one bucket per day.

## Privacy

- Post text is sent to TypeSafe's API for classification. Nothing is sent anywhere else.
- If the account location filter is on, account handles are looked up on x.com itself, under your logged-in session.
- Captured posts and classifications stay in the browser's local extension storage until you clear them.
- Your API key is stored only in local extension storage on your machine.

## Limitations

- It depends on x.com's page structure (`data-testid` attributes). If X changes it, extraction may break.
- Posts cut off by "Show more" are classified on the visible text until you open them.
- Feed replies are detected from the "Replying to" line; on thread pages, everything below the main post counts as a reply.
- Classifications are probabilistic. Thresholds trade missed posts against false alarms, and the antisemitism question has been the least consistent in testing.

## License

[MIT](LICENSE)
