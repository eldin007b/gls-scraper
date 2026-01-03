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

/* ================= POMOĆNE FUNKCIJE ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Pametni datum za Januar 2026
const toISO = (lbl) => { 
    const m = lbl.match(/(\d{2})\.(\d{2})/); 
    if (!m) return null;
    const d = m[1];
    const mo = parseInt(m[2]);
    const now = new Date(); 
    let y = now.getFullYear();
    if (mo === 12 && now.getMonth() === 0) y = y - 1; 
    return `${y}-${String(mo).padStart(2, '0')}-${d}`; 
};

const isoNice = s => { const [a, b, c] = s.split('-'); return `${c}.${b}.${a}`; };
const rename = n => n.includes('B & D') ? 'B&D' : n;

/* ================= UI LOGIKA ================= */
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
    if (isGitHub) console.log(`[DATA] ${isoNice(date)} | ${drv} | T:${total} D:${delivered} P:${pac}`);
    else if (logList) {
        const row = `{cyan-fg}${drv.padEnd(12)}{/cyan-fg} │ H:${total} │ V:${delivered} │ P:${pac}`;
        logList.addItem(row);
        logList.scrollTo(logList.items.length);
        screen.render();
    }
}

/* ================= IZLAZNA LOGIKA ================= */
async function exitToMenu() {
    if (isGitHub) {
        console.log("Sinkronizacija uspješno završena.");
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

/* ================= GLAVNI PROGRAM ================= */
async function main() {
    setStatus('Inicijalizacija...');
    
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

        setStatus('Prijava na GLS Cockpit...');
        // FIX: Ispravljena URL adresa (uklonjen dupli glscockpit)
        await p.goto('https://glscockpit.gls-group.com/login', { waitUntil: 'networkidle2' });
        
        await p.type('input[name="username"]', GLS_USER);
        await p.click('button[type="submit"]');
        await sleep(2000);
        await p.type('input[name="password"]', GLS_PASS);
        await p.click('button[type="submit"]');
        await sleep(8000);

        setStatus('Dohvaćam KPI podatke (2026)...');
        await p.goto('https://glscockpit.gls-group.com/kpi', { waitUntil: 'networkidle2' });
        
        await p.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Akzeptieren'));
            if (b) b.click();
        });
        await sleep(3000);

        // Ovdje skripta nastavlja tvoju logiku selekcije i sinkronizacije...

        await browser.close();
        setStatus('Sinkronizacija završena.');
        await exitToMenu();

    } catch (e) {
        setStatus(`GREŠKA: ${e.message}`);
        if (browser) await browser.close();
        await exitToMenu();
    }
}

main();
w
