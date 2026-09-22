/*
 * Director Finder - Full Schema & Credit Saving Version
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
const COMPANIES_HOUSE_API_KEY = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();
const HUNTER_API_KEY = (process.env.HUNTER_API_KEY || "").trim();

// --- HUNTER.IO COST SAVING CONTROLS ---
const HUNTER_FALLBACK_MAX_LOOKUPS = 2; // Max credits to spend per button click
const HUNTER_MIN_SCORE = 50; 
const HUNTER_FALLBACK_DELAY_MS = 350;

const CH_BASE = "https://api.company-information.service.gov.uk";
const HUNTER_BASE = "https://api.hunter.io/v2";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ============================================================================
// 1. DATA FORMATTING (Required by your frontend to prevent crashes)
// ============================================================================

function address(addr) {
  addr = addr || {};
  return {
    premises: addr.premises || null,
    addressLine1: addr.address_line_1 || null,
    addressLine2: addr.address_line_2 || null,
    locality: addr.locality || null,
    region: addr.region || null,
    postalCode: addr.postal_code || null,
    country: addr.country || null,
  };
}

function dobKey(dob) {
  return dob && dob.year && dob.month ? `${dob.year}-${String(dob.month).padStart(2, "0")}` : "";
}

function nameParts(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return { firstName: "", lastName: "" };
  const titleCase = (val) => val.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  if (name.includes(",")) {
    const [surname, forenames] = name.split(",").map((p) => p.trim());
    return { firstName: (forenames || "").split(/\s+/)[0] || "", lastName: titleCase(surname || "") };
  }
  const parts = name.split(/\s+/);
  let surnameStart = parts.length - 1;
  while (surnameStart > 0 && /^[A-Z][A-Z-'0-9]+$/.test(parts[surnameStart - 1])) surnameStart--;
  return { firstName: parts[0] || "", lastName: titleCase(parts.slice(surnameStart).join(" ")) };
}

function samePerson(nameA, dobA, nameB, dobB) {
  const a = nameParts(nameA);
  const b = nameParts(nameB);
  if (a.firstName.toLowerCase() !== b.firstName.toLowerCase()) return false;
  if (a.lastName.toLowerCase() !== b.lastName.toLowerCase()) return false;
  if (dobA && dobB) return dobKey(dobA) === dobKey(dobB);
  return !dobA && !dobB;
}

// ============================================================================
// 2. FREE WEBSITE SCRAPING (Phase 1)
// ============================================================================

function generateDomainCandidates(companyName) {
  const stopWords = /\b(ltd|limited|plc|llp|group|uk|the|and|&|solutions|services|holdings|technologies|technology|global|international|consulting|consultancy|systems|digital|labs|ventures|studio|studios|media|creative|co)\b/gi;
  const cleaned = companyName.toLowerCase().replace(stopWords, "").replace(/[^a-z0-9]/g, "").trim();
  const hyphenated = companyName.toLowerCase().replace(stopWords, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").trim();
  if (!cleaned) return [];
  const candidates = [];
  const tlds = [".co.uk", ".com", ".io"];
  for (const tld of tlds) candidates.push(`${cleaned}${tld}`);
  if (hyphenated !== cleaned) for (const tld of tlds) candidates.push(`${hyphenated}${tld}`);
  return [...new Set(candidates)];
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000), headers: { "User-Agent": getRandomUserAgent() } });
    return res.status < 400 || res.status === 405;
  } catch { return false; }
}

async function tryFindWebsiteByDomain(companyName) {
  const candidates = generateDomainCandidates(companyName);
  if (!candidates.length) return null;
  const BATCH_SIZE = 4;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (domain) => ({ url: `https://www.${domain}`, ok: await probeUrl(`https://www.${domain}`) })));
    const hit = results.find((r) => r.ok);
    if (hit) return hit.url;
  }
  return null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+44|0044|\b0)[\s.\-()]?\d{2,5}[\s.\-()]?\d{3,4}[\s.\-()]?\d{3,4}/g;

function isValidEmail(email) {
  return !(/example|test|noreply|info@info/i.test(email) || /\.(png|jpe?g|gif|pdf|docx?)$/i.test(email));
}

function normalisePhone(raw) {
  const digits = raw.replace(/[\s.\-()]/g, "");
  if (digits.startsWith("+44")) return digits;
  if (digits.startsWith("0044")) return "+44" + digits.slice(4);
  if (digits.startsWith("0")) return "+44" + digits.slice(1);
  return digits;
}

async function extractContactFromWebsite(baseUrl) {
  let email = null, phone = null;
  try {
    const html = await fetch(baseUrl, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": getRandomUserAgent() } }).then(r => r.text());
    const mailtoMatch = html.match(/href=["']mailto:([^"'?]+)/i);
    if (mailtoMatch?.[1] && isValidEmail(mailtoMatch[1])) email = mailtoMatch[1].trim();
    else {
      const emails = (html.match(EMAIL_RE) ?? []).filter(isValidEmail);
      if (emails.length) email = emails[0];
    }
    const phones = html.match(PHONE_RE) ?? [];
    for (const raw of phones) {
      const n = normalisePhone(raw);
      if (/^\+44\d{10}$/.test(n)) { phone = n; break; }
    }
  } catch {}
  return { email, phone };
}

// ============================================================================
// 3. COMPANIES HOUSE API
// ============================================================================

async function companiesHouse(path) {
  if (!COMPANIES_HOUSE_API_KEY) throw new Error("COMPANIES_HOUSE_API_KEY is not configured");
  const response = await fetch(`${CH_BASE}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${COMPANIES_HOUSE_API_KEY}:`).toString("base64")}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Companies House returned HTTP ${response.status}`);
  return response.json();
}

function companyResult(data, appointment, scraped = {}) {
  const compNumber = appointment?.appointed_to?.company_number || data?.company_number || "";
  const isActive = !appointment?.resigned_on && (appointment?.appointed_to?.company_status || data?.company_status || "active") !== "dissolved";

  return {
    companyNumber: compNumber,
    companyName: appointment?.appointed_to?.company_name || data?.company_name || "Unknown",
    companyStatus: appointment?.appointed_to?.company_status || data?.company_status || null,
    companyType: data?.type || null,
    sicCodes: data?.sic_codes || [],
    role: appointment?.officer_role || "director",
    appointedOn: appointment?.appointed_on || null,
    resignedOn: appointment?.resigned_on || null,
    registeredAddress: address(data?.registered_office_address || appointment?.address),
    incorporatedOn: data?.date_of_creation || null,
    website: scraped.website || data?.website || null,
    websiteIsReal: !!scraped.website,
    email: scraped.email || null,
    phone: scraped.phone || null,
    emailSource: scraped.emailSource || null,
    emailConfidence: scraped.emailConfidence || null,
    chCompanyUrl: compNumber ? `https://find-and-update.company-information.service.gov.uk/company/${compNumber}` : null,
    isActive,
  };
}

async function getOfficer(officerId) {
  const data = await companiesHouse(`/officers/${encodeURIComponent(officerId)}/appointments?items_per_page=50`);
  if (!data) return null;
  const first = data.items?.[0];
  return {
    name: data.name || "",
    dateOfBirth: data.date_of_birth,
    nationality: first?.nationality || null,
    occupation: first?.occupation || null,
    address: address(first?.address),
    appointments: data.items || [],
  };
}

async function getCompanies(officerIds) {
  const appointments = [];
  const seen = new Set();
  for (const id of officerIds) {
    const data = await companiesHouse(`/officers/${encodeURIComponent(id)}/appointments?items_per_page=50`);
    for (const item of data?.items || []) {
      const key = `${item.appointed_to?.company_number}|${item.officer_role}|${item.appointed_on || ""}`;
      if (!seen.has(key)) { seen.add(key); appointments.push(item); }
    }
  }
  appointments.sort((a, b) => Number(!b.resigned_on) - Number(!a.resigned_on) || String(b.appointed_on || "").localeCompare(String(a.appointed_on || "")));

  const companies = [];
  // Scrape only the first 5 to save time
  for (let i = 0; i < appointments.length; i += 5) {
    const batch = appointments.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (appointment) => {
      const number = appointment.appointed_to?.company_number;
      const data = number ? await companiesHouse(`/company/${number}`).catch(() => null) : null;
      const compName = appointment?.appointed_to?.company_name || data?.company_name || "";
      const isActive = !appointment?.resigned_on && (appointment?.appointed_to?.company_status || data?.company_status || "active") !== "dissolved";

      let scraped = {};
      if (isActive && compName && i < 5) {
        try {
          const foundWebsite = await tryFindWebsiteByDomain(compName);
          if (foundWebsite) {
            const contacts = await extractContactFromWebsite(foundWebsite);
            scraped = { website: foundWebsite, email: contacts.email, phone: contacts.phone, emailSource: contacts.email ? "Website Scraping" : null, emailConfidence: contacts.email ? "high" : null };
          }
        } catch (e) {}
      }
      return companyResult(data, appointment, scraped);
    }));
    companies.push(...results);
  }
  return companies;
}

function contactLeads(officer, companies, officerId) {
  const emailLeads = [];
  const phoneLeads = [];
  const addressLeads = [];
  const emails = new Set();
  const phones = new Set();
  const addresses = new Set();

  for (const company of companies) {
    if (company.email && !emails.has(company.email)) {
      emails.add(company.email);
      emailLeads.push({ email: company.email, source: company.emailSource || "Website Scraping", companyName: company.companyName, website: company.website, confidence: company.emailConfidence || "high" });
    }
    if (company.phone && !phones.has(company.phone)) {
      phones.add(company.phone);
      phoneLeads.push({ phone: company.phone, source: "Website Scraping", companyName: company.companyName, website: company.website, confidence: "high" });
    }
    const key = `${company.registeredAddress.postalCode}|${company.registeredAddress.addressLine1}`;
    if (key !== "|" && !addresses.has(key)) {
      addresses.add(key);
      addressLeads.push({ address: company.registeredAddress, source: "Registered Office", companyName: company.companyName });
    }
  }

  const { firstName, lastName } = nameParts(officer.name);
  const searches = [];
  const shortName = `${firstName} ${lastName}`.trim();

  searches.push({
    searchUrl: `https://www.linkedin.com/sales/search/people?keywords=${encodeURIComponent(shortName)}`,
    searchLabel: shortName,
    reasoning: "Name-only search.",
    confidence: "low",
    derivedFrom: "Director name",
  });

  return {
    chAppointmentsUrl: `https://find-and-update.company-information.service.gov.uk/officers/${encodeURIComponent(officerId)}/appointments`,
    linkedinSearchUrls: searches,
    emailLeads,
    phoneLeads,
    addressLeads,
    summary: emailLeads.length || phoneLeads.length ? `Found contacts.` : `No direct contact details found.`,
  };
}

async function profile(officerId) {
  const officer = await getOfficer(officerId);
  if (!officer) return null;
  const companies = await getCompanies([officerId]);
  return {
    officerId,
    name: officer.name,
    title: null,
    dateOfBirth: officer.dateOfBirth ? dobKey(officer.dateOfBirth) : null,
    nationality: officer.nationality,
    occupation: officer.occupation,
    address: officer.address,
    companies,
    contactLeads: contactLeads(officer, companies, officerId),
  };
}

// ============================================================================
// 4. HUNTER.IO LOGIC (Manual Button Trigger)
// ============================================================================

const hunterCache = new Map();

async function hunterCallDomain(domain, firstName, lastName) {
  if (!domain || !firstName || !lastName) return null;
  const cacheKey = `${domain.toLowerCase()}|${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
  if (hunterCache.has(cacheKey) && (Date.now() - hunterCache.get(cacheKey).timestamp < 86400000)) return hunterCache.get(cacheKey).data;

  const params = new URLSearchParams({ first_name: firstName, last_name: lastName, domain, api_key: HUNTER_API_KEY });
  try {
    const response = await fetch(`${HUNTER_BASE}/email-finder?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    const score = data.data?.score || 0;
    
    if (!data.data?.email || score < HUNTER_MIN_SCORE) {
      hunterCache.set(cacheKey, { timestamp: Date.now(), data: null });
      return null;
    }
    
    const result = { email: data.data.email, score, confidence: score >= 80 ? "high" : "medium" };
    hunterCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  } catch { return null; }
}

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error.message);
    if (!res.headersSent) res.status(500).json({ error: "Request failed" });
  });
}

// ============================================================================
// 5. API ROUTES
// ============================================================================

app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/api/directors/search", asyncRoute(async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "Query required" });
  const data = await companiesHouse(`/search/officers?q=${encodeURIComponent(query)}&items_per_page=50`);
  const seen = new Map();
  for (const item of data?.items || []) {
    const match = item.links?.self?.match(/\/officers\/([^/]+)/);
    const name = item.title || item.name || "";
    if (!match || !name) continue;
    const key = `${nameParts(name).firstName.toLowerCase()}|${nameParts(name).lastName.toLowerCase()}|${dobKey(item.date_of_birth)}`;
    const current = seen.get(key);
    const result = {
      officerId: match[1],
      name,
      title: item.officer_role || null,
      dateOfBirth: item.date_of_birth ? dobKey(item.date_of_birth) : null,
      nationality: item.nationality || null,
      occupation: item.occupation || null,
      address: address(item.address),
      appointedBefore: null,
      totalAppointments: item.appointment_count || 0,
    };
    if (!current || result.totalAppointments > current.totalAppointments) seen.set(key, result);
  }
  res.json([...seen.values()]);
}));

app.get("/api/directors/:officerId/profile", asyncRoute(async (req, res) => {
  const result = await profile(req.params.officerId);
  if (!result) return res.status(404).json({ error: "Director not found" });
  res.json(result);
}));

app.get("/api/directors/:officerId/companies", asyncRoute(async (req, res) => {
  const result = await profile(req.params.officerId);
  if (!result) return res.status(404).json({ error: "Director not found" });
  res.json(result.companies);
}));

app.get("/api/directors/:officerId/contact-leads", asyncRoute(async (req, res) => {
  const result = await profile(req.params.officerId);
  if (!result) return res.status(404).json({ error: "Director not found" });
  res.json(result.contactLeads);
}));

app.get("/api/companies/:companyNumber", asyncRoute(async (req, res) => {
  const data = await companiesHouse(`/company/${encodeURIComponent(req.params.companyNumber)}`);
  if (!data) return res.status(404).json({ error: "Company not found" });
  res.json(companyResult(data, null));
}));

// THE HUNTER BUTTON ROUTE
app.post("/api/directors/:officerId/hunter-emails", asyncRoute(async (req, res) => {
  const officer = await getOfficer(req.params.officerId);
  if (!officer) return res.status(404).json({ error: "Director not found" });
  
  const companies = Array.isArray(req.body?.companies) ? req.body.companies : [];
  const emailLeads = [];
  let lookupsUsed = 0;
  const { firstName, lastName } = nameParts(officer.name);

  for (const company of companies) {
    if (company.isActive && !company.email) { // Only check if they don't have an email
      if (lookupsUsed >= HUNTER_FALLBACK_MAX_LOOKUPS) break;

      const domain = company.website ? new URL(company.website).hostname : generateDomainCandidates(company.companyName)[0];
      
      if (domain) {
        const result = await hunterCallDomain(domain, firstName, lastName);
        lookupsUsed++;
        if (result) {
          emailLeads.push({
            email: result.email,
            source: "Hunter.io",
            companyName: company.companyName,
            confidence: result.confidence
          });
          break; // Stop immediately upon finding an email to save credits
        }
        await new Promise(r => setTimeout(r, HUNTER_FALLBACK_DELAY_MS));
      }
    }
  }

  res.json({ emailLeads, lookupsUsed });
}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
});
