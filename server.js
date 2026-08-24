/*
 * Director Finder - standalone GitHub version
 *
 * Setup:
 *   npm install
 *   COMPANIES_HOUSE_API_KEY=your_key HUNTER_API_KEY=your_key npm start
 *
 * Windows PowerShell:
 *   $env:COMPANIES_HOUSE_API_KEY="your_key"
 *   $env:HUNTER_API_KEY="your_key"
 *   npm start
 *
 * This file intentionally contains the complete API so it can be copied
 * without the original monorepo folders.
 */

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const COMPANIES_HOUSE_API_KEY = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();
const HUNTER_API_KEY = (process.env.HUNTER_API_KEY || "").trim();
const CH_BASE = "https://api.company-information.service.gov.uk";
const HUNTER_BASE = "https://api.hunter.io/v2";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
  if (!COMPANIES_HOUSE_API_KEY) {
    throw new Error("COMPANIES_HOUSE_API_KEY is not configured");
  }
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

function companyResult(data, appointment) {
  const sicCodes = data?.sic_codes || [];
  return {
    companyNumber: appointment?.appointed_to?.company_number || data?.company_number || "",
    companyName: appointment?.appointed_to?.company_name || data?.company_name || "Unknown",
    companyStatus: appointment?.appointed_to?.company_status || data?.company_status || null,
    companyType: data?.type || null,
    sicCodes,
    role: appointment?.officer_role || "director",
    appointedOn: appointment?.appointed_on || null,
    resignedOn: appointment?.resigned_on || null,
    registeredAddress: address(data?.registered_office_address || appointment?.address),
    incorporatedOn: data?.date_of_creation || null,
    website: data?.website || null,
    email: null,
    phone: null,
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
      if (!seen.has(key)) {
        seen.add(key);
        appointments.push(item);
      }
    }
  }
  appointments.sort((a, b) => Number(!b.resigned_on) - Number(!a.resigned_on) ||
    String(b.appointed_on || "").localeCompare(String(a.appointed_on || "")));

  const companies = [];
  for (let i = 0; i < appointments.length; i += 5) {
    const batch = appointments.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (appointment) => {
      const number = appointment.appointed_to?.company_number;
      const data = number ? await companiesHouse(`/company/${number}`).catch(() => null) : null;
      return companyResult(data, appointment);
    }));
    companies.push(...results);
  }
  return companies;
}

function contactLeads(officer, companies) {
  const emailLeads = [];
  const phoneLeads = [];
  const addressLeads = [];
  const emails = new Set();
  const phones = new Set();
  const addresses = new Set();

  for (const company of companies) {
    if (company.email && !emails.has(company.email)) {
      emails.add(company.email);
      emailLeads.push({ email: company.email, source: "Companies House", companyName: company.companyName, confidence: "high" });
    }
    if (company.phone && !phones.has(company.phone)) {
      phones.add(company.phone);
      phoneLeads.push({ phone: company.phone, source: "Companies House", companyName: company.companyName, confidence: "high" });
    }
    const key = `${company.registeredAddress.postalCode}|${company.registeredAddress.addressLine1}`;
    if (key !== "|" && !addresses.has(key)) {
      addresses.add(key);
      addressLeads.push({ address: company.registeredAddress, source: "Registered Office", companyName: company.companyName });
    }
  }

  const { firstName, lastName } = nameParts(officer.name);
  const searches = [];
  const salesNav = (keywords) => `https://www.linkedin.com/sales/search/people?query=${encodeURIComponent(`(spellCorrectionEnabled:true,keywords:${keywords})`)}`;
  const shortName = `${firstName} ${lastName}`.trim();
  searches.push({
    searchUrl: salesNav(shortName),
    searchLabel: shortName,
    reasoning: "Name-only search. Add location and industry filters inside Sales Navigator.",
    confidence: "low",
    derivedFrom: "Director name",
  });
  for (const company of companies.filter((item) => item.isActive).slice(0, 3)) {
    searches.push({
      searchUrl: salesNav(`${shortName} "${company.companyName}"`),
      searchLabel: `${shortName} at ${company.companyName}`,
      reasoning: `Searches for the director at ${company.companyName}.`,
      confidence: "high",
      derivedFrom: `Active company: ${company.companyName}`,
    });
  }

  return {
    linkedinSearchUrls: searches,
    emailLeads,
    phoneLeads,
    addressLeads,
    summary: emailLeads.length || phoneLeads.length
      ? `Found ${emailLeads.length} email(s) and ${phoneLeads.length} phone number(s).`
      : `No direct contact details found for ${officer.name}. LinkedIn searches generated as backup.`,
  };
}

async function hunterEmail(directorName, website, companyName) {
  if (!HUNTER_API_KEY || !website) return null;
  let domain;
  try { domain = new URL(website).hostname.replace(/^www\./, ""); } catch { return null; }
  const { firstName, lastName } = nameParts(directorName);
  if (!firstName || !lastName) return null;
  const params = new URLSearchParams({ first_name: firstName, last_name: lastName, domain, api_key: HUNTER_API_KEY });
  const response = await fetch(`${HUNTER_BASE}/email-finder?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const data = await response.json();
  const score = data.data?.score || 0;
  if (!data.data?.email || score < 50) return null;
  return {
    email: data.data.email,
    source: "Hunter.io Email Finder",
    companyName,
    confidence: score >= 80 ? "high" : "medium",
  };
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
    contactLeads: contactLeads(officer, companies),
  };
}

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error.message);
    if (!res.headersSent) res.status(500).json({ error: "Request failed" });
  });
}

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
  const emailLeads = (await Promise.all(companies.map((company) =>
    hunterEmail(officer.name, company.website, company.companyName).catch(() => null)
  ))).filter(Boolean);
  res.json({ emailLeads });
}));

app.listen(PORT, () => {
  console.log(`Director Finder API running at http://localhost:${PORT}`);
  if (!COMPANIES_HOUSE_API_KEY) console.warn("Warning: COMPANIES_HOUSE_API_KEY is not set");
  if (!HUNTER_API_KEY) console.warn("Warning: HUNTER_API_KEY is not set");
});
