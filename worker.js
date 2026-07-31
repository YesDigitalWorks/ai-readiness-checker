/**
 * AI Readiness Checker — Cloudflare Worker
 * Yes Digital Works
 *
 * Replaces ai-check.php. IONOS MyWebsite Creator has no webspace and no PHP,
 * so the backend lives on Cloudflare's free Workers tier instead. Your domain
 * and DNS stay at IONOS — the widget just calls this Worker's URL.
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create Worker ->
 *         Edit code -> paste this whole file -> Deploy.
 */

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  'https://www.yesdigitalworks.com',
  'https://yesdigitalworks.com',
];
const FETCH_TIMEOUT_MS = 12000;
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const UA = 'YDW-AI-Readiness-Checker/1.0 (+https://www.yesdigitalworks.com)';

const AI_BOTS = [
  'OAI-SearchBot', 'ChatGPT-User', 'GPTBot',
  'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Google-Extended',
];

// ===========================================================================
// Worker entry point
// ===========================================================================
const CACHE_SECONDS = 900; // 15 minutes

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    let target = '';
    if (request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      target = form ? String(form.get('url') || '') : '';
    } else {
      target = new URL(request.url).searchParams.get('url') || '';
    }

    const normalized = normalizeUrl(target);
    if (!normalized) {
      return json({ ok: false, error: 'Enter a full web address, like example.com' }, 400, cors);
    }

    // Serve a recent identical result rather than re-checking. Two runs a
    // minute apart should never disagree, and it spares the target site.
    const cacheKey = new Request(
      'https://ai-check.internal/v2?u=' + encodeURIComponent(normalized),
      { method: 'GET' }
    );
    let cache = null;
    try { cache = caches.default; } catch { /* cache unavailable; continue */ }

    if (cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const cached = await hit.text();
          return new Response(cached, { status: 200, headers: cors });
        }
      } catch { /* fall through to a live check */ }
    }

    try {
      const result = await runCheck(normalized);
      const body = JSON.stringify(result);

      if (cache && result.ok) {
        try {
          const store = new Response(body, {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'public, max-age=' + CACHE_SECONDS,
            },
          });
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(cache.put(cacheKey, store));
          } else {
            await cache.put(cacheKey, store);
          }
        } catch { /* caching is best-effort */ }
      }

      return new Response(body, { status: result.ok ? 200 : 400, headers: cors });
    } catch (err) {
      return json({ ok: false, error: 'Could not read that page: ' + String(err && err.message || err) }, 502, cors);
    }
  },
};

function corsHeaders(origin) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Vary'] = 'Origin';
  }
  return h;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// ===========================================================================
// Orchestration
// ===========================================================================
/**
 * Supporting files (robots.txt, sitemap.xml, llms.txt) are fetched alongside
 * the page, and some hosts throttle that burst. A transient failure used to be
 * indistinguishable from "file absent", which quietly moved the score between
 * runs. Retry on network-level failures; an HTTP status is a real answer.
 */
async function fetchWithRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fetchFollowing(url, true);
    if (last.ok || last.status >= 400) return last;   // definitive answer
    if (i < attempts - 1) await sleep(200 * (i + 1)); // back off, then retry
  }
  return last;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCheck(startUrl) {
  const page = await fetchFollowing(startUrl);
  if (!page.ok) return { ok: false, error: page.error };

  const finalUrl = page.url;
  const u = new URL(finalUrl);
  const root = u.origin;

  const [robots, sitemap, llms] = await Promise.all([
    fetchWithRetry(root + '/robots.txt'),
    fetchWithRetry(root + '/sitemap.xml'),
    fetchWithRetry(root + '/llms.txt'),
  ]);

  const result = scorePage({
    html: page.body,
    startUrl,
    finalUrl,
    hops: page.hops,
    ms: page.ms,
    robotsTxt: robots.ok ? robots.body : null,
    // Did we get a real answer about robots.txt, or did the fetch just fail?
    robotsResolved: robots.ok || robots.status >= 400,
    sitemapLive: sitemap.ok && sitemap.status === 200,
    llmsLive: llms.ok && llms.status === 200,
  });

  return result;
}

// ===========================================================================
// Fetching
// ===========================================================================
function normalizeUrl(raw) {
  let s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;

  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (isBlockedHost(host)) return null;

  return u.toString();
}

/**
 * Workers run on the edge with no internal network behind them, so the SSRF
 * surface is far smaller than on shared hosting. This still blocks the obvious
 * targets: loopback, link-local, cloud metadata, and private IP literals.
 */
function isBlockedHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;          // link-local + metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true;                         // multicast / reserved
  }
  return false;
}

async function fetchFollowing(url, quiet = false) {
  let current = url;
  let hops = 0;
  const t0 = Date.now();

  while (hops <= MAX_REDIRECTS) {
    let host;
    try { host = new URL(current).hostname.toLowerCase(); } catch { break; }
    if (isBlockedHost(host)) {
      return { ok: false, error: quiet ? '' : 'That address is not a public website.', status: 0, body: '', url: current, hops, ms: Date.now() - t0 };
    }

    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,text/plain,*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, error: quiet ? '' : 'Could not reach that site. Check the address and that it is online.', status: 0, body: '', url: current, hops, ms: Date.now() - t0 };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc) break;
      try { current = new URL(loc, current).toString(); } catch { break; }
      hops++;
      continue;
    }

    const ms = Date.now() - t0;

    if (res.status >= 400) {
      return { ok: false, error: quiet ? '' : `That page returned HTTP ${res.status}.`, status: res.status, body: '', url: current, hops, ms };
    }

    const len = Number(res.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) {
      return { ok: false, error: quiet ? '' : 'That page is too large to analyse.', status: res.status, body: '', url: current, hops, ms };
    }

    let body = await res.text();
    if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES);

    return { ok: true, error: '', status: res.status, body, url: current, hops, ms };
  }

  return { ok: false, error: quiet ? '' : 'Too many redirects.', status: 0, body: '', url: current, hops, ms: Date.now() - t0 };
}

// ===========================================================================
// Parsing — plain string work, no DOM available in Workers
// ===========================================================================
const RE = {
  comment: /<!--[\s\S]*?-->/g,
  script: /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  style: /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  noscript: /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi,
  svg: /<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi,
  template: /<template\b[^>]*>[\s\S]*?<\/template\s*>/gi,
  head: /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi,
  tag: /<[^>]+>/g,
};

export function parseAttrs(tagText) {
  const out = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  let first = true;
  while ((m = re.exec(tagText)) !== null) {
    if (first) { first = false; continue; }   // skip the tag name itself
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    out[m[1].toLowerCase()] = val;
  }
  return out;
}

export function getTitle(html) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function getMetaContent(html, name) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = parseAttrs(m[0]);
    if ((a.name || '').toLowerCase() === name.toLowerCase()) {
      return decodeEntities(a.content || '').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

export function getMetaProperty(html, prop) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = parseAttrs(m[0]);
    if ((a.property || '').toLowerCase() === prop.toLowerCase()) {
      return decodeEntities(a.content || '').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

export function getHtmlLang(html) {
  const m = html.match(/<html\b[^>]*>/i);
  if (!m) return '';
  return (parseAttrs(m[0]).lang || '').trim();
}

export function getCanonical(html) {
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = parseAttrs(m[0]);
    const rel = (a.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical')) return (a.href || '').trim();
  }
  return '';
}

// Headings that open with an interrogative are answer-shaped spans even when
// they carry no literal "?" — "How Tuckpointing Works" is a question heading.
const INTERROGATIVE = /^(how|what|why|when|where|which|who|whom|whose|can|could|should|would|will|do|does|did|is|are|was|were|has|have|had|may|might|must)\b/i;

export function getHeadings(html) {
  const out = { h1: 0, h2: 0, h3: 0, question: 0, explicit: 0 };
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const level = Number(m[1]);
    const text = decodeEntities(m[2].replace(RE.tag, ' ')).replace(/\s+/g, ' ').trim();
    if (level === 1) out.h1++;
    if (level === 2) out.h2++;
    if (level === 3) out.h3++;
    if (level >= 2 && level <= 4 && text) {
      const marked = text.includes('?');
      if (marked || INTERROGATIVE.test(text)) out.question++;
      if (marked) out.explicit++;
    }
  }
  return out;
}

export function getJsonLd(html) {
  const types = new Set();
  let blocks = 0, broken = 0, hasDate = false;

  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = parseAttrs('<script ' + m[1] + '>');
    if (!(a.type || '').toLowerCase().includes('ld+json')) continue;

    const raw = m[2].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    if (!raw) continue;

    let data;
    try { data = JSON.parse(raw); } catch { broken++; continue; }
    blocks++;

    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n['@type']) {
        for (const t of [].concat(n['@type'])) {
          if (typeof t === 'string') types.add(t);
        }
      }
      if (n.datePublished || n.dateModified) hasDate = true;
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === 'object') walk(v);
      }
    };
    walk(data);
  }

  return { types: [...types], blocks, broken, hasDate };
}

export function hasTimeElement(html) {
  return /<time\b[^>]*\bdatetime\s*=/i.test(html);
}

export function visibleWordCount(html) {
  let s = html
    .replace(RE.comment, ' ')
    .replace(RE.script, ' ')
    .replace(RE.style, ' ')
    .replace(RE.noscript, ' ')
    .replace(RE.svg, ' ')
    .replace(RE.template, ' ');

  const body = s.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  s = body ? body[1] : s.replace(RE.head, ' ');

  s = decodeEntities(s.replace(RE.tag, ' ')).replace(/\s+/g, ' ').trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ');
}

// --- robots.txt ------------------------------------------------------------
export function parseRobots(txt) {
  const groups = {};
  let current = [];
  let collectingAgents = true;

  for (let line of String(txt || '').split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;

    let m = line.match(/^user-agent\s*:\s*(.+)$/i);
    if (m) {
      if (!collectingAgents) { current = []; collectingAgents = true; }
      const ua = m[1].trim().toLowerCase();
      if (!groups[ua]) groups[ua] = [];
      current.push(ua);
      continue;
    }

    m = line.match(/^(dis)?allow\s*:\s*(.*)$/i);
    if (m) {
      collectingAgents = false;
      const rule = m[1] ? 'disallow' : 'allow';
      const path = m[2].trim();
      for (const ua of current) groups[ua].push({ rule, path });
      continue;
    }
    // Sitemap, Crawl-delay and unknown directives do not end a group.
  }
  return groups;
}

export function agentBlocked(groups, agent) {
  // Per spec: an agent with its own group ignores the * group entirely.
  const set = groups[agent.toLowerCase()] || groups['*'] || null;
  if (!set) return false;
  for (const r of set) if (r.rule === 'allow' && (r.path === '/' || r.path === '')) return false;
  for (const r of set) if (r.rule === 'disallow' && r.path === '/') return true;
  return false;
}

// ===========================================================================
// Scoring — pure, deterministic, unit-testable
// ===========================================================================
export function scorePage(input) {
  const { html, startUrl, finalUrl, hops, ms, robotsTxt, robotsResolved, sitemapLive, llmsLive } = input;

  if (!html || !html.trim()) {
    return { ok: false, error: 'That page returned an empty response, so there is nothing for an AI system to read.' };
  }

  const title = getTitle(html);
  const desc = getMetaContent(html, 'description');
  const canonical = getCanonical(html);
  const heads = getHeadings(html);
  const words = visibleWordCount(html);
  const schema = getJsonLd(html);
  const timeEl = hasTimeElement(html);

  const robotsFound = typeof robotsTxt === 'string' && robotsTxt.length > 0;
  // Default true for older callers that don't pass it; false means the fetch failed.
  const robotsKnown = input.robotsResolved !== false;
  const groups = robotsFound ? parseRobots(robotsTxt) : {};

  const cats = [];

  // --- A. Crawler access (25) ---------------------------------------------
  const A = [];
  const blanket = robotsFound && agentBlocked(groups, '*');
  A.push(check('Site is not blocked wholesale', blanket ? 0 : 5, 5,
    blanket
      ? 'robots.txt disallows all crawlers from the whole site. Nothing else matters until this is fixed.'
      : robotsFound
        ? 'robots.txt does not block the site globally.'
        : !robotsKnown
          ? 'robots.txt could not be read after three attempts, so this could not be verified.'
          : 'No robots.txt found, which means default-allow. Fine, though an explicit file is better.',
    'Remove the sitewide Disallow: / rule from robots.txt, or scope it to the paths you actually want hidden.'));

  const blockedBots = robotsFound ? AI_BOTS.filter((b) => agentBlocked(groups, b)) : [];
  const botPts = Math.round(15 * (1 - blockedBots.length / AI_BOTS.length));
  A.push(check('AI crawlers can reach the site', botPts, 15,
    blockedBots.length
      ? 'Blocked in robots.txt: ' + blockedBots.join(', ') + '.'
      : !robotsKnown
        ? 'robots.txt could not be read after three attempts, so no crawler rules could be checked.'
        : 'None of the major AI crawlers are disallowed.',
    'Allow the AI search crawlers you want citations from — OAI-SearchBot, Claude-SearchBot and PerplexityBot are the ones that feed live answers. Training crawlers (GPTBot, ClaudeBot) are a separate decision.'));

  const smDeclared = robotsFound && /^\s*sitemap\s*:/im.test(robotsTxt);
  const smPts = smDeclared ? 5 : (sitemapLive ? 3 : 0);
  A.push(check('Sitemap is discoverable', smPts, 5,
    smDeclared ? 'Declared in robots.txt.'
      : !robotsKnown
        ? (sitemapLive
            ? '/sitemap.xml responds. robots.txt could not be read after three attempts, so we could not confirm it is declared there — this site may be rate-limiting us.'
            : 'robots.txt could not be read after three attempts and no /sitemap.xml responded.')
      : sitemapLive ? '/sitemap.xml responds, but robots.txt does not point to it.'
      : 'No sitemap found at /sitemap.xml and none declared in robots.txt.',
    'Publish an XML sitemap and add a Sitemap: line to robots.txt so crawlers find it without guessing.'));

  cats.push(category('Crawler access', A));

  // --- B. Machine-readable content (30) -----------------------------------
  const B = [];
  let wPts, wMsg;
  if (words >= 800) { wPts = 12; wMsg = `${words.toLocaleString('en-US')} words in the raw HTML.`; }
  else if (words >= 400) { wPts = 9; wMsg = `${words.toLocaleString('en-US')} words — readable, but thin for a page you want quoted.`; }
  else if (words >= 200) { wPts = 5; wMsg = `${words.toLocaleString('en-US')} words — very light.`; }
  else { wPts = 0; wMsg = `Only ${words.toLocaleString('en-US')} words in the raw HTML. This usually means the content is rendered by JavaScript.`; }
  B.push(check('Content is in the HTML, not built by JavaScript', wPts, 12, wMsg,
    'Most AI crawlers do not run JavaScript. Serve your real copy in the initial HTML response, or the model sees an empty page.'));

  const h1Pts = heads.h1 === 1 ? 4 : (heads.h1 === 0 ? 0 : 2);
  B.push(check('Single, clear H1', h1Pts, 4,
    heads.h1 === 1 ? 'One H1 found.'
      : heads.h1 === 0 ? 'No H1 on the page.'
      : `${heads.h1} H1 tags — the page has no single subject.`,
    'Use exactly one H1 that names what the page is about in plain language.'));

  const subs = heads.h2 + heads.h3;
  const shPts = subs >= 6 ? 5 : (subs >= 3 ? 3 : (subs >= 1 ? 1 : 0));
  B.push(check('Sectioned with subheadings', shPts, 5,
    `${subs} H2/H3 headings found.`,
    'Break the page into labelled sections. Models extract answers span by span, and headings define where a span starts and ends.'));

  const hasFaq = schema.types.includes('FAQPage');
  const qPts = (heads.question >= 3 || hasFaq) ? 5 : (heads.question >= 1 ? 3 : 0);
  B.push(check('Answers questions directly', qPts, 5,
    hasFaq
      ? 'FAQPage schema present.'
      : heads.question > 0
        ? `${heads.question} question-shaped heading(s) found${heads.explicit ? '' : ' (phrased as questions, no "?" used)'}.`
        : 'No question-shaped headings on this page. FAQ content on a separate page is not counted here — check that page directly.',
    'Add a real Q&A block using the phrasing your customers use, with the answer in the first sentence under each question.'));

  const rPts = hops === 0 ? 4 : (hops === 1 ? 3 : (hops <= 3 ? 1 : 0));
  B.push(check('Short redirect path', rPts, 4,
    hops === 0 ? 'Served directly, no redirects.' : `${hops} redirect hop(s) before the final page.`,
    'Point links at the final URL. AI fetchers give up after a few hops, and each one is a chance to lose the request.'));

  cats.push(category('Machine-readable content', B));

  // --- C. Structured data (25) --------------------------------------------
  const C = [];
  C.push(check('Valid JSON-LD present', schema.blocks > 0 ? 8 : 0, 8,
    schema.blocks > 0
      ? `${schema.blocks} JSON-LD block(s), types: ${schema.types.slice(0, 8).join(', ')}.`
      : schema.broken > 0
        ? `${schema.broken} JSON-LD block(s) found but none parsed — the JSON is malformed.`
        : 'No JSON-LD structured data found.',
    'Add Schema.org JSON-LD. It is the most direct way to state facts about your business in a form a machine cannot misread.'));

  const entity = ['Organization', 'LocalBusiness', 'Person', 'ProfessionalService', 'Store']
    .some((t) => schema.types.includes(t));
  C.push(check('Business entity is declared', entity ? 7 : 0, 7,
    entity ? 'Entity schema found.' : 'No Organization or LocalBusiness schema.',
    'Declare who you are: legal name, address, phone, sameAs links to your profiles. This is what a model uses to decide you are a real, specific business.'));

  const contentTypes = ['FAQPage', 'HowTo', 'Article', 'BlogPosting', 'Service', 'Product', 'BreadcrumbList']
    .filter((t) => schema.types.includes(t));
  C.push(check('Content-level schema', contentTypes.length ? 5 : 0, 5,
    contentTypes.length ? contentTypes.join(', ') + ' found.' : 'No page-level content schema.',
    'Mark up what the page actually is — an FAQ, a service, an article — rather than leaving it as an unlabelled block of text.'));

  const dates = schema.hasDate || timeEl;
  C.push(check('Freshness signals', dates ? 5 : 0, 5,
    dates ? 'Published or modified dates exposed.' : 'No machine-readable dates on the page.',
    'Expose datePublished and dateModified. Undated content loses to dated content when a model is picking what to cite.'));

  cats.push(category('Structured data', C));

  // --- D. Technical hygiene (20) ------------------------------------------
  const D = [];
  const https = finalUrl.startsWith('https://');
  D.push(check('HTTPS', https ? 5 : 0, 5,
    https ? 'Served over HTTPS.' : 'Not served over HTTPS.',
    'Install a certificate and force HTTPS sitewide.'));

  const tLen = [...title].length;
  D.push(check('Title tag', (tLen >= 15 && tLen <= 65) ? 4 : (tLen > 0 ? 2 : 0), 4,
    tLen === 0 ? 'No title tag.' : `Title is ${tLen} characters.`,
    'Write a title between roughly 15 and 65 characters that names the thing and the place, not just the brand.'));

  const dLen = [...desc].length;
  D.push(check('Meta description', (dLen >= 50 && dLen <= 170) ? 4 : (dLen > 0 ? 2 : 0), 4,
    dLen === 0 ? 'No meta description.' : `Description is ${dLen} characters.`,
    'Write a 50–170 character summary that answers what the page is for. It is often the snippet a model quotes back.'));

  D.push(check('Canonical tag', canonical ? 3 : 0, 3,
    canonical ? 'Canonical: ' + canonical : 'No canonical tag.',
    'Add a self-referencing canonical to each page. A hardcoded sitewide canonical is worse than none.'));

  const lang = getHtmlLang(html);
  D.push(check('Page language declared', lang ? 2 : 0, 2,
    lang ? `<html lang="${lang}">` : 'No lang attribute on the <html> tag.',
    'Set lang on the <html> tag. It tells any system reading the page which language to interpret it as.'));

  const ogTitle = getMetaProperty(html, 'og:title');
  const ogDesc = getMetaProperty(html, 'og:description');
  const ogPts = (ogTitle && ogDesc) ? 2 : ((ogTitle || ogDesc) ? 1 : 0);
  D.push(check('Social preview metadata', ogPts, 2,
    (ogTitle && ogDesc) ? 'og:title and og:description both present.'
      : (ogTitle || ogDesc) ? 'Only one of og:title / og:description is set.'
      : 'No Open Graph tags.',
    'Add og:title and og:description. They are a second, cleaner statement of what the page is, and plenty of systems read them before the body.'));

  cats.push(category('Technical hygiene', D));

  // --- Totals -------------------------------------------------------------
  let score = 0, max = 0;
  for (const c of cats) { score += c.score; max += c.max; }

  const priorities = [];
  for (const c of cats) {
    for (const ck of c.checks) {
      if (ck.points < ck.max) {
        priorities.push({ lost: ck.max - ck.points, title: ck.label, fix: ck.fix });
      }
    }
  }
  priorities.sort((a, b) => b.lost - a.lost);

  const notes = [
    'This checks one page — the URL you entered — not your whole site.',
    'This measures whether AI systems can read and understand your page. It does not measure whether ChatGPT or Perplexity currently mentions you; that requires running live prompts against the models.',
    `The page returned its HTML in about ${Number(ms).toLocaleString('en-US')} ms. Not scored: network timing varies between runs, and the score is meant to be identical for an unchanged page.`,
  ];
  if (!robotsKnown) {
    notes.unshift('Heads up: robots.txt could not be read on this run, so the Crawler access score is incomplete. The site may be rate-limiting automated requests. Try again in a minute.');
  }
  if (llmsLive) {
    notes.push('An llms.txt file is present. Not scored: no major AI provider has confirmed they act on it, so treat it as optional housekeeping rather than a ranking factor.');
  }

  return {
    ok: true,
    url: startUrl,
    final_url: finalUrl,
    score, max,
    band: band(score),
    categories: cats,
    priorities: priorities.slice(0, 5),
    notes,
    checked_at: new Date().toISOString(),
  };
}

function check(label, points, max, detail, fix) {
  return {
    label, points, max,
    status: points === max ? 'pass' : (points === 0 ? 'fail' : 'partial'),
    detail, fix,
  };
}

function category(name, checks) {
  let score = 0, max = 0;
  for (const c of checks) { score += c.points; max += c.max; }
  return { name, score, max, checks };
}

function band(s) {
  if (s >= 85) return 'Strong';
  if (s >= 70) return 'Solid, with gaps';
  if (s >= 50) return 'Needs work';
  if (s >= 30) return 'Largely invisible';
  return 'Not readable by AI systems';
}
