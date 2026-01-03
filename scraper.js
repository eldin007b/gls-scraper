#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/* ================= 1. DETEKCIJA OKRUŽENJA ================= */
const isGitHub = process.env.GITHUB_ACTIONS === 'true';
const puppeteer = require(isGitHub ? 'puppeteer' : 'puppeteer-core');
let blessed, screen, statusBar, logList;

if (!isGitHub) {
    try { blessed = require('blessed'); } catch (e) {}
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

const ICON_HOUSE = '🏠'; const ICON_BOX = '📦'; const ICON_CHECK = '✅';
const color = { cyan: '{cyan-fg}', green: '{green-fg}', red: '{red-fg}', yellow: '{yellow-fg}', end: '{/}' };

/* ================= 3. UTILS ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const toISO = (lbl) => {
    const m = lbl.match(/(\d{2})\.(\d{2})/);
    if (!m) return null;
    const d = m[1]; const mo = parseInt(m[2]);
    const now = new Date();
    let y = now.getFullYear();
    // Fix za 2026 (Januar čita Decembar)
    if (mo === 12 && now.getMonth() === 0) y = y - 1;
    return `${y}-${String(mo).padStart(2, '0')}-${d}`;
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const rename = n => n.includes('B & D') ? 'B&D' : n;

/* ================= 4. UI SETUP ================= */
if (!isGitHub && blessed) {
    screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'GLS AUTO SCRAPER' });
    const header = blessed.box({ top: 0, height: 3, width: '100%', align: 'center', tags: true, style: { bg: '#020617', fg: 'cyan', bold: true }, content: '\n💎 {bold}GLS AUTO SCRAPER v12.4{/bold}' });
    statusBar = blessed.box({ top: 3, height: 3, width: '100%', border: 'line', tags: true, label: ' STATUS ', style: { border: { fg: 'cyan' }, bg: '#0f172a' }, content: ' Inicijalizacija...' });
    logList = blessed.list({ top: 7, left: 0, right: 0, bottom: 0, border: 'line', keys: true, mouse: true, tags: true });
    screen.append(header); screen.append(statusBar); screen.append(logList);
    screen.key(['q', 'C-c'], () => process.exit(0));
}

function logStatus(txt) {
    if (isGitHub) console.log(`[STATUS] ${txt.replace(/{.*?}/g, '')}`);
    else if (statusBar) { statusBar.setContent(` ${txt}`); screen.render(); }
}

function logRow(name, total, delivered, pac, date) {
    const drv = rename(name);
    if (isGitHub) {
        console.log(`[${isoNice(date)}] ${drv.padEnd(10)} | T:${total} D:${delivered} P:${pac}`);
    } else if (logList) {
        const row = `${color.cyan}${drv.padEnd(10)}${color.end} │ ${ICON_HOUSE} ${total.toString().padEnd(4)} │ ${ICON_CHECK} ${delivered.toString().padEnd(4)} │ ${ICON_BOX} ${pac}`;
        logList.addItem(row); logList.scrollTo(logList.items.length); screen.render();
    }
}

/* ================= 5. LOGIKA BRISANJA ================= */
async function deleteDates(dates) {
    if (!dates || dates.length === 0) return;
    const quoted = dates.map(d => `"${d}"`).join(',');
    const url = `${SUPABASE_URL}?date=in.(${quoted})`;
    logStatus(`Brišem stare podatke...`);
    try {
        await axios.delete(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
        if(!isGitHub) await sleep(1000);
    } catch (e) { logStatus(`Greška brisanja: ${e.message}`); }
}

/* ================= 6. GLAVNI PROGRAM ================= */
async function main() {
    logStatus('Pokrećem sustav...');
    
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await p.setViewport({ width: 1920, height: 1080 });

        logStatus('Otvaram GLS login...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2', timeout: 60000 });

        // --- FIX: PRVO RIJEŠI KOLAČIĆE (Cookie Banner) ---
        // Ponekad banner prekrije input polja pa ih skripta ne vidi
        logStatus('Provjeravam kolačiće...');
        try {
            // Tražimo gumb koji sadrži tekst "Akzeptieren"
            const cookieBtn = await p.waitForSelector('button', { timeout: 5000 }).then(async () => {
                return await p.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    return buttons.find(b => b.innerText.includes('Akzeptieren'));
                });
            });

            if (cookieBtn) {
                logStatus('Prihvaćam kolačiće...');
                await cookieBtn.click();
                await sleep(1000); // Daj vremena da se makne
            }
        } catch (e) {
            // Nije strašno ako nema bannera
        }

        // --- LOGIN DIO ---
        logStatus('Tražim username polje...');
        
        // Čekamo bilo koji input, ne samo username, da budemo sigurni da je forma tu
        await p.waitForSelector('input', { visible: true, timeout: 60000 });
        
        // Sada specifično username
        const userInput = await p.$('input[name="username"]');
        if (!userInput) throw new Error("Polje 'username' nije pronađeno nakon učitavanja!");

        await p.type('input[name="username"]', GLS_USER);
        await sleep(500);
        await p.keyboard.press('Enter');

        logStatus('Tražim password polje...');
        await p.waitForSelector('input[name="password"]', { visible: true, timeout: 60000 });
        await sleep(1000);
        await p.type('input[name="password"]', GLS_PASS);
        await sleep(500);
        await p.keyboard.press('Enter');

        await p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
        logStatus('Prijavljen! Idem na KPI...');

        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        
        // Opet provjera kolačića na KPI stranici
        try {
           await p.evaluate(() => {
                const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
                if (b) b.click();
            });
        } catch(e) {}

        await p.waitForSelector('ion-select', { visible: true, timeout: 60000 });
        await p.evaluate(() => document.querySelector('ion-select').click());
        await sleep(2000);

        const labels = await p.$$eval('ion-radio', els => els.map(el => el.textContent.trim()));
        const mapping = labels.map((lbl, idx) => ({ idx, iso: toISO(lbl) })).filter(x => x.iso && !labels[x.idx].includes('Keine Daten'));
        const byIso = new Map(); mapping.forEach(m => { if(!byIso.has(m.iso)) byIso.set(m.iso, m); });
        const allDates = [...byIso.keys()].sort();
        const targetDates = allDates.slice(-2); // Zadnja 2 dana

        if (targetDates.length === 0) {
            logStatus('Nema podataka!');
            await browser.close();
            process.exit(0);
        }

        await deleteDates(targetDates);

        for (const iso of targetDates) {
            logStatus(`Obrađujem: ${isoNice(iso)}`);
            await p.evaluate(() => { const pop = document.querySelector('ion-popover'); if(pop) pop.dismiss(); });
            await sleep(500);
            await p.evaluate(() => document.querySelector('ion-select').click());
            await sleep(1000);

            const info = byIso.get(iso);
            await p.evaluate((idx) => { const rs = document.querySelectorAll('ion-radio'); if (rs[idx]) rs[idx].click(); }, info.idx);
            
            await sleep(8000); 

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
                const delivered = total > 0 ? Math.round(total * (delPerc / 100)) : 0;
                const pac = parseInt(data.vZ[0] || '0');

                logRow(driver, total, delivered, pac, iso);

                try {
                    await axios.post(SUPABASE_URL, {
                        date: iso, driver: driver, zustellung_paketi: pac, produktivitaet_stops: delivered,
                        zustellung_proc: data.vZ[1] || '0%', produktivitaet_stops_pro_std: data.vP[1] || ''
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
        
        // DEBUG: Ako smo na GitHubu, ispiši HTML da vidimo što preglednik vidi
        if (isGitHub && browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    const content = await pages[0].content();
                    console.log("--- DEBUG: PAGE CONTENT START ---");
                    console.log(content.substring(0, 2000)); // Prvih 2000 znakova
                    console.log("--- DEBUG: PAGE CONTENT END ---");
                }
            } catch(dbge) {}
        }
        
        if(browser) await browser.close();
        if (screen) screen.destroy();
        process.exit(1);
    }
}

main();
