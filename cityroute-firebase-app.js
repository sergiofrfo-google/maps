// MapVivid — AI Itinerary Builder (Async)
// Front-end: Firebase (Auth + Firestore) + Cloud Run (job creator)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/** =========================
 *  CONFIG (YOU MUST EDIT)
 *  ========================= */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCzpRvO1XGB7D0JfHcct_9RFXdg4YP41Bo",
  authDomain: "mapvivid-com.firebaseapp.com",
  projectId: "mapvivid-com",
  appId: "1:162845718290:web:84394a11e98ea56088a5cb",
};

const CLOUD_RUN_BASE_URL = "https://maps-162845718290.europe-west1.run.app"; // no trailing slash
const COUNTRIES_URL = "https://apps.mapvivid.com/countries.json"; // you already use this
const CITIES_API_URL = "https://script.google.com/macros/s/AKfycbwGocu75weAKjVd-i-dUG9ecGJQfkRrGlssl6D8FQ18iwcjKOscPmbxdNTXdPtqDOUODw/exec"; // optional (fast), replace later if you want
const GMAPS_API_KEY = "AIzaSyA6MFWoq480bdhSIEIHiedPRat4Xq8ng20";

/** =========================
 *  Small helpers
 *  ========================= */
function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function startProgress(msg = "Preparing…") {
  const p = document.getElementById("mv-progress");
  const b = document.getElementById("mv-progress-bar");
  const l = document.getElementById("mv-progress-label");
  if (!p || !b || !l) return;
  p.style.display = "block";
  b.style.width = "10%";
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
  setTimeout(() => {
    p.style.display = "none";
    b.style.width = "0%";
  }, 600);
}

function getAllChecked(name, root = document) {
  return qsa(`input[name="${name}"]:checked`, root).map(i => i.value);
}

function buildPayloadFromForm(form) {
  const fd = new FormData(form);
  const pick = k => (fd.get(k) || "").toString().trim();

  const citySel = pick("city");
  return {
    city: (citySel === "__other__" ? pick("city_other") : citySel),
    country: pick("country"),

    start_date: pick("start_date"),
    end_date: pick("end_date"),
    no_dates: fd.get("no_dates") ? "1" : "",
    stay_days: pick("stay_days"),

    categories: getAllChecked("categories", form),
    mobility: getAllChecked("mobility", form),
    companion_type: pick("companion_type"),
    tip_focus: getAllChecked("tip_focus", form),

    pace: pick("pace"),
    budget: { value: pick("budget_value"), currency: pick("budget_currency") },

    extra_requests: pick("extra_requests"),
    email: pick("email"),
  };
}

function setStatus(text, color = "#374151") {
  const el = document.getElementById("mv-status");
  if (!el) return;
  el.style.color = color;
  el.textContent = text || "";
}

function setJobBadge(text) {
  const el = document.getElementById("mv-job-badge");
  if (!el) return;
  el.textContent = text || "";
}

function setUrlJob(jobId) {
  const url = new URL(location.href);
  url.searchParams.set("job", jobId);
  history.replaceState({}, "", url.toString());
}

function getUrlJob() {
  const url = new URL(location.href);
  return (url.searchParams.get("job") || "").trim();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Copy this:", text);
    return false;
  }
}

/** =========================
 *  Google Maps loader + map render
 *  ========================= */
const loadMaps = (() => {
  let p;
  return () => {
    if (window.google?.maps) return Promise.resolve();
    if (!p) {
      p = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GMAPS_API_KEY)}`;
        s.async = true;
        s.defer = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Google Maps failed to load"));
        document.head.appendChild(s);
      });
    }
    return p;
  };
})();

function buildMap(items) {
  const mapEl = document.getElementById("mv-map");
  if (!mapEl || !window.google?.maps) return;

  const points = (items || [])
    .map(x => ({ lat: Number(x.lat), lng: Number(x.lng), name: x.name }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  if (!points.length) {
    mapEl.innerHTML = "<div style='padding:14px;color:#6b7280'>No coordinates to show on the map.</div>";
    return;
  }

  const map = new google.maps.Map(mapEl, { zoom: 13, center: points[0] });
  const bounds = new google.maps.LatLngBounds();

  points.forEach(p => {
    const marker = new google.maps.Marker({ position: p, map, title: p.name || "" });
    bounds.extend(marker.getPosition());
  });

  map.fitBounds(bounds);
}

/** =========================
 *  Render result (simple + clean)
 *  ========================= */
function renderResult(job) {
  const itinerary = Array.isArray(job?.result?.itinerary) ? job.result.itinerary : [];
  const dayTips = job?.result?.day_tips && typeof job.result.day_tips === "object" ? job.result.day_tips : {};
  const cityTips = job?.result?.city_tips && typeof job.result.city_tips === "object" ? job.result.city_tips : {};

  const planRoot = document.getElementById("mv-plan");
  const tipsRoot = document.getElementById("mv-city-tips");
  if (!planRoot || !tipsRoot) return;

  if (!itinerary.length) {
    planRoot.innerHTML = "<div class='mv-day'>No itinerary returned.</div>";
    tipsRoot.innerHTML = "";
    return;
  }

  const days = [...new Set(itinerary.map(i => Number(i.day) || 1))].sort((a,b)=>a-b);

  planRoot.innerHTML = days.map(d => {
    const stops = itinerary.filter(x => (Number(x.day)||1) === d);
    const tip = (dayTips[String(d)] || dayTips[`day_${d}`] || "").toString().trim();

    const stopHtml = stops.map(s => {
      const name = (s.name || "").toString();
      const desc = (s.description || "").toString();
      const time = (s.time || "").toString();
      const q = encodeURIComponent(name + (job.input?.city ? `, ${job.input.city}` : "") + (job.input?.country ? `, ${job.input.country}` : ""));
      const mapUrl = `https://www.google.com/maps/search/?api=1&query=${q}`;
      return `
        <div class="mv-stop">
          <div><strong>${time ? `${time} — ` : ""}${name}</strong> · <a href="${mapUrl}" target="_blank" rel="noopener">Map</a></div>
          ${desc ? `<div style="color:#374151;margin-top:4px">${desc}</div>` : ""}
        </div>
      `;
    }).join("");

    return `
      <div class="mv-day">
        <h3>Day ${d}</h3>
        ${stopHtml}
        ${tip ? `<div style="margin-top:10px;color:#374151"><strong>Tip:</strong> ${tip}</div>` : ""}
      </div>
    `;
  }).join("");

  const cityKeys = Object.keys(cityTips || {});
  tipsRoot.innerHTML = cityKeys.length ? `
    <h3>City tips</h3>
    ${cityKeys.map(k => {
      const arr = Array.isArray(cityTips[k]) ? cityTips[k] : [];
      if (!arr.length) return "";
      const label = k.replaceAll("_", " ");
      return `
        <div class="mv-tip-block">
          <div style="font-weight:800;margin-bottom:6px">${label}</div>
          <ul style="margin:0;padding-left:18px">
            ${arr.map(t => `<li style="margin:6px 0">${String(t||"")}</li>`).join("")}
          </ul>
        </div>
      `;
    }).join("")}
  ` : "";
}

/** =========================
 *  Countries/Cities (like your current logic)
 *  ========================= */
async function loadCountries() {
  try {
    const res = await fetch(COUNTRIES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const countries = await res.json();
    const sel = document.getElementById("country");
    if (!sel) return;

    sel.innerHTML = `<option value="">-- Select a country --</option>`;
    countries.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error("loadCountries failed:", e);
  }
}

async function loadCities(country) {
  const cityEl = document.getElementById("city");
  const other = document.getElementById("city_other");
  if (!cityEl || !other) return;

  cityEl.innerHTML = `<option value="">-- Select a city --</option>`;
  cityEl.insertAdjacentHTML("beforeend", `<option value="__other__">Other (type manually)</option>`);
  other.style.display = "none";
  other.required = false;
  other.value = "";

  if (!country) return;

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
  } catch (e) {
    console.warn("loadCities failed (ok if you replace later):", e);
  }
}

/** =========================
 *  Firebase init + job flow
 *  ========================= */
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

async function ensureAuth() {
  const cred = await signInAnonymously(auth);
  return cred.user;
}

async function startJob(payload) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();

  const res = await fetch(`${CLOUD_RUN_BASE_URL}/v1/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.jobId) {
    throw new Error(data?.error || `Failed to create job (HTTP ${res.status})`);
  }
  return data.jobId;
}

function listenJob(jobId) {
  const ref = doc(db, "jobs", jobId);
  return onSnapshot(ref, async (snap) => {
    if (!snap.exists()) return;
    const job = snap.data();

    setJobBadge(`Job: ${jobId} · ${job.status || "…"}`);

    if (job.status === "queued") {
      setProgress(25, "Queued…");
      setStatus("Your job is queued. You can close this page — it will keep running.");
      return;
    }
    if (job.status === "running") {
      setProgress(45, "Generating itinerary…");
      setStatus("Generating… you can close the tab and come back later.");
      return;
    }
    if (job.status === "done") {
      setProgress(90, "Rendering…");
      setStatus("");
      renderResult(job);

      try {
        await loadMaps();
        buildMap(job?.result?.itinerary || []);
      } catch (e) {
        console.warn("Maps not loaded:", e);
      }

      setProgress(100, "Done");
      endProgress();

      // simple “notify” while tab is open
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("MapVivid itinerary ready", { body: "Your itinerary has been generated." });
        }
      } catch {}

      return;
    }
    if (job.status === "error") {
      endProgress();
      setStatus(`❌ ${job.error || "Job failed"}`, "red");
      return;
    }
  });
}

function wireDateControls() {
  const noDates = document.getElementById("no_dates");
  const s = document.getElementById("start_date");
  const e = document.getElementById("end_date");
  const stay = document.getElementById("stay_days");
  if (!noDates || !s || !e || !stay) return;

  function refresh() {
    const nd = !!noDates.checked;
    s.disabled = nd;
    e.disabled = nd;
    stay.disabled = !nd && !!(s.value && e.value);
  }

  noDates.addEventListener("change", refresh);

  function calcStayDays() {
    if (noDates.checked) return;
    if (!s.value || !e.value) return;
    const d1 = new Date(s.value);
    const d2 = new Date(e.value);
    const ms = d2 - d1;
    const days = Math.floor(ms / 86400000) + 1;
    if (Number.isFinite(days) && days > 0) {
      stay.value = String(Math.max(1, Math.min(7, days)));
    }
    refresh();
  }
  s.addEventListener("change", calcStayDays);
  e.addEventListener("change", calcStayDays);

  refresh();
}

async function init() {
  await ensureAuth();

  await loadCountries();
  wireDateControls();

  const form = document.getElementById("mv-form");
  const itinerary = document.getElementById("itinerary");
  const copyBtn = document.getElementById("mv-copy-link");
  const backBtn = document.getElementById("mv-back");

  const countryEl = document.getElementById("country");
  const cityEl = document.getElementById("city");
  const cityOther = document.getElementById("city_other");

  if (countryEl) {
    countryEl.addEventListener("change", () => loadCities(countryEl.value));
  }
  if (cityEl && cityOther) {
    cityEl.addEventListener("change", () => {
      if (cityEl.value === "__other__") {
        cityOther.style.display = "block";
        cityOther.required = true;
      } else {
        cityOther.style.display = "none";
        cityOther.required = false;
        cityOther.value = "";
      }
    });
  }

  // If opened with ?job=... resume listening immediately
  const existingJob = getUrlJob();
  if (existingJob) {
    if (form) form.style.display = "none";
    if (itinerary) itinerary.style.display = "block";
    startProgress("Resuming job…");
    listenJob(existingJob);
    if (copyBtn) {
      copyBtn.style.display = "";
      copyBtn.onclick = () => copyText(location.href);
    }
  }

  if (backBtn) {
    backBtn.onclick = () => {
      // reset view (new job)
      const url = new URL(location.href);
      url.searchParams.delete("job");
      history.replaceState({}, "", url.toString());
      if (itinerary) itinerary.style.display = "none";
      if (form) {
        form.style.display = "block";
        form.reset();
      }
      setStatus("");
      setJobBadge("");
    };
  }

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    try {
      setStatus("");
      startProgress("Creating job…");
      setProgress(15, "Creating job…");

      const payload = buildPayloadFromForm(form);

      // switch UI
      form.style.display = "none";
      if (itinerary) itinerary.style.display = "block";

      const jobId = await startJob(payload);
      setUrlJob(jobId);
      setJobBadge(`Job: ${jobId} · queued`);

      // show status link button
      if (copyBtn) {
        copyBtn.style.display = "";
        copyBtn.onclick = () => copyText(location.href);
      }

      setProgress(20, "Queued…");
      setStatus("Job created. You can close this page — it will keep running.");

      listenJob(jobId);

    } catch (err) {
      endProgress();
      setStatus("❌ " + String(err?.message || err || "Error"), "red");
      // show form again
      form.style.display = "block";
      if (itinerary) itinerary.style.display = "none";
    }
  });

  // optional: ask notification permission (only matters while tab is open unless you add FCM)
  try {
    if ("Notification" in window && Notification.permission === "default") {
      // don’t spam—only request on user gesture in real UX, but keeping minimal here
    }
  } catch {}
}

init().catch(e => {
  console.error(e);
  setStatus("❌ Init failed: " + String(e?.message || e), "red");
});
