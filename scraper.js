const { chromium } = require('playwright');
const axios = require('axios');

const GLS_USER = process.env.GLS_USER || 'demo_user';
const GLS_PASS = process.env.GLS_PASS || 'demo_pass';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xxx.supabase.co/rest/v1/your_table';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'supabase-api-key';

async function scrapeAndSave() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });

    await page.fill('input[name="username"], input[type="email"]', GLS_USER);
    await page.fill('input[name="password"]', GLS_PASS);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button[type="submit"]'),
    ]);

    // OVDJE DODAJ SELECTOR KOJI POSTOJI NA TVOM DASHBOARDU!
    // Ovo je samo primjer!
    const brojIsporuka = await page.$eval('.some-delivery-class', el => el.textContent.trim());

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
  }
}

scrapeAndSave();
