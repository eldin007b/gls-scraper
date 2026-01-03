#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/* ================= 1. KONFIGURACIJA I OKRUŽENJE ================= */
const isGitHub = process.env.GITHUB_ACTIONS === 'true';
const puppeteer = require(isGitHub ? 'puppeteer' : 'puppeteer-core');
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';

// Logika za URL iz stare skripte
let cleanBaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : '';
const apiPath = '/rest/v1/deliveries';
if (cleanBaseUrl.endsWith(apiPath)) {
    cleanBaseUrl = cleanBaseUrl.substring(0, cleanBaseUrl.length - apiPath.length);
}
const SUPABASE_URL = cleanBaseUrl + apiPath;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;

const FIXNA_GODINA = 2026; // Ažurirano na tekuću godinu
const DAYS = 7;

/* ================= 2. ALATI ZA BOJE I FORMATIRANJE ================= */
const color = {
    green: s => `\x1b[32m${s}\x1b[0m`,
    red: s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toISO(lbl) {
    const m = lbl.match(/(\d{2})\.(\d{2})/);
    if (!m) return null;
    const d = m[1]; const mo = parseInt(m[2]);
    const now = new Date();
    let y = now.getFullYear();
    // Fix za prijelaz godine (Januar čita Decembar)
    if (mo === 12 && now.getMonth() === 0) y = y - 1;
    return `${y}-${String(mo).padStart(2, '0')}-${d}`;
}
function isoNice(s) { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; }
function rename(n) { return n.includes('B & D') ? 'B&D' : n; }
function fmt4(n) { return String(n).padStart(4); }

/* ================= 3. LOGIKA ZA SUPABASE (ZAŠTITA) ================= */

// Briše samo NEZAŠTIĆENE redove
async function deleteDates(dates) {
    if (!dates.length) return 0;
    const quoted = dates.map(d => `"${d}"`).join(',');
    const url = `${SUPABASE_URL}?date=in.(${encodeURIComponent(quoted)})&urlaub_protected=eq.false`;
    try {
        const r = await axios.delete(url, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=representation' }
        });
        return Array.isArray(r.data) ? r.data.length : 0;
    } catch (e) {
        console.log(color.red('❌ Greška brisanja:'), e.message);
        return 0;
    }
}

// Provjerava je li red zaštićen (urlaub_protected = true)
async function isRowProtected(date, driver) {
    const url = `${SUPABASE_URL}?date=eq.${date}&driver=eq.${driver}&urlaub_protected=eq.true&select=id`;
    try {
        const r = await axios.get(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
        return r.data && r.data.length > 0;
    } catch (e) {
        return false;
    }
}

/* ================= 4. LOGIKA SPAJANJA (WEEKEND MERGE) ================= */
function processWeekendMerge(scrapedData, lastScrapeDates) {
    const correctedData = [...scrapedData];
    for (const iso of lastScrapeDates) {
        const dateObj = new Date(iso);
        if (dateObj.getDay() !== 5) continue; // Samo petak nas zanima

        const nextDay = new Date(dateObj);
        nextDay.setDate(dateObj.getDate() + 1);
        const nextDayIso = nextDay.toISOString().substring(0, 10);

        if (!lastScrapeDates.includes(nextDayIso)) continue;

        const fridayEntries = correctedData.filter(d => d.date === iso);
        const saturdayEntries = correctedData.filter(d => d.date === nextDayIso);

        for (const fridayEntry of fridayEntries) {
            // Ako je petak 0% a ima stopove, traži subotu
            if (fridayEntry.deliveryPercentage === 0 && fridayEntry.totalStops > 0) {
                const saturdayEntry = saturdayEntries.find(d => d.driver === fridayEntry.driver);
                if (saturdayEntry && saturdayEntry.deliveredStops > 0) {
                    // SPAJANJE
                    fridayEntry.stopsForDb = fridayEntry.totalStops;
                    fridayEntry.deliveredStops = fridayEntry.totalStops;
                    console.log(color.yellow(`  [MERGE] ${fridayEntry.driver}: Spajam Subotu u Petak (${iso}).`));
                    saturdayEntry.isMergedAndEmpty = true;
                }
            }
        }
    }
    return correctedData;
}

/* ================= 5. GLAVNI PROGRAM ================= */
async function main() {
    console.log(color.bold(`Supabase URL: ${SUPABASE_URL}`));

    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    let allScrapedData = [];

    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 1280, height: 800 });

        console.log(color.bold('Login GLS...'));
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await sleep(2000);
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await sleep(6000);

        console.log(color.bold('KPI Učitavanje...'));
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        
        // Prihvati kolačiće ako iskoče
        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });
        await sleep(2000);

        // Dohvati datume
        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels
            .map((lbl, idx) => ({ idx, iso: lbl.includes('Keine Daten') ? null : toISO(lbl) }))
            .filter(x => x.iso);
        
        const byIso = new Map();
        for (const m of mapping) if (!byIso.has(m.iso)) byIso.set(m.iso, m);
        
        // Sortiraj i uzmi zadnjih 7 (ili 3 na GitHubu da bude brže)
        const limit = isGitHub ? 3 : DAYS;
        const uniq = [...byIso.values()].sort((a,b) => a.iso.localeCompare(b.iso));
        const lastScrapeDates = uniq.map(x => x.iso).slice(-limit);

        console.log('Datumi:', lastScrapeDates.join(', '));
        
        // Zatvori dropdown klikom sa strane
        await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
        await sleep(1000);

        // --- LOOP SKREPANJA ---
        for (const iso of lastScrapeDates) {
            const info = byIso.get(iso);
            process.stdout.write(`\n[${isoNice(iso)}] Skrepam... `);

            // Odaberi datum
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1500);
            await p.evaluate((idx) => {
                const rs = document.querySelectorAll('ion-radio');
                if (rs[idx]) rs[idx].click();
            }, info.idx);
            
            await sleep(8000); // Čekaj da se učita dashboard

            const cards = await p.$$('app-compact-kpi-list-card ion-card');

            for (const card of cards) {
                const driver = await card.$eval('ion-card-title span', el => el.textContent.trim()).catch(() => '');
                if (!driver) continue;

                // Dohvati sve grupe podataka (Puppeteer verzija tvoje stare logike)
                const stats = await card.evaluate(node => {
                    const getV = (t) => {
                        const g = Array.from(node.querySelectorAll('.group')).find(x => x.innerText.includes(t));
                        return g ? Array.from(g.querySelectorAll('.value span')).map(s => s.innerText.trim()) : [];
                    };
                    return { 
                        vZ: getV('Zustellung'), 
                        vPickup: getV('PickUp'), 
                        vProb: getV('Probleme'), 
                        vP: getV('Produktivität') 
                    };
                });

                const pac = parseInt(stats.vZ[0] || '0', 10);
                const totalStops = parseInt(stats.vP[0] || '0', 10);
                const deliveryProcStr = stats.vZ[1] || '0,00 %';
                
                let deliveryPercentage = 0;
                if (deliveryProcStr) {
                    deliveryPercentage = parseFloat(deliveryProcStr.replace(',', '.').replace('%', '').trim());
                }

                let deliveredStops = 0;
                if (totalStops > 0 && deliveryPercentage > 0) {
                    deliveredStops = Math.round(totalStops * (deliveryPercentage / 100));
                }

                // Filtriranje prema staroj skripti
                if (['8696','8697','8698','8699'].includes(driver)) {
                    if (totalStops < 10) continue;
                } else {
                    if (pac === 0 && totalStops === 0) continue;
                }

                allScrapedData.push({
                    date: iso,
                    driver,
                    zustellung_paketi: pac,
                    zustellung_proc: stats.vZ[1] || '',
                    zustellung_nedostavljeno: stats.vZ[2] || '',
                    pickup_paketi: stats.vPickup[0] || '',
                    pickup_proc: stats.vPickup[1] || '',
                    pickup_nedostavljeno: stats.vPickup[2] || '',
                    probleme_prva: stats.vProb[0] || '',
                    probleme_druga: stats.vProb[1] || '',
                    produktivitaet_stops_pro_std: stats.vP[1] || '',
                    produktivitaet_dauer: stats.vP[2] || '',
                    totalStops,
                    deliveredStops,
                    deliveryPercentage,
                    stopsForDb: deliveredStops,
                    isMergedAndEmpty: false
                });
            }
            process.stdout.write(`OK (${cards.length} kartica)\n`);
        }

        // --- KOREKCIJA (WEEKEND MERGE) ---
        console.log(color.bold('\n--- KOREKCIJA PETAK/SUBOTA ---'));
        const correctedData = processWeekendMerge(allScrapedData, lastScrapeDates);

        // --- BRISANJE I SLANJE ---
        const deleted = await deleteDates(lastScrapeDates);
        console.log(color.bold(`\nObrisano ${deleted} nezaštićenih zapisa.`));

        for (const row of correctedData) {
            if (row.isMergedAndEmpty) continue;

            // 1. Provjera zaštite
            let isProtected = await isRowProtected(row.date, row.driver);
            if (row.driver === 'B & D Kleintransporte KG' && !isProtected) {
                 const components = ['8610', '8620', '8630', '8640'];
                 for (const c of components) {
                     if (await isRowProtected(row.date, c)) { isProtected = true; break; }
                 }
            }

            if (isProtected) {
                console.log(color.red(`  [SKIP PROTECTED] ${row.driver} na ${row.date}`));
                continue;
            }

            // 2. Slanje u bazu
            const rowDb = {
                date: row.date,
                driver: row.driver,
                zustellung_paketi: row.zustellung_paketi,
                zustellung_proc: row.zustellung_proc,
                zustellung_nedostavljeno: row.zustellung_nedostavljeno,
                pickup_paketi: row.pickup_paketi,
                pickup_proc: row.pickup_proc,
                pickup_nedostavljeno: row.pickup_nedostavljeno,
                probleme_prva: row.probleme_prva,
                probleme_druga: row.probleme_druga,
                produktivitaet_stops: row.stopsForDb, // Korigirano
                produktivitaet_stops_pro_std: row.produktivitaet_stops_pro_std,
                produktivitaet_dauer: row.produktivitaet_dauer
            };

            try {
                await axios.post(SUPABASE_URL, rowDb, {
                    headers: { 
                        apikey: SUPABASE_KEY, 
                        Authorization: `Bearer ${SUPABASE_KEY}`,
                        'Prefer': 'resolution=merge-duplicates'
                    }
                });
                console.log(`${color.green('✔')} ${row.driver} -> Baza OK`);
            } catch (e) {
                console.log(color.red('❌ Greška slanja:'), e.message);
            }
        }

        console.log(color.bold('\nGOTOVO.'));
        await browser.close();

    } catch (e) {
        console.log(color.red('FATAL ERROR:'), e);
        if (browser) await browser.close();
        process.exit(1);
    }
}

main();
