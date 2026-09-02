# Image Resizer for Claude Code

A tiny, static, client-side tool that resizes oversized images and copies them to your clipboard — so you stop losing AI chat sessions to the "image too large" error.

Drop, paste (`⌘V` / `Ctrl+V`), or click → if the image is wider than the threshold, it's resized → result is on your clipboard, ready to paste into Claude Code, ChatGPT, Cursor, or anywhere else.

> Works with **Claude Code**, **ChatGPT**, **Cursor**, **Gemini**, and any other web AI chat. **Not affiliated with Anthropic** — this is an independent community tool.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yawalkar/image-resizer-for-claude-code)

## Why this exists

If you take a screenshot on a Retina (or any HiDPI) Mac, the *file* is twice the resolution of what your eyes see. A "1700px-looking" screenshot of your editor is actually **3400px wide** on disk. Most AI chat tools start choking around **2000px** wide, and tools like Claude Code often **terminate the session** when an oversized image lands in the conversation — losing your in-progress work with no way to recover it.

The usual screenshot tools (macOS Screenshot, Zight/CloudApp, etc.) don't expose a "cap to N pixels" setting. So you either:

- Open every screenshot in Preview and resize manually before pasting (slow, easy to forget), or
- Lose hours of conversation when one file slips through (painful, happens often).

This tool is a one-step intercept: drop the image into the page, and a properly-sized copy ends up on your clipboard automatically. Paste with `⌘V` and carry on.

## What it does

- Reads dropped / pasted / picked images directly in the browser
- If `max(width, height) > trigger` → re-renders so the **longest side** equals `target` via Canvas (aspect ratio preserved, lossless PNG). The API rejects images where *either* dimension exceeds the cap, so checking just width isn't enough — tall portrait screenshots break sessions too.
- If both sides are within `trigger` → passes through untouched
- Writes the result to your system clipboard via the [Clipboard API][clipboard]
- Keeps the last 3 results visible as thumbnails — click any to re-copy

**100% client-side.** Image bytes never leave your browser tab. The Cloudflare Worker only serves the static HTML/CSS/JS — no image is ever uploaded, logged, or stored. Verify it yourself in [`public/script.js`](public/script.js) (no `fetch()` calls, no upload code).

## Deploy your own (60 seconds, free)

This is a single-file static site served by a Cloudflare Worker on the free plan (100,000 requests/day — plenty for a personal tool).

```bash
git clone https://github.com/yawalkar/image-resizer-for-claude-code
cd image-resizer-for-claude-code
npx wrangler login    # one-time, opens browser
npx wrangler deploy
```

Wrangler prints your URL (e.g. `https://image-resizer.<your-subdomain>.workers.dev`). Bookmark it. Done.

To run locally without deploying:

```bash
npx wrangler dev
```

## Configure thresholds

Defaults are conservative for the Claude Code use case — resize anything with a side over **1950px** down so the longest side is **1800px**. Override per-bookmark via URL params:

| Param     | Default | Meaning                                                                |
| --------- | ------- | ---------------------------------------------------------------------- |
| `trigger` | `1950`  | Resize when *either* width or height is greater than this (in pixels)  |
| `target`  | `1800`  | Resize so the longest side equals this; the other side scales to match |

Examples:

```
?trigger=2000&target=1600     # bigger trigger, smaller target
?trigger=1200&target=1200     # cap everything at 1200px exactly
```

`target` is automatically clamped to `≤ trigger`, and both are clamped to `[200, 8000]`.

## How resizing works

```
File / Paste / Drop
     ↓
createImageBitmap()  ← decode in the browser
     ↓
max(width, height) > trigger?
     ├─ yes → ratio = target / max(w,h); Canvas drawImage at (w*ratio, h*ratio) → toBlob('image/png')
     └─ no  → use original blob untouched
     ↓
navigator.clipboard.write([new ClipboardItem({ [type]: blob })])
     ↓
⌘V into your AI chat
```

## Caveats

- **Animated GIFs** lose animation when resized — Canvas flattens to a still frame. Not a concern for screenshots.
- **Clipboard write** requires a recent browser ([`ClipboardItem`][clipboarditem] support: Chrome 76+, Edge, Brave, Firefox 127+, Safari 13.4+) and HTTPS or `localhost`. If your browser blocks the write, a manual **Copy** button appears next to the result.
- **Mobile pasting** of images into chat apps varies wildly by platform — this tool targets desktop browsers.
- **Workaround, not a fix.** If Claude Code (or whoever's app you're using) ships a built-in max-image-dimension setting, this tool becomes redundant — and that's fine.

## Tech

- Pure HTML + CSS + JS, zero runtime dependencies
- Hosted via [Cloudflare Workers Static Assets][cf-assets] — no build step
- Wrangler for deploy

## License

[MIT](LICENSE)

[clipboard]: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
[clipboarditem]: https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem
[cf-assets]: https://developers.cloudflare.com/workers/static-assets/
