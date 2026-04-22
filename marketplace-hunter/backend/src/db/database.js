import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db;

export function initDatabase(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  db = new Database(resolved);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      price REAL,
      location TEXT,
      description TEXT,
      condition TEXT,
      image_url TEXT,
      listing_url TEXT,
      search_config_id INTEGER,
      scraped_at TEXT DEFAULT (datetime('now')),
      ai_score INTEGER,
      ai_verdict TEXT,
      ai_reasons TEXT,
      ai_negotiation TEXT,
      is_analyzed INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS search_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL,
      min_price REAL DEFAULT 0,
      max_price REAL DEFAULT 999999,
      location TEXT DEFAULT '',
      radius_km INTEGER DEFAULT 40,
      max_results INTEGER DEFAULT 30,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scrape_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT DEFAULT 'running',
      total_found INTEGER DEFAULT 0,
      total_analyzed INTEGER DEFAULT 0,
      error_message TEXT,
      config_ids TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Default settings
  const defaultSettings = [
    ['headless', 'true'],
    ['min_ai_score', '6'],
    ['auto_scrape_interval', '0'],
    ['notifications_enabled', 'false'],
  ];

  const upsert = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of defaultSettings) {
    upsert.run(key, value);
  }

  // Default search configs
  const countConfigs = db.prepare('SELECT COUNT(*) as c FROM search_configs').get();
  if (countConfigs.c === 0) {
    db.prepare(`INSERT INTO search_configs (name, keywords, min_price, max_price, max_results) VALUES (?, ?, ?, ?, ?)`)
      .run('Smartphones', 'iphone samsung galaxy', 100, 1500, 30);
    db.prepare(`INSERT INTO search_configs (name, keywords, min_price, max_price, max_results) VALUES (?, ?, ?, ?, ?)`)
      .run('Laptops', 'laptop macbook dell lenovo', 200, 2000, 20);
  }

  console.log(`✅ Database initialized at ${resolved}`);
  return db;
}

export function getDb() {
  return db;
}

// ---- Listings ----
export function insertListing(listing) {
  return db.prepare(`
    INSERT OR IGNORE INTO listings
      (id, title, price, location, description, condition, image_url, listing_url, search_config_id)
    VALUES
      (@id, @title, @price, @location, @description, @condition, @image_url, @listing_url, @search_config_id)
  `).run(listing);
}

export function updateListingAI(id, ai) {
  return db.prepare(`
    UPDATE listings SET
      ai_score = @ai_score,
      ai_verdict = @ai_verdict,
      ai_reasons = @ai_reasons,
      ai_negotiation = @ai_negotiation,
      is_analyzed = 1
    WHERE id = @id
  `).run({ id, ...ai });
}

export function getListings(filters = {}) {
  let query = 'SELECT * FROM listings WHERE 1=1';
  const params = [];

  if (filters.search) {
    query += ' AND (title LIKE ? OR description LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.min_score) {
    query += ' AND ai_score >= ?';
    params.push(Number(filters.min_score));
  }
  if (filters.config_id) {
    query += ' AND search_config_id = ?';
    params.push(Number(filters.config_id));
  }
  if (filters.favorites) {
    query += ' AND is_favorite = 1';
  }

  query += ' ORDER BY scraped_at DESC LIMIT 200';
  return db.prepare(query).all(...params);
}

export function toggleFavorite(id) {
  return db.prepare('UPDATE listings SET is_favorite = 1 - is_favorite WHERE id = ?').run(id);
}

export function deleteListing(id) {
  return db.prepare('DELETE FROM listings WHERE id = ?').run(id);
}

// ---- Configs ----
export function getConfigs() {
  return db.prepare('SELECT * FROM search_configs ORDER BY id').all();
}

export function createConfig(config) {
  return db.prepare(`
    INSERT INTO search_configs (name, keywords, min_price, max_price, location, radius_km, max_results, is_active)
    VALUES (@name, @keywords, @min_price, @max_price, @location, @radius_km, @max_results, @is_active)
  `).run(config);
}

export function updateConfig(id, config) {
  return db.prepare(`
    UPDATE search_configs SET
      name = @name, keywords = @keywords, min_price = @min_price, max_price = @max_price,
      location = @location, radius_km = @radius_km, max_results = @max_results, is_active = @is_active
    WHERE id = @id
  `).run({ id, ...config });
}

export function deleteConfig(id) {
  return db.prepare('DELETE FROM search_configs WHERE id = ?').run(id);
}

// ---- Settings ----
export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

export function setSetting(key, value) {
  return db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ---- Logs ----
export function createScrapeLog(configIds) {
  const result = db.prepare(
    'INSERT INTO scrape_logs (config_ids) VALUES (?)'
  ).run(JSON.stringify(configIds));
  return result.lastInsertRowid;
}

export function updateScrapeLog(id, data) {
  return db.prepare(`
    UPDATE scrape_logs SET
      finished_at = datetime('now'),
      status = @status,
      total_found = @total_found,
      total_analyzed = @total_analyzed,
      error_message = @error_message
    WHERE id = @id
  `).run({ id, ...data });
}

export function getScrapeLogs() {
  return db.prepare('SELECT * FROM scrape_logs ORDER BY started_at DESC LIMIT 50').all();
}

export function getStats() {
  const totalListings = db.prepare('SELECT COUNT(*) as c FROM listings').get().c;
  const analyzedListings = db.prepare('SELECT COUNT(*) as c FROM listings WHERE is_analyzed = 1').get().c;
  const favorites = db.prepare('SELECT COUNT(*) as c FROM listings WHERE is_favorite = 1').get().c;
  const avgScore = db.prepare('SELECT AVG(ai_score) as s FROM listings WHERE ai_score IS NOT NULL').get().s;
  const lastScrape = db.prepare('SELECT started_at FROM scrape_logs ORDER BY started_at DESC LIMIT 1').get()?.started_at;
  const topListings = db.prepare('SELECT * FROM listings WHERE ai_score IS NOT NULL ORDER BY ai_score DESC LIMIT 5').all();

  return { totalListings, analyzedListings, favorites, avgScore: avgScore ? Math.round(avgScore * 10) / 10 : null, lastScrape, topListings };
}
