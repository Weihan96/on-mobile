# Codex Mobile Markdown Rendering

Use this reference when the user is reading Codex output on a phone and the answer depends on how Markdown appears inside the Codex mobile conversation UI.

## Observed Renderer Shape

Codex mobile behaves like a safe Markdown subset plus Codex/ChatGPT product-native components. It is not a full GitHub Markdown renderer and does not preserve arbitrary HTML interaction.

## Support Matrix

| Content type | Observed result | Recommendation |
|---|---|---|
| Plain paragraphs | Supported | Safe for normal explanations. |
| Bold text | Supported | Safe for emphasis. |
| Code blocks | Supported, with copy UI | Use for literal commands, snippets, or syntax tests. |
| Fenced `svg` code blocks | Rendered with an SVG preview above the copyable source | Useful for small inline visual probes or generated SVG assets. Use a `svg` fence instead of raw inline SVG. |
| Fenced `xml` code blocks with a namespace-qualified SVG root | Rendered with an SVG preview above the copyable source in testing | Prefer `svg` for clarity. In follow-up testing, plain XML, non-namespaced SVG in an `xml` fence, nested SVG, and SVG-like non-SVG XML did not preview; only `<svg xmlns="http://www.w3.org/2000/svg" ...>` did. |
| Raw inline `<svg>` outside a code block | Did not render as an SVG preview in testing | Do not rely on raw SVG in normal Markdown text for Codex mobile. |
| SVG inside untyped or `html` fenced code blocks | Did not render as an SVG preview in testing | Use a `svg` fence when the desired result is an SVG preview. Use `xml` only when testing XML-fenced namespaced SVG behavior. |
| SVG preview inside blockquotes and GitHub callout-style blockquotes | Rendered; GitHub callout syntax still degraded to a normal blockquote | Safe for compact notes, but do not rely on callout title/icon/color rendering. |
| SVG preview adjacent to Markdown tables or links | Rendered, and surrounding tables/links remained usable | Safe for compact comparison sections and mobile-readable visual evidence. |
| SVG preview inside list items | Preview rendered but list structure became unreliable in testing | Avoid nesting SVG previews inside ordered or unordered lists. Put the preview between list items or outside the list. |
| SVG preview inside HTML `<details>` | Preview rendered, but no details folding UI was visible | Do not rely on collapsible behavior even when the inner SVG preview appears. |
| SVG `<animate>` inside preview | Rendered statically; animation did not run in testing | Treat Codex mobile SVG previews as static images. |
| Markdown inside code blocks | Not interpreted | Do not put syntax being tested inside fenced code blocks. |
| Normal blockquotes | Supported with a left rule | Safe for compact notes or callout-like visual grouping. |
| GitHub callouts such as `> [!NOTE]` | Degrades to normal blockquote with the marker visible | Do not rely on callout title, icon, or color rendering. |
| Markdown links | Supported and clickable | Prefer normal links for phone-accessible destinations. |
| Links inside blockquotes | Supported and clickable | Safe when a quote needs a link. |
| Bare URLs | Auto-linkified | Useful as a fallback, but prefer named links for readability. |
| Query/hash URLs | Supported | Keep clickable URLs in Markdown links when punctuation follows. |
| `mailto:` and `tel:` links | Appeared link-like in testing, system action unverified | Use only when the action is acceptable if the phone opens a mail or phone app. |
| Markdown tables | Supported | Good for compact comparison and status summaries. |
| Remote URL Markdown images such as `![x](https://...)` | Not visibly rendered in Codex mobile testing, but the same URL works as a clickable link | Do not rely on remote Markdown image rendering; provide a normal link or rendered preview. |
| Local absolute-path Markdown images such as `![x](/tmp/file.png)` | Rendered inline when the file exists on the Codex host | Useful for generated screenshots or local evidence, but include a normal link if the image matters. |
| Local image links such as `[open](/tmp/file.png)` | Rendered as a clickable link and may show a product file preview card | Good fallback for local screenshots/artifacts. |
| Markdown images inside blockquotes | Remote behavior unproven/unsafe; local path behavior should not be assumed unless tested | Keep images outside blockquotes for clearer mobile rendering. |
| HTML `<details>` / `<summary>` | Degrades to visible text/content without fold interaction | Do not rely on collapsible sections. |
| Product-native actions such as open thread or approvals | Supported when emitted by the Codex product layer | These cannot be created by arbitrary Markdown or HTML. |

## Writing Guidance

- Prefer tables, normal links, blockquotes, and code blocks for mobile-readable structure.
- For small SVG visuals in the conversation, prefer a fenced `svg` code block. It can show a preview while preserving copyable source.
- Keep SVG previews out of list items because nested previews can break list structure on Codex mobile.
- Use normal blockquotes as lightweight callouts, but label them in prose instead of GitHub callout markers.
- Distinguish remote image URLs from local Codex-host file paths: remote `![alt](https://...)` images may not render inline, while local `![alt](/tmp/file.png)` images can render when Codex can access the file.
- For images or visual evidence, provide a normal clickable link, an attached artifact, or a rendered HTML page exposed through the mobile preview/ngrok flow.
- When sending local screenshots or generated visual evidence, use both a local Markdown image and a normal file link if the user needs a reliable fallback.
- For long Markdown documents, render the file through the skill's Markdown preview workflow instead of relying on raw source or conversation Markdown.
- If testing renderer behavior, place the target Markdown syntax directly in the message body. Do not wrap it in a code block unless the goal is to test code-block display.

## Evidence

This matrix comes from live Codex mobile screenshots collected during a renderer probe:

- GitHub callouts rendered as normal blockquotes, with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, and `[!CAUTION]` visible as text.
- A normal blockquote rendered with a gray left rule.
- HTML `<details>` content appeared expanded as ordinary text, without a fold control.
- Normal links, blockquote links, bare URLs, query/hash links, and tables rendered successfully.
- A remote HTTPS PNG referenced as `![REMOTE IMAGE OK](https://placehold.co/...)` did not render inline in Codex mobile, while the same URL worked as a clickable link.
- A local downloaded PNG referenced as `![LOCAL IMAGE OK](/tmp/codex-mobile-local-image-test.png)` rendered inline in Codex mobile; the same local file linked as `[open](/tmp/...)` also opened and appeared as a file preview card.
- Raw inline `<svg>` did not render as a preview, while fenced `svg` code blocks rendered a preview plus source. Untyped and `html` fenced code blocks did not trigger the SVG preview.
- In `xml` fences, plain XML, XML declaration plus non-namespaced SVG, XML comment plus non-namespaced SVG, nested SVG, and SVG-like non-SVG XML did not preview. A namespace-qualified SVG root such as `<svg xmlns="http://www.w3.org/2000/svg" ...>` did preview.
- Fenced `svg` previews supported basic shapes, paths, text including Chinese, and linear gradients. SVG `<animate>` rendered statically rather than animating.
- Fenced `svg` previews rendered inside normal blockquotes, GitHub callout-style blockquotes, and HTML `<details>` content; they rendered adjacent to tables and links; list-item nesting rendered the preview but made list structure unreliable.
