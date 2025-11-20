require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const FIXNA_GODINA = 2025;
const DAYS = 5;

const ICON_HOUSE = '🏠';
const ICON_BOX   = '📦';

const color = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

function toISO(lbl,y){ const m=lbl.match(/(\d{2})\.(\d{2})\./); return m?`${y}-${m[2]}-${m[1]}`:null; }
function isoNice(s){ const[a,b,c]=s.split('-'); return `${c}.${b}.${a}`; }
function rename(n){ return n==='B & D Kleintransporte KG'?'B&D':n; }
function fmt4(n){ return String(n).padStart(4); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function ensureClosed(p){
  const pop=await p.$('ion-popover'); if(!pop)return;
  try{await p.keyboard.press('Escape');}catch{}
  try{await p.waitForSelector('ion-popover',{state:'detached',timeout:800});}catch{}
}

async function openSelect(p){
  await ensureClosed(p);
  await p.click('ion-select');
  await p.waitForSelector('ion-list ion-radio-group');
}

async function clickWithRetry(p,selector){
  for(let i=0;i<4;i++){
    try{await p.click(selector,{timeout:5000});return true;}catch{}
    await sleep(400);
  }
  return false;
}

async function deleteDates(dates){
  if(!dates.length)return;
  const quoted=dates.map(d=>`"${d}"`).join(',');
  const url=`${SUPABASE_URL}?date=in.(${encodeURIComponent(quoted)})`;
  try{
    const r=await axios.delete(url,{
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,Prefer:'return=representation'}
    });
    console.log(`Obrisano: ${Array.isArray(r.data)?r.data.length:0}`);
  }catch(e){
    console.log('Greška brisanja:',e.response?.data||e.message);
  }
}

function colorForStops(name, stops, stopsByDriver){
  const limits={8610:50, 8620:85, 8630:85, 8640:80};
  if(name==='B&D'){
    const sum=
      (stopsByDriver['8610']||0)+
      (stopsByDriver['8620']||0)+
      (stopsByDriver['8630']||0)+
      (stopsByDriver['8640']||0);
    return sum>300?'green':'red';
  }
  if(limits[name]!=null) return stops>limits[name]?'green':'red';
  return null;
}

function line(name, stops, pac, stopsByDriver, padW){
  const nm=name.padEnd(padW,' ');
  const stopsTxt=fmt4(stops);
  const pacTxt=color.yellow(fmt4(pac));
  const c=colorForStops(name,stops,stopsByDriver);
  const colStops=c?color[c](stopsTxt):stopsTxt;
  return `${nm}  ${ICON_HOUSE} ${colStops}   ${ICON_BOX} ${pacTxt}`;
}

async function main(){
  let browser;

  try{
    browser=await chromium.launch({headless:true});
    const ctx=await browser.newContext({...devices['Pixel 5'],locale:'de-DE'});
    const p=await ctx.newPage();

    console.log(color.bold('Login GLS'));
    await p.goto('https://glscockpit.gls-group.com/login',{waitUntil:'networkidle'});
    await p.fill('input[name="username"]',GLS_USER);
    await p.click('button[type="submit"],button[name="login"]');
    await p.fill('input[name="password"]',GLS_PASS);
    await p.click('button[type="submit"],button[name="login"]');
    await p.waitForNavigation({url:'**/dashboard'}).catch(()=>{});

    try{
      await p.waitForSelector('ion-modal',{timeout:5000});
      await p.click('ion-button:has-text("Akzeptieren")');
      await p.waitForSelector('ion-modal',{state:'detached',timeout:5000});
    }catch{}

    console.log(color.bold('KPI'));
    await p.goto('https://glscockpit.gls-group.com/kpi',{waitUntil:'networkidle'});
    await p.waitForSelector('ion-select');

    await openSelect(p);
    const labels=await p.$$eval(
      'ion-list ion-radio-group ion-item ion-radio',
      els=>els.map(el=>el.textContent.trim())
    );

    const mapping=labels
      .map((lbl,idx)=>({idx,iso:lbl.includes('Keine Daten')?null:toISO(lbl,FIXNA_GODINA)}))
      .filter(x=>x.iso);

    const byIso=new Map();
    for(const m of mapping) if(!byIso.has(m.iso)) byIso.set(m.iso,m);

    const uniq=[...byIso.values()];
    const last=uniq.map(x=>x.iso).sort().slice(-DAYS);

    console.log('Datumi:',last.join(', '));
    await ensureClosed(p);
    await deleteDates(last);

    for(const iso of last){
      const info=byIso.get(iso);
      if(!info)continue;

      process.stdout.write(`\n[${isoNice(iso)}] odabir datuma...\n`);

      await openSelect(p);
      const ok=await clickWithRetry(p,`ion-list ion-radio-group ion-item:nth-child(${info.idx+1})`);
      if(!ok){
        console.log(`[${isoNice(iso)}] ne mogu kliknuti – preskačem`);
        continue;
      }

      await ensureClosed(p);
      await p.waitForTimeout(1200);

      const cards=await p.$$('app-compact-kpi-list-card ion-card');
      const rows=[];
      const stopsByDriver={};

      for(const card of cards){
        let driver='';
        try{driver=await card.$eval('ion-card-title span',el=>el.textContent.trim());}catch{}
        if(!driver)continue;

        const extract=(t)=>card.$$eval(
          `.group:has(.title:has-text("${t}")) .kpi .value span`,
           s=>s.map(x=>x.textContent.trim()).filter(Boolean)
        );

        const vZ=await extract('Zustellung');
        const vP=await extract('Produktivität');

        const pac=parseInt(vZ[0]||'0',10);
        const stops=parseInt(vP[0]||'0',10);

        if(pac===0 && stops===0) continue;

        const rowDb={
          date:iso,driver,
          zustellung_paketi:pac,
          zustellung_proc:vZ[1]||'',
          zustellung_nedostavljeno:vZ[2]||'',
          pickup_paketi:'',
          pickup_proc:'',
          pickup_nedostavljeno:'',
          probleme_prva:'',
          probleme_druga:'',
          produktivitaet_stops:stops,
          produktivitaet_stops_pro_std:vP[1]||'',
          produktivitaet_dauer:vP[2]||''
        };

        try{
          await axios.post(SUPABASE_URL,rowDb,{
            headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'}
          });
        }catch{}

        const nm=rename(driver);
        rows.push({driver:nm,stops,pac});
        stopsByDriver[nm]=stops;
      }

      const order=['B&D','8610','8620','8630','8640'];
      const out=[];

      for(const k of order){
        const f=rows.find(r=>r.driver===k);
        if(f) out.push(f);
      }
      for(const r of rows){
        if(!order.includes(r.driver)) out.push(r);
      }

      const padW=Math.max(18,...out.map(r=>r.driver.length));

      console.log(color.bold(`\n=== ${isoNice(iso)} (${out.length}) ===`));
      for(const r of out){
        console.log(line(r.driver,r.stops,r.pac,stopsByDriver,padW));
      }
      console.log('');
    }

    console.log('Gotovo.');

  }catch(e){
    console.log('Greška:',e.message);
  }finally{
    if(browser) await browser.close();
  }
}

main();
