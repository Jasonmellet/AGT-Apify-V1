# Camp Director Contact Crawler (Apify Actor)

Finds director names, emails, and titles from camp websites by prioritizing pages like contact/staff/about/employment.

## Run locally

1. Install deps:

```bash
npm install
```

2. Prepare input `input.json`:

```json
{
  "domains": ["examplecamp.org", "https://anothercamp.com"],
  "maxDepth": 2,
  "maxRequestsPerDomain": 30,
  "pageKeywords": ["contact", "staff", "team", "about", "camp director"],
  "respectRobotsTxt": true,
  "useApifyProxy": false
}
```

3. Run:

```bash
npx apify run -p input.json
```

Each domain produces one dataset item with `bestContact` and `allEmails`.

## Output format (per domain)
```json
{
  "inputDomain": "examplecamp.org",
  "bestContact": {
    "fullName": "Jane Doe",
    "firstName": "Jane",
    "lastName": "Doe",
    "email": "jane@examplecamp.org",
    "title": "Camp Director",
    "pageUrl": "https://examplecamp.org/staff",
    "context": "...",
    "confidence": 78
  },
  "allEmails": ["info@examplecamp.org", "jane@examplecamp.org"],
  "candidatesChecked": 5,
  "pagesCrawled": 12,
  "runAt": "2025-09-10T00:00:00.000Z"
}
```

## n8n integration tips

- Use the Apify node or HTTP Request node to run the actor.
- Pass input per the schema above. For many domains, split into batches to control cost.
- Read the resulting dataset items and map `bestContact` fields into your n8n workflow.

## Notes

- Keeps costs down by limiting depth and focusing on prioritized page keywords.
- Titles matched: camp director, executive director, program director, site director.
- If no name is found but emails are, `bestContact` can be null; use `allEmails` fallback.
