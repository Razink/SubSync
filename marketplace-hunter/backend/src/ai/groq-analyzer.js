import Groq from 'groq-sdk';

let groqClient;

export function initGroq(apiKey) {
  groqClient = new Groq({ apiKey });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function analyzeListing(listing) {
  if (!groqClient) throw new Error('Groq not initialized');

  const prompt = `Tu es un expert en bonnes affaires sur les marketplaces. Analyse cette annonce et retourne un JSON.

Annonce:
- Titre: ${listing.title}
- Prix: ${listing.price}€
- État: ${listing.condition || 'Non précisé'}
- Localisation: ${listing.location || 'Non précisée'}
- Description: ${listing.description || 'Aucune'}

Réponds UNIQUEMENT avec ce JSON (pas de markdown):
{
  "score": <entier 1-10>,
  "verdict": "<EXCELLENTE|BONNE|CORRECTE|PASSABLE|MAUVAISE>",
  "reasons": ["raison 1", "raison 2"],
  "negotiation": "<conseil de négociation en une phrase>"
}`;

  try {
    const completion = await groqClient.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 300,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw);

    return {
      ai_score: Math.min(10, Math.max(1, parseInt(parsed.score) || 5)),
      ai_verdict: parsed.verdict || 'CORRECTE',
      ai_reasons: JSON.stringify(parsed.reasons || []),
      ai_negotiation: parsed.negotiation || '',
    };
  } catch (err) {
    console.error('Groq analysis error:', err.message);
    return { ai_score: 5, ai_verdict: 'CORRECTE', ai_reasons: '[]', ai_negotiation: '' };
  }
}

export async function analyzeListings(listings, onProgress) {
  const results = [];
  for (let i = 0; i < listings.length; i++) {
    const result = await analyzeListing(listings[i]);
    results.push({ id: listings[i].id, ...result });
    if (onProgress) onProgress(i + 1, listings.length);
    // Respect Groq free-tier rate limit (~30 req/min)
    if (i < listings.length - 1) await sleep(1100);
  }
  return results;
}
