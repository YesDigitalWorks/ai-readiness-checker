import assert from 'node:assert';
import {
  parseRobots, agentBlocked, getTitle, getMetaContent, getCanonical,
  getHeadings, getJsonLd, visibleWordCount, hasTimeElement, scorePage,
} from './worker.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('\n--- robots.txt parsing ---');

t('blanket disallow is detected', () => {
  const g = parseRobots('User-agent: *\nDisallow: /');
  assert.strictEqual(agentBlocked(g, '*'), true);
  assert.strictEqual(agentBlocked(g, 'GPTBot'), true);
});

t('empty disallow means allowed', () => {
  const g = parseRobots('User-agent: *\nDisallow:');
  assert.strictEqual(agentBlocked(g, '*'), false);
});

t('agent-specific block does not leak to other agents', () => {
  const g = parseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /');
  assert.strictEqual(agentBlocked(g, 'GPTBot'), true);
  assert.strictEqual(agentBlocked(g, 'PerplexityBot'), false);
});

t('own group overrides the * group', () => {
  // PerplexityBot has its own permissive group, so the * block must not apply.
  const g = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow:');
  assert.strictEqual(agentBlocked(g, 'PerplexityBot'), false);
  assert.strictEqual(agentBlocked(g, 'GPTBot'), true);
});

t('Crawl-delay does not end a group', () => {
  const g = parseRobots('User-agent: GPTBot\nCrawl-delay: 10\nDisallow: /');
  assert.strictEqual(agentBlocked(g, 'GPTBot'), true);
});

t('Sitemap line does not end a group', () => {
  const g = parseRobots('User-agent: *\nSitemap: https://x.com/sitemap.xml\nDisallow: /');
  assert.strictEqual(agentBlocked(g, '*'), true);
});

t('stacked user-agents share one rule block', () => {
  const g = parseRobots('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /');
  assert.strictEqual(agentBlocked(g, 'GPTBot'), true);
  assert.strictEqual(agentBlocked(g, 'ClaudeBot'), true);
});

t('comments are stripped', () => {
  const g = parseRobots('# block everything\nUser-agent: *\nDisallow: / # yes really');
  assert.strictEqual(agentBlocked(g, '*'), true);
});

t('case insensitive agent match', () => {
  const g = parseRobots('user-agent: gptbot\ndisallow: /');
  assert.strictEqual(agentBlocked(g, 'GPTBot'), true);
});

t('partial-path disallow is not a sitewide block', () => {
  const g = parseRobots('User-agent: *\nDisallow: /admin/');
  assert.strictEqual(agentBlocked(g, '*'), false);
});

console.log('\n--- head parsing ---');

t('title extracted and collapsed', () => {
  assert.strictEqual(getTitle('<html><head><title>  Moe&#39;s\n  Masonry </title>'), "Moe's Masonry");
});

t('meta description, single-quoted attrs', () => {
  const h = `<meta name='description' content='Brick and stone work'>`;
  assert.strictEqual(getMetaContent(h, 'description'), 'Brick and stone work');
});

t('meta description ignores og:description', () => {
  const h = `<meta property="og:description" content="OG"><meta name="description" content="Real">`;
  assert.strictEqual(getMetaContent(h, 'description'), 'Real');
});

t('canonical found in multi-value rel', () => {
  assert.strictEqual(getCanonical('<link rel="shortlink canonical" href="https://a.com/">'), 'https://a.com/');
});

t('no canonical returns empty', () => {
  assert.strictEqual(getCanonical('<link rel="stylesheet" href="/a.css">'), '');
});

console.log('\n--- headings ---');

t('counts levels and question headings', () => {
  const h = `<h1>Masonry</h1><h2>How much does tuckpointing cost?</h2>
             <h2>Areas served</h2><h3>Do you offer free estimates?</h3>`;
  const r = getHeadings(h);
  assert.strictEqual(r.h1, 1);
  assert.strictEqual(r.h2, 2);
  assert.strictEqual(r.h3, 1);
  assert.strictEqual(r.question, 2);
});

t('heading with nested markup still reads as text', () => {
  const r = getHeadings('<h2 class="x"><span>Is this <b>covered</b>?</span></h2>');
  assert.strictEqual(r.question, 1);
});

t('multiple H1 counted', () => {
  assert.strictEqual(getHeadings('<h1>A</h1><h1>B</h1>').h1, 2);
});

console.log('\n--- JSON-LD ---');

t('simple block, types collected', () => {
  const h = `<script type="application/ld+json">{"@type":"LocalBusiness","name":"Moe"}</script>`;
  const r = getJsonLd(h);
  assert.strictEqual(r.blocks, 1);
  assert.ok(r.types.includes('LocalBusiness'));
});

t('@graph is walked', () => {
  const h = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":"FAQPage"}]}
  </script>`;
  const r = getJsonLd(h);
  assert.ok(r.types.includes('Organization'));
  assert.ok(r.types.includes('FAQPage'));
});

t('array @type handled', () => {
  const h = `<script type="application/ld+json">{"@type":["Organization","LocalBusiness"]}</script>`;
  assert.strictEqual(getJsonLd(h).types.length, 2);
});

t('dates detected at depth', () => {
  const h = `<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person"},"dateModified":"2026-01-01"}</script>`;
  assert.strictEqual(getJsonLd(h).hasDate, true);
});

t('malformed JSON counted as broken, not valid', () => {
  const h = `<script type="application/ld+json">{"@type":"Organization",}</script>`;
  const r = getJsonLd(h);
  assert.strictEqual(r.blocks, 0);
  assert.strictEqual(r.broken, 1);
});

t('ordinary script tags ignored', () => {
  const h = `<script>var x = {"@type":"Organization"};</script>`;
  assert.strictEqual(getJsonLd(h).blocks, 0);
});

t('type with charset suffix still matches', () => {
  const h = `<script type="application/ld+json; charset=utf-8">{"@type":"Service"}</script>`;
  assert.strictEqual(getJsonLd(h).blocks, 1);
});

console.log('\n--- word count ---');

t('script and style contents excluded', () => {
  const h = `<html><head><style>body{color:red}</style></head><body>
    <script>var a = "alpha beta gamma delta epsilon";</script>
    <p>One two three four five</p></body></html>`;
  assert.strictEqual(visibleWordCount(h), 5);
});

t('SPA shell scores near zero', () => {
  const h = `<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
  assert.ok(visibleWordCount(h) < 5, 'got ' + visibleWordCount(h));
});

t('head content not counted when body present', () => {
  const h = `<html><head><title>Ignore these words</title></head><body><p>a b c</p></body></html>`;
  assert.strictEqual(visibleWordCount(h), 3);
});

t('comments excluded', () => {
  assert.strictEqual(visibleWordCount('<body><!-- hidden words here --><p>a b</p></body>'), 2);
});

t('time element detected', () => {
  assert.strictEqual(hasTimeElement('<time datetime="2026-01-01">Jan</time>'), true);
  assert.strictEqual(hasTimeElement('<time>Jan</time>'), false);
});

console.log('\n--- end-to-end scoring ---');

const goodHtml = `<!doctype html><html><head>
<title>Tuckpointing and Brick Repair in St. Louis</title>
<meta name="description" content="Moe's Masonry handles tuckpointing, chimney rebuilds and basement waterproofing across the St. Louis metro area with free estimates.">
<link rel="canonical" href="https://example.com/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"LocalBusiness","name":"Moe's Masonry"},
 {"@type":"FAQPage"},
 {"@type":"Article","dateModified":"2026-05-01"}]}</script>
</head><body>
<h1>Tuckpointing and brick repair</h1>
<h2>What does tuckpointing cost?</h2><p>${'word '.repeat(300)}</p>
<h2>How long does a chimney rebuild take?</h2><p>${'word '.repeat(300)}</p>
<h3>Do you offer free estimates?</h3><p>${'word '.repeat(300)}</p>
<h3>Areas served</h3><h2>Contact</h2><h3>Warranty</h3>
</body></html>`;

t('well-built page scores high', () => {
  const r = scorePage({
    html: goodHtml, startUrl: 'https://example.com', finalUrl: 'https://example.com',
    hops: 0, ms: 400, robotsTxt: 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml',
    sitemapLive: true, llmsLive: false,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.max, 100);
  assert.ok(r.score >= 95, 'expected >=95, got ' + r.score);
  assert.strictEqual(r.band, 'Strong');
});

t('JS-only page blocked in robots scores very low', () => {
  const r = scorePage({
    html: '<html><head><title>App</title></head><body><div id="root"></div><script src="/b.js"></script></body></html>',
    startUrl: 'https://example.com', finalUrl: 'http://example.com',
    hops: 4, ms: 4000, robotsTxt: 'User-agent: *\nDisallow: /',
    sitemapLive: false, llmsLive: false,
  });
  assert.ok(r.score <= 12, 'expected <=12, got ' + r.score);
  assert.strictEqual(r.band, 'Not readable by AI systems');
});

t('score is deterministic across runs', () => {
  const args = {
    html: goodHtml, startUrl: 'https://example.com', finalUrl: 'https://example.com',
    hops: 0, ms: 400, robotsTxt: '', sitemapLive: false, llmsLive: false,
  };
  const a = scorePage(args).score, b = scorePage(args).score, c = scorePage(args).score;
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

t('two different pages produce different advice', () => {
  const r1 = scorePage({
    html: goodHtml, startUrl: 'https://a.com', finalUrl: 'https://a.com',
    hops: 0, ms: 300, robotsTxt: 'User-agent: *\nDisallow:\nSitemap: https://a.com/s.xml',
    sitemapLive: true, llmsLive: false,
  });
  const r2 = scorePage({
    html: '<html><body><h1>a</h1><h1>b</h1><p>short</p></body></html>',
    startUrl: 'https://b.com', finalUrl: 'https://b.com',
    hops: 2, ms: 2500, robotsTxt: null, sitemapLive: false, llmsLive: false,
  });
  const p1 = r1.priorities.map((p) => p.title).join('|');
  const p2 = r2.priorities.map((p) => p.title).join('|');
  assert.notStrictEqual(p1, p2);
  assert.notStrictEqual(r1.score, r2.score);
});

t('category maxima add to 100', () => {
  const r = scorePage({
    html: goodHtml, startUrl: 'https://a.com', finalUrl: 'https://a.com',
    hops: 0, ms: 300, robotsTxt: null, sitemapLive: false, llmsLive: false,
  });
  assert.deepStrictEqual(r.categories.map((c) => c.max), [25, 30, 25, 20]);
  assert.strictEqual(r.categories.reduce((a, c) => a + c.max, 0), 100);
});

t('every category score equals the sum of its checks', () => {
  const r = scorePage({
    html: goodHtml, startUrl: 'https://a.com', finalUrl: 'https://a.com',
    hops: 1, ms: 1000, robotsTxt: 'User-agent: GPTBot\nDisallow: /', sitemapLive: false, llmsLive: false,
  });
  for (const c of r.categories) {
    assert.strictEqual(c.score, c.checks.reduce((a, k) => a + k.points, 0), c.name);
    assert.ok(c.score <= c.max, c.name + ' exceeded max');
  }
});

t('no check can exceed its own max or go negative', () => {
  const r = scorePage({
    html: goodHtml, startUrl: 'https://a.com', finalUrl: 'https://a.com',
    hops: 9, ms: 99999, robotsTxt: 'User-agent: *\nDisallow: /', sitemapLive: false, llmsLive: false,
  });
  for (const c of r.categories) {
    for (const k of c.checks) {
      assert.ok(k.points >= 0 && k.points <= k.max, k.label + ' = ' + k.points + '/' + k.max);
    }
  }
});

t('empty response is rejected, not scored', () => {
  const r = scorePage({ html: '   ', startUrl: 'https://a.com', finalUrl: 'https://a.com', hops: 0, ms: 100, robotsTxt: null });
  assert.strictEqual(r.ok, false);
});

t('llms.txt is reported but worth zero points', () => {
  const base = {
    html: goodHtml, startUrl: 'https://a.com', finalUrl: 'https://a.com',
    hops: 0, ms: 300, robotsTxt: null, sitemapLive: false,
  };
  const without = scorePage({ ...base, llmsLive: false });
  const with_ = scorePage({ ...base, llmsLive: true });
  assert.strictEqual(without.score, with_.score);
  assert.strictEqual(with_.notes.length, without.notes.length + 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
