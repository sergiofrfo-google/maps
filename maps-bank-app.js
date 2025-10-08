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
  addCustomControls();
  loadMeta();
};

/* ---------------- UI: Countries & Cities ---------------- */

async function loadMeta() {
  const meta = await fetchMeta();
  if (!meta) return;

      const countrySelect = document.getElementById("countrySelect");
      const countries = meta.countries || [];
      countrySelect.innerHTML = countries.map(c => `<option value="${c}">${c}</option>`).join("");
      
      // Keep city list in sync AND also eval button state
      countrySelect.addEventListener("change", () => updateCities(meta));
      countrySelect.addEventListener("change", toggleButtonState);
      
      // Initial city fill
      updateCities(meta);
      
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
          <li>
            <span class="tip-emoji">💡</span>
            <span>${item}</span>
          </li>
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

    // Content: use any per-place tips if present (data attribute), else fall back to the text after the link (description)
    const content = pop.querySelector('.tip-popover-content');
    const descNode = [...li.childNodes].find(n => n.nodeType === 3 && /\S/.test(n.nodeValue));
    const tipsText = li.getAttribute('data-place-tips') || (descNode ? descNode.nodeValue.trim().replace(/^—\s*/, '') : '');
    content.textContent = tipsText || 'No specific tips for this place. See “Tips” above.';

    // Insert after the place link
    nameLink.insertAdjacentElement('afterend', trigger);
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
          return (arr.length ? arr.join(' • ') : '').replace(/"/g,'&quot;');
        })()}">
          <a class="pinlink" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.city || '') + ' ' + (p.country || ''))}" target="_blank" rel="noopener">📍</a>
          <a class="place-title" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.city || '') + ' ' + (p.country || ''))}" target="_blank" rel="noopener">${p.name}</a>
          ${p.description ? ` <span class="place-desc">— ${p.description}</span>` : ``}
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

// Hook for WordPress loader (unchanged)
window.initMapsBankUI = function(rootEl) {
  console.log("MapsBank UI initialized in:", rootEl);
};

