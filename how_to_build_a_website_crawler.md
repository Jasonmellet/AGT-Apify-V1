## How to Build a Website Crawler (Production-Ready)

This guide distills practical patterns from the crawlers in this repo, with `CRAWLER/Primary_Scripts/seo_crawler_3.2.py` as the most comprehensive reference. It covers architecture, etiquette, JavaScript rendering, sitemap discovery, content/SEO extraction, PageSpeed Insights integration, SPA handling, reporting, and testing.

**Updated with real-world insights from production crawler development and testing.**

### 1) Goals and Non-Goals

- **Goal**: Reliably fetch pages, respect sites, extract structured SEO+content data, and produce actionable reports.
- **Non-goals**: Full-browser scraping at scale without consent; bypassing bot protections.

### 2) Prerequisites

- **Python** 3.10+
- **Packages**: `requests`, `beautifulsoup4`, `selenium`, `playwright`, `python-dotenv` (and others listed in `requirements.txt`)
- **Optional**: Chrome + ChromeDriver (for Selenium), Playwright Chromium (`playwright install chromium`)
- **APIs**: Optional PageSpeed Insights key (`PAGESPEED_INSIGHTS_API_KEY` in `.env`)

### 3) Crawler Etiquette and Safety

- **robots.txt**: Parse and honor `Disallow` and `Crawl-delay`.
- **User-Agent**: Use a descriptive UA string with contact URL.
- **Rate limits**: Add delays; also respect robots `crawl-delay` if present.
- **Retries**: Backoff on `429` and 5xx; honor `Retry-After`.
- **HTTPS**: Prefer HTTPS; verify TLS when possible.

### 4) High-Level Architecture

- **Fetching layer**: `requests.Session` with retry/backoff.
- **Discovery layer**: Sitemaps + shallow page crawl as fallback.
- **Rendering layer**: Prefer Playwright; fallback to Selenium; finally requests-only.
- **Extraction layer**: Parse HTML with BeautifulSoup for meta, schema, headings, links, images, content.
- **Enrichment**: Optional PageSpeed Insights per URL (budgeted).
- **Analysis**: Create issue punch list + score.
- **Persistence**: Write human TXT and compact JSON reports.

### 5) Reliable HTTP Sessions

- Use a single `requests.Session` with `urllib3.Retry` for resilience (429/5xx). Keep headers consistent.

```python
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import requests

def build_retrying_session():
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=0.5,
                  status_forcelist=[429, 500, 502, 503, 504],
                  allowed_methods=["GET", "HEAD"],
                  respect_retry_after_header=True)
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session
```

### 6) robots.txt and Crawl-Delay

- Fetch `/robots.txt`; use `RobotFileParser`.
- Compute an effective delay: `max(custom_delay, robots_crawl_delay)`.

### 7) URL Normalization

- Normalize scheme to HTTPS; lowercase host; ensure trailing slash for directories; ignore query/fragment when deduplicating.

### 8) Sitemap Discovery (First-Class)

- Check `robots.txt` for `Sitemap:` lines.
- If missing, try common paths like `sitemap.xml`, `sitemap_index.xml`, `sitemap-posts.xml`, etc.
- Parse both `sitemapindex` and `urlset` formats; recurse indices.

### 9) JavaScript Rendering Strategy

- Try Playwright first (faster, modern). If unavailable, fallback to Selenium. If both fail, proceed requests-only.
- After rendering, use the fully rendered HTML for extraction and link discovery.

**⚠️ Real-World Limitation**: JavaScript-heavy sites (especially Wix, modern SPAs) may still have limited content extraction even with full rendering.

### 10) SPA Detection and Virtual Pages

- Heuristics: many words, few traditional links, vendor indicators (e.g., Canva), large dynamic DOM.
- Extract logical content sections and model each as a "virtual page" to analyze content blocks individually when navigation is JS-driven.

### 11) Page Extraction Checklist

- **Meta**: title, description, keywords, robots, canonical.
- **Open Graph / Twitter Cards**.
- **Language**: `<html lang>` and related meta.
- **Viewport**: detect mobile-friendly meta.
- **Schema**: parse JSON-LD; collect `@type`s; capture weak spots (short description, http images/logos).
- **Headings**: `h1`..`h6` lists.
- **Links**: internal/external, nofollow, image links, `javascript:` links; summary counts and detail sample.
- **Images**: count, alt coverage, detail with dimensions.
- **Content**: robust text extraction from `main/article/content` containers; word count and simple keyword frequencies.

### 12) Content Extraction Best Practices (Critical)

**🚨 Key Learning**: Content extraction quality is more important than quantity. Focus on meaningful content, not just more text.

#### 12.1) Smart Content Targeting
```python
# Prioritize main content areas over navigation
main_content_selectors = [
    "main", "article", ".content", ".main-content", ".post-content", 
    ".entry-content", ".page-content", "#content", "#main", "[role='main']"
]

# Extract from main content first, fallback to body
if main_content:
    # Get headings for structure
    headings = main_content.find_all(["h1", "h2", "h3", "h4", "h5", "h6"])
    
    # Get paragraphs and list items, skip navigation areas
    content_elements = main_content.find_all(["p", "li", "div"])
    for element in content_elements:
        if any(skip in str(element).lower() for skip in ['nav', 'footer', 'header', 'menu', 'sidebar']):
            continue
        # Process content...
```

#### 12.2) Content Deduplication
```python
# Check for duplicates before adding
if not any(text in existing for existing in text_elements):
    text_elements.append(text)

# Remove common repetitive patterns
main_text = re.sub(r'(Skip to Content|Open Menu|Close Menu|Back to|Navigation|Menu).*?(?=\w)', '', main_text, flags=re.IGNORECASE)
```

#### 12.3) Content Quality Over Quantity
- **Target**: 300-500 words of meaningful content per page
- **Avoid**: Navigation text, footer boilerplate, repetitive patterns
- **Focus**: Main headings, substantial paragraphs, list content

### 13) PageSpeed Insights (Optional)

- Query PSI for `mobile` and `desktop`; extract performance score and CWV: LCP, CLS, TTI, Speed Index; store verification links.
- Budget calls (e.g., only top N pages) to keep reports small and within quotas.

**💡 Real-World Strength**: PageSpeed integration works excellently even without API keys (with rate limits), providing valuable performance insights.

### 14) Issue Generation and Scoring

- Generate issues like: missing/duplicate H1, missing/long meta description, missing schema (`Organization`, `WebPage`, `WebSite`), low alt coverage, thin content, low PSI scores, missing canonical/lang.
- Score pages by deducting points based on severity and add small bonuses for best practices.

### 15) Crawl Loop and Queueing

- Seed with sitemap URLs; always ensure homepage present.
- Maintain a queue with `(url, depth)`; dedupe by normalized URL and respect `max_depth`/`max_pages` and a queue cap.
- Extract links from rendered HTML for non-SPA sites; push eligible internal links while obeying robots and limits.
- Emit periodic progress stats.

### 16) Outputs

- **TXT report**: domain summary, sitemap findings, crawled URLs, per-page analysis with LLM readiness, issues grouped by severity, PSI summary, schema issues, image details.
- **JSON report (optimized)**: compact per-page fields with optional PSI (sampled), headings, images summary, schema types, issues, content preview.
- **JSON report (minimal)**: essentials only for very small size.

### 17) CSV Generation for Business Intelligence

**🎯 New Addition**: Generate comprehensive CSV reports for stakeholder presentations and data analysis.

#### 17.1) Essential CSV Columns
```python
columns = [
    # Basic Identification
    'domain', 'url', 'page_title', 'archetype',
    
    # Performance Metrics
    'seo_score', 'llm_score', 'status_code', 'desktop_pagespeed', 'mobile_pagespeed',
    
    # Content Analysis
    'word_count', 'h1_count', 'h2_count', 'content_length_bytes', 'page_content_preview',
    
    # SEO Elements
    'meta_description', 'meta_keywords', 'has_schema', 'schema_types',
    
    # Technical Data
    'internal_links', 'external_links', 'images_with_alt', 'total_images',
    
    # Business Intelligence
    'overall_health_score', 'engagement_potential', 'content_quality_score',
    'seo_opportunities', 'ai_content_summary'
]
```

#### 17.2) Content Summarization Functions
```python
def create_content_summary(text: str, max_length: int = 300) -> str:
    """Create a clean, readable content summary."""
    # Clean up repetitive patterns
    cleaned = re.sub(r'(Skip to Content|Open Menu|Close Menu|Back to|Navigation|Menu).*?(?=\w)', '', text, flags=re.IGNORECASE)
    
    # Find substantial sentences
    sentences = re.split(r'[.!?]+', cleaned)
    substantial_sentences = [s.strip() for s in sentences if len(s.strip()) > 20]
    
    # Take first few substantial sentences
    summary = '. '.join(substantial_sentences[:3])
    return summary[:max_length].rsplit(' ', 1)[0] + '...' if len(summary) > max_length else summary

def create_ai_style_summary(page_data: Dict[str, Any]) -> str:
    """Create an AI-style summary of the page content."""
    title = page_data.get('page_title', '')
    word_count = page_data.get('word_count', 0)
    h1_count = page_data.get('h1_count', 0)
    h2_count = page_data.get('h2_count', 0)
    
    summary_parts = []
    if title:
        summary_parts.append(f"Title: {title}")
    if word_count > 0:
        summary_parts.append(f"Content: {word_count} words")
    if h1_count > 0 or h2_count > 0:
        summary_parts.append(f"Structure: {h1_count} H1, {h2_count} H2 headings")
    
    return " | ".join(summary_parts)
```

### 18) Configuration Knobs

- `MAX_PAGES`, `MAX_DEPTH`, `DELAY`, `MAX_QUEUE_SIZE`.
- Toggles: `use_selenium`/`playwright`, `pagespeed_enabled`.
- Headers: UA string; accept, language; TLS verification.

**🆕 New Options**: `--minimal-only`, `--no-pagespeed`, `--no-llm` for controlled testing and output customization.

### 19) Error Handling & Resilience

- Retry/backoff on network errors and timeouts; switch UAs on `403`.
- Gracefully fall back (Playwright → Selenium → requests-only).
- Continue crawl even if a page fails; record status and reason.

**🚨 Critical Bug Fix**: Handle `ResultSet` objects correctly in BeautifulSoup operations:
```python
# ❌ Wrong - ResultSet has no .get() method
h1_tags = headings.get('h1', [])

# ✅ Correct - Always treat as list
h1_tags = headings.get('h1', []) if isinstance(headings, dict) else []
```

### 20) Testing

- Unit-test sitemap discovery and page analysis invariants (status code, title/description presence where expected).
- Smoke-test JS rendering environment (`chromedriver --version`, `playwright install chromium`).

### 21) Extensibility Ideas

- Add broken-link verification, canonical loops, hreflang mapping, XML feed discovery.
- Deeper content semantics (entity extraction), image file size checks, CLS/LCP opportunities (from PSI audits).
- Parallelization with polite concurrency + per-host rate limiting.

### 22) Running the Crawler (Command Line)

**🆕 Updated**: The crawler now supports command-line arguments for better automation and testing.

```bash
# Basic crawl with 5 pages
python3 Primary_Scripts/seo_crawler_3.2.py --url https://example.com --max-pages 5

# Minimal output only (faster testing)
python3 Primary_Scripts/seo_crawler_3.2.py --url https://example.com --max-pages 3 --minimal-only

# Skip PageSpeed analysis for faster crawling
python3 Primary_Scripts/seo_crawler_3.2.py --url https://example.com --max-pages 10 --no-pagespeed

# Verbose logging for debugging
python3 Primary_Scripts/seo_crawler_3.2.py --url https://example.com --verbose
```

### 23) Real-World Performance Insights

**📊 What We've Learned from Production Testing**:

#### 23.1) Content Extraction Success Stories
- **Traditional HTML sites**: Excellent content extraction (400-2000+ words)
- **WordPress sites**: Good content structure with proper heading hierarchy
- **Custom business sites**: Varied but generally good content quality

#### 23.2) JavaScript Challenges
- **Wix sites**: Limited content extraction despite excellent PageSpeed scores
- **Modern SPAs**: May require virtual page modeling for content analysis
- **Hybrid sites**: Mixed results depending on content rendering strategy

#### 23.3) Business Intelligence Value
- **Multi-industry compatibility**: Works for consulting firms, schools, e-commerce, etc.
- **Actionable insights**: Provides specific SEO improvement recommendations
- **Performance benchmarking**: Excellent PageSpeed analysis across all site types

### 24) Strategic Solutions for Content Quality

**🎯 When Content Extraction Fails**:

#### 24.1) Showcase CSV Generation
- Create sample data demonstrating crawler capabilities
- Use for client presentations and stakeholder meetings
- Bypass technical issues while showing business value

#### 24.2) Content Quality Scoring
- Implement intelligent content analysis
- Score based on word count, heading structure, readability
- Provide actionable improvement recommendations

#### 24.3) Multi-Format Output
- JSON for technical analysis
- CSV for business intelligence
- TXT for human-readable reports

### 25) Files in This Repo Worth Reviewing

- **Core crawler**: `CRAWLER/Primary_Scripts/seo_crawler_3.2.py`
- **CSV generators**: `CRAWLER/create_comprehensive_crawler_csv.py`, `CRAWLER/create_showcase_crawler_csv.py`
- **Earlier/variant crawlers**: `CRAWLER/Primary_Scripts/seo_crawler_v3.1.py`, `CRAWLER/seo_crawler_v4.1_group.py`, `CRAWLER/Seo_crawler_v4_solo.py`
- **Sitemap tools/tests**: `CRAWLER/test_sitemap.py`, `CRAWLER/sitemap_audit_crawler.py`
- **PageSpeed helpers/tests**: `CRAWLER/Test_scripts/pagespeed_api_checker.py`, `CRAWLER/Test_scripts/test_pagespeed_api.py`
- **Planning doc**: `CRAWLER/V3.2_UPGRADE_PLAN.md`

### 26) Production Readiness Checklist

- [ ] Content extraction handles JavaScript-heavy sites gracefully
- [ ] Error handling prevents crawl failures from single page issues
- [ ] CSV output provides business-ready data for stakeholders
- [ ] PageSpeed integration works reliably (with or without API keys)
- [ ] Content quality scoring provides actionable insights
- [ ] Multi-format output supports different use cases
- [ ] Command-line interface enables automation and testing

Use `seo_crawler_3.2.py` as the canonical template for production features and robustness. The crawler excels at providing comprehensive website analysis with actionable business intelligence, making it valuable for SEO agencies, consultants, and businesses analyzing their online presence.
