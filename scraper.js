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

let blessed, screen, statusBar, logList, selector;
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

const color = { cyan: '{cyan-fg}', green: '{green-fg}', red: '{red-fg}', yellow: '{yellow-fg}', white: '{white-fg}', bold: '{bold}', end: '{/}' };

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
    screen = blessed.screen({
        smartCSR: true, fullUnicode: true, title: 'GLS PRO v18.2',
        input: process.stdin, output: process.stdout, terminal: 'xterm-256color'
    });
    const header = blessed.box({
        top: 0, height: 3, width: '100%', align: 'center', tags: true,
        style: { bg: '#1e293b', fg: 'cyan', bold: true },
        content: '\n💎 {bold}GLS COCKPIT PRO v18.2 (SMART TRANSFER){/bold}'
    });
    statusBar = blessed.box({
        top: 3, height: 3, width: '100%', border: 'line', tags: true,
        label: ' STATUS ', style: { border: { fg: 'cyan' }, bg: '#0f172a' }, content: ' Spreman.'
    });
    const legend = blessed.box({
        top: 6, left: 0, width: '100%', height: 1, tags: true,
        style: { bg: '#020617', fg: 'white' },
        content: ` {bold}VOZAČ{/bold}       │ UKUPNO│ DOST │  %  │ PAKETI`
    });
    logList = blessed.list({
        top: 7, left: 0, right: 0, bottom: 0, border: 'line', keys: true, mouse: true, tags: true,
        scrollbar: { ch: ' ', track: { bg: '#1e293b' }, style: { bg: '#38bdf8' } },
        style: { border: { fg: '#334155' }, item: { fg: 'white' }, selected: { bg: '#1e293b', bold: true } }
    });
    selector = blessed.box({
        parent: screen, top: 'center', left: 'center', width: 50, height: 14,
        border: 'line', shadow: true, draggable: true, align: 'center',
        label: ' {bold}{cyan-fg} SINKRONIZACIJA {/cyan-fg}{/bold} ', tags: true, hidden: true,
        style: { border: { fg: 'cyan' }, bg: '#0f172a', fg: 'white' }
    });
    screen.append(header); screen.append(statusBar); screen.append(legend); screen.append(logList); screen.append(selector);
}

function logStatus(txt) {
    if (isGitHub) console.log(`[STATUS] ${txt.replace(/{.*?}/g, '')}`);
    else if (statusBar) { statusBar.setContent(` ${txt}`); screen.render(); }
}

function addDateHeader(date) {
    if (!logList) return;
    logList.addItem('');
    const dateStr = ` 📅  ${isoNice(date)} `;
    logList.addItem(`{center}{black-bg}{white-fg}{bold}   ${dateStr}   {/bold}{/white-fg}{/black-bg}{/center}`);
    logList.addItem('');
}

function logRow(name, total, delivered, pac) {
    const drv = rename(name);
    let perc = total > 0 ? Math.round((delivered / total) * 100) : 0;
    const percStr = `${perc}%`.padStart(4);
    const limits = { '8610': 50, '8620': 85, '8630': 85, '8640': 80 };
    let statColor = '{red-fg}';
    if (drv === 'B&D') { if (delivered > 300) statColor = '{green-fg}'; }
    else if (limits[drv] !== undefined) { if (delivered >= limits[drv]) statColor = '{green-fg}'; }
    else { if (perc >= 90) statColor = '{green-fg}'; else if (perc >= 75) statColor = '{yellow-fg}'; }

    if (isGitHub) {
        console.log(`  -> [DATA] ${drv} | T:${total} D:${delivered} (${perc}%) P:${pac}`);
        return;
    }
    if (logList) {
        const t = total.toString().padStart(4);
        const d = delivered.toString().padStart(4);
        const p = pac.toString().padStart(4);
        const row = drv === 'B&D'
            ? `{bold}{white-fg}🏢 ${drv.padEnd(8)} │ ${t}  │ ${statColor}${d}{/} │ ${statColor}${percStr}{/} │ ${color.yellow}${p}{/}`
            : `{cyan-fg}  🚛 ${drv.padEnd(8)}{/} │ ${t}  │ ${statColor}${d}{/} │ ${statColor}${percStr}{/} │ ${p}`;
        logList.addItem(row);
        logList.scrollTo(logList.items.length);
        screen.render();
    }
}

function returnToMenu() {
    if (isGitHub) process.exit(0);
    if (screen) screen.destroy();
    process.exit(0);
}

let daysCount = 3;
function updateSelector(maxDays) {
    selector.setContent(`\n{bold}ODABIR RAZDOBLJA{/bold}\n\nKoliko dana želiš povući?\n\n{yellow-fg}{bold}◀   [ ${daysCount} DANA ]   ▶{/bold}{/yellow-fg}\n\n\n{gray-fg}⬆/⬇: +/- Dan   ⬅: Natrag   ⮕: START{/gray-fg}`);
    screen.render();
}

function waitForUserSelection(maxDays) {
    return new Promise((resolve) => {
        if (!selector) return resolve(3);
        selector.show(); selector.focus(); updateSelector(maxDays);
        const onKey = (ch, key) => {
            if (key.name === 'up') { if (daysCount < maxDays) daysCount++; updateSelector(maxDays); }
            else if (key.name === 'down') { if (daysCount > 1) daysCount--; updateSelector(maxDays); }
            else if (key.name === 'left') { returnToMenu(); }
            else if (key.name === 'right' || key.name === 'enter') {
                selector.hide(); screen.removeListener('keypress', onKey); resolve(daysCount);
            }
        };
        screen.on('keypress', onKey);
    });
}

/* ================= 5. GLAVNI PROGRAM ================= */
async function main() {
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 393, height: 851, isMobile: true });

        logStatus('Prijava na GLS...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2', timeout: 90000 });

        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(el => el.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });

        await p.waitForSelector('input[name="username"]', { timeout: 30000 });
        await p.type('input[name="username"]', GLS_USER);
        await p.keyboard.press('Enter');
        await p.waitForSelector('input[name="password"]', { timeout: 30000 });
        await p.type('input[name="password"]', GLS_PASS);
        await p.keyboard.press('Enter');
        await p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(()=>{});

        logStatus('Otvaram KPI stranicu...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });

        await sleep(3000);
        await p.evaluate(() => {
            const b = document.querySelector('ion-backdrop'); if(b) b.click();
            const s = document.querySelector('ion-select'); if(s) s.click();
        });
        await p.waitForSelector('ion-radio', { timeout: 20000 });

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels.map((lbl, idx) => ({ idx, iso: toISO(lbl) })).filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));
        const byIso = new Map(); mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        const allDates = [...byIso.keys()].sort();

        let targetDates = isGitHub ? allDates.slice(-3) : allDates.slice(-(await waitForUserSelection(allDates.length)));

        for (const iso of targetDates) {
            if(!isGitHub) addDateHeader(iso);
            logStatus(`Čitam: ${isoNice(iso)}`);

            let transferMap = {};
            let driversOnUrlaub = new Set();
            try {
                const resU = await axios.get(`${URLAUB_URL}?date=eq.${iso}&is_active=eq.true`, { headers });
                if (resU.data) resU.data.forEach(u => { transferMap[u.driver] = u.target_driver; driversOnUrlaub.add(u.driver); });
            } catch (e) {}

            await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
            await sleep(500);
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1500);
            const info = byIso.get(iso);
            await p.evaluate((idx) => document.querySelectorAll('ion-radio')[idx].click(), info.idx);
            await sleep(6000);

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

                // Izračun dostavljenih stopova
                const curTotalStops = cleanInt(raw['Produktivität']?.[0]);
                const nedostavljenoRaw = raw['Zustellung']?.[2] || '0 / 0';
                const nedostavljenoStops = cleanInt(nedostavljenoRaw.split('/')[0]);
                const curDeliveredStops = curTotalStops - nedostavljenoStops;

                const curPaketi = cleanInt(raw['Zustellung']?.[0]);
                const curPickups = cleanInt(raw['PickUp']?.[0]);
                const finalDriver = transferMap[driverName] || driverName;

                if (!dailyData[finalDriver]) {
                    dailyData[finalDriver] = {
                        date: iso, driver: finalDriver, zustellung_paketi: 0, pickup_paketi: 0, produktivitaet_stops: 0,
                        raw_total_stops: 0, // Čuvamo originalni total samo za log prikaz
                        zustellung_proc: raw['Zustellung']?.[1] || '0,00%', zustellung_nedostavljeno: raw['Zustellung']?.[2] || '0 / 0',
                        pickup_proc: raw['PickUp']?.[1] || '0,00%', pickup_nedostavljeno: raw['PickUp']?.[2] || '0 / 0',
                        probleme_prva: raw['Probleme']?.[0] || '0', probleme_druga: raw['Probleme']?.[1] || '-',
                        produktivitaet_stops_pro_std: raw['Produktivität']?.[1] || '0', produktivitaet_dauer: raw['Produktivität']?.[2] || '0:00'
                    };
                }
                dailyData[finalDriver].zustellung_paketi += curPaketi;
                dailyData[finalDriver].produktivitaet_stops += curDeliveredStops; // Upisujemo samo dostavljene
                dailyData[finalDriver].raw_total_stops += curTotalStops; // Za log
                dailyData[finalDriver].pickup_paketi += curPickups;

                if (driversOnUrlaub.has(driverName) && !dailyData[driverName]) {
                    dailyData[driverName] = { date: iso, driver: driverName, zustellung_paketi: 0, pickup_paketi: 0, produktivitaet_stops: 0, raw_total_stops: 0, zustellung_proc: '0,00%', produktivitaet_dauer: '0:00' };
                }
            }

            for (const dKey in dailyData) {
                try {
                    const d = dailyData[dKey];
                    // Brišemo privremeni ključ prije slanja u Supabase
                    const payload = { ...d };
                    delete payload.raw_total_stops;

                    await axios.post(`${DELIVERIES_URL}?on_conflict=date,driver`, payload, {
                        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' }
                    });

                    logRow(d.driver, d.raw_total_stops, d.produktivitaet_stops, d.zustellung_paketi);
                } catch(e) {}
            }
        }
        await browser.close();
        if (isGitHub) process.exit(0);
        else { logStatus('{green-fg}GOTOVO! [←] Povratak.{/green-fg}'); screen.key(['left'], () => returnToMenu()); screen.render(); }
    } catch (e) {
        logStatus(`GREŠKA: ${e.message}`);
        if(browser) await browser.close();
        setTimeout(() => returnToMenu(), 5000);
    }
}
main();
