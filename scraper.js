import { supabase } from '../supabaseClient';

// Lista tura koje povlači
const DRIVERS = [8610, 8620, 8630, 8640];

// Glavna funkcija
export async function syncGLSData() {
  const startTime = new Date();
  let totalInserted = 0;
  let totalUpdated = 0;

  try {
    console.log("🚀 Pokrećem automatski GLS sync...");

    for (const driver of DRIVERS) {
      console.log(`🟦 Obrada vozača: ${driver}`);

      // Simulacija: povuci podatke sa Cockpit-a (ovo zamijeni real scraperom)
      const fetchedData = await fetchGLSData(driver);

      const existing = await supabase
        .from('deliveries')
        .select('id, date')
        .eq('driver', driver);

      const existingDates = new Set(existing.data?.map((r) => r.date) || []);
      const today = new Date();
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      // Kreiraj sve dane u mjesecu
      const allDays = [];
      for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const found = fetchedData.find((f) => f.date === dateStr);

        // Ako nema podataka, upiši '-' (kasnije će se automatski ažurirati)
        const record = found || {
          date: dateStr,
          driver,
          zustellung_paketi: null,
          zustellung_proc: '-',
          zustellung_nedostavljeno: '-',
          pickup_paketi: '-',
          pickup_proc: '-',
          pickup_nedostavljeno: '-',
          probleme_prva: '-',
          probleme_druga: '-',
          produktivitaet_stops: null,
          produktivitaet_stops_pro_std: '-',
          produktivitaet_dauer: '-',
        };

        if (existingDates.has(dateStr)) {
          await supabase.from('deliveries').update(record).match({ date: dateStr, driver });
          totalUpdated++;
        } else {
          await supabase.from('deliveries').insert(record);
          totalInserted++;
        }
      }
    }

    // Upis u sync_logs
    await supabase.from('sync_logs').insert({
      last_sync: new Date().toISOString(),
      total_days_scraped: new Date().getDate(),
      total_inserted: totalInserted,
      total_updated: totalUpdated,
      notes: `Sync uspješno završen za ${DRIVERS.length} vozača.`,
    });

    console.log(`✅ Sync završen: ${totalInserted} novih, ${totalUpdated} ažuriranih.`);
  } catch (err) {
    console.error("❌ Greška u syncGLSData:", err.message);
  }
}

// 📦 Dummy funkcija — ovdje se zamjenjuje scraperom koji vraća realne podatke
async function fetchGLSData(driver) {
  // Ovdje bi normalno išao Puppeteer/Playwright
  console.log(`⏳ Povlačim podatke sa GLS Cockpit-a za ${driver}...`);

  await new Promise((res) => setTimeout(res, 1000)); // simulacija čekanja

  // Simulacija nekoliko dana podataka
  const today = new Date();
  const results = [];
  for (let i = 1; i <= today.getDate(); i++) {
    if (Math.random() < 0.2) continue; // 20% dana bez podataka
    const date = new Date(today.getFullYear(), today.getMonth(), i)
      .toISOString()
      .split('T')[0];
    results.push({
      date,
      driver,
      zustellung_paketi: Math.floor(Math.random() * 60) + 20,
      zustellung_proc: '100%',
      zustellung_nedostavljeno: '0',
      pickup_paketi: Math.floor(Math.random() * 10),
      pickup_proc: '100%',
      pickup_nedostavljeno: '0',
      probleme_prva: 'OK',
      probleme_druga: 'OK',
      produktivitaet_stops: Math.floor(Math.random() * 60) + 20,
      produktivitaet_stops_pro_std: '12.5',
      produktivitaet_dauer: '8h',
    });
  }
  return results;
}
