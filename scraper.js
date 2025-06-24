require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios');

// === KONFIGURACIJA ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;
const DOZVOLJENI_VOZACI = ['8610','8620','8630','8640'];
const FIXNA_GODINA = 2025;

// === POMOĆNE FUNKCIJE ===
function toISODate(labelText, year) {
  const match = labelText.match(/(\d{2})\.(\d{2})\./);
  return match ? `${year}-${match[2]}-${match[1]}` : null;
}
async function existsInSupabase(date, driver) {
  try {
    const url = `${SUPABASE_URL}?date=eq.${encodeURIComponent(date)}&driver=eq.${encodeURIComponent(driver)}`;
    const res = await axios.get(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return res.data.length > 0;
  } catch (e) {
    console.error(`GREŠKA provjere (${date},${driver}):`, e.message);
    return false;
  }
}

// === GLAVNA FUNKCIJA ===
async function main() {
  const device = devices['Pixel 5'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...device, locale: 'de-DE' });
  const page = await context.newPage();

  try {
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', GLS_USER);
    await page.click('button[type="submit"],button[name="login"]');
    await page.fill('input[name="password"]', GLS_PASS);
    await page.click('button[type="submit"],button[name="login"]');

    await page.waitForNavigation({ url: '**/dashboard', timeout: 20000 });

    try {
      await page.waitForSelector('ion-modal', { timeout: 8000 });
      await page.click('ion-button:has-text("Akzeptieren")');
      await page.waitForSelector('ion-modal', { state:'detached', timeout:8000 });
    } catch {}

    await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil:'networkidle' });
    await page.waitForSelector('ion-select');
    await page.click('ion-select');
    await page.waitForSelector('ion-list ion-radio-group');

    const labels = await page.$$eval(
      'ion-list ion-radio-group ion-item ion-radio',
      els => els.map(el => el.textContent.trim()).filter(t => !t.includes('Keine Daten vorhanden'))
    );

    console.log('Datumi:', labels);
    for (let i = 0; i < labels.length; i++) {
      if (i > 0) {
        await page.click('ion-select');
        await page.waitForSelector('ion-list ion-radio-group');
      }
      await page.click(`ion-list ion-radio-group ion-item:nth-child(${i+1})`);
      await page.waitForTimeout(1200);

      const cards = await page.$$('app-compact-kpi-list-card ion-card');
      const dataToSend = [];

      for (const card of cards) {
        const driver = await card.$eval('ion-card-title span', el => el.textContent.trim());
        if (!DOZVOLJENI_VOZACI.includes(driver)) continue;

        const extractValues = async (groupName) => {
          return await card.$$eval(
            `.group:has(.title:has-text("${groupName}")) .kpi .value span`,
            spans => spans.map(s => s.textContent.trim())
          );
        };

        const vZ = await extractValues('Zustellung');
        const vP = await extractValues('PickUp');
        const vPr = await extractValues('Probleme');
        const vProd = await extractValues('Produktivität');

        const iso = toISODate(labels[i], FIXNA_GODINA);
        dataToSend.push({
          iso, driver,
          zustellung_paketi: parseInt(vZ[0] || '0'),
          zustellung_proc: vZ[1] || '',
          zustellung_nedostavljeno: vZ[2] || '',
          pickup_paketi: vP[0] || '', pickup_proc: vP[1] || '', pickup_nedostavljeno: vP[2] || '',
          probleme_prva: vPr[0] || '', probleme_druga: vPr[1] || '',
          produktivitaet_stops: parseInt(vProd[0] || '0'),
          produktivitaet_stops_pro_std: vProd[1] || '', produktivitaet_dauer: vProd[2] || ''
        });
      }

      for (const r of dataToSend) {
        if (!await existsInSupabase(r.iso, r.driver)) {
          await axios.post(SUPABASE_URL, {
            date: r.iso, driver: r.driver,
            zustellung_paketi: r.zustellung_paketi,
            zustellung_proc: r.zustellung_proc,
            zustellung_nedostavljeno: r.zustellung_nedostavljeno,
            pickup_paketi: r.pickup_paketi, pickup_proc: r.pickup_proc, pickup_nedostavljeno: r.pickup_nedostavljeno,
            probleme_prva: r.probleme_prva, probleme_druga: r.probleme_druga,
            produktivitaet_stops: r.produktivitaet_stops,
            produktivitaet_stops_pro_std: r.produktivitaet_stops_pro_std,
            produktivitaet_dauer: r.produktivitaet_dauer
          }, {
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type':'application/json'
            }
          });
          console.log(`📦 ${r.iso} ${r.driver} poslan.`);
        } else {
          console.log(`✔ ${r.iso} ${r.driver} već postoji, preskačem.`);
        }
      }
    }

    console.log('✅ Gotov scraping svih datuma.');
  } catch (e) {
    console.error('❌ Greška u scraperu:', e);
  } finally {
    await browser.close();
  }

  // === SNIMI LAST_SYNC ===
  try {
    await axios.post(
      process.env.SUPABASE_URL_SYNC_LOGS,
      { last_sync: new Date().toISOString() },
      { headers:{
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type':'application/json'
        }}
    );
    console.log('🕒 last_sync spremljen.');
  } catch (e) {
    console.error('❌ Greška pri last_sync:', e.response?.data || e.message);
  }
}

main();
