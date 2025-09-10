import { load } from 'cheerio';

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NAME_REGEX = /\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\b/g;

const DIRECTOR_TITLE_REGEX = /\b(camp\s*director|executive\s*director|program\s*director|director\s+of\s+[^\n<]{0,60}|site\s*director)\b/i;

const STOPWORD_TOKENS = new Set([
	'at','camp','high','adventure','base','staff','employment','register','today','only','program','areas','photo','journal','leadership','who','we','are','about','contact','team','jobs','directory','more','info','request','welcome','located','looking','week','protected','policy','terms','service','privacy','apply','send','name','email','please','know','when','submitting','submit','format','different','day','city','state','council','road','basecamp','register','registering','account','sign','signin','signout','home'
]);

function getRegistrableDomain(hostname) {
	if (!hostname) return '';
	const parts = String(hostname).toLowerCase().split('.').filter(Boolean);
	if (parts.length <= 2) return parts.join('.');
	return parts.slice(-2).join('.');
}

function emailIsOnDomain(email, siteHostname) {
	try {
		const e = String(email || '').toLowerCase();
		const host = e.split('@')[1];
		if (!host) return false;
		return getRegistrableDomain(host) === getRegistrableDomain(siteHostname);
	} catch {
		return false;
	}
}

export function filterEmailsToDomain(emails, siteHostname) {
	return (emails || []).filter((e) => emailIsOnDomain(e, siteHostname));
}

export function normalizeAndDedupe(list) {
	return Array.from(new Set((list || []).filter(Boolean).map((s) => String(s).trim())));
}

export function extractEmailsFromHtml(html, $) {
	const emails = new Set();
	$('a[href^="mailto:"]').each((_, el) => {
		const href = $(el).attr('href') || '';
		const m = href.replace(/^mailto:/i, '').match(EMAIL_REGEX);
		if (m) m.forEach((e) => emails.add(e.toLowerCase()));
	});
	const textMatches = String(html || '').match(EMAIL_REGEX) || [];
	textMatches.forEach((e) => emails.add(e.toLowerCase()));
	return Array.from(emails);
}

function isPlausibleName(first, last) {
	if (!first || !last) return false;
	const f = first.toLowerCase();
	const l = last.toLowerCase();
	if (STOPWORD_TOKENS.has(f) || STOPWORD_TOKENS.has(l)) return false;
	if (f.length < 2 || l.length < 2) return false;
	if (/high adventure|photo journal|register|employment|only at|request more info/.test(`${f} ${l}`)) return false;
	return true;
}

function findNamesNear(text) {
	const names = [];
	if (!text) return names;
	let m;
	NAME_REGEX.lastIndex = 0;
	while ((m = NAME_REGEX.exec(text)) !== null) {
		if (isPlausibleName(m[1], m[2])) {
			names.push({ fullName: `${m[1]} ${m[2]}`, firstName: m[1], lastName: m[2] });
		}
	}
	return names;
}

function findNamesAroundTitle(text) {
	const results = [];
	if (!text) return results;
	const titleRegex = new RegExp(DIRECTOR_TITLE_REGEX.source, 'gi');
	let match;
	while ((match = titleRegex.exec(text)) !== null) {
		const start = Math.max(0, match.index - 80);
		const end = Math.min(text.length, match.index + match[0].length + 160);
		const windowText = text.slice(start, end);
		results.push(...findNamesNear(windowText));
	}
	return results;
}

function parseDirectTitleNamePatterns(text) {
	const results = [];
	if (!text) return results;
	// Name — Title (dashes/colon/comma allowed)
	const nameThenTitle = /([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\s*[\u2013\u2014\-:,]+\s*(camp\s*director|executive\s*director|program\s*director|site\s*director)/gi;
	let m;
	while ((m = nameThenTitle.exec(text)) !== null) {
		const parts = m[1].trim().split(/\s+/);
		const first = parts[0];
		const last = parts[1];
		if (isPlausibleName(first, last)) {
			results.push({ fullName: `${first} ${last}`, firstName: first, lastName: last, source: 'name-then-title' });
		}
	}
	// Title — Name
	const titleThenName = /(camp\s*director|executive\s*director|program\s*director|site\s*director)\s*[\u2013\u2014\-:,]+\s*([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)/gi;
	while ((m = titleThenName.exec(text)) !== null) {
		const parts = m[2].trim().split(/\s+/);
		const first = parts[0];
		const last = parts[1];
		if (isPlausibleName(first, last)) {
			results.push({ fullName: `${first} ${last}`, firstName: first, lastName: last, source: 'title-then-name' });
		}
	}
	return results;
}

function scoreCandidate(candidate, pageUrl, prioritized) {
	let score = 0;
	if (candidate.title && DIRECTOR_TITLE_REGEX.test(candidate.title)) score += 50;
	if (candidate.email) score += 10;
	if (candidate.source === 'name-then-title' || candidate.source === 'title-then-name') score += 25;
	const url = new URL(pageUrl);
	const path = `${url.hostname}${url.pathname}`.toLowerCase();
	if (prioritized.some((k) => path.includes(k))) score += 10;
	if (/camp\s*director/i.test(candidate.context || '')) score += 8;
	return score;
}

function isInsideNavOrFooter($, el) {
	let cur = el;
	for (let i = 0; i < 6 && cur; i += 1) {
		const tag = cur.tagName?.toLowerCase?.() || '';
		const cls = ($(cur).attr('class') || '').toLowerCase();
		if (tag === 'nav' || tag === 'header' || tag === 'footer') return true;
		if (/\b(nav|menu|header|footer)\b/.test(cls)) return true;
		cur = cur.parent;
	}
	return false;
}

export function extractDirectorCandidates($, pageUrl, prioritizedKeywords, siteHostname) {
	const candidates = [];
	const prioritized = (prioritizedKeywords || []).map((k) => k.toLowerCase());

	const blocks = [];
	$('h1,h2,h3,h4,h5,h6,p,li,div,section,article,strong').each((_, el) => {
		if (isInsideNavOrFooter($, el)) return;
		const text = $(el).text().replace(/\s+/g, ' ').trim();
		if (!text) return;
		if (DIRECTOR_TITLE_REGEX.test(text)) blocks.push({ el, text });
	});

	for (const { el, text } of blocks) {
		let names = [
			...parseDirectTitleNamePatterns(text),
			...findNamesAroundTitle(text),
		];

		if (names.length === 0) {
			const prevText = $(el).prev().text().replace(/\s+/g, ' ').trim();
			const nextText = $(el).next().text().replace(/\s+/g, ' ').trim();
			names = [
				...parseDirectTitleNamePatterns(prevText),
				...parseDirectTitleNamePatterns(nextText),
				...findNamesAroundTitle(prevText),
				...findNamesAroundTitle(nextText),
			];
		}

		if (names.length === 0) continue;

		let email;
		$(el).find('a[href^="mailto:"]').each((_, a) => {
			if (!email) email = ($(a).attr('href') || '').replace(/^mailto:/i, '').trim();
		});
		if (!email) {
			const html = $(el).html() || '';
			const m = html.match(EMAIL_REGEX);
			if (m && m.length) email = m[0];
		}
		if (email && !emailIsOnDomain(email, siteHostname)) email = undefined;

		const titleMatch = text.match(DIRECTOR_TITLE_REGEX);
		const title = titleMatch ? titleMatch[0] : 'Camp Director';
		for (const n of names) {
			candidates.push({
				...n,
				email: email?.toLowerCase(),
				title,
				pageUrl,
				context: text.slice(0, 240),
				confidence: 0,
			});
		}
	}

	// Fallback: scan full body text if nothing found
	if (candidates.length === 0) {
		const fullText = $('body').text().replace(/\s+/g, ' ').trim();
		const names = [
			...parseDirectTitleNamePatterns(fullText),
			...findNamesAroundTitle(fullText),
		];
		const title = 'Camp Director';
		for (const n of names) {
			candidates.push({ ...n, email: undefined, title, pageUrl, context: fullText.slice(0, 240), confidence: 0 });
		}
	}

	const keyed = new Map();
	for (const c of candidates) {
		const key = `${c.fullName}|${c.title || ''}`.toLowerCase();
		if (!keyed.has(key)) keyed.set(key, c);
	}
	const unique = Array.from(keyed.values());
	unique.forEach((c) => (c.confidence = scoreCandidate(c, pageUrl, prioritized)));
	return unique.sort((a, b) => b.confidence - a.confidence);
}

export function pickBestCandidate(domainState) {
	const all = domainState.candidates || [];
	if (all.length === 0) return null;
	return all.reduce((best, cur) => (cur.confidence > (best?.confidence || -1) ? cur : best), null);
}

export function htmlToCheerio(html) {
	return load(html);
}
