const { chromium } = require('playwright');
const axios = require('axios');

const GLS_USER = process.env.GLS_USER || 'demo_user';
const GLS_PASS = process.env.GLS_PASS || 'demo_pass';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xxx.supabase.co/rest/v1/your_table';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'supabase-api-key';

async function scrapeAndSave() {
  console.log('Pokrećem Chromium...');
  const browser = await chromium.launch({ headless: true });
  console.log('Chromium pokrenut!');
  const page = await browser.newPage();
  console.log('Nova stranica otvorena!');

  try {
    console.log('Idem na GLS login stranicu...');
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    console.log('Na login stranici, unosim user/pass...');

    await page.fill('input[name="username"], input[type="email"]', GLS_USER);
    await page.fill('input[name="password"]', GLS_PASS);

    console.log('Klik na login...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button[type="submit"]'),
    ]);
    console.log('Login završen, na dashboardu!');

    // OVDJE DODAJ SELECTOR KOJI POSTOJI NA TVOM DASHBOARDU!
    // Ovo je samo primjer!
    console.log('Pokušavam pronaći broj isporuka...');
    const brojIsporuka = await page.$eval('.some-delivery-class', el => el.textContent.trim());
    console.log('Broj isporuka:', brojIsporuka);

    console.log('Šaljem podatke u Supabase...');
    await axios.post(
      SUPABASE_URL,
      {
        date: new Date().toISOString().slice(0, 10),
        delivery_count: brojIsporuka,
      },
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Uspješno scrapovano i poslano u Supabase!');
  } catch (e) {
    console.error('Greška:', e);
  } finally {
    await browser.close();
    console.log('Chromium ugašen.');
  }
}

scrapeAndSave();
