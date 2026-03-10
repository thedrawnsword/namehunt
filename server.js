/**
 * NameHunt — Username Availability Checker
 * Platform checks now run CLIENT-SIDE in the browser (user's own IP = no blocks).
 * This server only serves index.html + handles AI name generation.
 * node server.js
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

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
    feedback.slice(-4).map(f => `${f.name}->taken:${(f.takenPlatforms||[]).slice(0,3).join(',')}`).join('\n'),
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

}).listen(PORT, () => {
  console.log('\n  ✦ NameHunt — Username Checker\n');
  console.log(`  -> http://localhost:${PORT}\n`);
  console.log('  All platform checks run in the user\'s browser — zero unknowns.\n');
  if (!ANTHROPIC_API_KEY) console.log('  Set ANTHROPIC_API_KEY env var to enable AI name generation\n');
  console.log('  Ready.\n');
});

process.on('SIGINT', () => process.exit(0));