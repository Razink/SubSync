import { scrapeMarketplace } from './playwright-scraper.js';
import { analyzeListings } from '../ai/groq-analyzer.js';
import { insertListing, updateListingAI, getConfigs, createScrapeLog, updateScrapeLog, getSetting } from '../db/database.js';

export async function runScrapePipeline({ configIds, broadcast }) {
  const configs = getConfigs().filter(c => configIds.includes(c.id) && c.is_active);
  if (!configs.length) {
    broadcast({ type: 'error', message: 'Aucune configuration active trouvée' });
    return;
  }

  const logId = createScrapeLog(configIds);
  const cookiesPath = process.env.COOKIES_PATH || './config/fb_cookies.json';
  const headless = getSetting('headless') !== 'false';
  const minScore = parseInt(getSetting('min_ai_score') || '6');

  broadcast({ type: 'start', message: `Démarrage du scrape pour ${configs.length} config(s)` });

  let totalFound = 0;
  let totalAnalyzed = 0;
  const allNew = [];

  try {
    for (const config of configs) {
      broadcast({ type: 'status', message: `🔍 Scrape: "${config.name}"` });

      const listings = await scrapeMarketplace({
        config,
        cookiesPath,
        headless,
        onProgress: (info) => broadcast({ type: 'status', message: info.message || info }),
      });

      let newCount = 0;
      for (const listing of listings) {
        const result = insertListing(listing);
        if (result.changes > 0) {
          newCount++;
          allNew.push(listing);
        }
      }

      totalFound += listings.length;
      broadcast({ type: 'status', message: `✅ "${config.name}": ${listings.length} trouvées, ${newCount} nouvelles` });
    }

    // AI analysis
    if (allNew.length > 0) {
      broadcast({ type: 'status', message: `🤖 Analyse IA de ${allNew.length} annonces...` });

      const results = await analyzeListings(allNew, (done, total) => {
        broadcast({ type: 'progress', message: `IA: ${done}/${total}`, done, total });
      });

      for (const r of results) {
        updateListingAI(r.id, r);
        totalAnalyzed++;
        if (r.ai_score >= minScore) {
          broadcast({ type: 'highlight', message: `⭐ Score ${r.ai_score}/10 — analysé` });
        }
      }
    }

    updateScrapeLog(logId, { status: 'completed', total_found: totalFound, total_analyzed: totalAnalyzed, error_message: null });
    broadcast({ type: 'done', message: `✅ Terminé: ${totalFound} trouvées, ${totalAnalyzed} analysées` });
  } catch (err) {
    console.error('Pipeline error:', err);
    updateScrapeLog(logId, { status: 'error', total_found: totalFound, total_analyzed: totalAnalyzed, error_message: err.message });
    broadcast({ type: 'error', message: `Erreur: ${err.message}` });
  }
}
