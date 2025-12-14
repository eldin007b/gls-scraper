require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios';

/* =========================================================================
   SUPABASE URL – SIGURNA KONSTRUKCIJA
   ========================================================================= */
let cleanBaseUrl = process.env.SUPABASE_URL
  ? process.env.SUPABASE_URL.replace(/\/$/, '')
  : '';

const apiPath = '/rest/v1/deliveries';
if (cleanBaseUrl.endsWith(apiPath)) {
  cleanBaseUrl = cleanBaseUrl.substring(0, cleanBaseUrl.length - apiPath.length);
}
const SUPABASE_URL = cleanBaseUrl + apiPath;

const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const FIXNA_GODINA = 2025;
const DAYS = 7;

const color = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

function toISO(lbl,y){
  const m=lbl.match(/(\d{2})\.(\d{2})\./);
  return m?`${y}-${m[2]}-${m[1]}`:null;
}
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

/* =========================================================================
   SUPABASE HELPERS
   ========================================================================= */
async function deleteDates(dates){
  if(!dates.length)return 0;
  const quoted=dates.map(d=>`"${d}"`).join(',');
  const url=`${SUPABASE_URL}?date=in.(${encodeURIComponent(quoted)})&urlaub_protected=eq.false`;
  try{
    const r=await axios.delete(url,{
      headers:{
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${SUPABASE_KEY}`,
        Prefer:'return=representation'
      }
    });
    return Array.isArray(r.data)?r.data.length:0;
  }catch(e){
    console.log(color.red('❌ Greška brisanja:'),e.response?.data||e.message);
    return 0;
  }
}

async function isRowProtected(date, driver){
  const url=`${SUPABASE_URL}?date=eq.${date}&driver=eq.${driver}&urlaub_protected=eq.true&select=id`;
  try{
    const r=await axios.get(url,{
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`}
    });
    return r.data && r.data.length>0;
  }catch{
    return false;
  }
}

/* =========================================================================
   MAIN
   ========================================================================= */
async function main(){
  let browser;
  let allScrapedData = [];

  console.log(color.bold(`Supabase URL: ${SUPABASE_URL}`));

  try{
    browser=await chromium.launch({headless:true});
    const ctx=await browser.newContext({...devices['Pixel 5'],locale:'de-DE'});
    const p=await ctx.newPage();

    /* LOGIN */
    await p.goto('https://glscockpit.gls-group.com/login',{waitUntil:'networkidle'});
    await p.fill('input[name="username"]',GLS_USER);
    await p.click('button[type="submit"],button[name="login"]');
    await p.fill('input[name="password"]',GLS_PASS);
    await p.click('button[type="submit"],button[name="login"]');
    await p.waitForNavigation({url:'**/dashboard'}).catch(()=>{});

    /* KPI */
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

    const uniq=[...new Map(mapping.map(m=>[m.iso,m])).values()];
    const lastScrapeDates=uniq.map(x=>x.iso).sort().slice(-DAYS);

    /* ================== PASAŽ 1: SKREPANJE ================== */
    for(const iso of lastScrapeDates){
      const info=uniq.find(x=>x.iso===iso);
      if(!info)continue;

      await openSelect(p);
      const ok=await clickWithRetry(p,`ion-list ion-radio-group ion-item:nth-child(${info.idx+1})`);
      if(!ok) continue;

      await ensureClosed(p);
      await p.waitForTimeout(1200);

      const cards=await p.$$('app-compact-kpi-list-card ion-card');

      for(const card of cards){
        let driver='';
        try{driver=await card.$eval('ion-card-title span',el=>el.textContent.trim());}catch{}
        if(!driver)continue;

        const extract=(t)=>card.$$eval(
          `.group:has(.title:has-text("${t}")) .kpi .value span`,
          s=>s.map(x=>x.textContent.trim()).filter(Boolean)
        );

        const vZ=await extract('Zustellung');
        const vPickup=await extract('PickUp');
        const vProbleme=await extract('Probleme');
        const vP=await extract('Produktivität');

        const pac=parseInt(vZ[0]||'0',10);
        const totalStops=parseInt(vP[0]||'0',10);

        /* ================== BIZNIS-RULE ==================
           8696–8699 se spremaju SAMO ako imaju >= 10 adresa
           ================================================= */
        if (['8696','8697','8698','8699'].includes(driver)) {
          if (totalStops < 10) continue;
        } else {
          if (pac === 0 && totalStops === 0) continue;
        }

        let deliveryPercentage = 0;
        if (vZ[1]) {
          deliveryPercentage = parseFloat(
            vZ[1].replace(',', '.').replace('%', '').trim()
          ) || 0;
        }

        let deliveredStops = 0;
        if (totalStops > 0 && deliveryPercentage > 0) {
          deliveredStops = Math.round(totalStops * (deliveryPercentage / 100));
        }

        allScrapedData.push({
          date: iso,
          driver,
          zustellung_paketi: pac,
          zustellung_proc: vZ[1]||'',
          zustellung_nedostavljeno:vZ[2]||'',
          pickup_paketi:vPickup[0]||'',
          pickup_proc:vPickup[1]||'',
          pickup_nedostavljeno:vPickup[2]||'',
          probleme_prva:vProbleme[0]||'',
          probleme_druga:vProbleme[1]||'',
          produktivitaet_stops: deliveredStops,
          produktivitaet_stops_pro_std:vP[1]||'',
          produktivitaet_dauer:vP[2]||''
        });
      }
    }

    /* ================== PASAŽ 2: SUPABASE ================== */
    await deleteDates(lastScrapeDates);

    for(const row of allScrapedData){
      if(await isRowProtected(row.date,row.driver)) continue;

      await axios.post(SUPABASE_URL,row,{
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${SUPABASE_KEY}`,
          'Content-Type':'application/json',
          Prefer:'resolution=merge-duplicates'
        }
      });
    }

    console.log(color.green('✅ GOTOVO – podaci poslani u Supabase'));

  }catch(e){
    console.log(color.red('❌ Greška:'),e.message);
  }finally{
    if(browser) await browser.close();
  }
}

main();
