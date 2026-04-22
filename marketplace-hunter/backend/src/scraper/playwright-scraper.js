import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function makeId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
}

export async function scrapeMarketplace({ config, cookiesPath, headless = true, onProgress }) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  // Load FB cookies if available
  if (cookiesPath && fs.existsSync(cookiesPath)) {
    try {
      const raw = fs.readFileSync(cookiesPath, 'utf8');
      const cookies = JSON.parse(raw);
      await context.addCookies(cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain || '.facebook.com',
        path: c.path || '/', httpOnly: c.httpOnly || false, secure: c.secure || true,
        sameSite: 'None',
      })));
      console.log(`🍪 Loaded ${cookies.length} FB cookies`);
    } catch (e) {
      console.warn('⚠️  Could not load cookies:', e.message);
    }
  }

  const page = await context.newPage();
  const listings = [];

  const keywords = config.keywords.split(/\s+/).join('%20');
  const baseUrl = `https://www.facebook.com/marketplace/search?query=${keywords}&minPrice=${config.min_price || 0}&maxPrice=${config.max_price || 999999}&sortBy=creation_time_descend`;

  try {
    if (onProgress) onProgress({ type: 'status', message: `Navigation vers FB Marketplace...` });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check for session
    const isFBLoggedIn = await page.$('[aria-label="Marketplace"]').catch(() => null);
    if (!isFBLoggedIn) {
      console.warn('⚠️  FB session may be expired or not logged in');
    }

    // Scroll to load more items
    const maxResults = config.max_results || 30;
    let scrolls = 0;
    const maxScrolls = Math.ceil(maxResults / 10);

    while (scrolls < maxScrolls) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(2000);
      scrolls++;
      if (onProgress) onProgress({ type: 'status', message: `Chargement... (${scrolls}/${maxScrolls})` });
    }

    // Extract listings
    const extracted = await page.evaluate(() => {
      const results = [];

      // Try multiple selector strategies
      const links = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
      const seen = new Set();

      for (const link of links) {
        const href = link.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);

        const card = link.closest('[data-testid="marketplace_feed_item"]') || link.closest('div[class*="x1yztbdb"]') || link.parentElement;

        const imgEl = card?.querySelector('img');
        const titleEl = card?.querySelector('span[class*="x1lliihq"]') || card?.querySelector('span');
        const priceEl = card?.querySelectorAll('span')?.[1] || null;

        const rawTitle = titleEl?.innerText?.trim() || link.getAttribute('aria-label') || '';
        const rawPrice = priceEl?.innerText?.trim() || '';
        const numPrice = parseFloat(rawPrice.replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;

        if (!rawTitle) continue;

        results.push({
          listing_url: href,
          title: rawTitle,
          price: numPrice,
          image_url: imgEl?.src || '',
          location: '',
          description: '',
          condition: 'Non précisé',
        });
      }
      return results;
    });

    for (const item of extracted.slice(0, maxResults)) {
      const id = makeId(item.listing_url);
      listings.push({ id, ...item, search_config_id: config.id });
    }

    if (onProgress) onProgress({ type: 'status', message: `${listings.length} annonces extraites` });
  } catch (err) {
    console.error('Scraper error:', err.message);
    if (onProgress) onProgress({ type: 'error', message: err.message });
  } finally {
    await browser.close();
  }

  return listings;
}
