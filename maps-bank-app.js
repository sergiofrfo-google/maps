document.addEventListener("DOMContentLoaded", initMap);

let map;
let markers = [];
let userLocation = null;   // still used for centering if user taps "Track My Location" (not for directions)
let userMarker = null;
let cityCache = {};
let currentInfoWindow = null;

const API_URL = "https://script.google.com/macros/s/AKfycbzDePUpGo2LC9VWbUx3YzDJEaNff4aiMpaGtUiZIlbPPkCpTYSXvmzIvwUsk4naq_09/exec";
const CAN_HOVER = window.matchMedia && window.matchMedia("(hover: hover)").matches;

const categoryColors = {
  "top10": "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
  "museums": "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
  "instagramable": "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
  "walking tour": "http://maps.google.com/mapfiles/ms/icons/purple-dot.png"
};

async function fetchMeta() {
  const res = await fetch(`${API_URL}?mode=meta`);
  return res.json();
}
async function fetchPlaces(city) {
  if (cityCache[city]) return cityCache[city];
  const url = `${API_URL}?mode=places&city=${encodeURIComponent(city)}&categories=all`;
  const res = await fetch(url);
  const data = await res.json();
  cityCache[city] = data;
  return data;
}

function initMap() {
  map = new google.maps.Map(document.getElementById("custom-map"), {
    center: { lat: 0, lng: 0 },
    zoom: 2
  });
  map.addListener("click", closeCurrentInfo);
  addCustomControls();
  loadMeta();
}

async function loadMeta() {
  const meta = await fetchMeta();
  const countrySelect = document.getElementById("countrySelect");
  countrySelect.innerHTML = (meta.countries || []).map(c => `<option>${c}</option>`).join("");
  countrySelect.onchange = () => updateCities(meta);
  updateCities(meta);
}

function updateCities(meta) {
  const country = document.getElementById("countrySelect").value;
  const cities = (meta.cities && meta.cities[country]) ? meta.cities[country] : [];
  const citySelect = document.getElementById("citySelect");
  citySelect.innerHTML = cities.map(c => `<option>${c}</option>`).join("");
  citySelect.onchange = updateCategories;
  updateCategories();
}

async function updateCategories() {
  const city = document.getElementById("citySelect").value;
  const places = await fetchPlaces(city);
  const categories = [...new Set(places.map(p => p.category))];

  const container = document.createElement("div");
  container.classList.add("custom-map-panel");
  container.innerHTML =
    `<strong>Categories</strong>` +
    categories.map(cat =>
      // none selected by default
      `<label><input type="checkbox" id="cat-${encodeURIComponent(cat)}"> ${cat}</label>`
    ).join("");

  const ctrlArray = map.controls[google.maps.ControlPosition.TOP_LEFT];
  while (ctrlArray.getLength()) ctrlArray.pop();
  ctrlArray.push(container);

  container.querySelectorAll("input").forEach(cb =>
    cb.addEventListener("change", () => updateMarkers(city))
  );

  clearMarkers();
  closeCurrentInfo();
}

function clearMarkers() { markers.forEach(m => m.setMap(null)); markers = []; }
function closeCurrentInfo(){ if (currentInfoWindow){ currentInfoWindow.close(); currentInfoWindow = null; } }

// --- Tips helpers ---
function getAnyCase(obj, keys){
  const lowerMap = {};
  for (const k in obj) lowerMap[k.toLowerCase()] = obj[k];
  for (const want of keys) if (want.toLowerCase() in lowerMap) return lowerMap[want.toLowerCase()];
  return "";
}
function normalizeTips(raw){
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  return String(raw || "")
    .split(/\r?\n|[|;•]|,/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function createInfoContent(place, position) {
  const rawTips = getAnyCase(place, ["tips","advice","hints"]);
  const tipsArr = normalizeTips(rawTips);
  const tipsHtml = tipsArr.length
    ? `<div class="iw-tips"><h4>Tips</h4><ul>${tipsArr.map(t => `<li>${t}</li>`).join("")}</ul></div>`
    : "";

  const actions = `
    <div class="iw-actions">
      <button onclick="openGoogleMaps(${position.lat}, ${position.lng}, 'walking')">🚶 Walking</button>
      <button onclick="openGoogleMaps(${position.lat}, ${position.lng}, 'driving')">🚗 Driving</button>
    </div>
  `;

  return `
    <div class="iw-content">
      <div class="iw-title">${place.name || ""}</div>
      <div class="iw-desc">${place.description || ""}</div>
      ${tipsHtml}
      ${actions}
    </div>
  `;
}

async function updateMarkers(city) {
  clearMarkers(); closeCurrentInfo();

  const checked = Array.from(document.querySelectorAll("input[id^='cat-']:checked"))
    .map(cb => decodeURIComponent(cb.id.replace("cat-", "")));
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
}

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

// Optional: keeps the blue dot and centers map, but NOT used for directions
function trackUserLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(pos => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!userMarker) {
        userMarker = new google.maps.Circle({
          strokeColor:'#4285F4', strokeOpacity:0.8, strokeWeight:2,
          fillColor:'#4285F4', fillOpacity:0.6, map, center:userLocation, radius:20
        });
      } else { userMarker.setCenter(userLocation); }
      map.setCenter(userLocation); map.setZoom(15);
    }, () => alert("Unable to access location"), { enableHighAccuracy: true });
  } else { alert("Geolocation not supported by your browser"); }
}

// Always use Google Maps' own "My Location" as the origin
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
// Optional: expose a hook for WordPress loader
window.initMapsBankUI = function(rootEl) {
  console.log("MapsBank UI initialized in:", rootEl);
};
