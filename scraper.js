const { chromium } = require('playwright');
const axios = require('axios');

const { chromium } = require('playwright');
const axios = require('axios');
const GLS_USER = process.env.GLS_USER || '0408510235'; // zamijeni po potrebi
const GLS_PASS = process.env.GLS_PASS || 'Bd1910420';   // zamijeni po potrebi
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dsltpiupbfopyvuiqffg.supabase.co/rest/v1/deliveries';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzbHRwaXVwYmZvcHl2dWlxZmZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk5Mjc3MzcsImV4cCI6MjA2NTUwMzczN30.suu_OSbTBSEkM3YMiPDFIAgDnX3bDavcD8BX4ZfYZxw';

async function scrapeAndSave() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    // 1. LOGIN
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="username"], input[type="email"]', GLS_USER);
    await page.fill('input[name="password"]', GLS_PASS);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button[type="submit"]'),
    ]);

    // 2. DIREKTNO NA TABELU
    await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle' });

    // Ovdje (PO POTREBI!) dodaj klikove za Performance (hist.), otvaranje detalja i biranje datuma!

    // 3. ČUPANJE SVIH TURA
    const rows = await page.$$eval('.row.list.recent', trs =>
      trs.map(tr => {
        const cells = tr.querySelectorAll('span');
        return {
          tura: cells[0]?.innerText.trim(), // Broj ture
          broj_paketa: cells[1]?.innerText.trim(), // Žuto polje
          procenat: cells[2]?.innerText.trim(), // Procenat uspjeha
          broj_adresa: cells[7]?.innerText.trim(), // Crveno polje (pozicija zavisi od strukture!)
          reklamacije: cells[12]?.innerText.trim(), // Plavo polje (pozicija zavisi od strukture!)
        };
      })
    );

    const datum = new Date().toISOString().slice(0, 10);

    // 4. SLANJE SVIH REDOVA U SUPABASE
    for (const row of rows) {
      if (!row.tura || !row.broj_adresa) continue;
      await axios.post(
        SUPABASE_URL,
        {
          date: datum,
          tura: row.tura,
          broj_adresa: row.broj_adresa,
          broj_paketa: row.broj_paketa,
          procenat: row.procenat,
          reklamacije: row.reklamacije,
          created_at: new Date().toISOString()
        },
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    console.log('SVE POSLANO U SUPABASE!');
  } catch (e) {
    console.error('Greška:', e);
  } finally {
    await browser.close();
  }
}

scrapeAndSave();