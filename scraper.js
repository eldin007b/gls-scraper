#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/* ================= 1. DETEKCIJA OKRUŽENJA ================= */
const isGitHub = process.env.GITHUB_ACTIONS === 'true';

// Učitaj biblioteke ovisno o okruženju
const puppeteer = require(isGitHub ? 'puppeteer' : 'puppeteer-core');
let blessed, screen, statusBar, logList;

// Blessed učitavamo SAMO ako smo na mobitelu
if (!isGitHub) {
    try { blessed = require('blessed'); } catch (e) {}
}

/* ================= 2. KONFIGURACIJA ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';

// Supabase URL logika
let cleanBaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : '';
const apiPath = '/rest/v1/deliveries';
if (cleanBaseUrl.endsWith(apiPath)) cleanBaseUrl = cleanBaseUrl.slice(0, -apiPath.length);
const SUPABASE_URL = cleanBaseUrl + apiPath;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const ICON_HOUSE = '🏠'; const ICON_BOX = '📦'; const ICON_CHECK = '✅';
const color = { cyan: '{cyan-fg}', green: '{green-fg}', red: '{red-fg}', yellow: '{yellow-fg}', end: '{/}' };

/* ================= 3. UTILS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fix za prijelaz godine (Januar 2026 čita Decembar 2025)
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

/* ================= 4. UI SETUP (SAMO ZA TERMUX) ================= */
if (!isGitHub && blessed) {
    screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'GLS AUTO SCRAPER' });
    
    const header = blessed.box({
        top: 0, height: 3, width: '100%', align: 'center', tags: true,
        style: { bg: '#020617', fg: 'cyan', bold: true },
        content: '\n💎 {bold}GLS AUTO SCRAPER (Zadnja 2 dana){/bold}'
    });

    statusBar = blessed.box({
        top: 3, height: 3, width: '100%', border: 'line', tags: true,
        label: ' STATUS ', style: { border: { fg: 'cyan' }, bg: '#0f172a' },
        content: ' Inicijalizacija...'
    });

    const legend = blessed.box({
        top: 6, left: 0, width: '100%', height: 1, tags: true,
        style: { bg: '#020617' },
        content: ` VOZAČ      │ ${ICON_HOUSE} TOTAL │ ${ICON_CHECK} DELIV │ ${ICON_BOX} PKTS`
    });

    logList = blessed.list({
        top: 7, left: 0, right: 0, bottom: 0, border: 'line',
        keys: true, mouse: true, tags: true,
        scrollbar: { ch: ' ', track: { bg: '#1e293b' }, style: { bg: '#38bdf8' } }
    });

    screen.append(header); screen.append(statusBar); screen.append(legend); screen.append(logList);
    screen.key(['q', 'C-c'], () => process.exit(0));
}

// UNIFIED LOGGING FUNCTION
function logStatus(txt) {
    if (isGitHub) console.log(`[STATUS] ${txt.replace(/{.*?}/g, '')}`);
    else if (statusBar) { statusBar.setContent(` ${txt}`); screen.render(); }
}

function logRow(name, total, delivered, pac, date) {
    const drv = rename(name);
    if (isGitHub) {
        console.log(`[${isoNice(date)}] ${drv.padEnd(10)} | T:${total} D:${delivered} P:${pac}`);
    } else if (logList) {
        // Grafički prikaz na mobitelu
        const row = `${color.cyan}${drv.padEnd(10)}${color.end} │ ${ICON_HOUSE} ${total.toString().padEnd(4)} │ ${ICON_CHECK} ${delivered.toString().padEnd(4)} │ ${ICON_BOX} ${pac}`;
        logList.addItem(row);
        logList.scrollTo(logList.items.length);
        screen.render();
    }
}

/* ================= 5. LOGIKA BRISANJA ================= */
async function deleteDates(dates) {
    if (!dates || dates.length === 0) return;
    const quoted = dates.map(d => `"${d}"`).join(',');
    const url = `${SUPABASE_URL}?date=in.(${quoted})`;
    
    logStatus(`Brišem stare podatke za: ${dates.map(isoNice).join(', ')}...`);
    
    try {
        await axios.delete(url, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
        });
        if(!isGitHub) await sleep(1000);
    } catch (e) {
        logStatus(`Greška brisanja: ${e.message}`);
    }
}

/* ================= 6. GLAVNI PROGRAM ================= */
async function main() {
    logStatus('Pokrećem sustav...');
    
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 1280, height: 800 });

        logStatus('Prijava na GLS...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        if(!isGitHub) await sleep(1000);
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await sleep(5000); // Čekaj login

        logStatus('Dohvaćam KPI podatke...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        
        // Klik na "Prihvati kolačiće"
        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });
        
        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        
        // Mapiranje datuma
        const mapping = labels
            .map((lbl, idx) => ({ idx, iso: toISO(lbl) }))
            .filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));

        const byIso = new Map();
        mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        const allDates = [...byIso.keys()].sort();

        // --- AUTOMATSKI ODABIR ZADNJA 2 DANA ---
        const targetDates = allDates.slice(-2);

        if (targetDates.length === 0) {
            logStatus('Nema podataka za skrepanje!');
            if(browser) await browser.close();
            process.exit(0);
        }

        // 1. Brišemo stare podatke
        await deleteDates(targetDates);

        // 2. Skrepamo nove
        for (const iso of targetDates) {
            if (!isGitHub && logList) {
                logList.addItem(`{yellow-fg}─── ${isoNice(iso)} ───{/}`);
            } else {
                console.log(`--- OBRADA: ${isoNice(iso)} ---`);
            }
            
            logStatus(`Obrađujem: ${isoNice(iso)}`);

            // Reset dropdowna
            await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
            await sleep(500);
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1000);

            const info = byIso.get(iso);
            await p.evaluate((idx) => {
                const rs = document.querySelectorAll('ion-radio');
                if (rs[idx]) rs[idx].click();
            }, info.idx);

            await sleep(8000); // Čekanje učitavanja podataka

            const cards = await p.$$('app-compact-kpi-list-card ion-card');
            for (const card of cards) {
                const driver = await card.$eval('ion-card-title span', el => el.textContent.trim()).catch(()=>'');
                if (!driver) continue;

                const data = await card.evaluate(node => {
                    const getV = (t) => {
                        const g = Array.from(node.querySelectorAll('.group')).find(x => x.innerText.includes(t));
                        return g ? Array.from(g.querySelectorAll('.value span')).map(s => s.innerText.trim()) : [];
                    };
                    return { vZ: getV('Zustellung'), vP: getV('Produktivität') };
                });

                const total = parseInt(data.vP[0] || '0') || 0;
                const delPerc = parseFloat((data.vZ[1] || '0').replace(',', '.').replace('%', '')) || 0;
                let delivered = total > 0 ? Math.round(total * (delPerc / 100)) : 0;
                const pac = parseInt(data.vZ[0] || '0');

                logRow(driver, total, delivered, pac, iso);

                try {
                    await axios.post(SUPABASE_URL, {
                        date: iso,
                        driver: driver,
                        zustellung_paketi: pac,
                        produktivitaet_stops: delivered,
                        zustellung_proc: data.vZ[1] || '0%',
                        produktivitaet_stops_pro_std: data.vP[1] || ''
                    }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
                } catch(err) {}
            }
        }

        logStatus('GOTOVO! Gašenje...');
        await browser.close();
        
        if (screen) screen.destroy();
        process.exit(0);

    } catch (e) {
        logStatus(`FATAL ERROR: ${e.message}`);
        if(browser) await browser.close();
        if (screen) screen.destroy();
        process.exit(1);
    }
}

main();
