#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/* ================= 1. DETEKCIJA OKRUŽENJA ================= */
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

/* ================= 2. KONFIGURACIJA ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';

let cleanBaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : '';
const apiPath = '/rest/v1/deliveries';
if (cleanBaseUrl.endsWith(apiPath)) cleanBaseUrl = cleanBaseUrl.slice(0, -apiPath.length);
const SUPABASE_URL = cleanBaseUrl + apiPath;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

/* ================= 3. UTILS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const toISO = (lbl) => {
    const m = lbl.match(/(\d{2})\.(\d{2})/);
    if (!m) return null;
    const d = m[1]; const mo = parseInt(m[2]);
    const now = new Date();
    let y = now.getFullYear();
    if (mo === 12 && now.getMonth() === 0) y = y - 1;
    return `${y}-${String(mo).padStart(2, '0')}-${d}`;
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const cleanInt = (str) => {
    if (!str) return 0;
    const cleaned = str.split('/')[0].replace(/[^\d-]/g, ''); 
    const val = parseInt(cleaned);
    return isNaN(val) ? 0 : val;
};

function logStatus(txt) {
    console.log(`[STATUS] ${txt}`);
}

/* ================= 4. GLAVNI PROGRAM ================= */
async function main() {
    logStatus('Pokrećem FULL UPDATE mod (Prepisivanje svih podataka)...');
    
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setUserAgent('Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36');
        await p.setViewport({ width: 393, height: 851, isMobile: true, hasTouch: true });

        // Blokada resursa radi brzine
        await p.setRequestInterception(true);
        p.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        logStatus('Prijava na GLS...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'domcontentloaded' });
        
        await p.waitForSelector('input[name="username"]', { visible: true });
        await p.type('input[name="username"]', GLS_USER);
        await p.keyboard.press('Enter');

        await p.waitForSelector('input[name="password"]', { visible: true });
        await p.type('input[name="password"]', GLS_PASS);
        await p.keyboard.press('Enter');

        await p.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(()=>{});
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'domcontentloaded' });

        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels.map((lbl, idx) => ({ idx, iso: toISO(lbl) })).filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));
        const byIso = new Map(); mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        
        const targetDates = [...byIso.keys()].sort().slice(-3);

        for (const iso of targetDates) {
            logStatus(`Obrađujem: ${isoNice(iso)}`);
            await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
            await sleep(500);
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1000);

            const info = byIso.get(iso);
            await p.evaluate((idx) => { document.querySelectorAll('ion-radio')[idx].click(); }, info.idx);
            await sleep(5000); 

            const cards = await p.$$('app-compact-kpi-list-card ion-card');

            for (const card of cards) {
                const driver = await card.$eval('ion-card-title span', el => el.textContent.trim()).catch(()=>'');
                if (!driver) continue;
                
                const rawData = await card.evaluate(node => {
                    const sections = {};
                    const groups = Array.from(node.querySelectorAll('.group'));
                    groups.forEach(g => {
                        const title = g.querySelector('.title')?.innerText.trim();
                        if (title) {
                            sections[title] = Array.from(g.querySelectorAll('.value span')).map(s => s.innerText.trim());
                        }
                    });
                    return sections;
                });

                const z = rawData['Zustellung'] || [];
                const pk = rawData['PickUp'] || [];
                const pb = rawData['Probleme'] || [];
                const pr = rawData['Produktivität'] || [];

                // Slanje SVIH podataka uključujući i stopove
                try {
                    const payload = {
                        date: iso,
                        driver: driver,
                        zustellung_paketi: cleanInt(z[0]),
                        zustellung_proc: z[1] || '0%',
                        zustellung_nedostavljeno: z[2] || '0 / 0',
                        pickup_paketi: pk[0] || '0',
                        pickup_proc: pk[1] || '0%',
                        pickup_nedostavljeno: pk[2] || '0 / 0',
                        probleme_prva: pb[0] || '0',
                        probleme_druga: pb[1] || '-',
                        produktivitaet_stops: cleanInt(pr[0]), // OVO ĆE SADA PREPISATI SVE U BAZI
                        produktivitaet_stops_pro_std: pr[1] || '0',
                        produktivitaet_dauer: pr[2] || '0:00'
                    };

                    await axios.post(`${SUPABASE_URL}?on_conflict=date,driver`, payload, { 
                        headers: { 
                            apikey: SUPABASE_KEY, 
                            Authorization: `Bearer ${SUPABASE_KEY}`,
                            'Prefer': 'resolution=merge-duplicates'
                        } 
                    });
                    console.log(`  -> [UPDATE OK] ${driver}`);
                } catch(err) {
                    console.error(`  -> [ERR] ${driver}: ${err.message}`);
                }
            }
        }
        logStatus('GOTOVO!');
        await browser.close();
        process.exit(0);
    } catch (e) {
        logStatus(`GREŠKA: ${e.message}`);
        if(browser) await browser.close();
        process.exit(1);
    }
}
main();
