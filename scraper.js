#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');

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

let blessed, screen, statusBar, logList;
if (!isGitHub) {
    try { blessed = require('blessed'); } catch (e) {}
}

/* ================= 2. KONFIGURACIJA & URL FIX ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';

let base = process.env.SUPABASE_URL.replace(/\/$/, '');
if (base.includes('/rest/v1')) base = base.split('/rest/v1')[0];

const DELIVERIES_URL = `${base}/rest/v1/deliveries`;
const URLAUB_URL = `${base}/rest/v1/urlaub_marks`;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
};

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
const rename = n => n.includes('B & D') ? 'B&D' : n;

const cleanInt = (str) => {
    if (!str) return 0;
    const cleaned = str.split('/')[0].replace(/[^\d-]/g, '');
    const val = parseInt(cleaned);
    return isNaN(val) ? 0 : val;
};

/* ================= 4. UI SETUP (TERMUX ONLY) ================= */
if (!isGitHub && blessed) {
    screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'GLS PRO v18.3' });
    statusBar = blessed.box({ top: 0, height: 3, width: '100%', border: 'line', tags: true, label: ' STATUS ', content: ' Spreman.' });
    logList = blessed.list({ top: 3, left: 0, right: 0, bottom: 0, border: 'line', keys: true, mouse: true, tags: true });
    screen.append(statusBar); screen.append(logList);
}

function logStatus(txt) {
    if (isGitHub) console.log(`[STATUS] ${txt.replace(/{.*?}/g, '')}`);
    else if (statusBar) { statusBar.setContent(` ${txt}`); screen.render(); }
}

function logRow(name, total, delivered, pac) {
    const drv = rename(name);
    let perc = total > 0 ? Math.round((delivered / total) * 100) : 0;
    if (isGitHub) {
        console.log(`  -> [DATA] ${drv} | Ukupno:${total} | Dostavljeno:${delivered} (${perc}%) | Paketi:${pac}`);
    } else if (logList) {
        logList.addItem(` 🚛 ${drv.padEnd(8)} │ T:${total.toString().padStart(3)} │ D:${delivered.toString().padStart(3)} │ ${perc}% │ P:${pac}`);
        logList.scrollTo(logList.items.length);
        screen.render();
    }
}

/* ================= 5. GLAVNI PROGRAM ================= */
async function main() {
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 393, height: 851, isMobile: true });

        logStatus('Prijava na GLS...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Prihvati kolačiće ako se pojave
        try {
            await p.waitForSelector('button', { timeout: 5000 });
            await p.evaluate(() => {
                const b = Array.from(document.querySelectorAll('button')).find(el => el.innerText.includes('Akzeptieren'));
                if (b) b.click();
            });
        } catch (e) {}

        // Unos Username
        await p.waitForSelector('input[name="username"]', { timeout: 20000 });
        await p.type('input[name="username"]', GLS_USER);
        await p.keyboard.press('Enter');

        // Čekanje Password polja - rješava "Execution context was destroyed"
        await p.waitForSelector('input[name="password"]', { visible: true, timeout: 20000 });
        await sleep(1000); 
        await p.type('input[name="password"]', GLS_PASS);
        await p.keyboard.press('Enter');

        await p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

        logStatus('Otvaram KPI stranicu...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });

        await sleep(4000);
        await p.evaluate(() => {
            const b = document.querySelector('ion-backdrop'); if(b) b.click();
            const s = document.querySelector('ion-select'); if(s) s.click();
        });
        await p.waitForSelector('ion-radio', { timeout: 20000 });

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels.map((lbl, idx) => ({ idx, iso: toISO(lbl) })).filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));
        const byIso = new Map(); mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        
        // Uzimamo zadnja 3 dana
        const targetDates = [...byIso.keys()].sort().slice(-3);

        for (const iso of targetDates) {
            logStatus(`Čitam datum: ${isoNice(iso)}`);

            let transferMap = {};
            try {
                const resU = await axios.get(`${URLAUB_URL}?date=eq.${iso}&is_active=eq.true`, { headers });
                if (resU.data) resU.data.forEach(u => { transferMap[u.driver] = u.target_driver; });
            } catch (e) {}

            await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
            await sleep(500);
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1500);
            const info = byIso.get(iso);
            await p.evaluate((idx) => document.querySelectorAll('ion-radio')[idx].click(), info.idx);
            await sleep(7000);

            const cards = await p.$$('app-compact-kpi-list-card ion-card');
            const dailyData = {};

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

                // --- TERMUX MATEMATIKA (IZRAČUN DOSTAVLJENIH) ---
                const totalStops = cleanInt(raw['Produktivität']?.[0]);
                const procStr = raw['Zustellung']?.[1] || '0,00%';
                const procNum = parseFloat(procStr.replace(',', '.').replace('%', '')) / 100 || 0;
                
                // Izračunavamo točan broj (npr. 100 adresa * 0.85 = 85 dostavljenih)
                const deliveredStops = Math.round(totalStops * procNum);

                const finalDriver = transferMap[driverName] || driverName;

                if (!dailyData[finalDriver]) {
                    dailyData[finalDriver] = {
                        date: iso, driver: finalDriver, zustellung_paketi: 0, pickup_paketi: 0, produktivitaet_stops: 0,
                        _raw_total_for_log: 0,
                        zustellung_proc: procStr,
                        zustellung_nedostavljeno: raw['Zustellung']?.[2] || '0 / 0',
                        pickup_proc: raw['PickUp']?.[1] || '0,00%',
                        pickup_nedostavljeno: raw['PickUp']?.[2] || '0 / 0',
                        probleme_prva: raw['Probleme']?.[0] || '0',
                        probleme_druga: raw['Probleme']?.[1] || '-',
                        produktivitaet_stops_pro_std: raw['Produktivität']?.[1] || '0',
                        produktivitaet_dauer: raw['Produktivität']?.[2] || '0:00'
                    };
                }
                dailyData[finalDriver].zustellung_paketi += cleanInt(raw['Zustellung']?.[0]);
                dailyData[finalDriver].produktivitaet_stops += deliveredStops; // U bazu ide izračunati broj
                dailyData[finalDriver]._raw_total_for_log += totalStops;
                dailyData[finalDriver].pickup_paketi += cleanInt(raw['PickUp']?.[0]);
            }

            for (const dKey in dailyData) {
                try {
                    const { _raw_total_for_log, ...payload } = dailyData[dKey];
                    await axios.post(`${DELIVERIES_URL}?on_conflict=date,driver`, payload, {
                        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' }
                    });
                    logRow(payload.driver, _raw_total_for_log, payload.produktivitaet_stops, payload.zustellung_paketi);
                } catch(e) {}
            }
        }
        logStatus('{green-fg}GOTOVO!{/green-fg}');
        await browser.close();
        if (isGitHub) process.exit(0);
    } catch (e) {
        logStatus(`GREŠKA: ${e.message}`);
        if(browser) await browser.close();
        process.exit(1);
    }
}
main();
