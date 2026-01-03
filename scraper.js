#!/usr/bin/env node
'use strict';

require('dotenv').config();
const blessed = require('blessed');
const puppeteer = require('puppeteer-core');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/* ================= KONFIGURACIJA ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';

// Supabase URL logika
let cleanBaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : '';
const apiPath = '/rest/v1/deliveries';
if (cleanBaseUrl.endsWith(apiPath)) cleanBaseUrl = cleanBaseUrl.slice(0, -apiPath.length);
const SUPABASE_URL = cleanBaseUrl + apiPath;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const ICON_HOUSE = '🏠';
const ICON_BOX   = '📦';
const ICON_CHECK = '✅';

const color = { cyan: '{cyan-fg}', green: '{green-fg}', red: '{red-fg}', yellow: '{yellow-fg}', white: '{white-fg}', end: '{/}' };

/* ================= UTILS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getW() {
    const total = Math.max(screen.width - 4, 40);
    return {
        drv:  Math.floor(total * 0.22),
        h:    Math.floor(total * 0.20),
        chk:  Math.floor(total * 0.20),
        box:  Math.floor(total * 0.18),
        extra: Math.floor(total * 0.20)
    };
}

function P(text, width) {
    let s = String(text || '');
    const clean = s.replace(/{.*?}/g, '');
    const padding = width - clean.length;
    return s + ' '.repeat(padding > 0 ? padding : 0);
}

/* ================= SCREEN SETUP ================= */
const screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'GLS AUTO SCRAPER' });

const header = blessed.box({
    top: 0, height: 3, width: '100%', align: 'center', tags: true,
    style: { bg: '#020617', fg: 'cyan', bold: true },
    content: '\n💎 {bold}GLS AUTO SCRAPER (Zadnja 2 dana){/bold}'
});

const statusBar = blessed.box({
    top: 3, height: 3, width: '100%', border: 'line', tags: true,
    label: ' STATUS ', style: { border: { fg: 'cyan' }, bg: '#0f172a' },
    content: ' Inicijalizacija...'
});

const legend = blessed.box({
    top: 6, left: 0, width: '100%', height: 1, tags: true,
    style: { bg: '#020617' },
    content: ` VOZAČ      │ ${ICON_HOUSE} TOTAL │ ${ICON_CHECK} DELIV │ ${ICON_BOX} PKTS │ {red-fg}EXIT{/}`
});

const logList = blessed.list({
    top: 7, left: 0, right: 0, bottom: 1, border: 'line',
    keys: true, mouse: true, tags: true,
    scrollbar: { ch: ' ', track: { bg: '#1e293b' }, style: { bg: '#38bdf8' } },
    style: { border: { fg: '#1e293b' }, selected: { bg: '#0f172a', bold: true } }
});

screen.append(header); screen.append(statusBar); screen.append(legend); screen.append(logList);

function setStatus(txt) { statusBar.setContent(` ${txt}`); screen.render(); }

/* ================= DATUM FIX (2025/2026) ================= */
const toISO = (lbl) => {
    const m = lbl.match(/(\d{2})\.(\d{2})/);
    if (!m) return null;
    const d = m[1];
    const mo = parseInt(m[2]);
    const now = new Date();
    let y = now.getFullYear();
    // Ako je labela decembar, a mi smo u januaru, to je prošla godina
    if (mo === 12 && now.getMonth() === 0) y = y - 1;
    return `${y}-${String(mo).padStart(2, '0')}-${d}`;
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const rename = n => n.includes('B & D') ? 'B&D' : n;

function addDateHeader(date) {
    const total = Math.max(screen.width - 6, 20);
    const dateTxt = ` ${isoNice(date)} `;
    const side = "─".repeat(Math.max(0, Math.floor((total - dateTxt.length) / 2)));
    logList.addItem(`{yellow-fg}${side}${dateTxt}${side}{/}`);
    screen.render();
}

function addLogRow(name, total, delivered, pac) {
    const W = getW();
    const drvName = rename(name);
    const rowStr = `${color.cyan}${P(drvName, W.drv)}${color.end}│` +
                   `${ICON_HOUSE} ${P(total, W.h-3)}│` +
                   `${ICON_CHECK} ${P(delivered, W.chk-3)}│` +
                   `${ICON_BOX} ${color.yellow}${P(pac, W.box-3)}${color.end}`;
    logList.addItem(rowStr);
    logList.scrollTo(logList.items.length);
    screen.render();
}

/* ================= EXIT LOGIC (NO MENU RETURN) ================= */
let currentBrowser = null;
let forceStop = false;

async function exitProgram() {
    forceStop = true;
    setStatus('{red-fg}Gašenje...{/red-fg}');
    if (currentBrowser) try { await currentBrowser.close(); } catch(e) {}
    screen.destroy();
    process.exit(0); // Samo ugasi skriptu, nema povratka na menu
}

screen.key(['q', 'C-c', 'escape'], async () => await exitProgram());

/* ================= NOVE FUNKCIJE: DELETE ================= */
async function deleteDates(dates) {
    if (!dates || dates.length === 0) return;
    
    // Formatiranje za Supabase IN filter: "2026-01-01","2026-01-02"
    const quoted = dates.map(d => `"${d}"`).join(',');
    const url = `${SUPABASE_URL}?date=in.(${quoted})`;
    
    setStatus(`{red-fg}Brišem stare podatke za: ${dates.map(isoNice).join(', ')}...{/red-fg}`);
    
    try {
        await axios.delete(url, {
            headers: { 
                apikey: SUPABASE_KEY, 
                Authorization: `Bearer ${SUPABASE_KEY}` 
            }
        });
        await sleep(1000);
    } catch (e) {
        setStatus(`{red-fg}Greška pri brisanju: ${e.message}{/red-fg}`);
        await sleep(2000);
    }
}

/* ================= MAIN PROGRAM ================= */
async function main() {
    setStatus('{yellow-fg}Pokrećem Chromium...{/yellow-fg}');
    try {
        currentBrowser = await puppeteer.launch({
            executablePath: CHROMIUM_PATH,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const p = await currentBrowser.newPage();
        await p.setViewport({ width: 400, height: 800 });

        setStatus('{yellow-fg}Prijava na GLS...{/yellow-fg}');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await sleep(2000);
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await sleep(8000);

        setStatus('{yellow-fg}Dohvaćam datume iz KPI...{/yellow-fg}');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });

        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });

        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(3000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));

        // Mapiranje datuma
        const mapping = labels
            .map((lbl, idx) => ({ idx, iso: toISO(lbl) }))
            .filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));

        const byIso = new Map();
        mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        const allDates = [...byIso.keys()].sort();

        // --- AUTOMATSKI ODABIR ZADNJA 2 DANA ---
        const targetDates = allDates.slice(-2); // Uzima zadnja 2

        if (targetDates.length === 0) {
            setStatus('{red-fg}Nema dostupnih podataka!{/red-fg}');
            await sleep(3000);
            await exitProgram();
        }

        // --- BRISANJE PODATAKA ---
        await deleteDates(targetDates);

        // --- POKRETANJE SKREPANJA ---
        await startScraping(p, targetDates, byIso);
        
        // --- KRAJ ---
        await exitProgram();

    } catch (e) {
        setStatus(`{red-fg}ERROR: ${e.message}{/red-fg}`);
        await sleep(5000); 
        await exitProgram();
    }
}

async function startScraping(p, targetDates, byIso) {
    for (const iso of targetDates) {
        if(forceStop) break;
        addDateHeader(iso);
        setStatus(`Skrepam: {bold}${isoNice(iso)}{/bold}...`);

        await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
        await sleep(500);
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(1500);

        const info = byIso.get(iso);
        await p.evaluate((idx) => {
            const rs = document.querySelectorAll('ion-radio');
            if (rs[idx]) rs[idx].click();
        }, info.idx);

        await sleep(8000); // Malo smanjeno vrijeme čekanja radi brzine

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

            addLogRow(driver, total, delivered, parseInt(data.vZ[0] || '0'));

            try {
                await axios.post(SUPABASE_URL, {
                    date: iso,
                    driver: driver,
                    zustellung_paketi: parseInt(data.vZ[0] || '0'),
                    produktivitaet_stops: delivered
                }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
            } catch(err) {}
        }
        logList.addItem(' ');
    }
    setStatus('{green-fg}GOTOVO! Gasim se...{/green-fg}');
    await sleep(2000);
}

main();
