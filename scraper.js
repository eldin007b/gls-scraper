#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ================= 1. DETEKCIJA OKRUŽENJA ================= */
const isGitHub = process.env.GITHUB_ACTIONS === 'true';
const puppeteer = require(isGitHub ? 'puppeteer' : 'puppeteer-core');
let blessed;
if (!isGitHub) {
    try { blessed = require('blessed'); } catch (e) {}
}

/* ================= 2. KONFIGURACIJA ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';
const MENU_PATH = path.join(__dirname, 'menu.js');
const SUPABASE_URL = process.env.SUPABASE_URL ? (process.env.SUPABASE_URL.includes('/rest/v1') ? process.env.SUPABASE_URL : process.env.SUPABASE_URL + '/rest/v1/deliveries') : '';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

/* ================= 3. POMOĆNE FUNKCIJE ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fix za prijelaz godine (Januar 2026 čita Decembar 2025)
const toISO = (lbl) => { 
    const m = lbl.match(/(\d{2})\.(\d{2})/); 
    if (!m) return null;
    const d = m[1]; 
    const mo = parseInt(m[2]);
    const now = new Date(); 
    let y = now.getFullYear();
    // Ako je mjesec 12, a trenutno smo u 1. mjesecu, to je prošla godina
    if (mo === 12 && now.getMonth() === 0) y = y - 1; 
    return `${y}-${String(mo).padStart(2, '0')}-${d}`; 
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const rename = n => n.includes('B & D') ? 'B&D' : n;

/* ================= 4. UI LOGIKA (Dual Mode) ================= */
let screen, statusBar, logList;

if (!isGitHub && blessed) {
    screen = blessed.screen({ smartCSR: true, fullUnicode: true });
    statusBar = blessed.box({ top: 3, height: 3, width: '100%', border: 'line', tags: true, style: { border: { fg: 'cyan' } } });
    logList = blessed.list({ top: 7, left: 0, right: 0, bottom: 1, border: 'line', keys: true, mouse: true, tags: true });
    screen.append(statusBar); screen.append(logList);
}

function setStatus(txt) {
    if (isGitHub) console.log(`[STATUS] ${txt}`);
    else if (statusBar) { statusBar.setContent(` STATUS: ${txt}`); screen.render(); }
}

function addLogRow(name, total, delivered, pac, date) {
    const drv = rename(name);
    if (isGitHub) {
        console.log(`[DATA] ${isoNice(date)} | ${drv} | T:${total} D:${delivered} P:${pac}`);
    } else if (logList) {
        const row = `{cyan-fg}${drv.padEnd(10)}{/cyan-fg} │ T:${total} │ D:${delivered} │ P:${pac}`;
        logList.addItem(row);
        logList.scrollTo(logList.items.length);
        screen.render();
    }
}

/* ================= 5. IZLAZNA LOGIKA ================= */
async function exitToMenu() {
    if (isGitHub) {
        console.log("Proces završen. Izlaz.");
        process.exit(0);
    }
    
    if (screen) screen.destroy();
    process.stdin.pause();
    
    if (fs.existsSync(MENU_PATH)) {
        setTimeout(() => {
            spawn('node', [MENU_PATH], { stdio: 'inherit' }).on('exit', () => process.exit(0));
        }, 300);
    } else {
        process.exit(0);
    }
}

if (screen) screen.key(['q', 'C-c', 'left'], async () => await exitToMenu());

/* ================= 6. GLAVNI PROGRAM ================= */
async function runScraper(p, targetDates, byIso) {
    for (const iso of targetDates) {
        setStatus(`Obrađujem: ${isoNice(iso)}...`);
        
        // Resetiranje dropdowna
        await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
        await sleep(500);
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(1500);

        const info = byIso.get(iso);
        if (!info) continue;

        // Klik na radio button za datum
        await p.evaluate((idx) => {
            const rs = document.querySelectorAll('ion-radio');
            if (rs[idx]) rs[idx].click();
        }, info.idx);

        await sleep(8000); // Čekanje da se podaci učitaju

        // Čitanje kartica
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

            // Slanje u bazu
            if (SUPABASE_URL && SUPABASE_KEY) {
                try {
                    await axios.post(SUPABASE_URL, {
                        date: iso, driver: driver, zustellung_paketi: pac, produktivitaet_stops: delivered,
                        zustellung_proc: stats.vZ[1] || '0%', produktivitaet_stops_pro_std: stats.vP[1] || ''
                    }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
                } catch (err) {}
            }
        }
    }
}

async function main() {
    setStatus('Pokrećem sustav...');
    
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

        setStatus('Prijava na GLS...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await sleep(2000);
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await sleep(8000);

        setStatus('Učitavam KPI...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        
        // Klik na "Prihvati" (ako postoji popup)
        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });
        await sleep(2000);

        // Dohvaćanje liste datuma
        await p.waitForSelector('ion-select', { visible: true });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        
        // Mapiranje labela u ISO datume
        const mapping = labels
            .map((lbl, idx) => ({ idx, iso: toISO(lbl) }))
            .filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));

        const byIso = new Map();
        mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        
        const allDates = [...byIso.keys()].sort();
        
        // Na GitHubu uzimamo zadnja 3 dana, na mobitelu zadnjih 7
        const daysToScrape = isGitHub ? 3 : 7;
        const targetDates = allDates.slice(-daysToScrape);

        await runScraper(p, targetDates, byIso);

        await browser.close();
        setStatus('GOTOVO.');
        await exitToMenu();

    } catch (e) {
        setStatus(`GREŠKA: ${e.message}`);
        if (browser) await browser.close();
        await exitToMenu();
    }
}

main();
