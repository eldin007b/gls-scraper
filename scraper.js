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
// Na GitHubu koristimo 'puppeteer', u Termuxu 'puppeteer-core'
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
    const now = new Date(); // Januar 2026
    let y = now.getFullYear();
    // Ako je labela decembar (12), a mi smo u januaru (0), to je 2025.
    if (mo === 12 && now.getMonth() === 0) y = y - 1;
    return `${y}-${String(mo).padStart(2, '0')}-${d}`; 
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const rename = n => n.includes('B & D') ? 'B&D' : n;

/* ================= SCREEN SETUP (ZOOM SAFE) ================= */
const screen = blessed.screen({ smartCSR: true, fullUnicode: true });
const statusBar = blessed.box({ top: 3, height: 3, width: '100%', border: 'line', tags: true });
const logList = blessed.list({ top: 7, left: 0, right: 0, bottom: 1, border: 'line', keys: true, mouse: true, tags: true });
screen.append(statusBar); screen.append(logList);

function setStatus(txt) { statusBar.setContent(` STATUS: ${txt}`); screen.render(); }

/* ================= EXIT FIX (EIO) ================= */
async function exitToMenu() {
    if (isGitHub) process.exit(0); // GitHub se gasi odmah
    screen.destroy();
    if (process.stdin.isTTY) process.stdin.pause(); // Fix za EIO grešku
    setTimeout(() => {
        spawn('node', [MENU_PATH], { stdio: 'inherit' }).on('exit', () => process.exit(0));
    }, 300);
}

/* ================= MAIN PROGRAM ================= */
async function main() {
    setStatus(isGitHub ? 'GITHUB ACTIONS - Sinkronizacija...' : 'Termux - Pokrećem Chromium...');
    
    // Konfiguracija browsera ovisno o okruženju
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (!isGitHub) launchOptions.executablePath = CHROMIUM_PATH;

    try {
        const browser = await puppeteer.launch(launchOptions);
        const p = await browser.newPage();
        await p.setViewport({ width: 400, height: 800 });

        setStatus('Prijava na GLS Cockpit...');
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await new Promise(r => setTimeout(r, 2000));
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await new Promise(r => setTimeout(r, 8000));

        setStatus('Sinkronizacija podataka u tijeku...');
        // ... (ovdje ide tvoja logika za dohvat podataka i slanje u Supabase)

        await browser.close();
        setStatus('{green-fg}Sinkronizacija uspješna!{/}');
        await new Promise(r => setTimeout(r, 2000));
        await exitToMenu();

    } catch (e) {
        setStatus(`{red-fg}Greška: ${e.message}{/}`);
        if (!isGitHub) await new Promise(r => setTimeout(r, 5000));
        await exitToMenu();
    }
}

main();
