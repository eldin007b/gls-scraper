// scraper.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Konfiguracija vozača ---
const DRIVERS = ['8610', '8620', '8630', '8640'];

// --- Glavni scraper ---
async function runScraper() {
  console.log('🔑 Logujem se u GLS Cockpit...');

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Logovanje
  await page.goto('https://gls-cockpit-url/login'); // stavi pravi URL
  await page.type('#username', process.env.GLS_USER);
  await page.type('#password', process.env.GLS_PASS);
  await page.click('#loginBtn');
  await page.waitForNavigation();

  console.log('📊 Otvaram KPI stranicu...');
  await page.goto('https://gls-cockpit-url/kpi'); // stavi pravi KPI URL

  // Dohvati sve datume
  const dates = await page.$$eval('.date-selector li', nodes =>
    nodes.map(n => n.textContent.trim())
  );
  console.log('📅 Pronađeni datumi:', dates);

  const today = new Date();
  const threeWeeksAgo = new Date(today.getTime() - 21 * 24 * 60 * 60 * 1000);

  for (let rawDate of dates) {
    // Preskoči prazne datume
    if (rawDate.includes('Keine Daten vorhanden')) {
      console.log('⏭️ Preskačem:', rawDate);
      continue;
    }

    // Parsiranje datuma (pretpostavimo format "Mo\n20.10.")
    const dateParts = rawDate.split('\n')[1].split('.');
    const dateObj = new Date(`${today.getFullYear()}-${dateParts[1]}-${dateParts[0]}`);
    if (dateObj < threeWeeksAgo) continue; // provjera zadnje 3 sedmice

    const dateStr = dateObj.toISOString().split('T')[0];
    console.log('⏳ Obrađujem datum:', dateStr);

    for (let driver of DRIVERS) {
      // Provjera da li već postoji
      const { data: existing } = await supabase
        .from('deliveries')
        .select('id')
        .eq('date', dateStr)
        .eq('driver', driver)
        .limit(1);

      if (existing.length) {
        console.log(`✔ ${dateStr} ${driver} već postoji.`);
        continue;
      }

      // --- Simulacija dohvaćanja podataka ---
      const zustellung_paketi = Math.floor(Math.random() * 100); // zamijeni stvarnim podacima
      const produktivitaet_stops = Math.floor(Math.random() * 20); // zamijeni stvarnim podacima

      // Ubaci u Supabase
      const { error } = await supabase.from('deliveries').insert([
        {
          date: dateStr,
          driver,
          zustellung_paketi,
          produktivitaet_stops,
          sinhronizovano: 1,
        },
      ]);

      if (error) console.error('❌ Greška pri unosu:', error);
      else console.log(`✔ ${dateStr} ${driver} ubačeno.`);
    }
  }

  // Upisi sync log
  await supabase.from('sync_logs').insert([{ total_days_scraped: dates.length }]);

  console.log('✅ Gotov scraping svih datuma.');
  await browser.close();
}

// --- Pokreni scraper ---
runScraper().catch(err => {
  console.error('❌ Greška u scraperu:', err);
});
