let map;
let markers = [];
let userLocation = null;
let userMarker = null;
let cityCache = {};          // in‑memory (session) cache
let currentInfoWindow = null;
let categoriesPanel = null;  // reused instead of recreating
let metaCache = null;        // store meta after first load

const API_URL = "https://script.google.com/macros/s/AKfycbzDePUpGo2LC9VWbUx3YzDJEaNff4aiMpaGtUiZIlbPPkCpTYSXvmzIvwUsk4naq_09/exec";
const TIPS_API_URL = "https://script.google.com/macros/s/AKfycbzRXtrf0rMn6KPcOQvtvavtjvbn7wHFKmNg5zDCeftyV1mwe2TlxocM9CkOZryK5M0U/exec";
const CAN_HOVER = window.matchMedia && window.matchMedia("(hover: hover)").matches;


// version for localStorage city data (bump if data format changes)
const CACHE_VERSION = "v1";

// Marker icon colors by category (case-insensitive)
const categoryColors = {
  "top10": "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
  "museums": "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
  "instagramable": "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
  "walking tour": "http://maps.google.com/mapfiles/ms/icons/purple-dot.png"
};

/* ---------------- Meta & Places Fetching ---------------- */

async function fetchMeta() {
  // Use prefetch promise if present
  if (metaCache) return metaCache;
  if (window.mapsBankMetaPromise) {
    metaCache = await window.mapsBankMetaPromise;
    if (metaCache) return metaCache;
  }
  const res = await fetch(`${API_URL}?mode=meta`);
  metaCache = await res.json();
  return metaCache;
}

function loadCachedCity(city) {
  try {
    const raw = localStorage.getItem("mapsbank:city:" + CACHE_VERSION + ":" + city);
    return raw ? JSON.parse(raw) : null;
  } catch(_) { return null; }
}

function saveCachedCity(city, data) {
  try {
    localStorage.setItem("mapsbank:city:" + CACHE_VERSION + ":" + city, JSON.stringify(data));
  } catch(_) {}
}

async function fetchPlaces(city) {
  if (!city) return [];
  if (cityCache[city]) return cityCache[city];

  const cached = loadCachedCity(city);
  if (cached) {
    cityCache[city] = cached;
    return cached;
  }

  const url = `${API_URL}?mode=places&city=${encodeURIComponent(city)}&categories=all`;
  const res = await fetch(url);
  const data = await res.json();
  cityCache[city] = data;
  saveCachedCity(city, data);
  return data;
}

/* ---------------- Map Init ---------------- */

window.initMap = function() {
  map = new google.maps.Map(document.getElementById("custom-map"), {
    center: { lat: 0, lng: 0 },
    zoom: 2
  });
  map.addListener("click", closeCurrentInfo);
  preloadCountriesFast()
  addCustomControls();
  loadMeta();
};

// --- Fast countries preload (for faster dropdown) ---
let preloadedCountries = [];

async function preloadCountriesFast() {
  try {
    const res = await fetch("https://apps.mapvivid.com/countries-database.json", { cache: "no-cache" });
    preloadedCountries = await res.json();

    // Immediately fill the dropdown if available
    const select = document.getElementById("countrySelect");
    if (select && preloadedCountries.length) {
      select.innerHTML = preloadedCountries
        .map(c => `<option value="${c}">${c}</option>`)
        .join("");
    }
  } catch (err) {
    console.warn("Country preload failed:", err);
  }
}

/* ---------------- UI: Countries & Cities ---------------- */

async function loadMeta() {
  const meta = await fetchMeta();
  if (!meta) return;

  const countrySelect = document.getElementById("countrySelect");

  // Prefer preloaded countries if available; otherwise fall back to meta.countries
  const countries = Array.isArray(preloadedCountries) && preloadedCountries.length
    ? preloadedCountries
    : (meta.countries || []);

  // Keep city list in sync AND also eval button state
  countrySelect.addEventListener("change", () => updateCities(meta));
  countrySelect.addEventListener("change", toggleButtonState);
      
      // Initial city fill
      updateCities(meta);
      
      // Wire up the CTA button
      // Wire up the CTA button
      const checkMapsBtn = document.getElementById("checkMapsBtn");
      if (checkMapsBtn) {
        checkMapsBtn.addEventListener("click", () => {
          const loadingMessage = document.getElementById("loadingMessage");
          if (loadingMessage) loadingMessage.style.display = "block";
      
          // Load categories now (on demand)
          updateCategories().then(() => {
            if (loadingMessage) loadingMessage.style.display = "none";
          });
        });
      }

// PDF export button
const exportBtn = document.getElementById("exportPdfBtn");
if (exportBtn) {
  exportBtn.removeAttribute("disabled");     // ← enable the button in the DOM
  exportBtn.addEventListener("click", exportBankPDF);
}

// KML export button
const kmlBtn = document.getElementById("exportKmlBtn");
if (kmlBtn) {
  kmlBtn.removeAttribute("disabled");
  kmlBtn.addEventListener("click", exportBankKML);
}

// Share buttons
const shareBtn = document.getElementById("sharePlacesBtn");
if (shareBtn) {
  shareBtn.removeAttribute("disabled");
  shareBtn.addEventListener("click", async () => {
    const payload = buildSharePayload(false);   // places only
    const title = (payload.text.split("\n")[0] || "Places");
    // Mobile: native share sheet; Desktop: rich clipboard (HTML + plain)
    if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try {
        await navigator.share({ title, text: payload.text });
        return;
      } catch (e) { /* fallback to clipboard */ }
    }
    await copyToClipboard(payload);
    flashCopied(shareBtn);
  });
}

const shareTipsBtn = document.getElementById("sharePlacesTipsBtn");
if (shareTipsBtn) {
  shareTipsBtn.removeAttribute("disabled");
  shareTipsBtn.addEventListener("click", async () => {
    const payload = buildSharePayload(true);    // places + tips
    const title = (payload.text.split("\n")[0] || "Places & Tips");
    if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try {
        await navigator.share({ title, text: payload.text });
        return;
      } catch (e) { /* fallback to clipboard */ }
    }
    await copyToClipboard(payload);
    flashCopied(shareTipsBtn);
  });
}

// Wire up the Tips filter bar (outside the map)
const tipsFilterEl = document.getElementById('tips-filter');
if (tipsFilterEl) {
  tipsFilterEl.addEventListener('change', (e) => {
    if (e.target && e.target.matches('input[type="checkbox"]')) applyTipsFilter();
  });
}

// Apply once in case tips already exist later
applyTipsFilter();
startPlacePopovers();

}

function updateCities(meta) {
  const country = document.getElementById("countrySelect").value;
  const cities = (meta.cities && meta.cities[country]) ? meta.cities[country] : [];
  const citySelect = document.getElementById("citySelect");
  citySelect.innerHTML = cities.map(c => `<option value="${c}">${c}</option>`).join("");
  
  // Do NOT auto-load categories; just update the button state
  citySelect.onchange = toggleButtonState;
  toggleButtonState();

}
function toggleButtonState() {
  const country = document.getElementById("countrySelect")?.value;
  const city = document.getElementById("citySelect")?.value;
  const btn = document.getElementById("checkMapsBtn");
  if (btn) btn.disabled = !(country && city);
  const pdfBtn = document.getElementById("exportPdfBtn");
  if (pdfBtn) pdfBtn.disabled = !(country && city);
  const kmlBtn = document.getElementById("exportKmlBtn");
  if (kmlBtn) kmlBtn.disabled = !(country && city);

}


/* ---------------- Categories Panel (Reused) ---------------- */

function getCategoriesPanel() {
  if (categoriesPanel) return categoriesPanel;
  categoriesPanel = document.createElement("div");
  categoriesPanel.classList.add("custom-map-panel");
  map.controls[google.maps.ControlPosition.TOP_LEFT].push(categoriesPanel);
  return categoriesPanel;
}

async function updateCategories() {
  const city = document.getElementById("citySelect").value;
  if (!city) return;

  const places = await fetchPlaces(city);
  const categories = [...new Set(places.map(p => p.category))];

  const panel = getCategoriesPanel();
  panel.innerHTML =
    `<strong>Categories</strong>` +
    categories.map(cat => {
      const checked = (cat.toLowerCase() === "top10") ? "checked" : "";
      return `<label><input type="checkbox" class="cat-filter" data-cat="${encodeURIComponent(cat)}" ${checked}> ${cat}</label>`;
    }).join("");
    // Show markers for Top10 immediately
    updateMarkers(city);
  
  panel.querySelectorAll(".cat-filter").forEach(cb =>
    cb.addEventListener("change", () => updateMarkers(city))
  );

  clearMarkers();
  closeCurrentInfo();
}

/* ---------------- Markers ---------------- */

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function closeCurrentInfo() {
  if (currentInfoWindow) {
    currentInfoWindow.close();
    currentInfoWindow = null;
  }
}

function getAnyCase(obj, keys){
  const lowerMap = {};
  for (const k in obj) lowerMap[k.toLowerCase()] = obj[k];
  for (const want of keys) if (want.toLowerCase() in lowerMap) return lowerMap[want.toLowerCase()];
  return "";
}
function normalizeTips(raw) {
  if (!raw) return [];
  // Split only by newlines, keep commas inside sentences
  return raw
    .split(/\r?\n/) 
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

function createInfoContent(place, position) {
  const rawTips = getAnyCase(place, ["tips","advice","hints"]);
  const tipsArr = normalizeTips(rawTips);
  const tipsHtml = tipsArr.length ? `
<p><strong>Tips</strong></p>
<ul>
${tipsArr.map(t => `<li>${t}</li>`).join("")}
</ul>
` : "";

  const actions = `
    <div>
      <button class="gmaps-btn" onclick="window.open('https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((place.name || '') + ' ' + (place.city || '') + ' ' + (place.country || ''))}','_blank')">
        View on Google Maps
      </button>
    </div>
  `;

  return `
    <div class="info-window custom-info-window">
      <div class="info-header">
        <h3>${place.name || ""}</h3>
        <span class="info-close" onclick="closeCurrentInfo()">✖</span>
      </div>
      <div class="info-body">
        <p>${place.description || ""}</p>
        ${tipsHtml}
        ${actions}
      </div>
    </div>
  `;

}

// Utility: match category with color used for markers
function getCategoryColor(cat) {
  const map = {
    "top10": "#e74c3c",          // red
    "museums": "#2980b9",        // blue
    "instagramable": "#27ae60",  // green
    "walking tour": "#8e44ad"    // purple
  };
  return map[(cat || "").toLowerCase()] || "#555";
}

// jsPDF loader (same as cityroute)
async function loadJsPDF(){
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Failed to load jsPDF"));
    document.head.appendChild(s);
  });
  return window.jspdf.jsPDF;
}

// Use the same key as cityroute (kept here to avoid cross-page dependency)
const GMAPS_API_KEY = "AIzaSyA6MFWoq480bdhSIEIHiedPRat4Xq8ng20";

// Build a Google Static Map URL from visible places
function buildStaticMapUrlForBank(places, city){
  const params = [];
  params.push("size=1024x420");
  params.push("scale=2");
  params.push("maptype=roadmap");

  const byCat = {};
  places.forEach(p => {
    const cat = p.category || "Other";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(p);
  });

  Object.keys(byCat).forEach(cat => {
    const color = (getCategoryColor(cat) || "#d23").replace("#", "0x");
    const pts = byCat[cat].map(p => `${p.lat},${p.lng}`).join("|");
    params.push(`markers=color:${color}|${pts}`);
  });

  if (places.length === 0 && city){
    params.push(`center=${encodeURIComponent(city)}`);
    params.push("zoom=11");
  }

  const key = encodeURIComponent(GMAPS_API_KEY);
  return `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}&key=${key}`;
}

function hexToRgb(hex){
  const m = (hex || "").replace("#","").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if(!m) return {r:0,g:0,b:0};
  return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) };
}


let lastTipsKey = null;
let lastTipsData = null;

async function loadCityTips(city, country) {
  if (!city) return;
  const key = `${city.toLowerCase()}|${(country || "").toLowerCase()}`;
  if (key === lastTipsKey && lastTipsData) {
  // list was rebuilt by category toggle; re-append tips without refetch
  renderCityTips(lastTipsData);
  return;
}

  lastTipsKey = key;

  try {
    const url = `${TIPS_API_URL}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country || "")}`;
    const res = await fetch(url);
    const data = await res.json();
    renderCityTips(data);
  } catch (err) {
    const tb = document.getElementById("cityTips");
    if (tb) tb.innerHTML = "";
  }
  lastTipsData = data;
}

function renderCityTips(data) {
  const listContainer = document.getElementById("placesList");
  const gridContainer = listContainer?.querySelector('.mb-categories') || listContainer;
  if (!gridContainer || !data || !Array.isArray(data.sections)) return;


  // Remove any existing tips cards (safe re-render on category toggles)
  gridContainer.querySelectorAll(".tip-card").forEach(el => el.remove());

  // Build tips as the same kind of “category-section” cards
  const tipsHTML = data.sections.map(sec => `
    <section class="category-section tip-card" data-tip-type="${sec.title}">
      <h3 class="category-title">${sec.title}</h3>
      <ul class="category-list tips-list">
      ${(sec.items || []).map(item => `
      <li>${item}</li>
      `).join("")}
      </ul>
    </section>
  `).join("");

  // Append to the same container so they mix with categories
gridContainer.insertAdjacentHTML("beforeend", tipsHTML);
applyTipsFilter();
}

/* ----- Tips Filter: show/hide .tip-card by #tips-filter state ----- */
function applyTipsFilter() {
  const checked = Array.from(document.querySelectorAll('#tips-filter input[type="checkbox"]:checked'))
    .map(el => (el.value || '').trim());
  const cards = document.querySelectorAll('.tip-card');
  if (!cards.length) return;
  // If nothing checked, hide all tips
  if (checked.length === 0) {
    cards.forEach(card => { card.style.display = 'none'; });
    return;
  }
  // Otherwise show only matching sections
  cards.forEach(card => {
    const type = (card.getAttribute('data-tip-type') || '').trim();
    card.style.display = checked.includes(type) ? '' : 'none';
  });
}

/* ----- Place Popovers: add a 💡 trigger + popover to each place ----- */
function startPlacePopovers() {
  const root = document.getElementById('placesList');
  if (!root) return;

  const build = (li) => {
    if (li.querySelector('.place-tip-trigger')) return; // already added
    const nameLink = li.querySelector('a.place-title');
    if (!nameLink) return;

    // Create trigger
    const trigger = document.createElement('button');
    trigger.className = 'place-tip-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-label', `Tips for ${nameLink.textContent.trim()}`);
    trigger.textContent = '💡';

    // Create popover wrapper
    const pop = document.createElement('div');
    pop.className = 'place-tip-popover';
    pop.innerHTML = `
      <div class="tip-popover-inner">
        <button class="tip-popover-close" aria-label="Close">×</button>
        <div class="tip-popover-content"></div>
      </div>`;

    // Content: use per-place tips if present (data attribute), else fall back to description
    const content = pop.querySelector('.tip-popover-content');
    const descNode = [...li.childNodes].find(n => n.nodeType === 3 && /\S/.test(n.nodeValue));
    const tipsAttr = (li.getAttribute('data-place-tips') || '').replace(/\r/g,'');
    const tipsArr = tipsAttr
      ? tipsAttr.split('\n').map(s => s.trim()).filter(Boolean)
      : [];

    
    if (tipsArr.length) {
      const titleEl = document.createElement('p');
      titleEl.className = 'tip-popover-title';
      titleEl.textContent = 'Tips';
      const ul = document.createElement('ul');
      ul.className = 'tip-popover-list';
      tipsArr.forEach(t => {
        const liEl = document.createElement('li');
        liEl.textContent = t;
        ul.appendChild(liEl);
      });
      content.innerHTML = '';
      content.appendChild(titleEl);
      content.appendChild(ul);
    } else {
      const fallback = descNode ? descNode.nodeValue.trim().replace(/^—\s*/, '') : '';
      content.textContent = fallback || 'No specific tips for this place. See “Tips” above.';
    }
    // Insert after the place link
    const wrap = document.createElement('span');
    wrap.className = 'place-title-wrap';
    nameLink.parentNode.insertBefore(wrap, nameLink);
    wrap.appendChild(nameLink);
    wrap.appendChild(trigger);
    li.appendChild(pop);

    // Interactions (hover + click + close X + outside click)
    const open = () => { pop.classList.add('open'); };
    const close = () => { pop.classList.remove('open'); };

    let hoverTimer = null;
    trigger.addEventListener('mouseenter', () => { hoverTimer = setTimeout(open, 60); });
    trigger.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); setTimeout(() => { if (!pop.matches(':hover')) close(); }, 80); });
    pop.addEventListener('mouseleave', close);

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.classList.toggle('open');
    });
    pop.querySelector('.tip-popover-close').addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && e.target !== trigger) close();
    }, { passive: true });
  };

  const scan = () => {
    const items = root.querySelectorAll('.category-section:not(.tip-card) .category-list li');
    items.forEach((li) => {
      // Ensure li is positioned for absolute popover
      if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
      build(li);
    });
  };

  // Initial scan + watch for re-renders
  const mo = new MutationObserver(() => scan());
  mo.observe(root, { childList: true, subtree: true });
  scan();
}



async function updateMarkers(city) {
  clearMarkers();
  closeCurrentInfo();

  const checked = Array.from(document.querySelectorAll(".cat-filter:checked"))
    .map(cb => decodeURIComponent(cb.dataset.cat));
  if (checked.length === 0) return;

  const places = await fetchPlaces(city);
  const filtered = places.filter(p => checked.includes(p.category));

  const bounds = new google.maps.LatLngBounds();

  filtered.forEach(place => {
    const position = { lat: parseFloat(place.lat), lng: parseFloat(place.lng) };
    const marker = new google.maps.Marker({
      position, map, title: place.name,
      icon: categoryColors[(place.category || "").toLowerCase()] || null
    });

    const info = new google.maps.InfoWindow({
      content: createInfoContent(place, position),
      pixelOffset: new google.maps.Size(0, -6)
    });

    const openInfo = () => {
      if (currentInfoWindow !== info) {
        closeCurrentInfo();
        info.open({ map, anchor: marker, shouldFocus:false });
        currentInfoWindow = info;
      }
    };

    marker.addListener("click", openInfo);
    if (CAN_HOVER) marker.addListener("mouseover", openInfo);
    info.addListener("closeclick", () => { if (currentInfoWindow === info) currentInfoWindow = null; });

    markers.push(marker);
    bounds.extend(position);
  });

    if (!bounds.isEmpty()) map.fitBounds(bounds);

    // --- Build categorized list below the map ---
    const listContainer = document.getElementById("placesList");
    if (listContainer) {
      const grouped = {};
      filtered.forEach(p => {
        const cat = p.category || "Other";
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(p);
        
    const country = document.getElementById("countrySelect")?.value || "";
    loadCityTips(city, country)
        
        
      });

    // ✅ Reuse existing grid container and keep tips visible
    let grid = listContainer.querySelector('.mb-categories');
    if (!grid) {
      listContainer.innerHTML = `<div class="mb-categories"></div>`;
      grid = listContainer.querySelector('.mb-categories');
    }

    // Remove ONLY category cards (keep .tip-card sections intact)
    grid.querySelectorAll('.category-section:not(.tip-card)').forEach(el => el.remove());

    // Build and append new category cards
    const catsHTML = Object.keys(grouped).map(cat => {
      const color = getCategoryColor(cat);
      return `
        <section class="category-section" style="--cat-color:${color}">
        <h3 class="category-title" style="color:${color};">${cat}</h3>
        <ul class="category-list">
        ${grouped[cat].map(p => `
        <li data-place-tips="${(() => {
          const raw = getAnyCase(p, ['tips','advice','hints']);
          const arr = normalizeTips(raw);
          return (arr.length ? arr.join('\n') : '').replace(/"/g,'&quot;');
        })()}">
          <a class="place-title" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.city || '') + ' ' + (p.country || ''))}" target="_blank" rel="noopener">${p.name}</a>
          ${p.description ? ` <span class="place-desc">&mdash;&nbsp;${p.description}</span>` : ``}
        </li>
        `).join('')}
        </ul>

        </section>

      `;
    }).join("");

    const firstTip = grid.querySelector('.tip-card');
    if (firstTip) {
      const tmp = document.createElement('div');
      tmp.innerHTML = catsHTML;
      while (tmp.firstElementChild) {
        grid.insertBefore(tmp.firstElementChild, firstTip);
      }
    } else {
      grid.insertAdjacentHTML('beforeend', catsHTML);
    }
      
    }
}


/* ---------------- Map Controls & Helpers ---------------- */

function addCustomControls() {
  const locationButton = document.createElement("button");
  locationButton.textContent = "📍 Track My Location";
  locationButton.classList.add("custom-map-btn");
  map.controls[google.maps.ControlPosition.TOP_CENTER].push(locationButton);
  locationButton.addEventListener("click", trackUserLocation);

  const resetButton = document.createElement("button");
  resetButton.textContent = "🔄 Reset View";
  resetButton.classList.add("custom-map-btn");
  map.controls[google.maps.ControlPosition.TOP_CENTER].push(resetButton);
  resetButton.addEventListener("click", resetView);
}

function trackUserLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(pos => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!userMarker) {
        userMarker = new google.maps.Circle({
          strokeColor:'#4285F4', strokeOpacity:0.8, strokeWeight:2,
          fillColor:'#4285F4', fillOpacity:0.6, map, center:userLocation, radius:20
        });
      } else {
        userMarker.setCenter(userLocation);
      }
      map.setCenter(userLocation);
      map.setZoom(15);
    }, () => alert("Unable to access location"), { enableHighAccuracy: true });
  } else {
    alert("Geolocation not supported by your browser");
  }
}

function openGoogleMaps(destLat, destLng, mode="walking") {
  const mapsUrl =
    `https://www.google.com/maps/dir/?api=1&origin=My+Location&destination=${destLat},${destLng}&travelmode=${mode}`;
  window.open(mapsUrl, "_blank");
}

function resetView() {
  if (markers.length === 0) return;
  const bounds = new google.maps.LatLngBounds();
  markers.forEach(m => bounds.extend(m.getPosition()));
  if (!bounds.isEmpty()) map.fitBounds(bounds);
}

// ------------------------------------------------
// Export PDF (respects selected Categories & Tips)
// ------------------------------------------------
async function exportBankPDF(){
  try{
    const jsPDF = await loadJsPDF();
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;
    const maxW = pageW - margin*2;
    const lineH = 16;
    let y = margin;

    // Current city/country
    const citySel = document.getElementById("citySelect");
    const countrySel = document.getElementById("countrySelect");
    const city = citySel?.value || "";
    const country = countrySel?.value || "";

    // Title
    doc.setFont("helvetica","bold"); doc.setFontSize(16);
    const title = `${city}${country ? ", " + country : ""} — Map & Tips`;
    doc.text(title, margin, y); y += 18;
    doc.setDrawColor(220); doc.line(margin, y, pageW - margin, y); y += 12;

    // Selected categories
    const selectedCats = Array.from(document.querySelectorAll(".cat-filter:checked"))
      .map(cb => decodeURIComponent(cb.dataset.cat));

    // Fetch and filter places
    let places = [];
    if (selectedCats.length){
      const all = await fetchPlaces(city);
      places = all.filter(p => selectedCats.includes(p.category));
    }

    // Map first
    const mapUrl = buildStaticMapUrlForBank(places, city);
    try{
      // Load the image to get the true aspect ratio
      const imgEl = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = mapUrl;
      });
      const aspect = imgEl.naturalHeight / imgEl.naturalWidth;
      const imgW = maxW;
      const imgH = Math.round(imgW * aspect);
    
      doc.addImage(imgEl, "PNG", margin, y, imgW, imgH);
      y += imgH + 14;
    }catch(_){}



    // Writer helper
    function write(text, opt={bold:false}){
      doc.setFont("helvetica", opt.bold ? "bold":"normal");
      doc.setFontSize(opt.bold ? 13 : 11);
      const lines = doc.splitTextToSize(text, maxW);
      lines.forEach(line=>{
        if (y > pageH - margin) { doc.addPage(); y = margin; }
        doc.text(line, margin, y); y += lineH;
      });
    }

    // Categories currently rendered (non-tip sections)
    const catSections = Array.from(document.querySelectorAll(".mb-categories .category-section:not(.tip-card)"));
    for (const sec of catSections){
      const h = sec.querySelector(".category-title");
      if (h){
        if (y > pageH - margin - 24) { doc.addPage(); y = margin; }
        const catName = h.textContent.trim();
        const rgb = hexToRgb(getCategoryColor(catName));
        doc.setFont("helvetica","bold"); 
        doc.setFontSize(14);
        doc.setTextColor(rgb.r, rgb.g, rgb.b);   // keep category color
        doc.text(catName, margin, y);
        doc.setTextColor(0,0,0);                 // back to black for body
        y += 14;
        doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 10;
      }

      const items = sec.querySelectorAll(".category-list > li");
      items.forEach(li=>{
        const a = li.querySelector(".place-title");
        const name = a?.textContent?.trim() || "";
        const href = a?.getAttribute("href") || "";
        let desc = li.querySelector(".place-desc")?.textContent || "";
        if (!name) return;
      
        // Strip any leading dash so we never get “— —”
        desc = desc.replace(/^\s*[—-]+\s*/, "").trim();
      
        // Bullet at left
        if (y > pageH - margin) { doc.addPage(); y = margin; }
        const bullet = "• ";
        let x = margin;
        doc.setFont("helvetica", "normal"); doc.setFontSize(11);
        doc.text(bullet, x, y);
        x += doc.getTextWidth(bullet);
      
        // Bold, blue, underlined link for the place name
        doc.setFont("helvetica", "bold");
        if (href){
          doc.setTextColor(26, 13, 171);               // link blue
          doc.textWithLink(name, x, y, { url: href });
          const nameW = doc.getTextWidth(name);
          doc.setDrawColor(26, 13, 171);
          doc.setLineWidth(0.75);
          doc.line(x, y + 2, x + nameW, y + 2);        // underline
          doc.setTextColor(0,0,0);
          doc.setDrawColor(0);
        } else {
          doc.text(name, x, y);
        }
        x += doc.getTextWidth(name);
      
        // Description (single em-dash prefix), wraps to next line at left margin
        doc.setFont("helvetica", "normal");
        const rest = desc ? ` — ${desc}` : "";
        const firstLineWidth = Math.max(0, maxW - (x - margin));
        const first = doc.splitTextToSize(rest, firstLineWidth);
        if (first.length){
          doc.text(first[0], x, y);
          for (let i = 1; i < first.length; i++){
            y += lineH;
            if (y > pageH - margin) { doc.addPage(); y = margin; }
            doc.text(first[i], margin, y);
          }
        }
        y += lineH;
      });


      y += 4;
    }

    // Tips sections visible per Tips filter
    const tipSections = Array.from(document.querySelectorAll(".mb-categories .category-section.tip-card"))
      .filter(el => getComputedStyle(el).display !== "none");
    for (const sec of tipSections){
      const h = sec.querySelector(".category-title");
      if (h){
        if (y > pageH - margin - 24) { doc.addPage(); y = margin; }
        doc.setFont("helvetica","bold"); doc.setFontSize(14);
        doc.text(h.textContent.trim(), margin, y); y += 14;
        doc.setDrawColor(230); doc.line(margin, y, pageW - margin, y); y += 10;
      }
      const lis = sec.querySelectorAll(".tips-list > li");
      lis.forEach(li=>{
        const t = li.textContent.trim();
        if (t) write(`• ${t}`);
      });
      y += 4;
    }

    // Save
    const fname = `${city || "map"}_map_and_tips.pdf`;
    doc.save(fname);
  }catch(err){
    console.error("PDF export failed:", err);
    alert("Could not generate the PDF. Please try again.");
  }
}

// ------------------------------------------------
// Export KML (grouped by Categories; for Google My Maps)
// ------------------------------------------------
async function exportBankKML(){
  try{
    // Current selections
    const countrySel = document.getElementById("countrySelect");
    const citySel = document.getElementById("citySelect");
    const city = citySel?.value || "";
    const country = countrySel?.value || "";

    // Which categories are currently selected in the UI
    const selectedCats = Array.from(document.querySelectorAll(".cat-filter:checked"))
      .map(cb => decodeURIComponent(cb.dataset.cat));

    if (!city || selectedCats.length === 0){
      alert("Choose a city and at least one category.");
      return;
    }

    // Fetch and filter places just like updateMarkers()
    const placesAll = await fetchPlaces(city);
    const places = placesAll.filter(p => selectedCats.includes(p.category));

    // Group by category
    const grouped = {};
    places.forEach(p => {
      const cat = p.category || "Other";
      (grouped[cat] ||= []).push(p);
    });

    // Helpers (same style as cityroute)
    const xmlEscape = (s = "") =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const wrapCDATA = (s = "") => "<![CDATA[" + String(s).replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";

    // Build KML
    const docName = `${city}${country ? ", " + country : ""} — Categories`;
    const parts = [];
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    parts.push(`<kml xmlns="http://www.opengis.net/kml/2.2">`);
    parts.push(`<Document>`);
    parts.push(`<name>${xmlEscape(docName)}</name>`);

    // One Folder per Category (like CityRoute does per Day)
    Object.keys(grouped).sort((a,b)=>a.localeCompare(b)).forEach(cat => {
      parts.push(`<Folder>`);
      parts.push(`<name>${xmlEscape(cat)}</name>`);

      grouped[cat].forEach(p => {
        const lat = (p.lat != null) ? String(p.lat) : "";
        const lng = (p.lng != null) ? String(p.lng) : "";
        if (!lat || !lng) return;

        // Description: keep your same info (name link to GMaps + description)
        const query = encodeURIComponent(`${p.name || ""}, ${city}${country ? ", " + country : ""}`);
        const gmaps = `https://www.google.com/maps/search/?api=1&query=${query}`;
        const descHtml = `
            <div>
              ${p.description ? `<p>${xmlEscape(p.description)}</p>` : ``}
              <p><a href="${gmaps}">Open in Google Maps</a></p>
              ${p.category ? `<p><em>${xmlEscape(p.category)}</em></p>` : ``}
            </div>
          `.trim();
        parts.push(`<Placemark>`);
        parts.push(`<name>${xmlEscape(p.name || "")}</name>`);
        parts.push(`<description>${wrapCDATA(descHtml)}</description>`);
        parts.push(`<Point><coordinates>${lng},${lat},0</coordinates></Point>`);
        parts.push(`</Placemark>`);
      });

      parts.push(`</Folder>`);
    });

    parts.push(`</Document></kml>`);
    const kml = parts.join("");

    // Download
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml;charset=UTF-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ((city || "map") + (country ? "_" + country : "")).replace(/\s+/g, "_") + "_categories.kml";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }catch(err){
    console.error("KML export failed:", err);
    alert("Could not generate the KML. Please try again.");
  }
}

// Expose (optional)
window.exportBankKML = exportBankKML;


// ------------------------------------------------
// Build share text from visible sections
// includeTips = false -> only places; true -> places + tips
// ------------------------------------------------
function buildSharePayload(includeTips){
  const citySel = document.getElementById("citySelect");
  const countrySel = document.getElementById("countrySelect");
  const city = citySel?.value || "";
  const country = countrySel?.value || "";

  const title = `${city}${country ? ", " + country : ""} — Places${includeTips ? " & Tips" : ""}`;

  // helpers (escape only for HTML branch)
  const esc = s => (s || "").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  let txt = `${title}\n\n`;
  let html = `<div><p><strong>${esc(title)}</strong></p>`;

  // visible category sections (non-tip)
  const catSections = Array.from(document.querySelectorAll(".mb-categories .category-section:not(.tip-card)"));
  catSections.forEach(sec => {
    const h = sec.querySelector(".category-title");
    const sectionTitle = (h?.textContent || "").trim();
    if (sectionTitle) {
      txt += `${sectionTitle}\n`;
      html += `<h3 style="margin:10px 0 6px">${esc(sectionTitle)}</h3><ul style="margin:0 0 12px 18px; padding:0">`;
    }
    const items = sec.querySelectorAll(".category-list > li");
    items.forEach(li => {
      const a = li.querySelector(".place-title");
      const name = a?.textContent?.trim() || "";
      const href = a?.getAttribute("href") || "";
      let desc = li.querySelector(".place-desc")?.textContent || "";
      if (!name) return;
      desc = desc.replace(/^\s*[—-]+\s*/, "").trim(); // avoid double dash
      // plain text
      txt += `- ${name}${href ? ` (${href})` : ""}${desc ? ` — ${desc}` : ""}\n`;
      // html
      html += `<li><strong>${href ? `<a href="${esc(href)}">${esc(name)}</a>` : esc(name)}</strong>${desc ? ` — ${esc(desc)}` : ""}</li>`;
    });
    if (sectionTitle) html += `</ul>`;
    txt += `\n`;
  });

  if (includeTips){
    const tipSections = Array.from(document.querySelectorAll(".mb-categories .category-section.tip-card"))
      .filter(el => getComputedStyle(el).display !== "none");
    tipSections.forEach(sec => {
      const h = sec.querySelector(".category-title");
      const sectionTitle = (h?.textContent || "").trim();
      if (sectionTitle) {
        txt += `${sectionTitle} — Tips\n`;
        html += `<h3 style="margin:10px 0 6px">${esc(sectionTitle)} — Tips</h3><ul style="margin:0 0 12px 18px; padding:0">`;
      }
      const lis = sec.querySelectorAll(".tips-list > li");
      lis.forEach(li => {
        const t = (li.textContent || "").trim();
        if (!t) return;
        txt += `• ${t}\n`;
        html += `<li>• ${esc(t)}</li>`;
      });
      if (sectionTitle) html += `</ul>`;
      txt += `\n`;
    });
  }

  html += `</div>`;
  return { text: txt.trim(), html };
}


// ------------------------------------------------
// Clipboard helpers
// ------------------------------------------------
async function copyToClipboard(payload){
  try{
    if (navigator.clipboard && window.ClipboardItem) {
      const data = {
        "text/plain": new Blob([payload.text], { type: "text/plain" })
      };
      if (payload.html) {
        data["text/html"] = new Blob([payload.html], { type: "text/html" });
      }
      await navigator.clipboard.write([ new ClipboardItem(data) ]);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload.text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = payload.text;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }catch(err){
    console.error("Clipboard copy failed:", err);
    alert("Could not copy to clipboard. Please try again.");
  }
}


function flashCopied(btn){
  const old = btn.textContent;
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove("copied");
  }, 1200);
}


// Hook for WordPress loader (unchanged)
window.initMapsBankUI = function(rootEl) {
  console.log("MapsBank UI initialized in:", rootEl);
};


