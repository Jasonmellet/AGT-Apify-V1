import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { extractEmailsFromHtml, extractDirectorCandidates, normalizeAndDedupe, pickBestCandidate, filterEmailsToDomain } from './utils/extractors.js';
import fs from 'node:fs';
import path from 'node:path';

function toAbsoluteUrl(input) {
	try {
		const url = new URL(input);
		return url.toString();
	} catch {
		return `https://${input.replace(/^https?:\/\//i, '')}`;
	}
}

function buildSeedUrlsForDomain(domain, keywords) {
	const base = toAbsoluteUrl(domain).replace(/\/$/, '');
	const paths = [
		'',
		'/contact', '/contact-us', '/contactus', '/contact-us/',
		'/about', '/about-us', '/who-we-are', '/our-story', '/our-mission',
		'/staff', '/our-staff', '/staff-directory', '/staff-list', '/meet-our-staff',
		'/team', '/our-team', '/meet-the-team', '/leadership-team', '/executive-team',
		'/leadership', 'administration', 'administrative-staff', 'faculty',
		'/directory', 'people', 'board', 'board-of-directors',
		'/employment', 'jobs', 'careers', 'join-our-team',
		'/camp-director', 'program-director', 'site-director', 'directors'
	];
	const seeds = new Set(paths.map((p) => `${base}${p}`));
	(keywords || []).forEach((k) => seeds.add(`${base}/${k.replace(/\s+/g, '-')}`));
	return Array.from(seeds);
}

function isSameDomain(urlStr, domainStr) {
	try {
		const u = new URL(urlStr);
		const d = new URL(toAbsoluteUrl(domainStr));
		return u.hostname.replace(/^www\./, '') === d.hostname.replace(/^www\./, '');
	} catch {
		return false;
	}
}

function readJsonIfExists(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, 'utf8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

await Actor.init();

let input = (await Actor.getInput()) || {};
if (!input || typeof input !== 'object') input = {};

if (!Array.isArray(input.domains) || input.domains.length === 0) {
	const storageDir = process.env.APIFY_LOCAL_STORAGE_DIR || path.resolve('./apify_storage');
	const kvInputPath = path.join(storageDir, 'key_value_stores', 'default', 'INPUT.json');
	const localInputPath = path.resolve('./input.json');
	const fallback = readJsonIfExists(kvInputPath) || readJsonIfExists(localInputPath);
	if (fallback && Array.isArray(fallback.domains) && fallback.domains.length > 0) {
		input = { ...fallback, ...input };
		log.info(`Loaded input from fallback file: ${fallback === readJsonIfExists(kvInputPath) ? kvInputPath : localInputPath}`);
	}
}

const domains = normalizeAndDedupe(input.domains || []);
if (domains.length === 0) {
	log.error('No domains provided in input.');
	process.exit(1);
}

const defaultKeywords = [
	'contact', 'contact-us', 'contactus', 'about', 'about-us', 'who we are', 'our story', 'our mission',
	'staff', 'our staff', 'staff directory', 'staff list', 'meet our staff',
	'team', 'our team', 'meet the team', 'leadership team', 'executive team',
	'leadership', 'administration', 'administrative staff', 'faculty',
	'directory', 'people', 'board', 'board of directors',
	'employment', 'jobs', 'careers', 'join our team',
	'camp director', 'program director', 'site director', 'directors'
];

const prioritizedKeywords = normalizeAndDedupe(
	input.pageKeywords && input.pageKeywords.length ? input.pageKeywords : defaultKeywords,
);

const maxDepth = Number.isInteger(input.maxDepth) ? input.maxDepth : 2;
const maxRequestsPerDomain = Number.isInteger(input.maxRequestsPerDomain) ? input.maxRequestsPerDomain : 30;
const useApifyProxy = Boolean(input.useApifyProxy);

log.info(`Starting crawl for ${domains.length} domain(s).`);

const domainStates = new Map();
for (const d of domains) domainStates.set(d, { emails: new Set(), candidates: [], pagesCrawled: 0 });

const crawler = new CheerioCrawler({
	maxRequestsPerCrawl: domains.length * Math.max(10, Math.min(80, maxRequestsPerDomain)),
	minConcurrency: 2,
	maxConcurrency: 8,
	requestHandlerTimeoutSecs: 45,
	maxRequestRetries: 2,
	proxyConfiguration: useApifyProxy ? await Actor.createProxyConfiguration() : undefined,
	requestHandler: async ({ request, body, contentType, $ , enqueueLinks }) => {
		const { url, userData } = request;
		const { rootDomain, depth = 0 } = userData || {};
		const state = domainStates.get(rootDomain);
		if (!state) return;

		state.pagesCrawled += 1;

		if (!contentType?.type?.includes('text') && !contentType?.includes?.('text/html')) return;
		const html = body?.toString?.() || '';
		const cheerio = $;

		const emails = extractEmailsFromHtml(html, cheerio);
		emails.forEach((e) => state.emails.add(e));

		const siteHost = new URL(url).hostname;
		const candidates = extractDirectorCandidates(cheerio, url, prioritizedKeywords, siteHost);
		state.candidates.push(...candidates);

		if (depth < maxDepth) {
			await enqueueLinks({
				strategy: 'same-domain',
				globs: prioritizedKeywords.map((k) => `**/*${k.replace(/\s+/g, '-')}*`),
				transformRequestFunction: (req) => {
					try {
						const same = isSameDomain(req.url, rootDomain);
						if (!same) return null;
						return { ...req, userData: { rootDomain, depth: depth + 1 } };
					} catch {
						return null;
					}
				},
			});
		}
	},
});

for (const domain of domains) {
	const seeds = buildSeedUrlsForDomain(domain, prioritizedKeywords);
	for (const url of seeds.slice(0, maxRequestsPerDomain)) {
		await crawler.addRequests([{ url, userData: { rootDomain: domain, depth: 0 } }]);
	}
}

await crawler.run();

for (const domain of domains) {
	const state = domainStates.get(domain);
	const best = pickBestCandidate(state) || null;
	const siteHost = new URL(toAbsoluteUrl(domain)).hostname;
	const allEmails = filterEmailsToDomain(Array.from(state.emails), siteHost);
	const item = {
		inputDomain: domain,
		bestContact: best,
		allEmails,
		candidatesChecked: state.candidates.length,
		pagesCrawled: state.pagesCrawled,
		runAt: new Date().toISOString(),
	};
	await Actor.pushData(item);
	console.log(JSON.stringify(item));
}

log.info('Done.');
await Actor.exit();
