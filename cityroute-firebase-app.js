import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


(() => {
  "use strict";

  // -------------------------------
  // 0. Countries & Cities loader
  // -------------------------------
  // Separate endpoint for cities lookup (your deployed Apps Script Web App)
  const CITIES_API_URL = "https://script.google.com/macros/s/AKfycbwGocu75weAKjVd-i-dUG9ecGJQfkRrGlssl6D8FQ18iwcjKOscPmbxdNTXdPtqDOUODw/exec";
  // Static JSON with all countries (hosted on GitHub Pages)
  const COUNTRIES_URL = "https://apps.mapvivid.com/countries.json";
   

  async function loadCountries() {
    try {
      const res = await fetch(COUNTRIES_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const countries = await res.json();

      const countrySel = document.getElementById("country");
      if (!countrySel) return;
      countrySel.innerHTML = `<option value="">-- Select a country --</option>`;
      countries.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        countrySel.appendChild(opt);
      });
    } catch (err) {
      console.error("Error loading countries:", err);
    }
  }

// -------------------------------
// 1. Config + utilities
// -------------------------------
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby03H4JrbcYS-EJcKJ8wRGojWMRNyejB-QG0k-dqJgZKU1xttrrbJebH0vk4vLFC6mFQA/exec";
const RESTORE_URL = "https://script.google.com/macros/s/AKfycbxoIr6q62aC_vKC1IyHZ1qogcJVxQgBD4QZSxFNq6_9nTwjxWBE1cOtJ3U_q-QWP4Haog/exec";

// Cloud Run base + Firebase config are provided by your PageLayer snippet
const CLOUD_RUN_BASE_URL = String(window.MV_CLOUD_RUN_BASE_URL || "").replace(/\/+$/, "");
const FIREBASE_WEB_CONFIG = window.MV_FIREBASE_CONFIG || null;

const GMAPS_API_KEY = "AIzaSyA6MFWoq480bdhSIEIHiedPRat4Xq8ng20";

// --- Firebase singletons ---
let __fbApp = null;
let __fbAuth = null;
let __fbDb = null;
let __fbReady = null;

function initFirebaseOnce() {
  if (__fbReady) return __fbReady;
  __fbReady = (async () => {
    if (!FIREBASE_WEB_CONFIG) throw new Error("Missing MV_FIREBASE_CONFIG");
    __fbApp = initializeApp(FIREBASE_WEB_CONFIG);
    __fbAuth = getAuth(__fbApp);
    __fbDb = getFirestore(__fbApp);

    // Persist anonymous user in this browser so restores work
    try { await signInAnonymously(__fbAuth); } catch (_) {}
    return { app: __fbApp, auth: __fbAuth, db: __fbDb };
  })();
  return __fbReady;
}

async function getFirebaseIdToken() {
  const { auth } = await initFirebaseOnce();
  // If already signed in, reuse; otherwise sign in
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return await auth.currentUser.getIdToken(/* forceRefresh */ false);
}

async function cloudRunCreateJob(input) {
  if (!CLOUD_RUN_BASE_URL) throw new Error("Missing MV_CLOUD_RUN_BASE_URL");
  const idToken = await getFirebaseIdToken();

  const res = await fetch(`${CLOUD_RUN_BASE_URL}/v1/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    },
    body: JSON.stringify(input)
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Cloud Run ${res.status}: ${txt.slice(0, 300)}`);
  const data = JSON.parse(txt);
  if (!data.jobId) throw new Error("Missing jobId in response");
  return String(data.jobId);
}

function applyTipFocusSelection(tipFocusArr) {
  const arr = Array.isArray(tipFocusArr) ? tipFocusArr : [];
  document.querySelectorAll('input[name="tip_focus"]').forEach(cb => {
    cb.checked = arr.includes(cb.value);
  });
}

async function listenToJobDoc(jobId, onUpdate) {
  const { db } = await initFirebaseOnce();
  const ref = doc(db, "jobs", jobId);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;
    onUpdate(snap.data() || {});
  });
}

   const TIP_ORDER = ["transportation","security","saving","weather_clothing","cultural","local_hacks","tipping_payment_methods","internet_sim_cards","meetups_social_events"]; 
   const TIP_LABELS = { transportation: "Transportation", security: "Security", saving: "Saving", weather_clothing: "Weather/Clothing", cultural: "Cultural", local_hacks: "Local hacks", tipping_payment_methods: "Tipping & Payment Methods", internet_sim_cards: "Internet & SIM Cards", meetups_social_events: "Meetups & Social Events" }; 

// --- GA4 helpers (expects GA tag OR GTM dataLayer to be installed in WordPress) ---
function mvGaEvent(name, params = {}) {
  const payload = { app: "cityroute", ...params };
  if (typeof window.gtag === "function") {
    window.gtag("event", name, payload);
    return;
  }
  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.push({ event: name, ...payload });
  }
}
function mvGaPage(path, title) {
  const payload = { page_path: path, page_title: title, app: "cityroute" };
  if (typeof window.gtag === "function") {
    window.gtag("event", "page_view", payload);
    return;
  }
  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.push({ event: "page_view", ...payload });
  }
}


  // Keep global so renderItinerary can reuse them like before
  let itineraryEl;

  function getAllChecked(name) {
    return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(i => i.value);
  }

function startProgress(msg = "Preparing…") {
  const p = document.getElementById("mv-progress");
  const b = document.getElementById("mv-progress-bar");
  const l = document.getElementById("mv-progress-label");
  if (!p || !b || !l) return;
  p.style.display = "block";
  b.style.width = "8%";
  l.textContent = msg;
}
function setProgress(pct, msg) {
  const b = document.getElementById("mv-progress-bar");
  const l = document.getElementById("mv-progress-label");
  if (!b || !l) return;
  b.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (msg) l.textContent = msg;
}
function endProgress() {
  const p = document.getElementById("mv-progress");
  const b = document.getElementById("mv-progress-bar");
  const l = document.getElementById("mv-progress-label");
  if (!p || !b || !l) return;
  b.style.width = "100%";
  l.textContent = "Done";
  setTimeout(() => { p.style.display = "none"; b.style.width = "0%"; }, 600);
}
function showSkeleton(show) {
  const s = document.getElementById("mv-skeleton");
  if (!s) return;
  s.style.display = show ? "block" : "none";
}


  const loadMaps = (() => {
    let p;
    return () => {
      if (window.google && window.google.maps) return Promise.resolve();
      if (!p) {
        p = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GMAPS_API_KEY)}`;
          s.async = true; s.defer = true;
          s.onload = resolve;
          s.onerror = () => reject(new Error("Google Maps failed to load"));
          document.head.appendChild(s);
        });
      }
      return p;
    };
  })();

  async function ensureJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      s.onload = res; s.onerror = () => rej(new Error("Failed to load jsPDF"));
      document.head.appendChild(s);
    });
    return window.jspdf.jsPDF;
  }

  function openMapsSearch(name, city, country) {
    const q = encodeURIComponent(`${name}, ${city}${country ? ", " + country : ""}`);
    window.open(`https://www.google.com/maps/search/?api=1&query=${q}`, "_blank");
  }

function updateSharePageButton() {
  const btn = document.getElementById('btnSharePage');
  if (!btn) return;

  const jobId  = (window.__mvJobID  || '').trim();
  const planId = (window.__mvPlanID || '').trim();
  const tipsId = (window.__mvTipsID || '').trim();

  if (!jobId && !planId && !tipsId) {
    btn.style.display = 'none';
    btn.disabled = true;
    btn.removeAttribute('data-href');
    return;
  }

  const base = location.origin + location.pathname;
  const qs = new URLSearchParams();
  if (jobId)  qs.set('job_id', jobId);
  if (planId) qs.set('plan_id', planId);
  if (tipsId) qs.set('tips_id', tipsId);

  const url = base + '?' + qs.toString();
  btn.setAttribute('data-href', url);
  btn.style.display = '';
  btn.disabled = false;
}

function buildRestoreLink(
  jobId  = (window.__mvJobID  || ""),
  planId = (window.__mvPlanID || ""),
  tipsId = (window.__mvTipsID || "")
) {
  const base = location.origin + location.pathname;
  const qs = new URLSearchParams();
  if (jobId)  qs.set("job_id", jobId);
  if (planId) qs.set("plan_id", planId);
  if (tipsId) qs.set("tips_id", tipsId);
  return qs.toString() ? `${base}?${qs.toString()}` : base;
}   

  // -------------------------------
  // 4. Render itinerary (same logic)
  // -------------------------------
  function renderItinerary(result, city, country) {
    const { itinerary, recommendations } = result || {};
    if (!Array.isArray(itinerary) || itinerary.length === 0) return;
    const selectedFocus = Array.from(document.querySelectorAll('input[name="tip_focus"]:checked')).map(i=>i.value);
    const ALLOWED = new Set(selectedFocus);

    const days = [...new Set(itinerary.map(i => i.day))].sort((a,b)=>a-b);

    const filterAllowed = (obj) => {
      if (!obj || ALLOWED.size === 0) return {};
      const out = {};
      TIP_ORDER.forEach(k=>{
      if (!ALLOWED.has(k)) return;
      const arr = Array.isArray(obj[k]) ? obj[k].filter(Boolean) : [];
      if (arr.length) out[k] = arr;
      });
      return out;


    };
    const hasAnyAllowed = (obj) =>
      !!obj && Object.keys(obj).some(k => Array.isArray(obj[k]) && obj[k].length);

     // use the dedicated plan container so city tips can render independently
   const wrapEl = document.getElementById("itinerary");
   if (!wrapEl) return;
   let planRoot = wrapEl.querySelector("#mv-plan");
   if (!planRoot) {
     planRoot = document.createElement("div");
     planRoot.id = "mv-plan";
     wrapEl.appendChild(planRoot);
   }

    let html = "";

// wrap all days in a responsive 2-column grid
   html += `<div class="mv-days-grid">`;

     
   window.__mvItinerary = Array.isArray(itinerary) ? itinerary : [];
   window.__mvDayTips   = (recommendations?.per_day || recommendations?.day_tips || {});
   trySendEmailIfReady();

     
   days.forEach(day => {
     const stops = itinerary.filter(i => i.day === day);
   
     // build the list of stops (same content, but classed for CSS)
     const stopsHtml = stops.map(stop => {
       const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((stop.name||"") + ", " + city + (country ? ", " + country : ""))}`;
       return `
         <li>
           <strong>${stop.time ? stop.time + " — " : ""}${stop.name || ""}</strong>
           <a class="mv-day-place-link" href="${mapUrl}" target="_blank" title="View on Google Maps">
             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#2563eb" viewBox="0 0 16 16">
               <path d="M8 0C4.686 0 2 2.686 2 6c0 4.5 6 10 6 10s6-5.5 6-10  -2.686-6-6-6zm0 8.5A2.5 2.5 0 1 1 8 3.5a2.5 2.5 0 0 1 0 5z"/>
             </svg>
           </a><br>
           <em>${stop.description || ""}</em>
         </li>`;
     }).join("");
   
     // optional directions + per-day tip
     let extras = "";
     if (stops.length > 1) {
       const origin = encodeURIComponent(stops[0].name + ", " + city + (country ? ", " + country : ""));
       const destination = encodeURIComponent(stops[stops.length - 1].name + ", " + city + (country ? ", " + country : ""));
       const waypoints = stops.slice(1, -1).map(s => encodeURIComponent(s.name + ", " + city + (country ? ", " + country : ""))).join("|");
       const directionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints ? "&waypoints=" + waypoints : ""}`;
       extras += `<p class="mv-day-dir"><a href="${directionsUrl}" target="_blank">🗺️ Full directions for Day ${day}</a></p>`;
     }
      
      const _perDay = (recommendations?.per_day || recommendations?.day_tips || {});
      const dailyTip = _perDay[`day_${day}`] ?? _perDay[String(day)] ?? _perDay[day] ?? "";
      if (dailyTip && String(dailyTip).trim()) {
        extras += `<div class="mv-day-tip"><strong>Tip for Day ${day}:</strong> ${dailyTip}</div>`;
      }

   
     // the card
     html += `
       <section class="mv-day-card">
         <h3 class="mv-day-title">Day ${day}</h3>
         <ul class="mv-day-list">${stopsHtml}</ul>
         ${extras}
       </section>
     `;
   });
   
   html += `</div>`; // end .mv-days-grid


    html += `<div id="mv-map" style="width:100%;height:520px;border:1px solid #e5e7eb;border-radius:12px;margin:16px 0;"></div>`;

    const cityTips = filterAllowed(recommendations?.city_tips || {});
    if (hasAnyAllowed(cityTips)) {
   html += `<h2>City tips</h2><div class="mv-tips-grid">`;
   Object.keys(cityTips).forEach(k => {
     const label = TIP_LABELS[k] || k;
     const items = (cityTips[k] || []).map(t => `<li>${t}</li>`).join("");
     html += `
       <section class="mv-tip-card">
         <h3 class="mv-tip-title">${label}</h3>
         <ul class="mv-tip-list">${items}</ul>
       </section>
     `;
   });
   html += `</div>`;

    }

    html += `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px">
        <div style="display:flex;gap:8px;">
          <button id="btnKML">⬇️ KML</button>
          <button id="btnPDF">🧾 PDF</button>
          <button id="btnSharePage">🔗 Share page</button>
          <button id="btnShare">📤 Share Text</button>
        </div>
        <button id="backBtn" style="margin-left:auto;">🔄 Generate another route</button>
      </div>`;

    planRoot.innerHTML = html;

    // form/status come from init; store them on window so this function can access
    const form = window.cityrouteForm;
    const statusEl = window.cityrouteStatus;

    document.getElementById("backBtn").onclick   = () => { itineraryEl.style.display = "none"; form.style.display = "block"; form.reset(); statusEl.textContent = ""; };
    document.getElementById("btnKML").onclick    = () => downloadKML(itinerary, city, country);
    document.getElementById("btnPDF").onclick    = () => exportPDF(itinerary, city, country, recommendations);
    document.getElementById("btnShare").onclick  = () => shareItinerary(itinerary, city, country, recommendations);

     const sharePageBtn = document.getElementById("btnSharePage");
      if (sharePageBtn) {
        sharePageBtn.style.display = "none";
        sharePageBtn.disabled = true;
        sharePageBtn.addEventListener("click", async function () {
           const href = sharePageBtn.getAttribute("data-href") || buildRestoreLink();
           if (!href) return;
           const isMobile = !!(navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent));
           if (isMobile) {
             try { await navigator.share({ title: "MapVivid itinerary", url: href }); } catch (_) {}
           } else {
             try {
               await navigator.clipboard.writeText(href);
               (window.showToast ? showToast("Link copied. It can be reopened for ~30 days.") : alert("Link copied. It can be reopened for ~30 days."));
             } catch {
               window.prompt("Copy this link (kept ~30 days):", href);
             }
           }
         });

      }
     updateSharePageButton(); // enable Share page if plan_id/tips_id were already set
    buildEmbeddedMap(itinerary, city, country);
  }
  // Make available like before
  window.renderItinerary = renderItinerary;
// --- corrected renderItineraryWithDayTips ---
function renderItineraryWithDayTips(items, dayTipsObj, rootEl) {
  const byDay = {};
  (items || []).forEach(it => {
    const d = Number(it.day) || 1;
    (byDay[d] ||= []).push(it);
  });

  const parts = [];
  Object.keys(byDay).sort((a,b)=>a-b).forEach(d => {
    parts.push(`<h3 style="margin:12px 0 6px;font-weight:600">Day ${d}</h3>`);
    parts.push('<ul style="margin:0 0 12px 18px;padding:0">');
    byDay[d].forEach(it => {
      const name = it.name || "";
      const when = it.time || "";
      const desc = it.description ? ` · <span style="color:#6b7280">${it.description}</span>` : "";
      const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}%20${encodeURIComponent(it.lat||"")}%2C${encodeURIComponent(it.lng||"")}`;
      parts.push(
        `<li style="margin:8px 0">
          <span style="font-weight:600">${when}</span> — 
          <a href="${gmaps}" target="_blank" rel="noopener">${name}</a>${desc}
        </li>`
      );
    });
    parts.push('</ul>');

    const tip = (dayTipsObj && (dayTipsObj[String(d)] || dayTipsObj[`day_${d}`])) || "";
    parts.push(
      `<div class="mv-day-tips" data-day="${d}" style="margin:8px 0 16px 0">
        ${tip ? `
          <div style="border-left:3px solid #e5e7eb;padding:8px 12px;background:#fafafa;border-radius:6px">
            <div style="font-weight:600;margin-bottom:4px">Day ${d} — Tips</div>
            <p style="margin:0">${tip}</p>
          </div>
        ` : ``}
      </div>`
    );
  });

  rootEl.innerHTML = parts.join("");
}


function renderCityTipsIntoExistingContainer(rootEl, cityTips) {
  const label = k => TIP_LABELS[k] ? TIP_LABELS[k] : k.replaceAll("_"," ");
  const blocks = Object.entries(cityTips || {}).map(([k, arr]) => {
    if (!Array.isArray(arr) || !arr.length) return "";
    return `
     <section class="mv-tip-card">
       <h3 class="mv-tip-title">${label(k)}</h3>
       <ul class="mv-tip-list">
         ${arr.map(t => `<li>${t}</li>`).join("")}
       </ul>
     </section>`;

  }).join("");

   rootEl.innerHTML = `
   <hr style="border:none;height:1px;background:#e5e7eb;margin:16px 0">
   <h3 style="font-weight:700;margin:0 0 8px">City tips</h3>
   ${blocks
     ? `<div class="mv-tips-grid">${blocks}</div>`
     : "<div style='color:#9ca3af'>No city tip categories selected.</div>"
   }
   `;

}
function ensureCityTipsSectionAndRender(cityTips) {
  let tipsRoot = document.getElementById("mv-city-tips");
  if (!tipsRoot) {
    tipsRoot = document.createElement("div");
    tipsRoot.id = "mv-city-tips";
    tipsRoot.className = "mv-city-tips-section";
    document.querySelector("#mv-results")?.appendChild(tipsRoot);
  }

  renderCityTipsIntoExistingContainer(tipsRoot, cityTips);
}


  // -------------------------------
  // 5. Map with filters (same)
  // -------------------------------
  const DAY_COLORS = [
    { name:"red", hex:"#EA4335" }, { name:"blue", hex:"#4285F4" },
    { name:"green", hex:"#34A853" }, { name:"purple", hex:"#A142F4" },
    { name:"orange", hex:"#FB8C00" }, { name:"yellow", hex:"#FBBC04" },
    { name:"pink", hex:"#D81B60" }, { name:"ltblue", hex:"#00ACC1" }
  ];
  const dayIconUrl = (i) => `https://maps.google.com/mapfiles/ms/icons/${DAY_COLORS[i % DAY_COLORS.length].name}-dot.png`;

  let currentInfoWindow = null;
  const CAN_HOVER = window.matchMedia && window.matchMedia("(hover: hover)").matches;

  async function buildEmbeddedMap(itinerary, city, country) {
    await loadMaps();
    const map = new google.maps.Map(document.getElementById("mv-map"), {
      center:{lat:0,lng:0}, zoom:2, mapTypeControl:false, streetViewControl:false
    });

    map.addListener("click", () => { if (currentInfoWindow) { currentInfoWindow.close(); currentInfoWindow = null; }});

    // Normalize days to numbers
    const days = [...new Set(itinerary.map(i => Number(i.day)))]
      .filter(n => Number.isFinite(n))
      .sort((a,b)=>a-b);

    const groups = new Map();
    const allMarkers = [];

    days.forEach((day, idx) => {
      // ✅ Coerce lat/lng to numbers; drop only if parse fails
      const stops = itinerary
        .filter(s => Number(s.day) === day)
        .map(s => ({ ...s, lat: parseFloat(s.lat), lng: parseFloat(s.lng) }))
        .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));

      const markers = [];

      stops.forEach(s => {
        const pos = { lat: s.lat, lng: s.lng };
        const m = new google.maps.Marker({ position:pos, map, icon:dayIconUrl(idx), title:s.name });

        const gLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((s.name||"") + ", " + city + (country ? ", " + country : ""))}`;
        const info = new google.maps.InfoWindow({
          content: `
            <div style="max-width:260px">
              <div style="font-weight:700;margin-bottom:4px">${s.time ? s.time + " — " : ""}${s.name || ""}</div>
              <div style="color:#374151;margin-bottom:10px">${s.description || ""}</div>
              <div>
                <button style="padding:6px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer"
                  onclick="window.open('${gLink}','_blank')">🔗 Open in Google Maps</button>
              </div>
            </div>`
        });

        const open = () => {
          if (currentInfoWindow && currentInfoWindow !== info) currentInfoWindow.close();
          info.open({ map, anchor:m, shouldFocus:false }); currentInfoWindow = info;
        };
        m.addListener("click", open);
        if (CAN_HOVER) m.addListener("mouseover", open);

        markers.push(m);
        allMarkers.push(m);
      });

      groups.set(day, { markers, colorIdx: idx });
    });

    if (!allMarkers.length) {
      console.warn("[Map] No valid coordinates found in itinerary to render markers.");
    }

    // Fit to markers
    if (allMarkers.length) {
      const b = new google.maps.LatLngBounds();
      allMarkers.forEach(m => b.extend(m.getPosition()));
      map.fitBounds(b);
    }

    // Filters panel
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background:"#fff", border:"1px solid #e5e7eb", borderRadius:"10px",
      padding:"8px 10px", display:"flex", flexWrap:"wrap", gap:"10px",
      boxShadow:"0 1px 3px rgba(0,0,0,0.08)"
    });
    const title = document.createElement("strong"); title.textContent="Days"; title.style.marginRight="6px";
    panel.appendChild(title);

    days.forEach(day => {
      const grp = groups.get(day);
      const wrap = document.createElement("label");
      Object.assign(wrap.style, { display:"flex", alignItems:"center", gap:"6px", cursor:"pointer" });

      const cb = document.createElement("input"); cb.type="checkbox"; cb.checked = true;
      const sw = document.createElement("span");
      Object.assign(sw.style, { width:"10px", height:"10px", borderRadius:"999px",
                                background: DAY_COLORS[grp.colorIdx].hex, border:"1px solid #999" });
      const txt = document.createElement("span"); txt.textContent = `Day ${day}`;

      wrap.appendChild(cb); wrap.appendChild(sw); wrap.appendChild(txt);
      panel.appendChild(wrap);

      cb.addEventListener("change", () => {
        grp.markers.forEach(m => m.setMap(cb.checked ? map : null));
        if (currentInfoWindow && (!currentInfoWindow.getAnchor() || !currentInfoWindow.getAnchor().getMap())) {
          currentInfoWindow.close(); currentInfoWindow = null;
        }
        // Re-fit to visible markers
        const visible = [];
        groups.forEach(g => g.markers.forEach(m => { if (m.getMap()) visible.push(m); }));
        if (visible.length) {
          const b = new google.maps.LatLngBounds(); visible.forEach(m => b.extend(m.getPosition())); map.fitBounds(b);
        }
      });
    });

    // Reset view
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset view";
    Object.assign(resetBtn.style, { marginLeft:"6px", padding:"6px 10px", borderRadius:"8px",
                                    border:"1px solid #e5e7eb", background:"#fff", cursor:"pointer" });
    resetBtn.addEventListener("click", () => {
      const b = new google.maps.LatLngBounds(); allMarkers.forEach(m => b.extend(m.getPosition())); map.fitBounds(b);
    });
    panel.appendChild(resetBtn);

    map.controls[google.maps.ControlPosition.TOP_LEFT].push(panel);
  }
  window.buildEmbeddedMap = buildEmbeddedMap;

  // -------------------------------
  // 6. Export: KML (same)
  // -------------------------------
function downloadKML(itinerary, city, country) {
  // --- helpers ---
  const xmlEscape = (s = "") =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  // Wrap safely in CDATA
  const wrapCDATA = (s = "") =>
    "<![CDATA[" + String(s).replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";

  // Collect unique days sorted
  const days = [...new Set((itinerary || []).map(i => Number(i.day)))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const docName = `${city || "Itinerary"}${country ? ", " + country : ""} Itinerary`;

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<kml xmlns="http://www.opengis.net/kml/2.2">`);
  parts.push(`<Document>`);
  parts.push(`<name>${xmlEscape(docName)}</name>`);

  days.forEach(day => {
    parts.push(`<Folder><name>${xmlEscape("Day " + day)}</name>`);

    (itinerary || [])
      .filter(s => Number(s.day) === day)
      .forEach(s => {
        const lat = Number(s.lat), lng = Number(s.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const nm = `${s.time ? s.time + " — " : ""}${s.name || ""}`;
        const desc = s.description
          ? `<description>${wrapCDATA(s.description)}</description>`
          : "";

        parts.push(`<Placemark>`);
        parts.push(`<name>${xmlEscape(nm)}</name>`);
        if (desc) parts.push(desc);
        parts.push(`<Point><coordinates>${lng},${lat},0</coordinates></Point>`);
        parts.push(`</Placemark>`);
      });

    parts.push(`</Folder>`);
  });

  parts.push(`</Document></kml>`);
  const kml = parts.join("");

  // Download
  const blob = new Blob([kml], {
    type: "application/vnd.google-earth.kml+xml;charset=UTF-8"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ((city || "itinerary") + (country ? "_" + country : "")).replace(/\s+/g, "_") + ".kml";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}


  window.downloadKML = downloadKML;

  // -------------------------------
  // 7. Export: Static Map (same)
  // -------------------------------
  function buildStaticMapUrl(itinerary, city, country) {
    const size  = "640x320";   // scale=2 => 1280x640 effective
    const scale = 2;
    const colors = ["red","blue","green","purple","orange","yellow","pink","ltblue"];

    // Normalize day values to numbers to keep labels consistent
    const days = [...new Set(itinerary.map(i => Number(i.day)))]
      .filter(n => Number.isFinite(n))
      .sort((a,b)=>a-b);

    const params = [
      `size=${size}`,
      `scale=${scale}`,
      "maptype=roadmap"
    ];

    days.forEach((day, idx) => {
      // ✅ Coerce lat/lng; include only valid floats
      const stops = itinerary
        .filter(s => Number(s.day) === day)
        .map(s => ({ lat: parseFloat(s.lat), lng: parseFloat(s.lng) }))
        .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));

      if (!stops.length) return;

      const pts = stops.map(s => `${s.lat},${s.lng}`).join("|");
      params.push(`markers=color:${colors[idx % colors.length]}|label:${day}|${pts}`);
    });

    const key = encodeURIComponent(GMAPS_API_KEY);
    return `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}&key=${key}`;
  }
  window.buildStaticMapUrl = buildStaticMapUrl;

  // -------------------------------
  // 8. Export: PDF (same structure)
  // -------------------------------
  async function exportPDF(itinerary, city, country, recommendations = {}){
    const jsPDF = await ensureJsPDF();
    const doc = new jsPDF({ unit:"pt", format:"a4" });

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 46;
    let y = margin;
    const selectedFocus = Array.from(document.querySelectorAll('input[name="tip_focus"]:checked')).map(i=>i.value);
    const ALLOWED = new Set(selectedFocus);

    const allowFilter = (obj) => {
      if (!obj || ALLOWED.size === 0) return {};
      const out = {};
      TIP_ORDER.forEach(k=>{
      if (!ALLOWED.has(k)) return;
      const arr = Array.isArray(obj[k]) ? obj[k].filter(Boolean) : [];
      if (arr.length) out[k] = arr;
      });
      return out;


    };
    const hasAnyAllowed = (obj) => !!obj && Object.keys(obj).some(k => Array.isArray(obj[k]) && obj[k].length);

    const days = [...new Set(itinerary.map(i => i.day))].sort((a,b)=>a-b);

    doc.setFont("helvetica","bold"); doc.setFontSize(18);
    doc.text(`${city}${country ? ", " + country : ""} — Personalized Itinerary`, margin, y); 
    y += 12;
    doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 16;

    const staticUrl = buildStaticMapUrl(itinerary, city, country);
    const imgW = pageW - margin*2;
    const imgH = Math.round(imgW * (320/640));
    try { doc.addImage(staticUrl, "PNG", margin, y, imgW, imgH); y += imgH + 10; }
    catch { doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.setTextColor(60); doc.text("Map preview unavailable.", margin, y); doc.setTextColor(0); y += 16; }

    doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 18;

    const lineH = 15;
    const maxW = pageW - margin*2;

    function writeWrappedLink(text, url, opt={bold:false, indent:0}) {
      doc.setFont("helvetica", opt.bold ? "bold" : "normal");
      doc.setFontSize(opt.bold ? 13 : 11);
      const lines = doc.splitTextToSize(text, maxW - (opt.indent||0));
      for (const line of lines) {
        if (y > pageH - margin) { doc.addPage(); y = margin; }
        doc.setTextColor(33,115,214);
        doc.textWithLink(line, margin + (opt.indent||0), y, { url });
        doc.setTextColor(0);
        y += lineH;
      }
    }
    function writeWrappedText(text, opt={bold:false, indent:0, italic:false, gray:false}) {
      doc.setFont("helvetica", opt.bold ? "bold" : (opt.italic ? "italic" : "normal"));
      doc.setFontSize(opt.bold ? 13 : 11);
      if (opt.gray) doc.setTextColor(100); else doc.setTextColor(0);
      const lines = doc.splitTextToSize(text, maxW - (opt.indent||0));
      for (const line of lines) {
        if (y > pageH - margin) { doc.addPage(); y = margin; }
        doc.text(line, margin + (opt.indent||0), y);
        y += lineH;
      }
      doc.setTextColor(0);
    }

    days.forEach(day => {
      if (y > pageH - margin - 40) { doc.addPage(); y = margin; }
      doc.setFont("helvetica","bold"); doc.setFontSize(14);
      doc.text(`Day ${day}`, margin, y); y += 10;
      doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 12;

      const stops = itinerary.filter(s => s.day === day);

      stops.forEach((s, i) => {
        const timeText = s.time ? s.time + " — " : "";
        const nameText = s.name || "";
        const gLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(nameText + ", " + city + (country ? ", " + country : ""))}`;

        if (timeText) { doc.setFont("helvetica","normal"); doc.setFontSize(11); doc.text(timeText, margin, y); }
        const nameX = margin + doc.getTextWidth(timeText);
        doc.setFont("helvetica","bold"); doc.setFontSize(13);
        doc.setTextColor(33,115,214);
        doc.textWithLink(nameText, nameX, y, { url: gLink });
        doc.setTextColor(0);
        y += lineH;

        if (s.description) writeWrappedText(s.description, { indent:14 });
        if (i < stops.length - 1) y += 6;
      });

      if (stops.length > 1) {
        const origin = encodeURIComponent(stops[0].name + ", " + city + (country ? ", " + country : ""));
        const destination = encodeURIComponent(stops[stops.length - 1].name + ", " + city + (country ? ", " + country : ""));
        const waypoints = stops.slice(1, -1).map(s => encodeURIComponent(s.name + ", " + city + (country ? ", " + country : ""))).join("|");
        const dUrl = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints ? "&waypoints=" + waypoints : ""}`;
        y += 4;
        writeWrappedLink("Directions for this day", dUrl, { bold:true });
      }

      // Keep your current two-line style (title line + paragraph)
   
      const _perDay = (recommendations?.per_day || recommendations?.day_tips || {});
      const dailyTip = _perDay[`day_${day}`] ?? _perDay[String(day)] ?? _perDay[day] ?? "";
      if (dailyTip && String(dailyTip).trim()) {
        y += 6;
        writeWrappedText(`Tip for Day ${day}`, { bold:true });
        writeWrappedText(dailyTip, { indent:14, gray:true });
      }


      y += 10;
    });

    const cityTips = allowFilter((recommendations?.city_tips || (typeof window !== "undefined" ? window.__mvCityTips : null) || {}));
    if (hasAnyAllowed(cityTips)) {
      if (y > pageH - margin - 40) { doc.addPage(); y = margin; }
      doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 12;
      doc.setFont("helvetica","bold"); doc.setFontSize(14);
      doc.text("City tips", margin, y); y += 10;

      Object.keys(cityTips).forEach(k=>{
        writeWrappedText(TIP_LABELS[k], { bold:true });
        cityTips[k].forEach(t => writeWrappedText("• " + t, { indent:14, italic:true, gray:true }));
        y += 4;
      });
    }

    if (y > pageH - margin) { doc.addPage(); y = margin; }
    doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 14;
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(110);
    doc.text("Tip: In Google Maps app, download the city offline to use these links without data.", margin, y);
    doc.setTextColor(0);

   // Append restore link at the end
   const restoreLink = buildRestoreLink();
   if (restoreLink) {
     y += 16;
     if (y > pageH - margin) { doc.addPage(); y = margin; }
     doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(0);
     doc.text("Re-open later (kept ~30 days):", margin, y); y += 14;
     doc.setFont("helvetica","normal");
     doc.setTextColor(10, 80, 180);
     try { doc.textWithLink(restoreLink, margin, y, { url: restoreLink }); } catch(_) { doc.text(restoreLink, margin, y); }
     doc.setTextColor(0);
   }
   
   doc.save(`${(city || "itinerary").replace(/\s+/g,'_')}${country ? "_" + country.replace(/\s+/g,'_') : ""}.pdf`);

  }
  window.exportPDF = exportPDF;

  // -------------------------------
  // 9. Export: Share (same)
  // -------------------------------
async function shareItinerary(itinerary, city, country, recommendations = {}) {

  const selectedFocus = Array.from(document.querySelectorAll('input[name="tip_focus"]:checked')).map(i=>i.value);
  const ALLOWED = new Set(selectedFocus);
  const allowFilter = (obj) => {
    if (!obj || ALLOWED.size===0) return {};
    const o={}; Object.keys(obj).forEach(k=>{ if (ALLOWED.has(k)) o[k]=obj[k]; });
    return o;
  };

  // Escape for HTML clipboard
  const esc = (s) => String(s||"").replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const title = `${city}${country ? ", " + country : ""} — Itinerary`;

  // ------- TEXT (keeps your content + link lines) -------
  let text = `${title}\n\n`;
  const days = [...new Set(itinerary.map(i=>i.day))].sort((a,b)=>a-b);
  const byDay = new Map(); itinerary.forEach(it => { if(!byDay.has(it.day)) byDay.set(it.day, []); byDay.get(it.day).push(it); });

  days.forEach(day => {
    const stops = (byDay.get(day)||[]).sort((a,b)=> (a.time||"").localeCompare(b.time||""));
    text += `Day ${day}\n`;
    stops.forEach(s => {
      const link = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(((s.name||"") + ", " + city + (country ? ", " + country : "")))}`;
      text += `• ${s.time ? s.time+" — " : ""}${s.name}\n  ${link}\n${s.description? "  ("+s.description+")\n":""}`;
    });
    if (stops.length>1){
      const origin=encodeURIComponent(stops[0].name+", "+city+(country? ", "+country:""));
      const destination=encodeURIComponent(stops[stops.length-1].name+", "+city+(country? ", "+country:""));
      const waypoints=stops.slice(1,-1).map(s=>encodeURIComponent(s.name+", "+city+(country? ", "+country:""))).join("|");
      const dUrl=`https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints? "&waypoints="+waypoints:""}`;
      text += `Directions (Day ${day}): ${dUrl}\n`;
    }
   const _perDay = (recommendations?.per_day || recommendations?.day_tips || {});
   const dailyTip = _perDay[`day_${day}`] ?? _perDay[String(day)] ?? _perDay[day] ?? "";
   if (dailyTip && String(dailyTip).trim()) text += `Tip for Day ${day}: ${dailyTip}\n`;

    text += `\n`;
  });

  const cityTips = allowFilter(recommendations?.general || {});
  if (Object.keys(cityTips).length){
    text += `CITY TIPS\n`;
    Object.keys(cityTips).forEach(k=>{
      text += `- ${TIP_LABELS[k]}:\n`;
      cityTips[k].forEach(t => { text += `  • ${t}\n`; });
    });
    text += `\n`;
  }

  // ------- HTML (for rich clipboard: hyperlinked places) -------
  let html = `<div><p><strong>${esc(title)}</strong></p>`;
  days.forEach(day => {
    const stops = (byDay.get(day)||[]).sort((a,b)=> (a.time||"").localeCompare(b.time||""));
    html += `<p><strong>Day ${day}</strong></p><ul>`;
    stops.forEach(s => {
      const link = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(((s.name||"") + ", " + city + (country ? ", " + country : "")))}`;
      html += `<li>${s.time ? esc(s.time)+" — " : ""}<a href="${link}">${esc(s.name)}</a>${s.description? " <em>("+esc(s.description)+")</em>":""}</li>`;
    });
    if (stops.length>1){
      const origin=encodeURIComponent(stops[0].name+", "+city+(country? ", "+country:""));
      const destination=encodeURIComponent(stops[stops.length-1].name+", "+city+(country? ", "+country:""));
      const waypoints=stops.slice(1,-1).map(s=>encodeURIComponent(s.name+", "+city+(country? ", "+country:""))).join("|");
      const dUrl=`https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints? "&waypoints="+waypoints:""}`;
      html += `<li><a href="${dUrl}"><em>Directions (Day ${day})</em></a></li>`;
    }
   const _perDay = (recommendations?.per_day || recommendations?.day_tips || {});
   const dailyTip = _perDay[`day_${day}`] ?? _perDay[String(day)] ?? _perDay[day] ?? "";
   if (dailyTip && String(dailyTip).trim()) html += `<li><strong>Tip for Day ${day}:</strong> ${esc(dailyTip)}</li>`;
    html += `</ul>`;
  });

  if (Object.keys(cityTips).length){
    html += `<p><strong>CITY TIPS</strong></p>`;
    TIP_ORDER.forEach(k=>{
      if (!cityTips[k] || !cityTips[k].length) return;
      html += `<p><strong>${esc(TIP_LABELS[k])}:</strong></p><ul>`;
      cityTips[k].forEach(t => { html += `<li>• ${esc(t)}</li>`; });
      html += `</ul>`;
    });
  }
  html += `</div>`;
   // Add restore link at the end of the plain text
const __restoreLink = buildRestoreLink();
if (__restoreLink && !/Re-open this itinerary:/i.test(text)) {
  text += `\n\nRe-open this itinerary: ${__restoreLink}  (kept ~30 days)`;
}
   // Add the same link to the HTML flavor (used by desktop rich clipboard)
if (__restoreLink && !/Re-open this itinerary/i.test(html)) {
  html += `<p><strong>Re-open this itinerary:</strong> <a href="${__restoreLink}">${__restoreLink}</a> <em>(kept ~30 days)</em></p>`;
}

  // Mobile: native share sheet first
  if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)){
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) { /* fallback below */ }
  }

  // Desktop / fallback: rich clipboard (HTML + plain)
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const data = { "text/plain": new Blob([text], { type: "text/plain" }) };
      if (html) data["text/html"] = new Blob([html], { type: "text/html" });
      await navigator.clipboard.write([ new ClipboardItem(data) ]);
      alert("Itinerary copied ✔️");
      return;
    }
  } catch (e) { /* continue to simple fallback */ }

  try {
    await navigator.clipboard?.writeText(text);
    alert("Itinerary copied ✔️");
  } catch {
    const w = window.open("","_blank");
    w.document.write(`<pre>${text.replace(/</g,"&lt;")}</pre>`);
    w.document.close();
  }
}
window.shareItinerary = shareItinerary;


  // -------------------------------
  // 2. Form submission (wired in init)
  // 3. Date controls wiring (wired in init)
  // -------------------------------

// NEW: make this a function so it's not executed at top-level
// wrap in a function so 'root' exists and nothing executes at top level
// --- Config (lives in GitHub) ---
const EMAIL_URL_DEFAULT = "https://script.google.com/macros/s/AKfycbxny50qVDVtA-ZWXor9oX2trVH-IeR6UiEWFAPaPHm7jBbiyset9gQdF4FG7tSx7aj6/exec";

   
function wireDateControls(root = document){
  const pick = (id, name) => document.getElementById(id) || root.querySelector(`[name="${name}"]`);

  function init(){
    const startEl = pick("start_date","start_date");
    const endEl   = pick("end_date","end_date");
    const freeCb  = pick("no_dates","no_dates");
    const daysEl  = pick("stay_days","stay_days");
    const festCb  = document.getElementById("cat_festivals");

    if (!startEl || !endEl || !freeCb || !daysEl) return false;

    const today = new Date(); today.setHours(0,0,0,0);
    const isoToday = today.toISOString().slice(0,10);
    startEl.min = isoToday;
    endEl.min   = isoToday;

    function clamp7(n){ return Math.max(1, Math.min(7, Math.floor(Number(n)||0))); }
    function calcDays(){
      const s = new Date(startEl.value||isoToday);
      const e = new Date(endEl.value||startEl.value||isoToday);
      s.setHours(0,0,0,0); e.setHours(0,0,0,0);
      if (e < s) { endEl.value = startEl.value; return calcDays(); }
      const d = Math.floor((e - s)/86400000) + 1;
      daysEl.value = clamp7(d);
    }

    function enforceFestivalsRule(){
      if (!festCb) return;
      if (freeCb.checked){
        festCb.checked = false;
        festCb.disabled = true;
        festCb.closest("label")?.setAttribute("title","Requires fixed dates");
      } else {
        festCb.disabled = false;
      }
    }

    function syncDisabled(){
      if (freeCb.checked){
        startEl.disabled = true; endEl.disabled = true;
        startEl.value = ""; endEl.value = "";
        daysEl.disabled  = false;
      } else {
        startEl.disabled = false; endEl.disabled = false;
        daysEl.disabled  = true;
        calcDays();
      }
      enforceFestivalsRule();
    }

    startEl.addEventListener("change", () => {
      endEl.min = startEl.value || isoToday;
      if (endEl.value && endEl.value < endEl.min) endEl.value = endEl.min;
      calcDays();
    });
    endEl.addEventListener("change", calcDays);
    freeCb.addEventListener("change", syncDisabled);

    syncDisabled();
    return true;
  }

  if (!init()){
    let tries = 0, t = setInterval(() => { if (init() || ++tries > 40) clearInterval(t); }, 100);
  }
}
   
function mvClearPreviousOutput() {
   // reset email gating + last payload
  window.__mvEmailSent = false;
  window.__mvItinerary = [];
  window.__mvDayTips = {};
  window.__mvCityTips = {};
  // results (days + buttons live here)
  const results = document.getElementById("mv-results");
  if (results) results.innerHTML = "";

  // NEW: clear the dedicated plan container so previous itinerary disappears immediately
  const planRoot = document.getElementById("mv-plan");
  if (planRoot) planRoot.innerHTML = "";

  // tips (the helper renders into this container)
  const tips = document.getElementById("mv-city-tips");
  if (tips) tips.innerHTML = "";

  // map (simple reset so you don't see previous markers while loading)
  const mapWrap = document.getElementById("mv-map-wrap");
  if (mapWrap) {
    mapWrap.innerHTML = `<div id="mv-map"></div>`;
  } else {
    const map = document.getElementById("mv-map");
    if (map) map.innerHTML = "";
  }
}

function mvBuildEmailPayload() {
  // Gather the most recent data already in your UI/state
  const city     = document.querySelector('#mv-form input[name="city"]')?.value?.trim() || "";
  const country  = document.querySelector('#mv-form input[name="country"]')?.value?.trim() || "";
  const to       = document.querySelector('#mv-form input[name="email"]')?.value?.trim() || "";
  const itinerary = Array.isArray(window.__mvItinerary) ? window.__mvItinerary : [];
  const day_tips  = window.__mvDayTips || {};
  const city_tips = window.__mvCityTips || {};
  const tip_focus = (typeof ALLOWED !== "undefined" && ALLOWED && typeof ALLOWED.forEach === "function")
    ? Array.from(ALLOWED)
    : [];

  const restore_url = buildRestoreLink();
   return { to, city, country, itinerary, day_tips, city_tips, tip_focus, restore_url };

}

function mvEmailSendFireAndForget(payload) {
  try {
    const url = (typeof window !== "undefined" && typeof window.CITYROUTE_EMAIL_URL === "string" && window.CITYROUTE_EMAIL_URL)
      ? window.CITYROUTE_EMAIL_URL
      : (typeof EMAIL_URL_DEFAULT === "string" ? EMAIL_URL_DEFAULT : "");

    if (!url || !payload || !payload.to) return;

    const json = JSON.stringify(payload);

    // Use Beacon first: text/plain avoids preflight and is non-blocking
    if (navigator.sendBeacon) {
      const blob = new Blob([json], { type: "text/plain;charset=UTF-8" });
      navigator.sendBeacon(url, blob);
      return;
    }

    // Fallback: simple POST without custom headers; no-cors prevents preflight
    fetch(url, {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      body: json // text/plain by default (no headers) -> simple request
    }).catch(() => {});
  } catch (_) {}
}

   function trySendEmailIfReady() {
  try {
    // already sent in this session?
    if (window.__mvEmailSent) return;

    // user didn’t provide an email? do nothing
    const to = document.querySelector('#mv-form input[name="email"]')?.value?.trim() || "";
    if (!to) return;

    // itinerary must exist
    const itin = Array.isArray(window.__mvItinerary) ? window.__mvItinerary : [];
    if (!itin.length) return;

    // if the user selected any city-tip categories, wait until tips are present too
    const selectedFocus = Array.from(document.querySelectorAll('input[name="tip_focus"]:checked')).map(i=>i.value);
    const requireTips = selectedFocus.length > 0;
    const tips = window.__mvCityTips || {};
    const tipsReady = !requireTips || Object.keys(tips).some(k => Array.isArray(tips[k]) && tips[k].length);

    if (!tipsReady) return;

    // build + fire (non-blocking)
    const payload = mvBuildEmailPayload();
    mvEmailSendFireAndForget(payload);
    window.__mvEmailSent = true;
  } catch (_) {}
}
// -------------------------------
// Auto-restore from querystring
// -------------------------------
function tryAutoRestore(ctx = {}) {
  const formRef       = ctx.form || document.getElementById("mv-form");
  const itineraryRoot = ctx.itineraryEl || document.getElementById("itinerary");

const params = new URLSearchParams(location.search || "");
const jobId  = params.get("job_id") || params.get("jobId") || params.get("jobID") || "";
const planId = params.get("plan_id") || params.get("planId") || params.get("planID") || "";
const tipsId = params.get("tips_id") || params.get("tipsId") || params.get("tipsID") || "";

// NEW: Firestore restore path
if (jobId) {
  mvClearPreviousOutput();
  if (formRef) formRef.style.display = "none";
  if (itineraryRoot) itineraryRoot.style.display = "block";
  startProgress("Restoring job…");
  showSkeleton(true);

  window.__mvJobID = jobId;
  updateSharePageButton();

  (function ensureItinContainers(){
    const wrap = itineraryRoot || document.getElementById("itinerary");
    if (!wrap) return;
    if (!wrap.querySelector("#mv-plan")) {
      const d = document.createElement("div");
      d.id = "mv-plan";
      wrap.appendChild(d);
    }
    if (!wrap.querySelector("#mv-city-tips")) {
      const d = document.createElement("div");
      d.id = "mv-city-tips";
      wrap.appendChild(d);
    }
  })();

  // stop previous listener (if any)
  try { window.__mvJobUnsub?.(); } catch (_) {}
  window.__mvJobUnsub = await listenToJobDoc(jobId, async (job) => {
    const status = String(job.status || "");
    if (status === "queued")  setProgress(20, "Queued…");
    if (status === "running") setProgress(45, "Generating…");

    if (status === "error") {
      showSkeleton(false);
      endProgress();
      showRestoreError(String(job.error || "Job failed"));
      return;
    }

    if (status === "done") {
      const input = job.input || {};
      const result = job.result || {};
      const itinerary = Array.isArray(result.itinerary) ? result.itinerary : [];
      const day_tips  = (result.day_tips  && typeof result.day_tips  === "object") ? result.day_tips  : {};
      const city_tips = (result.city_tips && typeof result.city_tips === "object") ? result.city_tips : {};

      applyTipFocusSelection(input.tip_focus);

      setProgress(70, "Rendering…");
      showSkeleton(false);

      renderItinerary(
        { itinerary, recommendations: { per_day: day_tips, city_tips } },
        input.city || "",
        input.country || ""
      );

      setProgress(85, "Building map…");
      try { buildEmbeddedMap?.(itinerary, input.city || "", input.country || ""); } catch (_){}

      // keep email logic
      window.__mvCityTips = city_tips;
      trySendEmailIfReady();

      setProgress(100, "Done");
      endProgress();
    }
  });

  return true;
}

// OLD fallback: plan_id / tips_id restore (your existing code)
if (!planId && !tipsId) return false;


  // Prepare UI
  mvClearPreviousOutput();
  if (formRef) formRef.style.display = "none";
  if (itineraryRoot) itineraryRoot.style.display = "block";
  startProgress("Restoring itinerary…");
  showSkeleton(true);

  // keep Share Page working
  window.__mvPlanID = planId || "";
  window.__mvTipsID = tipsId || "";
  updateSharePageButton();

  // Ensure result containers exist (#mv-plan, #mv-city-tips) exactly like the submit flow
  (function ensureItinContainers(){
    const wrap = itineraryRoot || document.getElementById("itinerary");
    if (!wrap) return;
    if (!wrap.querySelector("#mv-plan")) {
      const d = document.createElement("div");
      d.id = "mv-plan";
      wrap.appendChild(d);
    }
    if (!wrap.querySelector("#mv-city-tips")) {
      const d = document.createElement("div");
      d.id = "mv-city-tips";
      wrap.appendChild(d);
    }
  })();

  // Fetch combined data (itinerary + per-day tips + city tips)
  const qs = new URLSearchParams();
  if (planId) qs.set("plan_id", planId);
  if (tipsId) qs.set("tips_id", tipsId);

  fetch(`${RESTORE_URL}?${qs.toString()}`)
    .then(r => r.json())
    .then(data => {
      if (!data?.success) throw new Error(data?.error || "Restore failed");

      const itinerary = Array.isArray(data.result?.itinerary) ? data.result.itinerary : [];
      const day_tips  = (data.result && typeof data.result.day_tips  === "object") ? data.result.day_tips  : {};
      const city_tips = (data.result && typeof data.result.city_tips === "object") ? data.result.city_tips : {};

      const resultObj = { itinerary, recommendations: { per_day: day_tips } };

      setProgress(45, "Rendering itinerary…");
      showSkeleton(false);
      renderItinerary(resultObj, "", "");

      setProgress(70, "Building map…");
      try { buildEmbeddedMap?.(itinerary, "", ""); } catch (_){}

      if (Object.keys(city_tips).length) {
        const tipsRoot = document.getElementById("mv-city-tips") || itineraryRoot;
        renderCityTipsIntoExistingContainer(tipsRoot, city_tips);
        window.__mvCityTips = city_tips;
        trySendEmailIfReady();
      }

      setProgress(100, "Done");
      endProgress();
    })
    .catch(err => {
     const raw = String(err || "");
     let human = "We couldn’t restore this itinerary. The saved IDs may be wrong or expired.";
     // Make it extra clear when it’s the 30-day window or a not-found
     if (/not\s*found|404/i.test(raw)) {
       human = "These saved results are no longer available (System keeps responses for ~30 days).";
     } else if (/expired|30\s*days?/i.test(raw)) {
       human = "These saved results have expired (System keeps responses for ~30 days).";
     }
     human += " ";
     showRestoreError(human);
   });


  return true;
}
// Friendly error (form stays hidden) + visible top banner with restart link
function showRestoreError(message) {
  endProgress();
  showSkeleton(false);

  // Ensure we’re at the top so the banner is seen
  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (_){ window.scrollTo(0,0); }

  // Create (or reuse) a top alert banner just under the site header
  let bar = document.getElementById("mv-restore-alert");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "mv-restore-alert";
    // Inline styles so we don’t need CSS edits
    bar.style.position = "relative";
    bar.style.zIndex = "100";
    bar.style.margin = "16px auto";
    bar.style.maxWidth = "1100px";
    bar.style.border = "1px solid #e5b4b4";
    bar.style.background = "#ffecec";
    bar.style.color = "#8b0000";
    bar.style.borderRadius = "8px";
    bar.style.padding = "14px 16px";
    bar.style.fontWeight = "600";
    bar.style.boxShadow = "0 2px 8px rgba(0,0,0,0.06)";

    // insert just before the itinerary/results area (near the top hero)
    const anchor = document.querySelector("#mv-hero") ||
                   document.querySelector(".entry-content") ||
                   document.querySelector("#mv-results") ||
                   document.body;
    anchor.parentNode.insertBefore(bar, anchor);
  }

  // Render text + CTA
  bar.innerHTML = ""; // reset
  const msg = document.createElement("div");
  msg.textContent = message;
  const cta = document.createElement("a");
  cta.href = "https://mapvivid.com/ai-itinerary/";
  cta.textContent = "Start a new itinerary";
  cta.style.display = "inline-block";
  cta.style.marginTop = "6px";
  cta.style.textDecoration = "underline";
  cta.style.color = "#0047ab";
  bar.appendChild(msg);
  bar.appendChild(cta);

  // Keep the form hidden so the user isn’t pushed down the page
  const formEl = document.getElementById("mv-form");
  if (formEl) formEl.style.display = "none";
}

function mvAttachFormFunnelTracking(form) {
  if (!form) return;

  let started = false;
  const sentFields = new Set();

  const startOnce = () => {
    if (started) return;
    started = true;
    window.__mvFormFirstInteractAt = performance.now();
    mvGaEvent("itinerary_form_start");
  };

  // First interaction = form started
  ["focusin", "input", "change"].forEach(ev => {
    form.addEventListener(ev, startOnce, { passive: true });
  });

  // Lightweight “field_change” (only once per field name to avoid spam)
  form.addEventListener("change", (e) => {
    const t = e.target;
    if (!t) return;

    const name = t.name || t.id || "";
    if (!name || sentFields.has(name)) return;
    sentFields.add(name);

    mvGaEvent("itinerary_field_change", {
      field: name,
      type: (t.type || "").toString(),
    });
  }, { passive: true });
}

  // -------------------------------
  // INIT — called after HTML is injected
  // -------------------------------
  function initCityRouteUI(root = document){
   mvGaPage("/ai-itinerary/form", "AI Itinerary Builder - Form");
   mvGaEvent("cityroute_loaded");
   window.__mvFormLoadedAt = performance.now();


         // --- Countries & Cities wiring (moved from top-level so it runs AFTER injection)
    loadCountries();
    // cache key elements (same IDs as before)
     wireDateControls(root);
    const form = root.querySelector("#mv-form") || document.getElementById("mv-form");
     const statusEl = root.querySelector("#mv-status") || document.getElementById("mv-status");
     mvAttachFormFunnelTracking(form);


    // expose for renderItinerary
    window.cityrouteForm = form;
    window.cityrouteStatus = statusEl;

    // init containers
    itineraryEl = root.querySelector("#itinerary") || document.getElementById("itinerary");
   tryAutoRestore({ form, itineraryEl });


    const countryEl = document.getElementById("country");
    const cityEl = document.getElementById("city");
    const cityOther = document.getElementById("city_other");

    if (countryEl) {
      countryEl.addEventListener("change", async (e) => {
        const country = e.target.value;

        cityEl.innerHTML = `<option value="">-- Select a city --</option>`;
        cityOther.style.display = "none";
        cityOther.value = "";

        if (!country) {
          const otherOpt = document.createElement("option");
          otherOpt.value = "__other__";
          otherOpt.textContent = "Other (type manually)";
          cityEl.appendChild(otherOpt);
          return;
        }

        try {
          const sep = CITIES_API_URL.includes("?") ? "&" : "?";
          const res = await fetch(`${CITIES_API_URL}${sep}action=getCities&country=${encodeURIComponent(country)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();

          if (Array.isArray(data)) {
            data.forEach(city => {
              const opt = document.createElement("option");
              opt.value = city;
              opt.textContent = city;
              cityEl.appendChild(opt);
            });
          }
        } catch (err) {
          console.error("Error loading cities:", err);
        }

        const otherOpt = document.createElement("option");
        otherOpt.value = "__other__";
        otherOpt.textContent = "Other (type manually)";
        cityEl.appendChild(otherOpt);
      });
    }

    if (cityEl) {
      cityEl.addEventListener("change", (e) => {
        if (e.target.value === "__other__") {
          cityOther.style.display = "block";
          cityOther.required = true;
        } else {
          cityOther.style.display = "none";
          cityOther.required = false;
          cityOther.value = "";
        }
      });
    }


    // --- Form submission (same logic)
    form.addEventListener("submit", async function(e) {
  e.preventDefault();
   mvClearPreviousOutput();  // <-- clear old itinerary/tips/map immediately


  const statusEl = document.getElementById("mv-status");
  let itineraryEl = document.getElementById("itinerary");
  const form = e.currentTarget;
   // show results area right now, so whichever request finishes first can render
form.style.display = "none";
itineraryEl.style.display = "block";
showSkeleton(true);

// ensure dedicated roots so plan and tips don’t overwrite each other
(function ensureItinContainers(){
  const wrap = itineraryEl || document.getElementById("itinerary");
  if (!wrap) return;
  if (!wrap.querySelector("#mv-plan")) {
    const d = document.createElement("div");
    d.id = "mv-plan";
    wrap.appendChild(d);
  }
  if (!wrap.querySelector("#mv-city-tips")) {
    const d = document.createElement("div");
    d.id = "mv-city-tips";
    wrap.appendChild(d);
  }
})();


  // === build your existing payload exactly as you already do (keep your current code here) ===
  // NOTE: If your code already computes "payload", leave it as-is. We reuse it below.
  const payload = (function buildPayloadFromForm(f) {
    const fd = new FormData(f);
    const pick = k => (fd.get(k) || "").toString().trim();
    const pickAll = name => Array.from(f.querySelectorAll(`input[name="${name}"]:checked`)).map(i=>i.value);
    return {
     city: (pick("city") === "__other__" ? pick("city_other") : pick("city")),
     country: pick("country"),
     start_date: pick("start_date"),
     end_date: pick("end_date"),
     no_dates: fd.get("no_dates") ? "1" : "",
     stay_days: pick("stay_days"),
     categories: pickAll("categories"),
     mobility: pickAll("mobility"),
     companion_type: pick("companion_type"),
     tip_focus: pickAll("tip_focus"),
     pace: pick("pace"),
     budget: { value: pick("budget_value"), currency: pick("budget_currency") },
     duration_value: pick("duration_value"),
     duration_unit: pick("duration_unit"),
     start_daypart: pick("start_daypart"),
     extra_requests: pick("extra_requests"),
     outputs: pickAll("outputs").join(","),
     email: pick("email")
   };

  })(form);
       const tSubmit = performance.now();
window.__mvSubmitAt = tSubmit;

mvGaEvent("itinerary_submit", {
  city: payload.city || "",
  country: payload.country || "",
  categories: payload.categories || "",
  pace: payload.pace || "",
  categories_count: payload.categories ? payload.categories.split(",").filter(Boolean).length : 0,
  outputs_count: payload.outputs ? payload.outputs.split(",").filter(Boolean).length : 0,
  has_email: !!(payload.email && payload.email.trim()),
  no_dates: payload.no_dates ? 1 : 0,
  ms_since_load: window.__mvFormLoadedAt ? Math.round(tSubmit - window.__mvFormLoadedAt) : undefined,
  ms_since_start: window.__mvFormFirstInteractAt ? Math.round(tSubmit - window.__mvFormFirstInteractAt) : undefined
});

mvGaPage("/ai-itinerary/loading", "AI Itinerary Builder - Loading");


  // === UI start ===
  statusEl.style.color = "#374151";
  statusEl.textContent = "";
  startProgress("Validating inputs…");
  showSkeleton(true);

  // preload heavy libs in parallel while network requests run
  const preloads = Promise.all([
    (typeof loadMaps === "function" ? loadMaps() : Promise.resolve()).catch(()=>{}),
    (typeof ensureJsPDF === "function" ? ensureJsPDF() : Promise.resolve()).catch(()=>{})
  ]);

  // === Create 1 async job in Cloud Run, then listen in Firestore ===
setProgress(18, "Starting job…");

try {
  // Convert your existing payload into the Cloud Run input format
  // (This assumes you already changed payload fields in 4A: arrays + budget object)
  const input = {
    city: String(payload.city || "").trim(),
    country: String(payload.country || "").trim(),
    start_date: String(payload.start_date || "").trim(),
    end_date: String(payload.end_date || "").trim(),
    no_dates: !!payload.no_dates,
    stay_days: String(payload.stay_days || "").trim(),
    categories: Array.isArray(payload.categories) ? payload.categories : [],
    mobility: Array.isArray(payload.mobility) ? payload.mobility : [],
    companion_type: String(payload.companion_type || "").trim(),
    tip_focus: Array.isArray(payload.tip_focus) ? payload.tip_focus : [],
    pace: String(payload.pace || "").trim(),
    budget: (payload.budget && typeof payload.budget === "object")
      ? payload.budget
      : { value: "", currency: "" },
    extra_requests: String(payload.extra_requests || "").trim(),
    email: String(payload.email || "").trim()
  };

  // 1) Create job
  const jobId = await cloudRunCreateJob(input);
  window.__mvJobID = jobId;
  updateSharePageButton();

  setProgress(30, "Queued…");

  // 2) Listen to Firestore until done/error
  try { window.__mvJobUnsub?.(); } catch (_) {}
  window.__mvJobUnsub = await listenToJobDoc(jobId, async (job) => {
    const s = String(job.status || "");

    if (s === "queued")  setProgress(30, "Queued…");
    if (s === "running") setProgress(50, "Generating…");

    if (s === "error") {
      showSkeleton(false);
      endProgress();
      statusEl.style.color = "red";
      statusEl.textContent = "❌ " + (job.error || "Job failed");
      return;
    }

    if (s === "done") {
      const input2 = job.input || input;
      const result = job.result || {};

      const itineraryItems = Array.isArray(result.itinerary) ? result.itinerary : [];
      const dayTips = (result.day_tips && typeof result.day_tips === "object") ? result.day_tips : {};
      const cityTips = (result.city_tips && typeof result.city_tips === "object") ? result.city_tips : {};

      applyTipFocusSelection(input2.tip_focus);

      setProgress(70, "Rendering…");
      showSkeleton(false);

      renderItinerary(
        { itinerary: itineraryItems, recommendations: { per_day: dayTips, city_tips: cityTips } },
        input2.city || "",
        input2.country || ""
      );

      setProgress(85, "Building map…");
      try { await preloads; } catch (_){}
      try { buildEmbeddedMap?.(itineraryItems, input2.city || "", input2.country || ""); } catch (_){}

      window.__mvCityTips = cityTips;
      trySendEmailIfReady();

      setProgress(100, "Done");
      endProgress();
      statusEl.textContent = "";
    }
  });

} catch (err) {
  showSkeleton(false);
  endProgress();
  statusEl.style.color = "red";
  statusEl.textContent = "❌ " + String(err?.message || err || "Failed to start job");
}


});

  }
   
// expose for WP inline caller + console
if (typeof window !== "undefined") {
  window.initCityRouteUI = initCityRouteUI;
}

  // expose init for the loader
  window.initCityRouteUI = initCityRouteUI;

})();
