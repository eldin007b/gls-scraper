require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios');

// === KONFIGURACIJA ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;
const DOZVOLJENI_VOZACI = ['8610', '8620', '8630', '8640'];
const FIXNA_GODINA = 2025; // OVDJE postavi godinu za scraping

// === POMOĆNE FUNKCIJE ===
function toISODate(labelText, year) {
  const match = labelText.match(/(\d{2})\.(\d{2})\./);
  if (!match) return null;
  return `${year}-${match[2]}-${match[1]}`;
}
function extractMonth(labelText) {
  const match = labelText.match(/\d{2}\.(\d{2})\./);
  return match ? parseInt(match[1], 10) : null;
}
async function existsInSupabase(date, driver) {
  try {
    const url = `${SUPABASE_URL}?date=eq.${encodeURIComponent(date)}&driver=eq.${encodeURIComponent(driver)}`;
    const res = await axios.get(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      }
    });
    return res.data.length > 0;
  } catch (err) {
    console.error(`GREŠKA prilikom provjere (${date}, ${driver}):`, err.message);
    return false;
  }
}

// === GLAVNA FUNKCIJA ===
async function main() {
  // --- MOBILNI KONTEKST (Pixel 5) ---
  const device = devices['Pixel 5'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...device,
    locale: 'de-DE'
  });
  const page = await context.newPage();

  try {
    // --- LOGIN ---
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    console.log('Otišao na login');

    await page.waitForSelector('input[name="username"]', { timeout: 60000 });
    await page.fill('input[name="username"]', GLS_USER);
    console.log('Popunio username');

    await page.click('button[type="submit"], button[name="login"]');
    console.log('Kliknuo login (user)');

    await page.waitForSelector('input[name="password"]', { timeout: 60000 });
    await page.fill('input[name="password"]', GLS_PASS);
    console.log('Popunio password');

    await page.click('button[type="submit"], button[name="login"]');
    console.log('Kliknuo login (pass)');

    // --- ČEKANJE REDIRECTA NA DASHBOARD ---
    await page.waitForNavigation({ url: '**/dashboard', timeout: 20000 });
    console.log('Na dashboardu!');

    // --- COOKIE MODAL ---
    try {
      await page.waitForSelector('ion-modal', { timeout: 10000 });
      await page.waitForSelector('ion-button:has-text("Akzeptieren")', { timeout: 8000 });
      await page.click('ion-button:has-text("Akzeptieren")');
      console.log('Kliknuo na cookie modal: Akzeptieren');
      await page.waitForSelector('ion-modal', { state: 'detached', timeout: 8000 });
      console.log('Cookie modal nestao!');
    } catch (e) {
      console.log('Nije pronađen cookie modal! Probam fallback...');
      try {
        await page.click('text=Akzeptieren');
        console.log('Kliknuo na cookie modal: text=Akzeptieren');
      } catch {
        console.log('Nije pronađen ni fallback!');
      }
    }

    // --- SADA KPI SCREEN ---
    await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle' });
    console.log('Na KPI ekranu!');

    // --- OTVORI SELEKTOR DATUMA ---
    await page.waitForSelector('ion-select');
    await page.click('ion-select');
    await page.waitForSelector('ion-list ion-radio-group');

    // --- IZLISTAJ SVE AKTIVNE DATUME ---
    let radioItemsAll = await page.$$('ion-list ion-radio-group ion-item ion-radio');
    let aktivniDatumi = [];
    let aktivniRadio = [];
    for (let j = 0; j < radioItemsAll.length; j++) {
      const txt = (await radioItemsAll[j].textContent()).replace(/\s+/g, ' ').trim();
      if (!txt.includes('Keine Daten vorhanden')) {
        aktivniDatumi.push(txt);
        aktivniRadio.push(radioItemsAll[j]);
      }
    }
    console.log('Aktivni datumi:', aktivniDatumi);

    // --- Fiksiraj godinu na onu koju želiš (nema više automatskog skoka godine) ---
    let godina = 2025;

    // --- PROĐI KROZ SVE AKTIVNE DANE ---
    for (let i = 0; i < aktivniDatumi.length; i++) {
      const labelText = aktivniDatumi[i];

      // --- Parsiraj kartice za sve vozače ---
      if (i > 0) {
        await page.click('ion-select');
        await page.waitForSelector('ion-list ion-radio-group');
        radioItemsAll = await page.$$('ion-list ion-radio-group ion-item ion-radio');
        aktivniRadio = [];
        for (let j = 0; j < radioItemsAll.length; j++) {
          const txt = (await radioItemsAll[j].textContent()).replace(/\s+/g, ' ').trim();
          if (!txt.includes('Keine Daten vorhanden')) {
            aktivniRadio.push(radioItemsAll[j]);
          }
        }
      }
      await aktivniRadio[i].click();
      await page.waitForTimeout(1200);

      // === PARSIRANJE SVIH KARTICA ZA SVE VOZAČE ===
      const cardHandles = await page.$$('app-compact-kpi-list-card ion-card');
      let cards = [];

      for (const card of cardHandles) {
        // Helper: uzmi sve vrijednosti iz grupe
        async function groupValues(grupa) {
          const groups = await card.$$('.group');
          for (const group of groups) {
            const titleEl = await group.$('.title');
            if (titleEl) {
              const label = (await titleEl.textContent()).replace(/\s+/g, ' ').trim();
              if (label === grupa) {
                const kpis = await group.$$('.kpis .kpi');
                let values = [];
                for (const kpi of kpis) {
                  const valueEl = await kpi.$('.value');
                  let val = '';
                  if (valueEl) val = (await valueEl.textContent()).replace(/\s+/g, ' ').trim();
                  values.push(val);
                }
                return values;
              }
            }
          }
          return [];
        }

        const driver = await card.$eval('ion-card-title span', el => el.textContent.trim());

        if (!DOZVOLJENI_VOZACI.includes(driver)) continue; // Samo traženi vozači

        const Zustellung = await groupValues('Zustellung');
        const PickUp = await groupValues('PickUp');
        const Probleme = await groupValues('Probleme');
        const Produktivitaet = await groupValues('Produktivität');

        cards.push({
          driver,
          zustellung_paketi: Zustellung[0] || null,
          zustellung_proc: Zustellung[1] || null,
          zustellung_nedostavljeno: Zustellung[2] || null,
          pickup_paketi: PickUp[0] || null,
          pickup_proc: PickUp[1] || null,
          pickup_nedostavljeno: PickUp[2] || null,
          probleme_prva: Probleme[0] || null,
          probleme_druga: Probleme[1] || null,
          produktivitaet_stops: Produktivitaet[0] || null,
          produktivitaet_stops_pro_std: Produktivitaet[1] || null,
          produktivitaet_dauer: Produktivitaet[2] || null,
        });
      }

      // --- SLANJE U SUPABASE ---
      const isoDate = toISODate(labelText, godina);

      for (const red of cards) {
        if (!red.driver) continue;
        const alreadyExists = await existsInSupabase(isoDate, red.driver);
        if (alreadyExists) {
          console.log(`Preskačem ${isoDate} ${red.driver} (već postoji)`);
          continue;
        }

        try {
          await axios.post(
            SUPABASE_URL,
            {
              date: isoDate,
              driver: red.driver,
              zustellung_paketi: parseInt(red.zustellung_paketi && red.zustellung_paketi.replace(/\D/g, '') || '0'),
              zustellung_proc: red.zustellung_proc || '',
              zustellung_nedostavljeno: red.zustellung_nedostavljeno || '',
              pickup_paketi: red.pickup_paketi || '',
              pickup_proc: red.pickup_proc || '',
              pickup_nedostavljeno: red.pickup_nedostavljeno || '',
              probleme_prva: red.probleme_prva || '',
              probleme_druga: red.probleme_druga || '',
              produktivitaet_stops: parseInt(red.produktivitaet_stops && red.produktivitaet_stops.replace(/\D/g, '') || '0'),
              produktivitaet_stops_pro_std: red.produktivitaet_stops_pro_std || '',
              produktivitaet_dauer: red.produktivitaet_dauer || ''
            },
            {
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`Poslano u Supabase: ${isoDate} ${red.driver}`);
        } catch (e) {
          console.log(`GREŠKA za ${isoDate} ${red.driver}:`, e.response?.data || e.message);
        }
      }

      console.log(`Datum: ${labelText} (${isoDate}) - kartica: ${cards.length}`);
      await page.waitForTimeout(700);
    }

    console.log('ALL DONE! Svi podaci za sve datume poslani u Supabase.');

  } catch (err) {
    console.error('GREŠKA:', err);
  } finally {
    await browser.close();
  }
}

main();
