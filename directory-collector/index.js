import { CheerioCrawler, log } from 'crawlee';
import fs from 'node:fs';
import path from 'node:path';
import { htmlToCheerio, extractEmailsFromHtml, normalizeAndDedupe, getRegistrableDomain } from '../src/utils/extractors.js';

const ROOT = 'https://www.summercampdirectories.com/';

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function pickFirstNonEmpty(...vals) { return vals.find((v) => v && String(v).trim().length > 0) || ''; }

function parseListingBlock($block) {
  const text = $block.text().replace(/\s+/g, ' ').trim();
  const name = pickFirstNonEmpty($block.find('a,strong,b').first().text(), text.split(' Ph:')[0]).trim();
  const websiteHref = ($block.find('a[href^="http"]').filter((_, a) => !($(a).attr('href')||'').includes('facebook.com') && !($(a).attr('href')||'').includes('instagram.com') && !($(a).attr('href')||'').includes('yelp.com')).first().attr('href')) || '';
  const emailHref = ($block.find('a[href^="mailto:"]').first().attr('href') || '').replace(/^mailto:/i, '').trim();
  const phoneText = (text.match(/(?:Ph:|Phone:)\s*([^\n<]+?)(?:\s|Email:|Website:|$)/i) || [])[1] || '';
  const addressText = (text.split(/Ph:|Phone:|Email:|Website:/i)[0] || '').trim();
  return { name, website: websiteHref, email: emailHref.toLowerCase(), phone: phoneText.trim(), address: addressText };
}

function extractListings($) {
  const items = [];
  $('table').each((_, table) => {
    const $table = $(table);
    // Heuristic: listing rows have two <td> and contain Email:/Website:
    $table.find('tr').each((__, tr) => {
      const $tr = $(tr);
      const cells = $tr.find('td');
      if (cells.length === 0) return;
      const $cell = cells.length === 1 ? $tr : $(cells[0]);
      const txt = $cell.text().toLowerCase();
      if (/(email:|website:)/i.test(txt)) {
        const parsed = parseListingBlock($cell);
        if (parsed.website || parsed.email || parsed.phone) items.push(parsed);
      }
    });
  });
  return items;
}

function normalizeRecord(record) {
  let domain = '';
  try { domain = new URL(record.website).hostname; } catch {}
  const registrableDomain = getRegistrableDomain(domain);
  return { ...record, registrableDomain };
}

function dedupeByDomain(records) {
  const map = new Map();
  for (const r of records) {
    const key = r.registrableDomain || r.website || r.name;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) { map.set(key, r); continue; }
    const score = (x) => (x.email ? 3 : 0) + (x.phone ? 2 : 0) + (x.website ? 1 : 0);
    if (score(r) > score(prev)) map.set(key, r);
  }
  return Array.from(map.values());
}

async function collectSubdirectories() {
  const startUrls = [ROOT];
  const subdirs = new Set();
  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 5,
    requestHandler: async ({ $, request }) => {
      $('select option').each((_, opt) => {
        const href = $(opt).attr('value') || '';
        if (/^https?:\/\//i.test(href) && /summercamps\.(com|org)$/i.test(href.split('/')[2] || '')) subdirs.add(href);
      });
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href') || '';
        if (/^https?:\/\//i.test(href) && /summercamps\.(com|org)$/i.test(href.split('/')[2] || '')) subdirs.add(href);
      });
    },
  });
  await crawler.addRequests(startUrls.map((u) => ({ url: u })));
  await crawler.run();
  return Array.from(subdirs);
}

async function collectDirectory(dirUrl) {
  const records = [];
  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 2,
    requestHandler: async ({ $, request }) => {
      const listings = extractListings($).map(normalizeRecord);
      records.push(...listings);
    },
  });
  await crawler.addRequests([{ url: dirUrl }]);
  await crawler.run();
  return dedupeByDomain(records);
}

async function main() {
  log.info('Discovering subdirectories...');
  const subdirs = await collectSubdirectories();
  log.info(`Found ${subdirs.length} subdirectories`);

  const all = [];
  for (const u of subdirs) {
    log.info(`Harvesting ${u}`);
    try {
      const items = await collectDirectory(u);
      items.forEach((it) => (it.sourceDirectory = u));
      all.push(...items);
    } catch (err) {
      log.warning(`Failed ${u}: ${err?.message || err}`);
    }
  }

  const outDir = path.resolve('./directory-collector/output');
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'directory-collect.jsonl');
  const csvPath = path.join(outDir, 'directory-collect.csv');
  const kvPath = path.join(outDir, 'domain-index.json');

  // Write JSONL
  fs.writeFileSync(jsonPath, all.map((x) => JSON.stringify(x)).join('\n'));

  // Write CSV
  const header = ['campName','websiteUrl','email','phone','address','registrableDomain','sourceDirectory'];
  const rows = [header.join(',')].concat(all.map((r) => [
    JSON.stringify(r.name || ''),
    JSON.stringify(r.website || ''),
    JSON.stringify(r.email || ''),
    JSON.stringify(r.phone || ''),
    JSON.stringify(r.address || ''),
    JSON.stringify(r.registrableDomain || ''),
    JSON.stringify(r.sourceDirectory || ''),
  ].join(',')));
  fs.writeFileSync(csvPath, rows.join('\n'));

  // Write KV index by registrable domain
  const kv = {};
  for (const r of all) {
    if (!r.registrableDomain) continue;
    kv[r.registrableDomain] = { name: r.name, website: r.website, email: r.email, phone: r.phone };
  }
  fs.writeFileSync(kvPath, JSON.stringify(kv, null, 2));

  log.info(`Wrote ${all.length} records`);
  log.info(`JSONL: ${jsonPath}`);
  log.info(`CSV:   ${csvPath}`);
  log.info(`KV:    ${kvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });


