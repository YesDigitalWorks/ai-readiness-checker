# AI Readiness Checker

Fetches a web page, reads it the way an AI crawler does, and scores how well it's set up to be parsed and cited. Twenty checks, every one shown to the user with its point value.

**[Try it live](https://www.yesdigitalworks.com/digital-marketing-terms---concepts)** · Cloudflare Worker + embeddable widget · No dependencies

---

## Why I built it

I run an SEO and AI-visibility agency. The lead-gen tool on my site was supposed to score how well a page was set up for AI search. It wasn't measuring anything — the score was generated, not calculated, and every site got the same list of suggestions.

I found it by testing sites where I already knew the answer. Google scored 85. A local masonry client scored 87. Those numbers should not have been close.

So I rebuilt it as something that actually fetches the page and shows its work.

## What it does

| Category | Points | What it reads |
|---|---|---|
| Crawler access | 25 | robots.txt rules for OAI-SearchBot, ClaudeBot, PerplexityBot and others; sitemap discoverability |
| Machine-readable content | 30 | Server-rendered word count, heading structure, question-shaped headings, redirect depth |
| Structured data | 25 | JSON-LD blocks, entity and content types, freshness dates |
| Technical hygiene | 20 | HTTPS, title, meta description, canonical, language, Open Graph |

Every check displays the points it earned and why. The number is auditable instead of a black box.

**It does not measure AI visibility.** Whether ChatGPT or Perplexity actually mentions you can only be found by running live prompts against those models and counting citations. That's a different tool with real per-query cost. The results panel says so directly. Most tools in this category blur that line, and I think blurring it is why people stop trusting them.

## Three calls I made

**Latency is measured but not scored.** The first version gave up to 4 points for server response time. Then the same page started returning 65, then 63, seconds apart with nothing changed. Network latency swings by hundreds of milliseconds every request, so any site near a threshold would flip forever. I'd put a variable input inside a score that promised to be repeatable. Response time is now reported and worth zero points. A smaller score that's always the same beats a richer one you can't defend when a prospect runs it twice.

**`llms.txt` is detected and scored at zero.** It's the fashionable file in this space. No major AI provider has confirmed they act on it, server logs suggest the crawlers don't even request it, and one study found it made citation prediction less accurate. The tool reports whether it's there and says plainly why it isn't counted.

**Question detection isn't just looking for "?".** The first version only counted headings containing a literal question mark. Then a well-known SEO practitioner's site scored 0 on it. When someone whose whole business is this fails your check, suspect the check. Headings now count if they open with an interrogative — "How Tuckpointing Works" is answer-shaped with or without the punctuation. A test confirms plain headings like "Our Services" still score zero, so the fix didn't just make everyone pass.

## Repeatability

The core promise is that an unchanged page returns the same score. That took more work than I expected.

- Supporting files retry up to three times with backoff. A failed fetch used to look identical to "file absent," which silently moved the score.
- When robots.txt genuinely can't be read, the tool says so and flags the score as incomplete instead of guessing.
- No scored check takes a varying input.
- Results cache per URL for 15 minutes.

Checked by running the same live site ten times in a row with caching bypassed. Identical every time, category by category.

## Tests

```bash
npm test        # or: node test.mjs
```

56 passing. Covers robots.txt group precedence (an agent's own group overrides the `*` group — the case most simple parsers get backwards), JSON-LD `@graph` walking, malformed JSON counted as broken rather than valid, word counting with script contents excluded, and invariants: no check exceeds its maximum, categories sum to 100, and a sweep of response times from 50ms to 12 seconds confirming the score never moves.

## Architecture

My site runs on a builder platform with no server-side execution, so the backend is a Cloudflare Worker on the free tier and the frontend is a self-contained HTML/CSS/JS block embedded in the page. DNS stayed where it was.

- `worker.js` — fetching, parsing, scoring. No DOM in Workers, so parsing is string-based.
- `widget.html` — the embeddable UI. No frameworks, no build step.
- `test.mjs` — unit tests for the parsing and scoring logic.

Known limits: one page per run, not the whole site. SSRF protection is hostname-based, since Workers can't resolve DNS directly. The score bands are my judgement — there's no industry-standard AI-readiness scale to calibrate against.

## How I built it

I'm a marketer, not a programmer, and I built this with AI assistance. I'm saying that up front because I'd rather be clear than have someone assume otherwise.

What I did: defined what the tool should measure and what it should refuse to measure, specified the checks and their weights, tested it against real client sites, caught the scoring drift from live behavior, and worked through each diagnosis until it was fixed.

The decisions I'd want judged are in the section above — deciding repeatability mattered more than a richer rubric, refusing to score the trendy file that has no evidence behind it, and treating a well-known site failing a check as a reason to question the check.

## License

MIT
