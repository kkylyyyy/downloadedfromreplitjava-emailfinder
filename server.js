/*
 * Director Finder - standalone GitHub version
 *
 * Setup:
 *   npm install
 *   COMPANIES_HOUSE_API_KEY=your_key HUNTER_API_KEY=your_key npm start
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const COMPANIES_HOUSE_API_KEY = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();
const HUNTER_API_KEY = (process.env.HUNTER_API_KEY || "").trim();
const CH_BASE = "https://api.company-information.service.gov.uk";
const HUNTER_BASE = "https://api.hunter.io/v2";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15"
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function generateDomainCandidates(companyName) {
  const stopWords = /\b(ltd|limited|plc|llp|group|uk|the|and|&|solutions|services|holdings|technologies|technology|global|international|consulting|consultancy|systems|digital|labs|ventures|studio|studios|media|creative|co)\b/gi;
  const cleaned = companyName.toLowerCase().replace(stopWords, "").replace(/[^a-z0-9]/g, "").trim();
  const hyphenated = companyName.toLowerCase().replace(stopWords, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").trim();
  if (!cleaned) return [];
  const candidates = [];
  for (const host of [...new Set([cleaned, hyphenated].filter(Boolean))]) {
    for (const tld of [".co.uk", ".com", ".io", ".org.uk"]) {
      candidates.push(`${host}${tld}`);
    }
  }
  return [...new Set(candidates)];
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
      redirect: "follow",
      headers: { "User-Agent": getRandomUserAgent() }
    });
    return res.status < 400 || res.status === 405;
  } catch {
    return false;
  }
}

async function tryFindWebsiteByDomain(companyName) {
  const candidates = generateDomainCandidates(companyName);
  if (!candidates.length) return null;
  const BATCH_SIZE = 4;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (url) => ({ url: `https://www.${url}`, ok: await probeUrl(`https://www.${url}`) })));
    const hit = results.find((r) => r.ok);
    if (hit) return hit.url;
  }
  return null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK_EMAIL = /example|test|youremail|your@|no-reply|noreply|support@support|info@info/i;
const FILE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|docx?|xlsx?|zip|mp[34]|mov|css|js|ts|json|xml)$/i;
const TEL_HREF_RE = /href=["']tel:([^"']+)["']/gi;
const PHONE_RE = /(?:\+44|0044|\b0)[\s.\-()]?\d{2,5}[\s.\-()]?\d{3,4}[\s.\-()]?\d{3,4}/g;

function isValidEmail(email) {
  if (JUNK_EMAIL.test(email)) return false;
  if (FILE_EXT.test(email)) return false;
  const tld = email.split(".").pop() ?? "";
  return /^[a-zA-Z]{2,6}$/.test(tld);
}

function normalisePhone(raw) {
  const digits = raw.replace(/[\s.\-()]/g, "");
  if (digits.startsWith("+44")) return digits;
  if (digits.startsWith("0044")) return "+44" + digits.slice(4);
  if (digits.startsWith("0")) return "+44" + digits.slice(1);
  return digits;
}

function isValidUkPhone(phone) {
  return /^\+44\d{10}$/.test(phone);
}

async function fetchHtml(url, timeoutMs = 6000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": getRandomUserAgent() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function extractContactFromWebsite(baseUrl) {
  let email = null;
  let phone = null;

  const tryExtract = (html) => {
    if (!email) {
      const mailtoMatch = html.match(/href=["']mailto:([^"'?]+)/i);
      const hrefEmail = mailtoMatch?.[1]?.trim();
      if (hrefEmail && isValidEmail(hrefEmail)) {
        email = hrefEmail;
      } else {
        const emails = (html.match(EMAIL_RE) ?? []).filter(isValidEmail);
        if (emails.length) email = emails[0];
      }
    }
    if (!phone) {
      let found = false;
      let m;
      TEL_HREF_RE.lastIndex = 0;
      while ((m = TEL_HREF_RE.exec(html)) !== null) {
        const n = normalisePhone(m[1]);
        if (isValidUkPhone(n)) { phone = n; found = true; break; }
      }
      if (!found) {
        for (const raw of html.match(PHONE_RE) ?? []) {
          const n = normalisePhone(raw);
          if (isValidUkPhone(n)) { phone = n; break; }
        }
      }
    }
  };

  for (const url of [baseUrl, `${baseUrl}/contact`, `${baseUrl}/contact-us`, `${baseUrl}/about`]) {
    if (email && phone) break;
    try { tryExtract(await fetchHtml(url)); } catch { /* try next */ }
  }

  return { email, phone };
}

function address(address) {
  address = address || {};
  return {
    premises: address.premises || null,
    addressLine1: address.address_line_1 || null,
    addressLine2: address.address_line_2 || null,
    locality: address.locality || null,
    region: address.region || null,
    postalCode: address.postal_code || null,
    country: address.country || null,
  };
}

function dobKey(dob) {
  return dob && dob.year && dob.month
    ? `${dob.year}-${String(dob.month).padStart(2, "0")}`
    : "";
}

function nameParts(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return { firstName: "", lastName: "" };
  const titleCase = (value) => value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  if (name.includes(",")) {
    const [surname, forenames] = name.split(",").map((part) => part.trim());
    return { firstName: (forenames || "").split(/\s+/)[0] || "", lastName: titleCase(surname || "") };
  }

  const parts = name.split(/\s+/);
  let surnameStart = parts.length - 1;
  while (surnameStart > 0 && /^[A-Z][A-Z-'0-9]+$/.test(parts[surnameStart - 1])) surnameStart--;
  return {
    firstName: parts[0] || "",
    lastName: titleCase(parts.slice(surnameStart).join(" ")),
  };
}

function samePerson(nameA, dobA, nameB, dobB) {
  const a = nameParts(nameA);
  const b = nameParts(nameB);
  if (a.firstName.toLowerCase() !== b.firstName.toLowerCase()) return false;
  if (a.lastName.toLowerCase() !== b.lastName.toLowerCase()) return false;
  if (dobA && dobB) return dobKey(dobA) === dobKey(dobB);
  return !dobA && !dobB;
}

async function companiesHouse(path) {
  if (!COMPANIES_HOUSE_API_KEY) throw new Error("COMPANIES_HOUSE_API_KEY is not configured");
  const response = await fetch(`${CH_BASE}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${COMPANIES_HOUSE_API_KEY}:`).toString("base64")}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Companies House returned HTTP ${response.status}`);
  return response.json();
}

function companyResult(data, appointment, scraped = {}) {
  const sicCodes = data?.sic_codes || [];
  const compWebsite = scraped.website || data?.website || null;
  const compNumber = appointment?.appointed_to?.company_number || data?.company_number || "";
  const chCompanyUrl = compNumber
    ? `https://find-and-update.company-information.service.gov.uk/company/${compNumber}`
    : null;

  return {
    companyNumber: compNumber,
    companyName: appointment?.appointed_to?.company_name || data?.company_name || "Unknown",
    companyStatus: appointment?.appointed_to?.company_status || data?.company_status || null,
    companyType: data?.type || null,
    sicCodes,
    role: appointment?.officer_role || "director",
    appointedOn: appointment?.appointed_on || null,
    resignedOn: appointment?.resigned_on || null,
    registeredAddress: address(data?.registered_office_address || appointment?.address),
    incorporatedOn: data?.date_of_creation || null,
    website: compWebsite,
    websiteIsReal: !!scraped.website,
    email: scraped.email || null,
    phone: scraped.phone || null,
    chCompanyUrl,
    isActive: !appointment?.resigned_on &&
      (appointment?.appointed_to?.company_status || data?.company_status || "active") !== "dissolved",
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

async function getAllOfficerIds(officer) {
  const data = await companiesHouse(`/search/officers?q=${encodeURIComponent(officer.name)}&items_per_page=50`);
  const ids = new Set();
  for (const item of data?.items || []) {
    if (!samePerson(officer.name, officer.dateOfBirth, item.title || item.name, item.date_of_birth)) continue;
    const match = item.links?.self?.match(/\/officers\/([^/]+)/);
    if (match) ids.add(match[1]);
  }
  return [...ids];
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
  appointments.sort((a, b) =>
    Number(!b.resigned_on) - Number(!a.resigned_on) ||
    String(b.appointed_on || "").localeCompare(String(a.appointed_on || ""))
  );

  const companies = [];
  for (let i = 0; i < appointments.length; i += 5) {
    const batch = appointments.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (appointment) => {
      const number = appointment.appointed_to?.company_number;
      const data = number ? await companiesHouse(`/company/${number}`).catch(() => null) : null;
      const compName = appointment?.appointed_to?.company_name || data?.company_name || "";
      const isActive = !appointment?.resigned_on &&
        (appointment?.appointed_to?.company_status || data?.company_status || "active") !== "dissolved";

      let scraped = {};
      if (isActive && compName) {
        try {
          const foundWebsite = await tryFindWebsiteByDomain(compName);
          if (foundWebsite) {
            const contacts = await extractContactFromWebsite(foundWebsite);
            scraped = { website: foundWebsite, email: contacts.email, phone: contacts.phone };
          }
        } catch (e) { /* ignore scraping errors */ }
      }
      return companyResult(data, appointment, scraped);
    }));
    companies.push(...results);
    if (i + 5 < appointments.length) await new Promise((r) => setTimeout(r, 150));
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
      emailLeads.push({ email: company.email, source: "Website Scraping", companyName: company.companyName, website: company.website, confidence: "high" });
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
  const salesNav = (keywords) =>
    `https://www.linkedin.com/sales/search/people?keywords=${encodeURIComponent(keywords)}&geoIncluded=101165590`;
  const shortName = `${firstName} ${lastName}`.trim();

  searches.push({
    searchUrl: salesNav(shortName),
    searchLabel: shortName,
    reasoning: "Name-only search. Add location and industry filters inside Sales Navigator.",
    confidence: "low",
    derivedFrom: "Director name",
  });

  for (const company of companies.filter((item) => item.isActive).slice(0, 3)) {
    const pCode = company.registeredAddress?.postalCode || "";
    const searchKeywords = pCode ? `${shortName} ${pCode}` : `${shortName} ${company.companyName}`;
    searches.push({
      searchUrl: salesNav(searchKeywords),
      searchLabel: `${shortName} (${pCode || company.companyName})`,
      reasoning: `Searches director with postcode ${pCode || "N/A"} for precise location matching.`,
      confidence: "high",
      derivedFrom: `Active company: ${company.companyName} | Postcode: ${pCode}`,
    });
  }

  const chAppointmentsUrl = `https://find-and-update.company-information.service.gov.uk/officers/${encodeURIComponent(officerId)}/appointments`;

  return {
    chAppointmentsUrl,
    linkedinSearchUrls: searches,
    emailLeads,
    phoneLeads,
    addressLeads,
    summary: emailLeads.length || phoneLeads.length
      ? `Found ${emailLeads.length} email(s) and ${phoneLeads.length} phone number(s).`
      : `No direct contact details found for ${officer.name}. LinkedIn searches generated as backup.`,
  };
}

// =============================================================================
// Hunter.io — with domain-guessing fallback when no website was scraped
// =============================================================================

async function hunterCallDomain(domain, firstName, lastName) {
  if (!domain || !firstName || !lastName) return null;
  const params = new URLSearchParams({ first_name: firstName, last_name: lastName, domain, api_key: HUNTER_API_KEY });
  try {
    const response = await fetch(`${HUNTER_BASE}/email-finder?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const data = await response.json();
    const score = data.data?.score || 0;
    if (!data.data?.email || score < 50) return null;
    return { email: data.data.email, score, confidence: score >= 80 ? "high" : "medium" };
  } catch {
    return null;
  }
}

async function hunterEmail(directorName, website, companyName) {
  if (!HUNTER_API_KEY) return null;

  const { firstName, lastName } = nameParts(directorName);
  if (!firstName || !lastName) return null;

  // Path 1: website was found — extract domain and call Hunter directly
  if (website) {
    let domain;
    try { domain = new URL(website).hostname.replace(/^www\./, ""); } catch { return null; }
    const result = await hunterCallDomain(domain, firstName, lastName);
    if (result) {
      return {
        email: result.email,
        source: "Hunter.io Email Finder",
        companyName,
        website,
        confidence: result.confidence,
      };
    }
    return null;
  }

  // Path 2: no website found — guess domain candidates from company name
  const domainCandidates = generateDomainCandidates(companyName);
  for (const candidate of domainCandidates.slice(0, 8)) {
    const result = await hunterCallDomain(candidate, firstName, lastName);
    if (result) {
      return {
        email: result.email,
        source: "Hunter.io Email Finder (domain guessed)",
        companyName,
        website: `https://www.${candidate}`,
        confidence: result.confidence,
      };
    }
  }

  return null;
}

async function profile(officerId) {
  const officer = await getOfficer(officerId);
  if (!officer) return null;
  const ids = await getAllOfficerIds(officer);
  if (!ids.includes(officerId)) ids.unshift(officerId);
  const companies = await getCompanies(ids);
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

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error.message);
    if (!res.headersSent) res.status(500).json({ error: "Request failed" });
  });
}

// =============================================================================
// API Routes
// =============================================================================

app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/api/directors/search", asyncRoute(async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "Query parameter q is required" });
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
  res.json(companyResult(data));
}));

app.post("/api/directors/:officerId/hunter-emails", asyncRoute(async (req, res) => {
  const officer = await getOfficer(req.params.officerId);
  if (!officer) return res.status(404).json({ error: "Director not found" });
  
  const companies = Array.isArray(req.body?.companies) ? req.body.companies : [];
  const emailLeads = [];

  // Process sequentially to respect Hunter.io API rate limits
  for (const company of companies) {
    try {
      const result = await hunterEmail(officer.name, company.website, company.companyName);
      if (result) {
        emailLeads.push(result);
      }
      
      // Tiny pause to keep Hunter.io happy (rate limits)
      await new Promise(resolve => setTimeout(resolve, 300)); 
    } catch (e) {
      // ignore individual failures and continue to the next company
    }
  }

  res.json({ emailLeads });
}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Director Finder API running at http://localhost:${PORT}`);
  if (!COMPANIES_HOUSE_API_KEY) console.warn("Warning: COMPANIES_HOUSE_API_KEY is not set");
  if (!HUNTER_API_KEY) console.warn("Warning: HUNTER_API_KEY is not set");
});
