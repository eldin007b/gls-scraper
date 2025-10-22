import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_URL_SYNC_LOGS = process.env.SUPABASE_URL_SYNC_LOGS;

const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const supabaseSync = createClient(SUPABASE_URL_SYNC_LOGS, SUPABASE_KEY);

async function runScraper() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('🔑 Logujem se u GLS Cockpit...');
  await page.goto('https://cockpit.gls-group.eu/login');

  // Login
  await page.fill('#username', GLS_USER);
  await page.fill('#password', GLS_PASS);
  await page.click('button[type="submit"]');

  await page.waitForNavigation({ waitUntil: 'networkidle' });
  console.log('✅ Uspješno logovan.');

  console.log('📊 Otvaram KPI stranicu...');
  await page.goto('https://cockpit.gls-group.eu/kpi');

  // Dohvat datuma (primjer selektora – prilagodi prema stranici)
  const dateElements = await page.$$('.date-class'); // zamijeni sa stvarnim selektorom
  const dates = [];
  for (const el of dateElements) {
    const text = await el.innerText();
    dates.push(text.trim());
  }
  console.log('📅 Pronađeni datumi:', dates);

  for (const date of dates) {
    if (date.includes('Keine Daten')) {
      console.log(`⏭️ Preskačem: ${date}`);
      continue;
    }

    console.log(`⏳ Obrađujem datum: ${date}`);
    // ovdje ide tvoj kod za dohvat podataka po vozaču
    const drivers = ['8610', '8620', '8630', '8640'];

    for (const driver of drivers) {
      // primjer: dohvat podataka po driveru
      const data = {
        date: new Date(), // zamijeni stvarnim datumom
        driver,
        zustellung_paketi: Math.floor(Math.random() * 20),
        pickup_paketi: Math.floor(Math.random() * 10),
      };

      // upis u supabase
      const { data: dbData, error } = await supabase
        .from('deliveries')
        .upsert(data, { onConflict: ['date', 'driver'] });

      if (error) console.error(error);
      else console.log(`✔ ${data.date.toISOString().slice(0, 10)} ${driver} spremljeno.`);
    }
  }

  // log u sync_logs
  await supabaseSync.from('sync_logs').insert({
    total_days_scraped: dates.length,
    notes: 'Automatski sync sa GitHub Actions',
  });

  await browser.close();
  console.log('✅ Scraper završen.');
}

runScraper().catch(err => {
  console.error('❌ Greška u scraperu:', err);
  process.exit(1);
});

runScraper().catch(err => {
  console.error('❌ Greška u scraperu:', err);
});
