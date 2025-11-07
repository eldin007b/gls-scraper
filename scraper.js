cat > scraper.js << 'EOF'
require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;

const DOZVOLJENI_VOZACI = ['8610','8620','8630','8640','8689','8698']; // dodaj po potrebi: '8699','8698'
const FIXNA_GODINA = 2025;
const DAYS_TO_REFRESH = 5; // promijeni na 5 ako želiš

function toISODate(labelText, year) {
  const m = labelText.match(/(\d{2})\.(\d{2})\./);
  return m ? `${year}-${m[2]}-${m[1]}` : null;
}

async function ensurePopoverClosed(page) {
  // Ako je popover otvoren, zatvori ga ESC-om ili klikom na backdrop
  const hasPopover = await page.$('ion-popover');
  if (hasPopover) {
    try { await page.keyboard.press('Escape'); } catch {}
    try { await page.waitForSelector('ion-popover', { state: 'detached', timeout: 1500 }); } catch {}
    const backdrop = await page.$('ion-popover ion-backdrop');
    if (backdrop) {
      try { await backdrop.click({ force: true }); } catch {}
      try { await page.waitForSelector('ion-popover', { state: 'detached', timeout: 1500 }); } catch {}
    }
  }
}

async function openSelect(page) {
  await ensurePopoverClosed(page);
  await page.click('ion-select');
  await page.waitForSelector('ion-list ion-radio-group', { timeout: 8000 });
}

async function deleteRecentDaysFromSupabase(dates) {
  if (!dates || dates.length === 0) {
    console.log('Nema datuma za brisanje.');
    return;
  }
  const quotedDates = dates.map(d => `"${d}"`).join(',');
  const quotedDrivers = DOZVOLJENI_VOZACI.map(d => `"${d}"`).join(',');
  const url =
    `${SUPABASE_URL}` +
    `?date=in.(${encodeURIComponent(quotedDates)})` +
    `&driver=in.(${encodeURIComponent(quotedDrivers)})`;
  try {
    const res = await axios.delete(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation'
      }
    });
    const count = Array.isArray(res.data) ? res.data.length : 0;
    console.log(`Obrisano zapisa: ${count}`);
  } catch (e) {
    console.error('Greška pri brisanju:', e.response?.data || e.message);
  }
}

async function main() {
  let browser;
  try {
    // Launch + login
    const device = devices['Pixel 5'];
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ...device, locale: 'de-DE' });
    const page = await context.newPage();

    console.log('Login GLS...');
    await page.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', GLS_USER);
    await page.click('button[type="submit"],button[name="login"]');
    await page.fill('input[name="password"]', GLS_PASS);
    await page.click('button[type="submit"],button[name="login"]');
    await page.waitForNavigation({ url: '**/dashboard', timeout: 20000 });

    // Cookie modal
    try {
      await page.waitForSelector('ion-modal', { timeout: 8000 });
      await page.click('ion-button:has-text("Akzeptieren")');
      await page.waitForSelector('ion-modal', { state:'detached', timeout:8000 });
    } catch {}

    // KPI
    console.log('KPI...');
    await page.goto('https://glscockpit.gls-group.com/kpi', { waitUntil:'networkidle' });
    await page.waitForSelector('ion-select');

    // Otvori select jednom da uzmemo listu
    await openSelect(page);

    const labels = await page.$$eval(
      'ion-list ion-radio-group ion-item ion-radio',
      els => els.map(el => el.textContent.trim())
    );

    // Mapiranje index+ISO, izbaci "Keine Daten..."
    const mapping = labels
      .map((lbl, idx) => ({ idx, lbl, iso: lbl.includes('Keine Daten') ? null : toISODate(lbl, FIXNA_GODINA) }))
      .filter(x => !!x.iso);

    // Unikati po ISO uz prvi klikabilni indeks
    const byIso = new Map();
    for (const m of mapping) if (!byIso.has(m.iso)) byIso.set(m.iso, m);
    const unique = Array.from(byIso.values());

    // Zadnjih X
    const lastX = unique.map(x => x.iso).sort().slice(-DAYS_TO_REFRESH);
    if (!lastX.length) {
      console.log('Nema ISO datuma za refresh.');
      return;
    }
    console.log(`Datumi za refresh (${DAYS_TO_REFRESH}): ${lastX.join(', ')}`);

    // Zatvori popover prije brisanja
    await ensurePopoverClosed(page);

    // Brisanje
    await deleteRecentDaysFromSupabase(lastX);

    // Za svaki od tih datuma selektuj i upiši
    for (const iso of lastX) {
      const found = byIso.get(iso);
      if (!found) continue;

      // Otvori select za ovaj krug
      await openSelect(page);

      // Klikni odgovarajući item
      try {
        await page.click(`ion-list ion-radio-group ion-item:nth-child(${found.idx + 1})`);
      } catch {
        console.log(`Preskačem ${iso}: ne mogu selektovati datum`);
        // Zatvori popover ako je još otvoren
        await ensurePopoverClosed(page);
        continue;
      }

      // Sačekaj render kartica i zatvaranje popovera
      await page.waitForSelector('ion-popover', { state: 'detached', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);

      const cards = await page.$$('app-compact-kpi-list-card ion-card');
      for (const card of cards) {
        let driver = '';
        try {
          driver = await card.$eval('ion-card-title span', el => el.textContent.trim());
        } catch {}
        if (!DOZVOLJENI_VOZACI.includes(driver)) continue;

        const extractValues = async (title) =>
          card.$$eval(
            `.group:has(.title:has-text("${title}")) .kpi .value span`,
            s => s.map(x => x.textContent.trim()).filter(Boolean)
          );

        const vZ = await extractValues('Zustellung');
        const vP = await extractValues('PickUp');
        const vPr = await extractValues('Probleme');
        const vProd = await extractValues('Produktivität');

        const row = {
          date: iso,
          driver,
          zustellung_paketi: parseInt(vZ[0] || '0'),
          zustellung_proc: vZ[1] || '',
          zustellung_nedostavljeno: vZ[2] || '',
          pickup_paketi: vP[0] || '',
          pickup_proc: vP[1] || '',
          pickup_nedostavljeno: vP[2] || '',
          probleme_prva: vPr[0] || '',
          probleme_druga: vPr[1] || '',
          produktivitaet_stops: parseInt(vProd[0] || '0'),
          produktivitaet_stops_pro_std: vProd[1] || '',
          produktivitaet_dauer: vProd[2] || ''
        };

        try {
          await axios.post(SUPABASE_URL, row, {
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type':'application/json'
            }
          });
          console.log(`Upisano: ${row.date} ${row.driver}`);
        } catch (e) {
          console.error(`Greška upisa (${row.date} ${row.driver}):`, e.response?.data || e.message);
        }
      }

      // safety: zatvori popover ako je ostao otvoren
      await ensurePopoverClosed(page);
    }

    console.log('Refresh gotov. Izlazim.');
    return;

  } catch (err) {
    console.error('Greška:', err);
  } finally {
    if (browser) await browser.close();
  }
}

main();
EOF
