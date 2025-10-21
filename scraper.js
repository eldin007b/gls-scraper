require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;
const DOZVOLJENI_VOZACI = ['8610', '8620', '8630', '8640'];
const FIXNA_GODINA = 2025;

function toISODate(labelText, year) {
  const match = labelText.match(/(\d{2})\.(\d{2})\./);
  return match ? `${year}-${match[2]}-${match[1]}` : null;
}

async function upsertDelivery(r) {
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/deliveries`, r, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
    });
    console.log(`📦 ${r.date} ${r.driver} -> upsert OK`);
  } catch (err) {
    console.error(`❌ Greška slanja za ${r.driver} (${r.date}):`, err.response?.data || err.message);
  }
}

async function main() {
  let browser;

  try {
    const device = devices['Pixel 5'];
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ...device, locale: 'de-DE' });
    const page = await context.newPage();

    console.log('🔐 Login na GLS Cockpit...');
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', GLS_USER);
    await page.click('button[type="submit"],button[name="login"]');
    await page.fill('input[name="password"]', GLS_PASS);
    await page.click('button[type="submit"],button[name="login"]');
    await page.waitForNavigation({ url: '**/dashboard', timeout: 20000 });

    // Modal "Akzeptieren"
    try {
      await page.waitForSelector('ion-modal', { timeout: 8000 });
      await page.click('ion-button:has-text("Akzeptieren")');
      await page.waitForSelector('ion-modal', { state: 'detached', timeout: 8000 });
    } catch {}

    console.log('📊 Otvaram KPI stranicu...');
    await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle' });
    await page.waitForSelector('ion-select');
    await page.click('ion-select');
    await page.waitForSelector('ion-list ion-radio-group');

    const labels = await page.$$eval(
      'ion-list ion-radio-group ion-item ion-radio',
      els => els.map(el => el.textContent.trim())
    );

    console.log('📅 Pronađeni datumi:', labels);

    for (let i = 0; i < labels.length; i++) {
      const labelText = labels[i];
      if (labelText.includes('Keine Daten vorhanden')) {
        console.log(`⏭️ Preskačem: ${labelText}`);
        continue;
      }

      console.log(`⏳ Obrađujem datum: ${labelText}`);

      await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      await page.waitForSelector('ion-select');
      await page.click('ion-select');
      await page.waitForSelector('ion-list ion-radio-group');

      const iso = toISODate(labelText, FIXNA_GODINA);
      if (!iso) {
        console.log(`⚠️ Datum nije prepoznat: ${labelText}`);
        continue;
      }

      try {
        await page.click(`ion-list ion-radio-group ion-item:nth-child(${i + 1})`);
        await page.waitForTimeout(2000);
      } catch (err) {
        console.log(`⚠️ Neuspješno klikanje na datum: ${labelText}`);
        continue;
      }

      const cards = await page.$$('app-compact-kpi-list-card ion-card');
      const dataToSend = [];

      for (const card of cards) {
        const driver = await card.$eval('ion-card-title span', el => el.textContent.trim());
        if (!DOZVOLJENI_VOZACI.includes(driver)) continue;

        const extractValues = async (groupName) => {
          const group = await card.$(`.group:has(.title:has-text("${groupName}"))`);
          if (!group) return [];
          return group.$$eval('.kpi .value span', spans =>
            spans.map(s => s.textContent.trim()).filter(Boolean)
          );
        };

        const vZ = await extractValues('Zustellung');
        const vP = await extractValues('PickUp');
        const vPr = await extractValues('Probleme');
        const vProd = await extractValues('Produktivität');

        const probleme_prva = vPr[0] || '';
        const probleme_druga = vPr[1] || '';

        const row = {
          date: iso,
          driver,
          zustellung_paketi: parseInt(vZ[0] || '0'),
          zustellung_proc: vZ[1] || '',
          zustellung_nedostavljeno: vZ[2] || '',
          pickup_paketi: vP[0] || '',
          pickup_proc: vP[1] || '',
          pickup_nedostavljeno: vP[2] || '',
          probleme_prva,
          probleme_druga,
          produktivitaet_stops: parseInt(vProd[0] || '0'),
          produktivitaet_stops_pro_std: vProd[1] || '',
          produktivitaet_dauer: vProd[2] || '',
          last_updated: new Date().toISOString(),
          deleted: 0,
          sinhronizovano: 0
        };

        dataToSend.push(row);
      }

      for (const r of dataToSend) {
        await upsertDelivery(r);
      }
    }

    console.log('✅ Gotov scraping svih datuma.');

    // 🕒 Upis last_sync u tabelu sync_logs
    try {
      await axios.post(`${SUPABASE_URL}/rest/v1/sync_logs`, {
        last_sync: new Date().toISOString(),
      }, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
      });
      console.log('🕒 last_sync spremljen.');
    } catch (syncErr) {
      console.error('❌ Greška pri last_sync:', syncErr.response?.data || syncErr.message);
    }

  } catch (err) {
    console.error('❌ Greška u scraperu:', err);
  } finally {
    if (browser) await browser.close();
  }
}

main();
