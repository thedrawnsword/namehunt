/**
 * NameHunt — Username Availability Checker
 * node server.js
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Playwright pool ───────────────────────────────────────────────────────────

const POOL_SIZE = 8;
let playwright, browserPool = [], poolReady = false;

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const randUA  = () => UAS[Math.floor(Math.random() * UAS.length)];
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const jitter  = ms => sleep(ms + Math.floor(Math.random() * ms * 0.5));

async function initPool() {
  try {
    playwright = require('playwright');
    for (let i = 0; i < POOL_SIZE; i++) {
      const browser = await playwright.chromium.launch({
        headless: true,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--window-size=1366,768', '--lang=en-US,en',
        ]
      });
      browserPool.push({ browser, busy: false });
    }
    poolReady = true;
    console.log(`  ✓ Playwright ready (${POOL_SIZE} Chrome instances)\n`);
  } catch {
    console.log('  ⚠  Playwright unavailable — HTTP-only mode\n');
  }
}

async function acquireBrowser(timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const slot = browserPool.find(b => !b.busy);
    if (slot) { slot.busy = true; return slot; }
    if (Date.now() > deadline) throw new Error('browser pool timeout');
    await sleep(50);
  }
}
const releaseBrowser = slot => { slot.busy = false; };

const STEALTH = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins',   { get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = { runtime: { id: undefined }, loadTimes: () => {}, csi: () => {}, app: {} };
};

async function pwCheck(fn, timeout = 14000) {
  if (!poolReady) return null;
  const slot = await acquireBrowser();
  let ctx, page;
  try {
    ctx = await slot.browser.newContext({
      userAgent: randUA(),
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1',
      }
    });
    await ctx.route('**/*', r => ['image','font','media'].includes(r.request().resourceType()) ? r.abort() : r.continue());
    await ctx.addInitScript(STEALTH);
    page = await ctx.newPage();
    return await Promise.race([fn(page), sleep(timeout).then(() => { throw new Error('timeout'); })]);
  } catch { return 'unknown'; }
  finally {
    try { await page?.close(); } catch {}
    try { await ctx?.close(); } catch {}
    releaseBrowser(slot);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpHead(url, headers = {}) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + (u.search || ''),
        method: 'HEAD', timeout: 7000,
        headers: { 'User-Agent': randUA(), 'Accept-Language': 'en-US,en;q=0.9', ...headers }
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error',   () => resolve(0));
      req.end();
    } catch { resolve(0); }
  });
}

function httpGet(url, headers = {}) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + (u.search || ''),
        method: 'GET', timeout: 7000,
        headers: {
          'User-Agent': randUA(), 'Accept': 'application/json, text/html, */*',
          'Accept-Language': 'en-US,en;q=0.9', 'Referer': `https://${u.hostname}/`,
          ...headers
        }
      }, res => {
        let b = ''; res.setEncoding('utf8');
        res.on('data', c => { b += c; if (b.length > 30000) req.destroy(); });
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', headers: {} }); });
      req.on('error',   () => resolve({ status: 0, body: '', headers: {} }));
      req.end();
    } catch { resolve({ status: 0, body: '', headers: {} }); }
  });
}

function httpPost(hostname, path, payload, headers = {}) {
  return new Promise(resolve => {
    try {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const req = https.request({
        hostname, path, method: 'POST', timeout: 7000,
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
          'User-Agent': randUA(), 'Accept': 'application/json', ...headers
        }
      }, res => {
        let b = ''; res.setEncoding('utf8');
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.on('error',   () => resolve({ status: 0, body: '' }));
      req.write(data); req.end();
    } catch { resolve({ status: 0, body: '' }); }
  });
}

// ── InstantUsername API proxy ─────────────────────────────────────────────────
// Maps our platform names to their API slugs
const IU_SLUGS = {
  'YouTube':      'youtube',
  'Instagram':    'instagram',
  'TikTok':       'tiktok',
  'X (Twitter)':  'twitter',
  'Reddit':       'reddit',
  'GitHub':       'github',
  'Twitch':       'twitch',
  'LinkedIn':     'linkedin',
  'Pinterest':    'pinterest',
  'Snapchat':     'snapchat',
  'Telegram':     'telegram',
  'Facebook':     'facebook',
  'Threads':      'threads',
  'Bluesky':      'bluesky',
  'Mastodon':     'mastodon',
  'Tumblr':       'tumblr',
  'Medium':       'medium',
  'Substack':     'substack',
  'Patreon':      'patreon',
  'SoundCloud':   'soundcloud',
  'Spotify':      'spotify',
  'Flickr':       'flickr',
  'Imgur':        'imgur',
  'Vimeo':        'vimeo',
  'Rumble':       'rumble',
  'Letterboxd':   'letterboxd',
  'Goodreads':    'goodreads',
  'Behance':      'behance',
  'Dribbble':     'dribbble',
  'DeviantArt':   'deviantart',
  'VK':           'vk',
  'Wattpad':      'wattpad',
  'Discord':      'discord',
  'Gab':          'gab',
  'Truth Social': 'truthsocial',
};

async function iuCheck(platformName, username) {
  const slug = IU_SLUGS[platformName];
  if (!slug) return null; // no mapping, skip
  try {
    const { status, body } = await httpGet(
      `https://api.instantusername.com/c/v2/${slug}/${encodeURIComponent(username)}`,
      {
        'Referer':  'https://instantusername.com/',
        'Origin':   'https://instantusername.com',
        'Accept':   'application/json',
      }
    );
    if (status === 200 || status === 304) {
      const j = JSON.parse(body);
      // { result: "claimed"|"available"|"unknown", available: bool }
      if (j.result === 'available' || j.available === true)  return 'free';
      if (j.result === 'claimed'   || j.available === false) {
        // still trust "unknown" result even if available=false
        if (j.result === 'unknown') return null; // fall through to our own check
        return 'taken';
      }
    }
  } catch {}
  return null; // fall through to our own check
}

// ── Platform checks ───────────────────────────────────────────────────────────

const PLATFORMS = [

  // ── YouTube ──────────────────────────────────────────────────────────────
  {
    name: 'YouTube',
    url: n => `https://www.youtube.com/@${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://www.youtube.com/@${n}`, { 'Accept': 'text/html' });
      if (status === 404) return 'free';
      if (body.includes('"error":{"code":404') || body.includes('channelNotFound') || body.includes('"reason":"channelNotFound"')) return 'free';
      if (status === 200 && body.length > 5000) return 'taken';
      // fallback: yt's channel existence API
      const { status: s2, body: b2 } = await httpGet(`https://www.youtube.com/c/${n}`, { 'Accept': 'text/html' });
      if (s2 === 404) return 'free';
      if (s2 === 200 && b2.length > 5000) return 'taken';
      return 'unknown';
    }
  },

  // ── Instagram ─────────────────────────────────────────────────────────────
  {
    name: 'Instagram',
    url: n => `https://www.instagram.com/${n}/`,
    check: async n => {
      // Graph API — most reliable
      const { status, body } = await httpGet(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${n}`,
        { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }
      );
      if (status === 404) return 'free';
      if (status === 200) {
        try {
          const j = JSON.parse(body);
          if (j?.data?.user) return 'taken';
          if (j?.message === 'No users found') return 'free';
        } catch {}
      }
      // Playwright fallback
      const r = await pwCheck(async page => {
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        await jitter(500);
        const res = await page.goto(`https://www.instagram.com/${n}/`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        if (res.status() === 404) return 'free';
        const c = await page.content();
        if (c.includes('"userNotFound"') || c.includes('Page Not Found') || c.includes('Sorry, this page')) return 'free';
        if (c.includes('"username"') && c.includes('"profile_pic_url"')) return 'taken';
        return 'unknown'; // got a 200 page but can't confirm
      }, 20000);
      return r ?? 'unknown';
    }
  },

  // ── TikTok ────────────────────────────────────────────────────────────────
  {
    name: 'TikTok',
    url: n => `https://www.tiktok.com/@${n}`,
    check: async n => {
      // Try TikTok's internal web API first
      const { status, body } = await httpGet(
        `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(n)}&aid=1988&app_language=en&app_name=tiktok_web`,
        { 'Referer': 'https://www.tiktok.com/', 'Accept': 'application/json' }
      );
      if (status === 200 && body) {
        try {
          const j = JSON.parse(body);
          const code = j?.statusCode ?? j?.status_code;
          if (code === 10202 || code === 10221 || code === 10223) return 'free';
          if (code === 0 && j?.userInfo?.user?.uniqueId) return 'taken';
        } catch {}
      }
      // Playwright fallback
      const r = await pwCheck(async page => {
        const res = await page.goto(`https://www.tiktok.com/@${n}`, { waitUntil: 'domcontentloaded', timeout: 14000 });
        if (res.status() === 404) return 'free';
        const c = await page.content();
        if (c.includes('"statusCode":10202') || c.includes('user-not-exist') || c.includes("Couldn't find this account") || c.includes('"statusCode":10221')) return 'free';
        if (c.includes('"uniqueId"') || c.includes('"followerCount"') || c.includes('"nickname"')) return 'taken';
        return res.status() === 200 && c.length > 10000 ? 'taken' : 'unknown';
      }, 18000);
      return r ?? 'unknown';
    }
  },

  // ── X / Twitter ───────────────────────────────────────────────────────────
  {
    name: 'X (Twitter)',
    url: n => `https://x.com/${n}`,
    check: async n => {
      // unavatar.io returns 301 for BOTH free and taken — completely useless
      // Use Playwright and intercept Twitter's own UserByScreenName GraphQL call
      const r = await pwCheck(async page => {
        let api = null;
        page.on('response', async resp => {
          if (resp.url().includes('UserByScreenName') || resp.url().includes('ProfileSpotlightsQuery')) {
            try {
              const j = await resp.json().catch(() => null);
              if (!j) return;
              if (j?.data?.user?.result) api = 'taken';
              else if (j?.data?.user === null) api = 'free';
              else if (j?.errors?.some(e => e.message?.includes('not found'))) api = 'free';
            } catch {}
          }
        });
        const res = await page.goto(`https://x.com/${n}`, { waitUntil: 'domcontentloaded', timeout: 14000 });
        await jitter(800);
        if (api) return api;
        if (res.status() === 404) return 'free';
        const c = await page.content();
        if (c.includes('user_not_found') || c.includes('"errors":[{"code":34')) return 'free';
        if (c.includes('"followers_count"') || c.includes('"screen_name"')) return 'taken';
        return res.status() === 200 && c.length > 10000 ? 'taken' : 'unknown';
      }, 18000);
      return r ?? 'unknown';
    }
  },

  // ── Reddit ────────────────────────────────────────────────────────────────
  {
    name: 'Reddit',
    url: n => `https://www.reddit.com/user/${n}`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://www.reddit.com/user/${n}/about.json`,
        { 'Accept': 'application/json' }
      );
      if (status === 404 || body.includes('"reason": "USER_DOESNT_EXIST"')) return 'free';
      if (status === 200 && body.includes('"name"')) return 'taken';
      return 'unknown';
    }
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  {
    name: 'GitHub',
    url: n => `https://github.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://api.github.com/users/${n}`,
        { 'Accept': 'application/vnd.github+json' }
      );
      if (status === 404) return 'free';
      if (status === 200 && body.includes('"login"')) return 'taken';
      return 'unknown';
    }
  },

  // ── Twitch ────────────────────────────────────────────────────────────────
  {
    name: 'Twitch',
    url: n => `https://www.twitch.tv/${n}`,
    check: async n => {
      const r = await pwCheck(async page => {
        const res = await page.goto(`https://www.twitch.tv/${n}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        if (res.status() === 404) return 'free';
        const c = await page.content();
        if (c.includes('Sorry. Unless you') || c.includes('"status":404')) return 'free';
        if (c.includes('"displayName"') || c.includes('"channelLogin"')) return 'taken';
        return 'unknown';
      });
      return r ?? 'unknown';
    }
  },

  // ── LinkedIn ──────────────────────────────────────────────────────────────
  {
    name: 'LinkedIn',
    url: n => `https://www.linkedin.com/in/${n}`,
    check: async n => {
      // HTTP returns 999 (bot block) — must use Playwright
      // Missing profile → redirects to /in/unavailable
      // Existing profile → redirects to /authwall but keeps /in/{n} in redirect_uri
      const r = await pwCheck(async page => {
        await page.goto(`https://www.linkedin.com/in/${n}`, { waitUntil: 'domcontentloaded', timeout: 14000 });
        const finalUrl = page.url();
        const c = await page.content();
        if (finalUrl.includes('/in/unavailable')) return 'free';
        if (c.includes('Page not found') || c.includes('profile-not-found') || c.includes("This page doesn't exist")) return 'free';
        if (finalUrl.includes('/authwall') && (finalUrl.includes(encodeURIComponent(`/in/${n}`)) || finalUrl.includes(`in%2F${n}`))) return 'taken';
        if (finalUrl.includes(`/in/${n}`) && !finalUrl.includes('unavailable')) return 'taken';
        if (c.includes('"publicIdentifier"')) return 'taken';
        return 'unknown';
      }, 16000);
      return r ?? 'unknown';
    }
  },

  // ── Pinterest ─────────────────────────────────────────────────────────────
  {
    name: 'Pinterest',
    url: n => `https://www.pinterest.com/${n}/`,
    check: async n => {
      const { status, body } = await httpGet(`https://www.pinterest.com/${n}/`);
      if (status === 404 || body.includes('"notFound"')) return 'free';
      if (status === 200 && body.includes('"username"')) return 'taken';
      return 'unknown';
    }
  },

  // ── Snapchat ──────────────────────────────────────────────────────────────
  {
    name: 'Snapchat',
    url: n => `https://www.snapchat.com/add/${n}`,
    check: async n => {
      // /add/ does 301/308 redirect — plain HTTP useless, must use Playwright
      const r = await pwCheck(async page => {
        const res = await page.goto(`https://www.snapchat.com/add/${n}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        const finalUrl = page.url();
        const c = await page.content();
        if (res.status() === 404) return 'free';
        if (c.includes('"__typename":"UserProfileNotFound"') || c.includes('pageNotFound') || c.includes("Sorry, we couldn")) return 'free';
        if (c.includes('"__typename":"UserProfile"') || c.includes('"snapchatUsername"') || c.includes('add-friend')) return 'taken';
        if (finalUrl.includes(`/@${n}`) && c.length > 3000) return 'taken';
        return 'unknown';
      });
      return r ?? 'unknown';
    }
  },

  // ── Telegram ──────────────────────────────────────────────────────────────
  {
    name: 'Telegram',
    url: n => `https://t.me/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://t.me/${n}`, { 'Accept': 'text/html' });
      if (status === 404 || body.includes('tgme_page_description_empty') || body.includes('If you have Telegram')) return 'free';
      if (body.includes('tgme_page_title') || body.includes('tgme_page_description')) return 'taken';
      return 'unknown';
    }
  },

  // ── Facebook ──────────────────────────────────────────────────────────────
  {
    name: 'Facebook',
    url: n => `https://www.facebook.com/${n}`,
    check: async n => {
      const r = await pwCheck(async page => {
        const res = await page.goto(`https://www.facebook.com/${n}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        if (res.status() === 404) return 'free';
        const c = await page.content();
        if (c.includes("This content isn") || c.includes('Page Not Found')) return 'free';
        return 'unknown';
      });
      return r ?? 'unknown';
    }
  },

  // ── Threads ───────────────────────────────────────────────────────────────
  {
    name: 'Threads',
    url: n => `https://www.threads.net/@${n}`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${n}`,
        { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.threads.net/' }
      );
      if (status === 404) return 'free';
      if (status === 200) {
        try { const j = JSON.parse(body); if (j?.data?.user) return 'taken'; } catch {}
      }
      return status === 404 ? 'free' : 'unknown';
    }
  },

  // ── Bluesky ───────────────────────────────────────────────────────────────
  {
    name: 'Bluesky',
    url: n => `https://bsky.app/profile/${n}.bsky.social`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${n}.bsky.social`
      );
      if (status === 400 || status === 404) return 'free';
      if (status === 200 && body.includes('"handle"')) return 'taken';
      return 'unknown';
    }
  },

  // ── Mastodon ──────────────────────────────────────────────────────────────
  {
    name: 'Mastodon',
    url: n => `https://mastodon.social/@${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://mastodon.social/api/v1/accounts/lookup?acct=${n}`);
      if (status === 404) return 'free';
      if (status === 200 && body.includes('"username"')) return 'taken';
      return 'unknown';
    }
  },

  // ── Tumblr ────────────────────────────────────────────────────────────────
  {
    name: 'Tumblr',
    url: n => `https://${n}.tumblr.com`,
    check: async n => {
      const s = await httpHead(`https://${n}.tumblr.com`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── Medium ────────────────────────────────────────────────────────────────
  {
    name: 'Medium',
    url: n => `https://medium.com/@${n}`,
    check: async n => {
      // Confirmed: taken users get 302 redirect to {n}.medium.com
      // Missing users get 404 or hang — pure HTTP check, no Playwright needed
      return new Promise(resolve => {
        const req = https.request({
          hostname: 'medium.com', path: `/@${n}`,
          method: 'GET', timeout: 9000,
          headers: { 'User-Agent': randUA(), 'Accept': 'text/html' }
        }, res => {
          res.resume();
          const loc = res.headers.location || '';
          if (res.statusCode === 404) return resolve('free');
          if ((res.statusCode === 301 || res.statusCode === 302) && loc.includes('.medium.com')) return resolve('taken');
          if (res.statusCode === 200) return resolve('taken');
          resolve('unknown');
        });
        req.on('error', () => resolve('unknown'));
        req.on('timeout', () => { req.destroy(); resolve('unknown'); });
        req.end();
      });
    }
  },

  // ── Substack ──────────────────────────────────────────────────────────────
  {
    name: 'Substack',
    url: n => `https://${n}.substack.com`,
    check: async n => {
      const s = await httpHead(`https://${n}.substack.com`);
      if (s === 200) return 'taken';
      if (s === 404) return 'free';
      return 'unknown';
    }
  },

  // ── Patreon ───────────────────────────────────────────────────────────────
  {
    name: 'Patreon',
    url: n => `https://www.patreon.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://www.patreon.com/api/campaigns?filter[vanity]=${n}`, { 'Accept': 'application/json' });
      if (status === 200) {
        try { const j = JSON.parse(body); if (j?.data?.length === 0) return 'free'; if (j?.data?.length > 0) return 'taken'; } catch {}
      }
      const s = await httpHead(`https://www.patreon.com/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── SoundCloud ────────────────────────────────────────────────────────────
  {
    name: 'SoundCloud',
    url: n => `https://soundcloud.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://soundcloud.com/${n}`, { 'Accept': 'text/html' });
      if (status === 404 || body.includes('"status":404') || body.includes('not found')) return 'free';
      if (status === 200 && body.length > 3000) return 'taken';
      return 'unknown';
    }
  },

  // ── Spotify ───────────────────────────────────────────────────────────────
  {
    name: 'Spotify',
    url: n => `https://open.spotify.com/user/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://open.spotify.com/user/${n}`);
      if (status === 404 || body.includes('User not found')) return 'free';
      if (status === 200 && body.includes('"type":"user"')) return 'taken';
      return 'unknown';
    }
  },

  // ── Flickr ────────────────────────────────────────────────────────────────
  {
    name: 'Flickr',
    url: n => `https://www.flickr.com/people/${n}`,
    check: async n => {
      const s = await httpHead(`https://www.flickr.com/people/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── Imgur ─────────────────────────────────────────────────────────────────
  {
    name: 'Imgur',
    url: n => `https://imgur.com/user/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://imgur.com/user/${n}`);
      if (status === 404 || body.includes('User Not Found')) return 'free';
      return 'unknown';
    }
  },

  // ── Vimeo ─────────────────────────────────────────────────────────────────
  {
    name: 'Vimeo',
    url: n => `https://vimeo.com/${n}`,
    check: async n => {
      const s = await httpHead(`https://vimeo.com/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── Rumble ────────────────────────────────────────────────────────────────
  {
    name: 'Rumble',
    url: n => `https://rumble.com/c/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://rumble.com/c/${n}`, { 'Accept': 'text/html' });
      if (status === 404 || body.includes('Page Not Found')) return 'free';
      if (status === 200 && body.length > 3000) return 'taken';
      const { status: s2, body: b2 } = await httpGet(`https://rumble.com/user/${n}`, { 'Accept': 'text/html' });
      if (s2 === 404 || b2.includes('not found')) return 'free';
      if (s2 === 200 && b2.length > 3000) return 'taken';
      return 'unknown';
    }
  },

  // ── Letterboxd ────────────────────────────────────────────────────────────
  {
    name: 'Letterboxd',
    url: n => `https://letterboxd.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://letterboxd.com/${n}/`);
      if (status === 404 || body.includes('page-not-found')) return 'free';
      if (status === 200 && body.length > 5000) return 'taken';
      return 'unknown';
    }
  },

  // ── Goodreads ─────────────────────────────────────────────────────────────
  {
    name: 'Goodreads',
    url: n => `https://www.goodreads.com/${n}`,
    check: async n => {
      const s = await httpHead(`https://www.goodreads.com/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── Strava ────────────────────────────────────────────────────────────────
  {
    name: 'Strava',
    url: n => `https://www.strava.com/athletes/${n}`,
    check: async n => {
      // HTTP always returns 307 → /login for both real and fake users — useless
      // Playwright: existing athlete login redirect preserves /athletes/{n} in URL
      // Missing athlete just goes to plain /login with no reference to the athlete
      const r = await pwCheck(async page => {
        await page.goto(`https://www.strava.com/athletes/${n}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        const finalUrl = page.url();
        const c = await page.content();
        if (finalUrl.includes(`/athletes/${n}`)) return 'taken';
        if (finalUrl.includes('redirect_uri') && finalUrl.includes(encodeURIComponent(n))) return 'taken';
        if (c.includes('404') || c.includes("doesn't exist") || c.includes('not found')) return 'free';
        if (finalUrl.includes('/login') && !finalUrl.includes(n)) return 'free';
        return 'unknown';
      });
      return r ?? 'unknown';
    }
  },

  // ── Behance ───────────────────────────────────────────────────────────────
  {
    name: 'Behance',
    url: n => `https://www.behance.net/${n}`,
    check: async n => {
      const s = await httpHead(`https://www.behance.net/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── Dribbble ──────────────────────────────────────────────────────────────
  {
    name: 'Dribbble',
    url: n => `https://dribbble.com/${n}`,
    check: async n => {
      const s = await httpHead(`https://dribbble.com/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── DeviantArt ────────────────────────────────────────────────────────────
  {
    name: 'DeviantArt',
    url: n => `https://www.deviantart.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://www.deviantart.com/${n}`);
      if (status === 404 || body.includes('This user does not exist')) return 'free';
      return 'unknown';
    }
  },

  // ── ArtStation ────────────────────────────────────────────────────────────
  {
    name: 'ArtStation',
    url: n => `https://www.artstation.com/${n}`,
    check: async n => {
      // /users/{n}/quick.json returns 404 for EVERYONE now — endpoint is dead
      // Use main profile page — returns clean 404 for missing users
      const { status, body } = await httpGet(`https://www.artstation.com/${n}`);
      if (status === 404) return 'free';
      if (body.includes('page-not-found') || body.includes('User Not Found')) return 'free';
      if (status === 200 && body.length > 3000) return 'taken';
      const r = await pwCheck(async page => {
        const res = await page.goto(`https://www.artstation.com/${n}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        if (res.status() === 404) return 'free';
        const c = await page.content();
        if (c.includes('page-not-found') || c.includes('User Not Found')) return 'free';
        return res.status() === 200 && c.length > 3000 ? 'taken' : 'unknown';
      });
      return r ?? 'unknown';
    }
  },

  // ── VK ────────────────────────────────────────────────────────────────────
  {
    name: 'VK',
    url: n => `https://vk.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://vk.com/${n}`);
      if (status === 404 || body.includes('page_not_found')) return 'free';
      return 'unknown';
    }
  },

  // ── Wattpad ───────────────────────────────────────────────────────────────
  {
    name: 'Wattpad',
    url: n => `https://www.wattpad.com/user/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://www.wattpad.com/user/${n}`);
      if (status === 404 || body.includes('not found')) return 'free';
      return 'unknown';
    }
  },

  // ── Untappd ───────────────────────────────────────────────────────────────
  {
    name: 'Untappd',
    url: n => `https://untappd.com/user/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://untappd.com/user/${n}`);
      if (status === 404 || body.includes('Sorry, we could not find')) return 'free';
      return 'unknown';
    }
  },

  // ── Odysee ────────────────────────────────────────────────────────────────
  {
    name: 'Odysee',
    url: n => `https://odysee.com/@${n}`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://api.na-backend.odysee.com/api/v1/proxy?method=resolve&params={"urls":["lbry://@${n}"]}`,
        { 'Accept': 'application/json', 'Content-Type': 'application/json' }
      );
      if (status === 200) {
        try {
          const j = JSON.parse(body);
          const result = Object.values(j?.result || {})[0];
          if (result?.error) return 'free';
          if (result?.name) return 'taken';
        } catch {}
      }
      const { status: s2, body: b2 } = await httpGet(`https://odysee.com/@${n}`, { 'Accept': 'text/html' });
      if (s2 === 404 || b2.includes('not found')) return 'free';
      if (s2 === 200 && b2.length > 3000) return 'taken';
      return 'unknown';
    }
  },

  // ── Gab ───────────────────────────────────────────────────────────────────
  {
    name: 'Gab',
    url: n => `https://gab.com/${n}`,
    check: async n => {
      const { status, body } = await httpGet(`https://gab.com/${n}`);
      if (status === 404 || body.includes('not found')) return 'free';
      return 'unknown';
    }
  },

  // ── Truth Social ──────────────────────────────────────────────────────────
  {
    name: 'Truth Social',
    url: n => `https://truthsocial.com/@${n}`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://truthsocial.com/api/v1/accounts/lookup?acct=${encodeURIComponent(n)}`,
        { 'Origin': 'https://truthsocial.com' }
      );
      if (status === 404 || status === 422) return 'free';
      if (status === 200) {
        try {
          const j = JSON.parse(body);
          if (j?.username) return 'taken';
          if (j?.error) return 'free';
        } catch {}
      }
      return 'unknown';
    }
  },

  // ── Gettr ─────────────────────────────────────────────────────────────────
  {
    name: 'Gettr',
    url: n => `https://gettr.com/user/${n}`,
    check: async n => {
      const { status, body } = await httpGet(
        `https://api.gettr.com/s/user/${n}`,
        { 'Referer': 'https://gettr.com/' }
      );
      if (status === 404 || body.includes('"error"')) return 'free';
      if (status === 200 && body.includes('"un"')) return 'taken';
      const s = await httpHead(`https://gettr.com/user/${n}`);
      return s === 404 ? 'free' : 'unknown';
    }
  },

  // ── Discord ───────────────────────────────────────────────────────────────
  {
    name: 'Discord',
    url: n => `https://discord.com/users/${n}`,
    check: async n => {
      // Discord's own unauthenticated signup-page endpoint
      const { status, body } = await httpPost(
        'discord.com',
        '/api/v9/unique-username/username-attempt-unauthed',
        { username: n },
        { 'Origin': 'https://discord.com', 'Referer': 'https://discord.com/register' }
      );
      if (status === 200 && body) {
        try {
          const j = JSON.parse(body);
          if (j?.taken === false) return 'free';
          if (j?.taken === true)  return 'taken';
        } catch {}
      }
      return 'unknown';
    }
  },

];

// ── Name generation ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}

async function generateNames(description, previousNames = [], feedback = []) {
  if (!ANTHROPIC_API_KEY) return localGenerate(description, previousNames);
  const round = Math.floor(previousNames.length / 5) + 1;
  const style = round <= 2 ? 'Creative real words.' : round <= 5 ? 'Foreign roots, portmanteaus.' : round <= 9 ? 'Coined startup words.' : 'Invented human-sounding words.';
  const prompt = [
    `Generate 5 usernames for: "${description}"`,
    `Style: ${style}`,
    previousNames.length ? `Avoid: ${previousNames.slice(-15).join(', ')}` : '',
    feedback.slice(-4).map(f => `${f.name}→taken:${(f.takenPlatforms||[]).slice(0,3).join(',')}`).join('\n'),
    'Rules: lowercase+numbers only, 4-13 chars, no underscores.',
    '5 usernames, one per line, nothing else.',
  ].filter(Boolean).join('\n');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.error) return reject(new Error(p.error.message));
          const names = p.content[0].text.trim().split('\n')
            .map(l => l.replace(/^\d+[.)]\s*/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15))
            .filter(n => n.length >= 3 && !previousNames.includes(n))
            .filter((n, i, a) => a.indexOf(n) === i).slice(0, 5);
          if (!names.length) return reject(new Error('No valid names'));
          resolve(names);
        } catch { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

const ADJ  = ['swift','dark','neon','void','frost','echo','lunar','pixel','nova','flux','ghost','iron','storm','wild','blaze','zero','apex','drift','prism','vex'];
const NOUN = ['wolf','fox','hawk','raven','blade','code','byte','wave','mind','soul','fire','core','loop','node','lens','forge','vault','edge','realm','spark'];
function localGenerate(description, used = []) {
  const words = description.toLowerCase().replace(/[^a-z ]/g,'').split(/\s+/).filter(w=>w.length>2&&w.length<10);
  const results = new Set(); let attempts = 0;
  while (results.size < 5 && attempts < 60) {
    attempts++;
    const adj = ADJ[Math.floor(Math.random()*ADJ.length)], noun = NOUN[Math.floor(Math.random()*NOUN.length)];
    const kw  = words.length ? words[Math.floor(Math.random()*words.length)] : '';
    const num = Math.random()>.65 ? Math.floor(Math.random()*99) : '';
    const opts = [`${adj}${noun}${num}`, kw?`${kw}${noun}`:`${adj}${noun}`, kw?`${adj}${kw}`:`${noun}${adj.slice(0,4)}`];
    const pick = opts[Math.floor(Math.random()*opts.length)].slice(0,15);
    if (!used.includes(pick)) results.add(pick);
  }
  return [...results].slice(0,5);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  if (u.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ playwright: poolReady, browsers: POOL_SIZE, platforms: PLATFORMS.length }));
    return;
  }

  if (u.pathname === '/check') {
    const name = (u.searchParams.get('name') || '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
    if (!name) { res.writeHead(400); res.end('missing name'); return; }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

    const total = PLATFORMS.length;
    const send  = data => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
    send({ type: 'start', total, playwright: poolReady });

    let done = 0;
    const HARD_TIMEOUT = 22000;
    await Promise.all(PLATFORMS.map(async p => {
      let result = 'taken';
      try {
        // Try instantusername API first — fast, cached, reliable
        const iuResult = await iuCheck(p.name, name);
        if (iuResult !== null) {
          result = iuResult;
        } else {
          // Fall back to our own check
          result = await Promise.race([
            p.check(name),
            new Promise(r => setTimeout(() => r('taken'), HARD_TIMEOUT))
          ]);
        }
      } catch {}
      done++;
      send({ type: 'result', platform: p.name, result, url: p.url(name), done, total });
    }));

    send({ type: 'done', total: done });
    if (!res.writableEnded) res.end();
    return;
  }

  if (u.pathname === '/generate' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { description, previousNames = [], feedback = [] } = JSON.parse(body);
      if (!description) throw new Error('No description');
      const names = await generateNames(description, previousNames, feedback);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ names, usedAI: !!ANTHROPIC_API_KEY }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, async () => {
  console.log('\n  ✦ NameHunt — Username Checker\n');
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  ✓ ${PLATFORMS.length} platforms\n`);
  if (!ANTHROPIC_API_KEY) console.log('  ℹ  Set ANTHROPIC_API_KEY env var to enable AI name generation\n');
  await initPool();
  console.log('  Ready. Press Ctrl+C to stop.\n');
});

process.on('SIGINT', async () => {
  const browsers = new Set(browserPool.map(s => s.browser));
  for (const b of browsers) { try { await b.close(); } catch {} }
  process.exit(0);
});