#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');

/* ================= 1. KONFIGURACIJA ================= */
const isGitHub = process.env.GITHUB_ACTIONS === 'true';
let puppeteer;
if (isGitHub) {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    puppeteer = puppeteerExtra;
} else {
    puppeteer = require('puppeteer-core');
}

const SUPABASE_URL = process.env.SUPABASE_URL.replace(/\/$/, '');
const DELIVERIES_URL = `${SUPABASE_URL}/rest/v1/deliveries`;
const URLAUB_URL = `${SUPABASE_URL}/rest/v1/urlaub_marks`;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER = process.env.GLS_USER;
const GLS_PASS = process.env.GLS_PASS;

const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanInt = (str) => {
    if (!str) return 0;
    const cleaned = str.split('/')[0].replace(/[^\d-]/g, ''); 
    const val = parseInt(cleaned);
    return isNaN(val) ? 0 : val;
};
const toISO = (lbl) => {
    const m = lbl.match(/(\d{2})\.(\d{2})/);
    if (!m) return null;
    const d = m[1]; const mo = parseInt(m[2]);
    const now = new Date();
    let y = now.getFullYear();
    if (mo === 12 && now.getMonth() === 0) y = y - 1;
    return `${y}-${String(mo).padStart(2, '0')}-${d}`;
};

/* ================= 2. GLAVNI PROGRAM ================= */
async function main() {
    console.log('[START] Pokrećem Smart Scraper sa zbrajanjem Urlauba...');
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote']
    });

    try {
        const p = await browser.newPage();
        await p.setViewport({ width: 393, height: 851, isMobile: true });

        // Login proces
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('input[name="username"]');
        await p.type('input[name="username"]', GLS_USER);
        await p.keyboard.press('Enter');
        await p.waitForSelector('input[name="password"]');
        await p.type('input[name="password"]', GLS_PASS);
        await p.keyboard.press('Enter');
        await p.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(()=>{});

        // KPI stranica
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels.map((lbl, idx) => ({ idx, iso: toISO(lbl) })).filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));
        const byIso = new Map(); mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        
        const targetDates = [...byIso.keys()].sort().slice(-3);

        for (const iso of targetDates) {
            console.log(`\n[DATUM] Obrađujem: ${iso}`);

            // 1. DOHVATI URLAUB MAPU ZA TAJ DAN
            const { data: urlaubs } = await axios.get(`${URLAUB_URL}?date=eq.${iso}&is_active=eq.true`, { headers });
            const transferMap = {}; // Izvor -> Cilj
            const driversOnUrlaub = new Set();
            if (urlaubs) {
                urlaubs.forEach(u => {
                    transferMap[u.driver] = u.target_driver;
                    driversOnUrlaub.add(u.driver);
                });
            }

            // 2. SKREPAJ PODATKE SA GLS-a
            await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
            await sleep(500);
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1000);
            const info = byIso.get(iso);
            await p.evaluate((idx) => { document.querySelectorAll('ion-radio')[idx].click(); }, info.idx);
            await sleep(5000); 

            const cards = await p.$$('app-compact-kpi-list-card ion-card');
            const dailyData = {}; // Memorija za zbrajanje

            for (const card of cards) {
                const driverName = await card.$eval('ion-card-title span', el => el.textContent.trim()).catch(()=>'');
                if (!driverName) continue;

                const raw = await card.evaluate(node => {
                    const res = {};
                    Array.from(node.querySelectorAll('.group')).forEach(g => {
                        const t = g.querySelector('.title')?.innerText.trim();
                        if (t) res[t] = Array.from(g.querySelectorAll('.value span')).map(s => s.innerText.trim());
                    });
                    return res;
                });

                // Osnovni podaci vozača
                const currentStops = cleanInt(raw['Produktivität']?.[0]);
                const currentPaketi = cleanInt(raw['Zustellung']?.[0]);
                const currentPickups = cleanInt(raw['PickUp']?.[0]);

                // ODREDI CILJNOG VOZAČA (Ako je izvor na odmoru, prebaci na cilj, inače ostaje isti)
                const finalDriver = transferMap[driverName] || driverName;

                if (!dailyData[finalDriver]) {
                    dailyData[finalDriver] = {
                        date: iso,
                        driver: finalDriver,
                        zustellung_paketi: 0,
                        zustellung_proc: raw['Zustellung']?.[1] || '0%',
                        zustellung_nedostavljeno: raw['Zustellung']?.[2] || '0 / 0',
                        pickup_paketi: 0,
                        pickup_proc: raw['PickUp']?.[1] || '0%',
                        pickup_nedostavljeno: raw['PickUp']?.[2] || '0 / 0',
                        probleme_prva: raw['Probleme']?.[0] || '0',
                        probleme_druga: raw['Probleme']?.[1] || '-',
                        produktivitaet_stops: 0,
                        produktivitaet_stops_pro_std: raw['Produktivität']?.[1] || '0',
                        produktivitaet_dauer: raw['Produktivität']?.[2] || '0:00'
                    };
                }

                // ZBRAJANJE (Akumulacija)
                dailyData[finalDriver].zustellung_paketi += currentPaketi;
                dailyData[finalDriver].produktivitaet_stops += currentStops;
                dailyData[finalDriver].pickup_paketi += currentPickups;

                // Ako je vozač na odmoru, osiguraj da on ipak dobije svoj red sa 0
                if (driversOnUrlaub.has(driverName)) {
                    dailyData[driverName] = {
                        date: iso,
                        driver: driverName,
                        zustellung_paketi: 0,
                        produktivitaet_stops: 0,
                        pickup_paketi: 0,
                        zustellung_proc: '0%',
                        produktivitaet_dauer: '0:00',
                        deleted: 0
                    };
                }
            }

            // 3. POŠALJI SVE U BAZU (UPSERT)
            for (const driverKey in dailyData) {
                try {
                    await axios.post(`${DELIVERIES_URL}?on_conflict=date,driver`, dailyData[driverKey], { 
                        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' } 
                    });
                    console.log(`  -> [DB OK] ${driverKey}: P:${dailyData[driverKey].zustellung_paketi} S:${dailyData[driverKey].produktivitaet_stops}`);
                } catch(err) {
                    console.error(`  -> [DB ERR] ${driverKey}: ${err.message}`);
                }
            }
        }

    } catch (e) {
        console.error('[FATAL ERROR]', e.message);
    } finally {
        await browser.close();
        process.exit(0);
    }
}

main();
