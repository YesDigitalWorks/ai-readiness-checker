# AI Readiness Checker

Fetches a web page, reads it the way an AI crawler does, and scores how well it's set up to be parsed and cited. Twenty checks, every one shown to the user with its point value.

**[Try it live](https://www.yesdigitalworks.com)** · Cloudflare Worker + embeddable widget · No dependencies

---

## Why this exists

My agency site had an "AI Presence Checker" on it. Enter a URL, get a visibility score out of 100, get suggestions. It had been live for months.

This was the scoring engine:

```js
const score = Math.floor(Math.random() * 41) + 60;
```

A random integer between 60 and 100. The URL was never fetched. The suggestions were a hardcoded string, identical for every site. I caught it when google.com scored 85 and a local masonry client scored 87.

I sell AI visibility services. A tool on my own site that invented numbers was a liability, not a lead magnet. So I rebuilt it.

## What it does now

| Category | Points | What it reads |
|---|---|---|
| Crawler access | 25 | robots.txt rules for OAI-SearchBot, ClaudeBot, PerplexityBot and others; sitemap discoverability |
| Machine-readable content | 30 | Server-rendered word count, heading structure, question-shaped headings, redirect depth |
| Structured data | 25 | JSON-LD blocks, entity and content types, freshness dates |
| Technical hygiene | 20 | HTTPS, title, meta description, canonical, language, Open Graph |

Every check is displayed with the points it earned and why. The number is auditable instead of a black box — which matters, because the whole failure mode of the original was asking people to trust a number that had nothing behind it.

**It does not measure AI visibility.** Whether ChatGPT or Perplexity actually mentions you can only be determined by running live prompts against those models and counting citations. That's a different tool with real per-query cost. The results panel says so explicitly rather than blurring the two, because the blur is where most tools in this category lose their credibility.

## Three decisions worth explaining

**Latency is measured but not scored.** The first version awarded 4 points on a sliding scale for server response time. Then scores started drifting — the same page returning 65, then 63, seconds apart with nothing changed. Retries on flaky sub-fetches fixed part of it. The rest was my own design error: network latency varies by hundreds of milliseconds every request, so any site near a threshold would flip forever. I'd built a variable input into a rubric that promised determinism. Response time is now reported as an observation and worth zero points. A less complete score that's always the same beats a richer one that can't be defended when someone runs it twice.

**`llms.txt` is detected and scored at zero.** It's the fashionable file in this space right now. No major AI provider has confirmed acting on it, server logs suggest the crawlers don't request it, and at least one study found it made citation prediction *less* accurate. The tool reports whether it's present and states plainly why it isn't counted.

**Question detection isn't just looking for "?".** The first version only counted headings containing a literal question mark. Then a well-known SEO practitioner's site scored 0/5 on it. When someone whose entire business is this fails your check, suspect the check. Headings now count if they open with an interrogative — "How Tuckpointing Works" is answer-shaped whether or not it carries a question mark. A test asserts that plain topic headings like "Our Services" still score zero, so the fix didn't just make everyone pass.

## Determinism

The core promise is that an unchanged page returns an identical score. That required more work than expected:

- Supporting files retry up to three times with backoff. A transient fetch failure used to be indistinguishable from "file absent," which silently moved the score.
- When robots.txt genuinely can't be read, the tool says so and flags the score as incomplete rather than guessing.
- No scored check takes a varying input.
- Results cache per URL for 15 minutes.

Verified by running the same live site ten times consecutively with caching bypassed — identical every time, category by category.

## Tests

```bash
node test.mjs   # 56 passing
```

Covers robots.txt group precedence (an agent's own group overrides the `*` group — the case most naive parsers get backwards), JSON-LD `@graph` walking, malformed JSON counted as broken rather than valid, word counting with script contents excluded, and invariants: no check exceeds its own maximum, categories sum to 100, and a sweep of response times from 50ms to 12 seconds that asserts the score never moves.

## Architecture

The site runs on a builder platform with no server-side execution, so the backend is a Cloudflare Worker on the free tier and the frontend is a self-contained HTML/CSS/JS block embedded in the page. DNS stays where it was.

- `worker.js` — fetching, parsing and scoring. No DOM in Workers, so parsing is string-based.
- `widget.html` — the embeddable UI. No frameworks, no build step.
- `test.mjs` — unit tests for the parsing and scoring logic.

Known limits: one page per run, not the whole site. SSRF protection is hostname-based since Workers can't resolve DNS directly. Score bands are my judgement — there's no industry-standard AI-readiness scale to calibrate against.

## Attribution

I specified this tool, made every call about what to measure and what refuses to be measured, caught the score drift from live behavior, and drove each diagnosis. The implementation was written with heavy AI assistance — I'd rather say that plainly than have someone assume otherwise.

The part I'd want judged is the product reasoning: recognizing that a lead-gen tool built on a random number was a credibility problem, deciding that determinism mattered more than a richer rubric, and refusing to score the trendy file that has no evidence behind it.

## License

MIT
