import { CheerioCrawler } from 'crawlee';
import { extractDirectorCandidates } from '../src/utils/extractors.js';

const targets = [
	'https://camporr.org/camp-staff/employment',
	'https://camporr.org',
];

const results = [];

const crawler = new CheerioCrawler({
	maxConcurrency: 2,
	requestHandler: async ({ request, $, body, contentType }) => {
		if (!contentType?.includes?.('text')) return;
		const url = request.url;
		const siteHost = new URL(url).hostname;
		const candidates = extractDirectorCandidates($, url, ['staff','employment','about','team','director'], siteHost);
		results.push({ url, candidates: candidates.slice(0, 3) });
	},
});

await crawler.addRequests(targets.map((url) => ({ url })));
await crawler.run();

console.log(JSON.stringify(results, null, 2));
