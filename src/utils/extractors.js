import { load } from 'cheerio';

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NAME_REGEX = /\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\b/g;
const PHONE_REGEX = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}/g; // US-centric

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

function normalizePhone(raw) {
	if (!raw) return undefined;
	const digits = String(raw).replace(/\D+/g, '');
	if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
	if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
	return undefined;
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

function extractPhoneFromElement($, el) {
	let phone;
	$(el).find('a[href^="tel:"]').each((_, a) => {
		if (phone) return;
		const href = $(a).attr('href') || '';
		const normalized = normalizePhone(href.replace(/^tel:/i, ''));
		if (normalized) phone = normalized;
	});
	if (!phone) {
		const text = ($(el).text() || '').replace(/\s+/g, ' ');
		const m = text.match(PHONE_REGEX);
		if (m && m.length) phone = normalizePhone(m[0]);
	}
	if (!phone) {
		const html = $(el).html() || '';
		const m = html.match(PHONE_REGEX);
		if (m && m.length) phone = normalizePhone(m[0]);
	}
	return phone;
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
	if (candidate.phone) score += 6;
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

function findNamesInContainer($, el) {
	// Look in the parent container (up to 2 levels) for typical name tags
	const results = [];
	let container = el.parent || null;
	for (let depth = 0; depth < 2 && container; depth += 1) {
		const $container = $(container);
		$container.find('h1,h2,h3,h4,h5,h6,strong,b,a,span').each((_, n) => {
			const txt = $(n).text().replace(/\s+/g, ' ').trim();
			for (const cand of findNamesNear(txt)) results.push(cand);
		});
		// Also check image alt attributes on staff cards
		$container.find('img[alt]').each((_, img) => {
			const alt = ($(img).attr('alt') || '').replace(/\s+/g, ' ').trim();
			for (const cand of findNamesNear(alt)) results.push(cand);
		});
		container = container.parent || null;
	}
	return results;
}

function ucfirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }
function firstNameFromEmail(email) {
	if (!email) return undefined;
	const local = String(email).split('@')[0];
	const token = (local.split(/[._-]+/)[0] || '').replace(/\d+/g, '');
	return ucfirst(token);
}

function findFullNameByFirst(text, firstName) {
	if (!firstName) return null;
	const windowRegex = new RegExp(`\\b${firstName}\\b[\	 \-\u2013\u2014,]*([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)`, 'i');
	const m = text.match(windowRegex);
	if (m) {
		const last = m[1];
		if (isPlausibleName(firstName, last)) return { fullName: `${ucfirst(firstName)} ${last}`, firstName: ucfirst(firstName), lastName: last };
	}
	return null;
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

		// Try container-level scan (cards on staff pages)
		if (names.length === 0) {
			names = findNamesInContainer($, el);
		}

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

		const phone = extractPhoneFromElement($, el) || extractPhoneFromElement($, $(el).parent());

		// If still no names but we have an email, try derive firstName from email and search nearby
		if (names.length === 0 && email) {
			const fn = firstNameFromEmail(email);
			const neighbor = findFullNameByFirst(text, fn) || findFullNameByFirst($(el).parent().text().replace(/\s+/g, ' ').trim(), fn);
			if (neighbor) names = [neighbor];
		}

		const titleMatch = text.match(DIRECTOR_TITLE_REGEX);
		const title = titleMatch ? titleMatch[0] : 'Camp Director';
		if (names.length === 0) continue;
		for (const n of names) {
			candidates.push({
				...n,
				email: email?.toLowerCase(),
				phone,
				title,
				pageUrl,
				context: text.slice(0, 240),
				confidence: 0,
			});
		}
	}

	// Global fallbacks if nothing found in title blocks
	if (candidates.length === 0) {
		const fullText = $('body').text().replace(/\s+/g, ' ').trim();
		const globalNames = [
			...parseDirectTitleNamePatterns(fullText),
			...findNamesAroundTitle(fullText),
		];
		for (const n of globalNames) {
			candidates.push({ ...n, email: undefined, phone: normalizePhone((fullText.match(PHONE_REGEX)||[])[0]), title: 'Camp Director', pageUrl, context: fullText.slice(0, 240), confidence: 0 });
		}
		// Pair names with mailto containers even without explicit titles
		$('a[href^="mailto:"]').each((_, a) => {
			const email = ($(a).attr('href') || '').replace(/^mailto:/i, '').trim().toLowerCase();
			if (!emailIsOnDomain(email, siteHostname)) return;
			const $container = $(a).closest('div,section,article,li,header,footer');
			const containerText = ($container.text() || '').replace(/\s+/g, ' ').trim();
			const nameNear = findNamesNear(containerText)[0];
			const phoneNear = extractPhoneFromElement($, $container);
			if (nameNear) {
				const title = DIRECTOR_TITLE_REGEX.test(containerText) ? (containerText.match(DIRECTOR_TITLE_REGEX)?.[0] || 'Camp Director') : 'Camp Director';
				candidates.push({ ...nameNear, email, phone: phoneNear, title, pageUrl, context: containerText.slice(0, 240), confidence: 0 });
			}
		});
	}

	const keyed = new Map();
	for (const c of candidates) {
		const key = `${c.fullName}|${c.title || ''}|${c.email || ''}`.toLowerCase();
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

export function pickEmailForCandidate(domainEmails, candidate) {
	if (!candidate || !Array.isArray(domainEmails) || domainEmails.length === 0) return undefined;
	const emails = domainEmails.map((e) => String(e).toLowerCase());
	const first = (candidate.firstName || '').toLowerCase();
	const last = (candidate.lastName || '').toLowerCase();
	const expected = first && last ? `${first[0]}${last}` : '';
	const byLast = emails.find((e) => last && e.includes(last));
	if (byLast) return byLast;
	const byFirst = emails.find((e) => first && e.includes(first));
	if (byFirst) return byFirst;
	const byInit = emails.find((e) => expected && e.split('@')[0].includes(expected));
	if (byInit) return byInit;
	return emails[0];
}
