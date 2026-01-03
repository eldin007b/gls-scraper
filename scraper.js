#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. DETEKCIJA OKRUŽENJA
const isGitHub = process.env.GITHUB_ACTIONS === 'true';
const puppeteer = require(isGitHub ? 'puppeteer' : 'puppeteer-core');
let blessed;
if (!isGitHub) {
    try { blessed = require('blessed'); } catch (e) {}
}

/* ================= KONFIGURACIJA ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';
const MENU_PATH = path.join(__dirname, 'menu.js');
const SUPABASE_URL = process.env.SUPABASE_URL + '/rest/v1/deliveries';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const ICON_HOUSE = '🏠'; const ICON_BOX = '📦'; const ICON_CHECK = '✅';
const color = { cyan: '{cyan-fg}', green: '{green-fg}', red: '{red-fg}', yellow: '{yellow-fg}', white: '{white-fg}', end: '{/}' };

/* ================= POMOĆNE FUNKCIJE ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fix za Januar 2026 / Decembar 2025
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

/* ================= UI LOGIKA (SAMO ZA TERMUX) ================= */
let screen, statusBar, logList;
if (!isGitHub && blessed) {
    screen = blessed.screen({ smartCSR: true, fullUnicode: true });
    statusBar = blessed.box({ top: 3, height: 3, width: '100%', border: 'line', tags: true, style: { border: { fg: 'cyan' } } });
    logList = blessed.list({ top: 7, left: 0, right: 0, bottom: 1, border: 'line', keys: true, mouse: true, tags: true, scrollbar: { ch: ' ', track: { bg: '#1e293b' }, style: { bg: '#38bdf8' } } });
    screen.append(statusBar); screen.append(logList);
}

function setStatus(txt) {
    if (isGitHub) console.log(`[STATUS] ${txt}`);
    else if (statusBar) { statusBar.setContent(` STATUS: ${txt}`); screen.render(); }
}

function addLogRow(name, total, delivered, pac, date) {
    const drv = rename(name);
    if (isGitHub) console.log(`[DATA] ${isoNice(date)} | ${drv} | T:${total} D:${delivered} P:${pac}`);
    else if (logList) {
        const row = `${color.cyan}${drv.padEnd(10)}${color.end} │ ${ICON_HOUSE} ${total.toString().padEnd(4)} │ ${ICON_CHECK} ${delivered.toString().padEnd(4)} │ ${ICON_BOX} ${pac}`;
        logList.addItem(row); logList.scrollTo(logList.items.length); screen.render();
    }
}

/* ================= IZLAZNA LOGIKA (EIO FIX) ================= */
async function exitToMenu() {
    if (isGitHub) process.exit(0);
    if (screen) screen.destroy();
    process.stdin.pause(); // Fix za EIO grešku
    if (fs.existsSync(MENU_PATH)) {
        setTimeout(() => { spawn('node', [MENU_PATH], { stdio: 'inherit' }).on('exit', () => process.exit(0)); }, 300);
    } else { process.exit(0); }
}

if (screen) screen.key(['left'], async () => await exitToMenu());

/* ================= GLAVNI SCRAPER ================= */
async function runScraper(p, targetDates, byIso) {
    for (const iso of targetDates) {
        setStatus(`Obrađujem datum: ${isoNice(iso)}...`);
        // Otvaranje ion-select i biranje datuma
        await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
        await sleep(1000);
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const info = byIso.get(iso);
        await p.evaluate((idx) => {
            const rs = document.querySelectorAll('ion-radio');
            if (rs[idx]) rs[idx].click();
        }, info.idx);

        await sleep(10000); // Čekanje da se dashboard osvježi

        const cards = await p.$$('app-compact-kpi-list-card ion-card');
        for (const card of cards) {
            const driver = await card.$eval('ion-card-title span', el => el.textContent.trim()).catch(()=>'');
            if (!driver) continue;

            const stats = await card.evaluate(node => {
                const getV = (t) => {
                    const g = Array.from(node.querySelectorAll('.group')).find(x => x.innerText.includes(t));
                    return g ? Array.from(g.querySelectorAll('.value span')).map(s => s.innerText.trim()) : [];
                };
                return { vZ: getV('Zustellung'), vP: getV('Produktivität') };
            });

            const total = parseInt(stats.vP[0] || '0');
            const delPerc = parseFloat((stats.vZ[1] || '0').replace(',', '.').replace('%', '')) || 0;
            const delivered = total > 0 ? Math.round(total * (delPerc / 100)) : 0;
            const pac = parseInt(stats.vZ[0] || '0');

            addLogRow(driver, total, delivered, pac, iso);

            // Slanje u Supabase
            try {
                await axios.post(SUPABASE_URL, {
                    date: iso, driver: driver, zustellung_paketi: pac, produktivitaet_stops: delivered,
                    zustellung_proc: stats.vZ[1] || '0%', produktivitaet_stops_pro_std: stats.vP[1] || ''
                }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
            } catch (err) {}
        }
    }
}

async function main() {
    setStatus('Pokrećem preglednik...');
    const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 1280, height: 800 });

        setStatus('Prijava na GLS Cockpit...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await sleep(2000);
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await sleep(8000);

        setStatus('Učitavam KPI panele...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });
        await sleep(3000);

        // Dohvat dostupnih datuma
        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(3000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels.map((lbl, idx) => ({ idx, iso: toISO(lbl) })).filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));
        const byIso = new Map(); mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        const allDates = [...byIso.keys()].sort();

        if (isGitHub) {
            await runScraper(p, allDates.slice(-3), byIso); // Na GitHubu odradi zadnja 3 dana
        } else {
            // Na mobitelu odradi zadnjih 7 dana automatski radi brzine
            await runScraper(p, allDates.slice(-7), byIso);
        }

        await browser.close();
        setStatus('Sinkronizacija završena uspješno.');
        await sleep(2000);
        await exitToMenu();

    } catch (e) {
        setStatus(`GREŠKA: ${e.message}`);
        if (browser) await browser.close();
        await exitToMenu();
    }
}

main();y
