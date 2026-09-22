/*
 * Director Finder - Credit Saving Version (Complete & Ready to Run)
 *
 * Setup:
 *   npm install express cors
 *   COMPANIES_HOUSE_API_KEY=your_key HUNTER_API_KEY=your_key node server.js
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 8080);

// Ensure keys are safely extracted
const COMPANIES_HOUSE_API_KEY = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();
const HUNTER_API_KEY = (process.env.HUNTER_API_KEY || "").trim();

// --- COST SAVING CONTROLS ---
const HUNTER_FALLBACK_MAX_LOOKUPS = 2; 
const HUNTER_MIN_SCORE = 50; 
const HUNTER_FALLBACK_DELAY_MS = 350;

const CH_BASE = "https://api.company-information.service.gov.uk";
const HUNTER_BASE = "https://api.hunter.io/v2";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- UTILS & FREE SCRAPING (PHASE 1) ---
const USER_AGENTS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"];
const getRandomUserAgent = () => USER_AGENTS[0];

function generateDomainCandidates(companyName) {
  const stopWords = /\b(ltd|limited|plc|llp|group|uk|the|and|&|solutions|services|holdings|technologies|technology|global|international|consulting|consultancy|systems|digital|labs|ventures|studio|studios|media|creative|co)\b/gi;
  const cleaned = companyName.toLowerCase().replace(stopWords, "").replace(/[^a-z0-9]/g, "").trim();
  if (!cleaned) return [];
  return [`${cleaned}.co.uk`, `${cleaned}.com`];
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000), headers: { "User-Agent": getRandomUserAgent() } });
    return res.status < 400 || res.status === 405;
  } catch { return false; }
}

async function tryFindWebsiteByDomain(companyName) {
  const candidates = generateDomainCandidates(companyName);
  for (const domain of candidates) {
    if (await probeUrl(`https://www.${domain}`)) return `https://www.${domain}`;
  }
  return null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
function isValidEmail(email) {
  return !(/example|test|noreply|info@info/i.test(email) || /\.(png|jpe?g|gif|pdf)$/i.test(email));
}

async function extractContactFromWebsite(baseUrl) {
  let email = null;
  try {
    const html = await fetch(baseUrl, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": getRandomUserAgent() } }).then(r => r.text());
    const mailtoMatch = html.match(/href=["']mailto:([^"'?]+)/i);
    if (mailtoMatch?.[1] && isValidEmail(mailtoMatch[1])) email = mailtoMatch[1].trim();
    else {
      const emails = (html.match(EMAIL_RE) ?? []).filter(isValidEmail);
      if (emails.length) email = emails[0];
    }
  } catch {}
  return { email };
}

async function companiesHouse(path) {
  const response = await fetch(`${CH_BASE}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${COMPANIES_HOUSE_API_KEY}:`).toString("base64")}` }
  });
  if (response.status === 404) return null;
  return response.json();
}

function nameParts(rawName) {
  const parts = String(rawName || "").trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (rawName.includes(",")) {
    const [last, first] = rawName.split(",");
    return { firstName: first.trim().split(/\s+/)[0], lastName: last.trim() };
  }
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

// --- HUNTER.IO (PHASE 2 - BUTTON TRIGGERED) ---
const hunterCache = new Map();

async function hunterCallDomain(domain, firstName, lastName) {
  if (!HUNTER_API_KEY || !domain) return null;
  const cleanDomain = String(domain).trim().toLowerCase().replace(/^www\./i, "");
  const cacheKey = `${cleanDomain}|${firstName.toLowerCase()}`;
  
  if (hunterCache.has(cacheKey) && Date.now() - hunterCache.get(cacheKey).timestamp < 86400000) {
    return hunterCache.get(cacheKey).data;
  }

  const params = new URLSearchParams({ first_name: firstName, last_name: lastName, domain: cleanDomain });
  try {
    const res = await fetch(`${HUNTER_BASE}/email-finder?${params}`, {
      headers: { "X-API-KEY": HUNTER_API_KEY }, signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    
    const data = await res.json();
    const score = Number(data?.data?.score || 0);
    const email = String(data?.data?.email || "").trim();

    if (!email || score < HUNTER_MIN_SCORE || !isValidEmail(email)) {
      hunterCache.set(cacheKey, { timestamp: Date.now(), data: null });
      return null;
    }

    const result = { email, score, confidence: score >= 80 ? "high" : "medium" };
    hunterCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  } catch { return null; }
}

// --- ROUTES ---

// Health check endpoint
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

// Search for a director by name
app.get("/api/directors/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.status(400).json({ error: "Query parameter q is required" });
    
    const data = await companiesHouse(`/search/officers?q=${encodeURIComponent(query)}&items_per_page=50`);
    const seen = new Map();
    
    for (const item of data?.items || []) {
      const match = item.links?.self?.match(/\/officers\/([^/]+)/);
      const name = item.title || item.name || "";
      if (!match || !name) continue;
      
      const parts = nameParts(name);
      const dob = item.date_of_birth ? `${item.date_of_birth.year}-${String(item.date_of_birth.month).padStart(2, '0')}` : "";
      const key = `${parts.firstName.toLowerCase()}|${parts.lastName.toLowerCase()}|${dob}`;
      
      const current = seen.get(key);
      const result = {
        officerId: match[1],
        name,
        title: item.officer_role || null,
        dateOfBirth: dob || null,
        totalAppointments: item.appointment_count || 0
      };
      
      if (!current || result.totalAppointments > current.totalAppointments) seen.set(key, result);
    }
    res.json([...seen.values()]);
  } catch (error) {
    res.status(500).json({ error: "Search failed" });
  }
});

// 1. FREE PROFILE LOAD (Happens immediately when you select a director)
app.get("/api/directors/:officerId/profile", async (req, res) => {
  try {
    const officer = await companiesHouse(`/officers/${req.params.officerId}/appointments`);
    if (!officer) return res.status(404).json({ error: "Not found" });
    
    const companies = [];
    const emailLeads = [];

    // Only scrape the first 5 active companies for free
    for (const appt of (officer.items || []).slice(0, 5)) {
      if (appt.resigned_on || appt.appointed_to?.company_status === 'dissolved') continue;
      
      const compName = appt.appointed_to?.company_name;
      const foundWebsite = await tryFindWebsiteByDomain(compName);
      let email = null;
      
      if (foundWebsite) {
        const contacts = await extractContactFromWebsite(foundWebsite);
        email = contacts.email;
        if (email) emailLeads.push({ email, source: "Free Website Scrape", companyName: compName });
      }

      companies.push({ companyName: compName, website: foundWebsite, email, isActive: true });
    }
    
    res.json({ name: officer.name, companies, contactLeads: { emailLeads } });
  } catch (error) {
    res.status(500).json({ error: "Server Error" });
  }
});

// Dummy endpoints to satisfy existing frontend calls if they expect these
app.get("/api/directors/:officerId/companies", (req, res) => res.json([]));
app.get("/api/directors/:officerId/contact-leads", (req, res) => res.json([]));

// 2. THE BUTTON ROUTE (Only triggers when you click the Hunter button)
app.post("/api/directors/:officerId/hunter-emails", async (req, res) => {
  try {
    const officer = await companiesHouse(`/officers/${req.params.officerId}/appointments`);
    if (!officer) return res.status(404).json({ error: "Not found" });

    const companies = Array.isArray(req.body?.companies) ? req.body.companies : [];
    const emailLeads = [];
    let lookupsUsed = 0;

    const { firstName, lastName } = nameParts(officer.name || "");

    for (const company of companies) {
      // ONLY check companies that don't already have an email found for free
      if (!company.email && company.website) {
        if (lookupsUsed >= HUNTER_FALLBACK_MAX_LOOKUPS) break; // Hard cap!

        const domain = new URL(company.website).hostname;
        const hunterResult = await hunterCallDomain(domain, firstName, lastName);
        lookupsUsed++;

        if (hunterResult) {
          emailLeads.push({
            email: hunterResult.email,
            source: "Hunter.io (Paid Lead)",
            companyName: company.companyName,
            confidence: hunterResult.confidence
          });
          break; // EMERGENCY BRAKE: Found one, stop checking the rest to save points!
        }
        
        await new Promise(r => setTimeout(r, HUNTER_FALLBACK_DELAY_MS));
      }
    }

    // Send the leads back to your frontend button to display
    res.json({ emailLeads, lookupsUsed });
  } catch (error) {
    res.status(500).json({ error: "Hunter API Failed" });
  }
});

// Catch-all route to serve the frontend
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Companies House API Key: ${COMPANIES_HOUSE_API_KEY ? "Loaded" : "MISSING"}`);
  console.log(`Hunter.io API Key: ${HUNTER_API_KEY ? "Loaded" : "MISSING"}`);
});
