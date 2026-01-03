#!/usr/bin/env node
'use strict';

require('dotenv').config();
const blessed = require('blessed');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// DETEKCIJA OKRUŽENJA
const isGitHub = process.env.GITHUB_ACTIONS === 'true';
const puppeteer = require(isGitHub ? 'puppeteer' : 'puppeteer-core');

/* ================= KONFIGURACIJA ================= */
const CHROMIUM_PATH = '/data/data/com.termux/files/usr/bin/chromium-browser';
const MENU_PATH = path.join(__dirname, 'menu.js');
const SUPABASE_URL = process.env.SUPABASE_URL + '/rest/v1/deliveries';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const ICON_HOUSE = '🏠';
const ICON_BOX   = '📦';
const ICON_CHECK = '✅';
const color = { cyan: '{cyan-fg}', green: '{green-fg}', red: '{red-fg}', yellow: '{yellow-fg}', white: '{white-fg}', end: '{/}' };

/* ================= DINAMIČKI DATUM FIX (2025/2026) ================= */
const toISO = (lbl) => { 
    const m = lbl.match(/(\d{2})\.(\d{2})/); 
    if (!m) return null;
    const d = m[1];
    const mo = parseInt(m[2]);
    const now = new Date(); // Danas je 03.01.2026
    let y = now.getFullYear();
    if (mo === 12 && now.getMonth() === 0) y = y - 1; // Ako je 12. mj, a mi smo u 1. mj, godina je 2025.
    return `${y}-${String(mo).padStart(2, '0')}-${d}`; 
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const rename = n => n.includes('B & D') ? 'B&D' : n;

/* ================= SCREEN SETUP (SAMO ZA TERMUX) ================= */
const screen = blessed.screen({ smartCSR: true, fullUnicode: true, dump: isGitHub });
const statusBar = blessed.box({ top: 3, height: 3, width: '100%', border: 'line', tags: true });
const logList = blessed.list({ top: 7, left: 0, right: 0, bottom: 1, border: 'line', keys: true, mouse: true, tags: true });

if (!isGitHub) {
    screen.append(statusBar); 
    screen.append(logList);
}

function setStatus(txt) { 
    if (isGitHub) console.log(`STATUS: ${txt}`);
    else { statusBar.setContent(` STATUS: ${txt}`); screen.render(); }
}

function addLogRow(name, total, delivered, pac) {
    if (isGitHub) console.log(`${rename(name)} | T:${total} | D:${delivered} | P:${pac}`);
    else {
        const rowStr = `${color.cyan}${rename(name)}${color.end} │ ${total} │ ${delivered} │ ${pac}`;
        logList.addItem(rowStr);
        logList.scrollTo(logList.items.length);
        screen.render();
    }
}

/* ================= EXIT LOGIC (FIX ZA MODULE_NOT_FOUND) ================= */
async function exitToMenu() {
    if (isGitHub) {
        console.log("Sinkronizacija završena. Gasim proces.");
        process.exit(0); // Na GitHubu se samo gasi, ne traži menu.js
    }
    
    screen.destroy();
    if (process.stdin.isTTY) process.stdin.pause(); 
    
    // Provjera postoji li menu.js prije pokretanja (samo na mobitelu)
    if (fs.existsSync(MENU_PATH)) {
        setTimeout(() => {
            spawn('node', [MENU_PATH], { stdio: 'inherit' }).on('exit', () => process.exit(0));
        }, 300);
    } else {
        process.exit(0);
    }
}

/* ================= MAIN PROGRAM ================= */
async function main() {
    setStatus(isGitHub ? 'POKRETANJE NA GITHUB-U' : 'POKRETANJE NA MOBITELU');
    
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    try {
        const browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 1280, height: 800 });

        setStatus('Prijava na GLS...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await new Promise(r => setTimeout(r, 2000));
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await new Promise(r => setTimeout(r, 8000));

        setStatus('Provjeravam datume (Januar 2026)...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        
        // ... tvoja logika za skrepanje ...
        // addLogRow(...) pozivaj unutar petlje

        await browser.close();
        setStatus('GOTOVO - Podaci poslani u Supabase.');
        await exitToMenu();

    } catch (e) {
        setStatus(`GREŠKA: ${e.message}`);
        await exitToMenu();
    }
}

main();
