const { chromium, devices } = require('playwright');
const axios = require('axios');

const SUPABASE_URL = 'https://dsltpiupbfopyvuiqffg.supabase.co/rest/v1/deliveries';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzbHRwaXVwYmZvcHl2dWlxZmZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk5Mjc3MzcsImV4cCI6MjA2NTUwMzczN30.suu_OSbTBSEkM3YMiPDFIAgDnX3bDavcD8BX4ZfYZxw';

const GLS_USER = process.env.GLS_USER || '0408510235';
const GLS_PASS = process.env.GLS_PASS || 'Bd19102420';

// === NOVO: Funkcija za provjeru postoji li već podatak ===
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
    // Ako ne može provjeriti, bolje ipak pokušati insert!
    return false;
  }
}

async function main() {
  const device = devices['Pixel 5'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...device, locale: 'de-DE' });
  const page = await context.newPage();

  try {
    // --- LOGIN ---
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    await page.waitForSelector('input[name="username"]', { timeout: 60000 });
    await page.fill('input[name="username"]', GLS_USER);
    await page.click('button[name="login"]');
    await page.waitForSelector('input[name="password"]', { timeout: 30000 });
    await page.fill('input[name="password"]', GLS_PASS);
    await page.click('button:has-text("prijaviti se")');
    await page.waitForTimeout(2000);

    // --- KPI SCREEN ---
    await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // --- Cookie modal: AKZEPTIEREN ---
    let clicked = false;
    for (const selector of [
      'button:has-text("AKZEPTIEREN")',
      'ion-button:has-text("AKZEPTIEREN")',
      'span:has-text("AKZEPTIEREN")'
    ]) {
      try {
        const btn = await page.waitForSelector(selector, { timeout: 3000 });
        await btn.click();
        clicked = true;
        break;
      } catch {}
    }
    if (!clicked) {
      clicked = await page.evaluate(() => {
        function clickDeep(node) {
          if (!node) return false;
          if (node.innerText && node.innerText.trim().toUpperCase() === 'AKZEPTIEREN') {
            node.click();
            return true;
          }
          for (const child of node.children || []) {
            if (clickDeep(child)) return true;
          }
          return false;
        }
        return clickDeep(document.body);
      });
    }
    await page.waitForTimeout(1200);

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

    // --- PROĐI KROZ SVE AKTIVNE DANE ---
    for (let i = 0; i < aktivniDatumi.length; i++) {
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
      const labelText = aktivniDatumi[i];
      await aktivniRadio[i].click();
      await page.waitForTimeout(1200);

      // Parsiraj sve kartice (vozače) na stranici
      const cardHandles = await page.$$('app-compact-kpi-list-card ion-card');
      let cards = [];

      for (const card of cardHandles) {
        // Helper funkcija za čitanje vrijednosti iz grupe po labeli
        async function valueByLabel(groupTitle, kpiIdx = 1) {
          const groups = await card.$$('.group');
          for (const group of groups) {
            const titleEl = await group.$('.title');
            if (titleEl) {
              const label = (await titleEl.textContent()).replace(/\s+/g, ' ').trim();
              if (label === groupTitle) {
                const kpis = await group.$$('.kpis .kpi');
                if (kpis[kpiIdx-1]) {
                  const valueEl = await kpis[kpiIdx-1].$('.value');
                  if (valueEl) {
                    return (await valueEl.textContent()).replace(/\s+/g, ' ').trim();
                  }
                }
              }
            }
          }
          return null;
        }

        const driver = await card.$eval('ion-card-title span', el => el.textContent.trim());

        const Zustellung = [
          await valueByLabel('Zustellung', 1),    // npr: 52
          await valueByLabel('Zustellung', 2),    // npr: 98,08 %
          await valueByLabel('Zustellung', 3)     // npr: 1 / 0
        ];
        const PickUp = [
          await valueByLabel('PickUp', 1),
          await valueByLabel('PickUp', 2),
          await valueByLabel('PickUp', 3)
        ];
        const Probleme = [
          await valueByLabel('Probleme', 1),
          await valueByLabel('Probleme', 2)
        ];
        const Produktivität = [
          await valueByLabel('Produktivität', 1),
          await valueByLabel('Produktivität', 2),
          await valueByLabel('Produktivität', 3)
        ];

        cards.push({ driver, Zustellung, PickUp, Probleme, Produktivität });
      }

      // --- SLANJE U SUPABASE ---

      for (const red of cards) {
        if (!red.driver) continue;

        // PROVJERA POSTOJI LI VEĆ PODATAK
        const alreadyExists = await existsInSupabase(labelText, red.driver);
        if (alreadyExists) {
          console.log(`Preskačem ${labelText} ${red.driver} (već postoji)`);
          continue;
        }

        try {
          await axios.post(
            SUPABASE_URL,
            {
              date: labelText,
              driver: red.driver,
              zustellung_paketi: parseInt(red.Zustellung?.[0]?.replace(/\D/g, '') || '0'),
              zustellung_proc: red.Zustellung?.[1] || '',
              zustellung_nedostavljeno: red.Zustellung?.[2] || '',
              pickup_paketi: red.PickUp?.[0] || '',
              pickup_proc: red.PickUp?.[1] || '',
              pickup_nedostavljeno: red.PickUp?.[2] || '',
              probleme_prva: red.Probleme?.[0] || '',
              probleme_druga: red.Probleme?.[1] || '',
              produktivitaet_prva: red.Produktivität?.[0] || '',
              produktivitaet_druga: red.Produktivität?.[1] || '',
              produktivitaet_treca: red.Produktivität?.[2] || ''
            },
            {
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`Poslano u Supabase: ${labelText} ${red.driver}`);
        } catch (e) {
          console.log(`GREŠKA za ${labelText} ${red.driver}:`, e.response?.data || e.message);
        }
      }

      console.log(`Datum: ${labelText} - kartica: ${cards.length}`);
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
