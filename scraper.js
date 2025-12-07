require('dotenv').config();
const { chromium, devices } = require('playwright');
const axios = require('axios');

// POBOLJŠANJE: KORIGIRANA LOGIKA ZA KONSTRUKCIJU SUPABASE URL-A
let cleanBaseUrl = process.env.SUPABASE_URL 
    ? process.env.SUPABASE_URL.replace(/\/$/, '') // Ukloni kosu crtu na kraju
    : '';

// Ako korisnik greškom stavi punu putanju u .env, ukloni je prije dodavanja
const apiPath = '/rest/v1/deliveries';
if (cleanBaseUrl.endsWith(apiPath)) {
    cleanBaseUrl = cleanBaseUrl.substring(0, cleanBaseUrl.length - apiPath.length);
}
// Finalni, točan URL (sada je sigurno da je dodano samo jednom)
const SUPABASE_URL = cleanBaseUrl + apiPath; 

const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GLS_USER     = process.env.GLS_USER;
const GLS_PASS     = process.env.GLS_PASS;

const FIXNA_GODINA = 2025;
const DAYS = 7;

const ICON_HOUSE = '🏠'; // Ukupne stanice/adrese (Total Stops)
const ICON_BOX   = '📦'; // Paketi
const ICON_CHECK = '✅'; // Dostavljene stanice/adrese (filtrirano)

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

// -------------------------------------------------------------------------
// PROMJENA 1: Brisanje samo NEPZAŠTIĆENIH redova
// Dodan je '&urlaub_protected=eq.false' u URL za Supabase filter
// -------------------------------------------------------------------------
async function deleteDates(dates){
  if(!dates.length)return 0;
  const quoted=dates.map(d=>`"${d}"`).join(',');
  // Dodan uvjet da se brišu samo oni koji NISU zaštićeni
  const url=`${SUPABASE_URL}?date=in.(${encodeURIComponent(quoted)})&urlaub_protected=eq.false`;
  try{
    const r=await axios.delete(url,{
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,Prefer:'return=representation'}
    });
    const deletedCount = Array.isArray(r.data)?r.data.length:0;
    return deletedCount;
  }catch(e){
    // Poboljšano logiranje greške
    console.log(color.red('❌ Greška brisanja:'),e.response?.data?.message||e.response?.data||e.message);
    return 0;
  }
}

// -------------------------------------------------------------------------
// PROMJENA 2: Nova funkcija za provjeru zaštite
// Provjerava postoji li red s ovim datumom, vozačem i postavljenom zaštitom ('true')
// -------------------------------------------------------------------------
async function isRowProtected(date, driver){
  // Traži red gdje je datum, vozač i urlaub_protected = 'true'
  const url=`${SUPABASE_URL}?date=eq.${date}&driver=eq.${driver}&urlaub_protected=eq.true&select=id`;
  try{
    const r=await axios.get(url,{
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`}
    });
    // Ako r.data ima elemente, znači da je zaštićen red pronađen
    return r.data && r.data.length > 0;
  }catch(e){
    // Poboljšano logiranje greške
    console.error(color.red('❌ Greška pri provjeri zaštite:'), e.response?.data?.message||e.response?.data || e.message);
    // U slučaju greške, bolje je pretpostaviti da NIJE zaštićeno, da se ne bi blokirao unos drugih podataka
    return false; 
  }
}


// Funkcija za bojanje sada koristi filtrirane dostavljene stanice
function colorForStops(name, deliveredStops, stopsByDriver){
  const limits={8610:50, 8620:85, 8630:85, 8640:80};
  if(name==='B&D'){
    // Zbrajaju se filtrirane DOSTAVLJENE stanice
    const sum=
      (stopsByDriver['8610']?.delivered||0)+
      (stopsByDriver['8620']?.delivered||0)+
      (stopsByDriver['8630']?.delivered||0)+
      (stopsByDriver['8640']?.delivered||0);
    return sum>300?'green':'red';
  }
  // Bojanje se bazira na DOSTAVLJENIM stanicama
  if(limits[name]!=null) return deliveredStops>limits[name]?'green':'red';
  return null;
}

// Ispis u konzolu: Ukupne stanice, Dostavljene stanice, Paketi
function line(name, totalStops, deliveredStops, pac, stopsByDriver, padW){
  // Ukupne stanice moraju uvijek biti planirane stanice (totalStops)
  const nm=name.padEnd(padW,' ');
  const totalTxt=fmt4(totalStops);
  const deliveredTxt=fmt4(deliveredStops);
  const pacTxt=color.yellow(fmt4(pac));
  
  // Boja se računa na temelju DOSTAVLJENIH stanica
  const c=colorForStops(name,deliveredStops,stopsByDriver);
  const colDeliveredStops=c?color[c](deliveredTxt):deliveredTxt;
  
  // Prikazuje Ukupno (🏠) i Dostavljeno (✅)
  return `${nm}  ${ICON_HOUSE} ${totalTxt}   ${ICON_CHECK} ${colDeliveredStops}   ${ICON_BOX} ${pacTxt}`;
}

// Funkcija za prebacivanje posla sa subote na petak
function processWeekendMerge(scrapedData, lastScrapeDates) {
    // Koristimo filter() za novi array koji sadrži samo one koje trebamo zadržati
    const correctedData = [...scrapedData];

    for (const iso of lastScrapeDates) {
        // Provjeri je li dan petak
        const dateObj = new Date(iso);
        const dayOfWeek = dateObj.getDay(); // 0=Nedjelja, 5=Petak, 6=Subota
        
        // Ako nije petak, preskačemo
        if (dayOfWeek !== 5) continue; 

        // Izračunaj ISO datum za subotu
        const nextDay = new Date(dateObj);
        nextDay.setDate(dateObj.getDate() + 1);
        const nextDayIso = nextDay.toISOString().substring(0, 10);
        
        // Provjeri da li je i subota skrepana unutar zadnjih 20 dana
        if (!lastScrapeDates.includes(nextDayIso)) continue;

        const fridayEntries = correctedData.filter(d => d.date === iso);
        const saturdayEntries = correctedData.filter(d => d.date === nextDayIso);

        for (const fridayEntry of fridayEntries) {
            const driverId = fridayEntry.driver;
            
            // 1. GLAVNI UVJET: Je li vozač imao 0% dostave u petak? (Ali je imao rutu)
            if (fridayEntry.deliveryPercentage === 0 && fridayEntry.totalStops > 0) {
                
                const saturdayEntry = saturdayEntries.find(d => d.driver === driverId);

                // 2. SEKUNDARNI UVJET: Je li vozač imao dostavu u subotu? (tj. poslao je stopove)
                if (saturdayEntry && saturdayEntry.deliveredStops > 0) {
                    
                    // --- IZVRŠI SPAJANJE ---
                    
                    // Petak dobiva puni broj planiranih stopova
                    fridayEntry.stopsForDb = fridayEntry.totalStops; 
                    fridayEntry.deliveredStops = fridayEntry.totalStops; 
                    
                    // Poruka u konzoli za feedback
                    console.log(color.yellow(`\n  [MERGE] ${driverId} (0% Pet): Spajam Subotnji posao (${saturdayEntry.deliveredStops} DS) u Petak (${iso}).`));
                    
                    // NULIRANJE SUBOTE (Markiramo je za izuzimanje iz baze)
                    // Postavljamo flag, a filter u glavnoj petlji će se pobrinuti za izuzimanje
                    saturdayEntry.isMergedAndEmpty = true;
                }
            }
        }
    }

    // Vrati ispravljene podatke za slanje u Supabase
    return correctedData;
}


async function main(){
  let browser;
  let allScrapedData = []; // Spremi podatke u memoriju za 2. prolaz (korekcija)

  // POBOLJŠANJE: Ispis Supabase URL-a za lakše otklanjanje grešaka
  console.log(color.bold(`Supabase URL za slanje podataka: ${SUPABASE_URL}`));

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
    const lastScrapeDates=uniq.map(x=>x.iso).sort().slice(-DAYS);

    console.log('Datumi za skrepanje:',lastScrapeDates.join(', '));
    await ensureClosed(p);
    
    // =========================================================================
    // PASAŽ 1: SKREPANJE SVIH PODATAKA U MEMORIJU
    // =========================================================================
    // ... (Logika skrepanja ostaje ista)

    for(const iso of lastScrapeDates){
      const info=byIso.get(iso);
      if(!info)continue;

      process.stdout.write(`\n[${isoNice(iso)}] skrepanje u memoriju...\n`);

      await openSelect(p);
      const ok=await clickWithRetry(p,`ion-list ion-radio-group ion-item:nth-child(${info.idx+1})`);
      if(!ok){
        console.log(`[${isoNice(iso)}] ne mogu kliknuti – preskačem`);
        continue;
      }

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

        // Izdvajanje podataka
        const vZ=await extract('Zustellung'); 
        const vPickup=await extract('PickUp'); 
        const vProbleme=await extract('Probleme');
        const vP=await extract('Produktivität'); 

        const pac=parseInt(vZ[0]||'0',10); 
        const totalStops=parseInt(vP[0]||'0',10); 
        const deliveryProcStr = vZ[1] || '0,00 %'; 

        // Izračun postotka
        let deliveryPercentage = 0;
        if (deliveryProcStr) {
            const cleanStr = deliveryProcStr.replace(',', '.').replace('%', '').trim();
            deliveryPercentage = parseFloat(cleanStr);
        }

        // Proporcionalni izračun dostavljenih stopova
        let deliveredStops = 0;
        if (totalStops > 0 && deliveryPercentage > 0) { 
          deliveredStops = Math.round(totalStops * (deliveryPercentage / 100));
        } 
        
        // Priprema privremenog objekta u memoriji
        const rowMem = {
          date: iso,
          driver,
          zustellung_paketi: pac,
          zustellung_proc: vZ[1] || '',
          pickup_paketi: vPickup[0] || '',
          probleme_prva: vProbleme[0] || '',
          totalStops: totalStops, // GLS sirovi stopovi
          deliveredStops: deliveredStops, // Proporcionalno izračunati stopovi
          deliveryPercentage: deliveryPercentage, // Postotak dostave
          stopsForDb: deliveredStops, // Početna vrijednost za slanje u bazu (prije korekcije)
          isMergedAndEmpty: false, // Flag za označavanje subotnjeg unosa koji treba preskočiti
          // Dodatni podaci za bazu
          zustellung_nedostavljeno:vZ[2]||'',
          pickup_proc:vPickup[1]||'',
          pickup_nedostavljeno:vPickup[2]||'',
          probleme_druga:vProbleme[1]||'',
          produktivitaet_stops_pro_std:vP[1]||'',
          produktivitaet_dauer:vP[2]||''
        };

        if(pac===0 && totalStops===0) continue; 
        allScrapedData.push(rowMem);
      }
    }
    
    // =========================================================================
    // PASAŽ 2: KOREKCIJA PODATAKA U MEMORIJI (Spajanje Petak/Subota)
    // =========================================================================
    console.log(color.bold('\n--- KOREKCIJA I SPAJANJE (Petak/Subota) ---'));
    const correctedData = processWeekendMerge(allScrapedData, lastScrapeDates);
    console.log(color.bold('------------------------------------------'));

    // =========================================================================
    // PASAŽ 3: AŽURIRANJE BAZE I ISPIS U KONZOLU
    // PROMJENA: Uveden UPSERT za rješavanje konflikta ključeva i PROŠIRENA LOGIKA ZAŠTITE
    // =========================================================================

    // Ovdje deleteDates sada briše SAMO nezaštićene redove.
    const deletedCount = await deleteDates(lastScrapeDates); 
    console.log(color.bold(`\nObrisano ${deletedCount} starih NEZAŠTIĆENIH unosa iz Supabasea za obuhvaćene datume.`));

    // Skup za ispis u konzolu (grupira po datumu)
    const outputByDate = new Map();

    for (const rowMem of correctedData) {
        const driverId = rowMem.driver;
        const date = rowMem.date;
        const driverName = rename(driverId);
        
        // FILTRIRANJE: Ako je unos subota koja je spojena s petkom, preskačemo slanje u bazu.
        if (rowMem.isMergedAndEmpty) {
            console.log(color.yellow(`  [SKIP] Preskočen prazan unos za ${driverName} na ${isoNice(date)} (spojen s petkom).`));
            continue;
        }

        // 1. PROVJERA ZAŠTITE ZA VOZAČE (8610-8640)
        let isProtected = await isRowProtected(date, driverId);

        // 2. SPECIJALNA PROVJERA ZA B&D: Ako je komponenta zaštićena, zaštićen je i zbroj.
        if (driverId === 'B & D Kleintransporte KG' && !isProtected) {
            const components = ['8610', '8620', '8630', '8640'];
            for (const componentId of components) {
                if (await isRowProtected(date, componentId)) {
                    isProtected = true; // Mark B&D as protected because a component is protected
                    console.log(color.red(`  [PROTECTED AGGREGATE] Preskočen unos za B&D na ${isoNice(date)} jer je ${componentId} ručno zaštićen.`));
                    break;
                }
            }
        }

        // Preskoči unos ako je zaštićen
        if (isProtected) {
            console.log(color.red(`  [PROTECTED] Preskočen unos za ${driverName} na ${isoNice(date)} (ručno zaštićen unos).`));
            continue; 
        }

        // Kreiranje finalnog objekta za slanje u Supabase
        const rowDb = {
            date: rowMem.date,
            driver: rowMem.driver,
            zustellung_paketi: rowMem.zustellung_paketi,
            zustellung_proc: rowMem.zustellung_proc,
            zustellung_nedostavljeno: rowMem.zustellung_nedostavljeno,
            pickup_paketi: rowMem.pickup_paketi,
            pickup_proc: rowMem.pickup_proc,
            pickup_nedostavljeno: rowMem.pickup_nedostavljeno,
            probleme_prva: rowMem.probleme_prva,
            probleme_druga: rowMem.probleme_druga,
            produktivitaet_stops: rowMem.stopsForDb, // Koristi ispravljeni/prebačeni broj
            produktivitaet_stops_pro_std: rowMem.produktivitaet_stops_pro_std,
            produktivitaet_dauer: rowMem.produktivitaet_dauer,
            // Nema 'urlaub_protected' jer se skriptom unose nezaštićeni (false) podaci
        };

        try {
            await axios.post(SUPABASE_URL, rowDb, {
                headers: { 
                    apikey: SUPABASE_KEY, 
                    Authorization: `Bearer ${SUPABASE_KEY}`, 
                    'Content-Type': 'application/json',
                    // *** UPSERT: Ako postoji duplikat (zbog race condition), spoji ga (tj. ažuriraj).
                    'Prefer': 'resolution=merge-duplicates' 
                }
            });
            
            // Grupiranje za ispis u konzolu
            if (!outputByDate.has(rowMem.date)) {
                outputByDate.set(rowMem.date, []);
            }
            outputByDate.get(rowMem.date).push({
                driver: driverName, 
                totalStops: rowMem.totalStops, 
                deliveredStops: rowMem.deliveredStops, 
                pac: rowMem.zustellung_paketi
            });

        } catch (e) {
            // Poboljšano logiranje greške
            console.log(color.red(`❌ Greška pri spremanju ${driverName} (${rowDb.date}):`), e.response?.data?.message||e.response?.data||e.message);
        }
    }
    
    // =========================================================================
    // ISPIS KONAČNOG PREGLEDA PO DATUMIMA
    // =========================================================================

    const allDrivers = correctedData.map(r => r.driver).filter((v, i, a) => a.indexOf(v) === i).map(rename);
    const maxDriverLength = Math.max(18, ...allDrivers.map(n => n.length));
    const stopsByDriverFinal = {};
    correctedData.forEach(r => stopsByDriverFinal[rename(r.driver)] = { delivered: r.deliveredStops });


    const sortedDates = [...outputByDate.keys()].sort();

    for (const iso of sortedDates) {
        const out = outputByDate.get(iso);
        // Ovdje su u out samo oni koji su uspješno spremljeni, pa moramo dodati zaštićene za ispis
        
        // Moramo ponovno dobiti podatke zaštićenih retova (koji su preskočeni)
        const protectedRows = allScrapedData.filter(r => r.date === iso && !outputByDate.get(iso).map(o => rename(o.driver)).includes(rename(r.driver)));

        const finalOut = outputByDate.get(iso).map(r => ({ driver: r.driver, totalStops: r.totalStops, deliveredStops: r.deliveredStops, pac: r.pac }));

        for (const r of protectedRows) {
          finalOut.push({ 
            driver: rename(r.driver), 
            totalStops: r.totalStops, 
            deliveredStops: r.deliveredStops, 
            pac: r.zustellung_paketi
          });
        }
        
        // Redoslijed vozača za ispis
        const order=['B&D','8610','8620','8630','8640'];
        const orderedOut = [];
        const otherOut = [];

        for(const k of order){
            const f=finalOut.find(r=>r.driver===k);
            if(f) orderedOut.push(f);
        }
        for(const r of finalOut){
            if(!order.includes(r.driver)) otherOut.push(r);
        }

        const orderedAndProtected = orderedOut.concat(otherOut);

        console.log(color.bold(`\n=== ${isoNice(iso)} (${orderedAndProtected.length}) ===`));
        console.log(color.bold(`VOZAČ             ${ICON_HOUSE} UKUPNO ${ICON_CHECK} DOSTAVLJENO ${ICON_BOX} PAKETA`)); 
        for(const r of orderedAndProtected){
            console.log(line(r.driver,r.totalStops,r.deliveredStops,r.pac,stopsByDriverFinal,maxDriverLength));
        }
    }

    console.log(color.bold('\n✅ SVE KOLONE popunjene: Zustellung + Pickup + Probleme + Produktivität'));

  }catch(e){
    // Poboljšano logiranje opće greške
    console.log(color.red('❌ Opća Greška:'),e.mes
