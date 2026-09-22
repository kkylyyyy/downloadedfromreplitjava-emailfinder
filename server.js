/*
 * Director Finder - standalone GitHub version
 *
 * Setup:
 *   npm install
 *   COMPANIES_HOUSE_API_KEY=your_key HUNTER_API_KEY=your_key npm start
 *
 * Optional Hunter controls:
 *   HUNTER_FALLBACK_MAX_LOOKUPS=2   # Max Hunter API calls per director
 *   HUNTER_MIN_SCORE=50             # Ignore Hunter results below this score
 *
 * Behaviour:
 *   1. Search company websites first (no Hunter credits).
 *   2. Only when no website email is found, use Hunter as a small fallback.
 *   3. Stop after the first good Hunter result.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const COMPANIES_HOUSE_API_KEY = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();
const HUNTER_API_KEY = (process.env.HUNTER_API_KEY || "").trim();

// Hunter is a fallback only. These settings keep usage deliberately small.
// HUNTER_FALLBACK_MAX_LOOKUPS controls the maximum Hunter Email Finder calls
// made for one director after website searching has failed.
function safeNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const HUNTER_FALLBACK_MAX_LOOKUPS = Math.max(
  0,
  Math.min(10, safeNumberEnv("HUNTER_FALLBACK_MAX_LOOKUPS", 2))
);

const HUNTER_MIN_SCORE = Math.max(
  0,
  Math.min(100, safeNumberEnv("HUNTER_MIN_SCORE", 50))
);

const HUNTER_FALLBACK_DELAY_MS = Math.max(
  100,
  safeNumberEnv("HUNTER_FALLBACK_DELAY_MS", 350)
);

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

  const cleaned = companyName
    .toLowerCase()
    .replace(stopWords, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();

  const hyphenated = companyName
    .toLowerCase()
    .replace(stopWords, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();

  if (!cleaned) return [];

  const candidates = [];
  const tlds = [".co.uk", ".com", ".io", ".org.uk", ".net"];

  // Exact matches first, prioritizing .co.uk over .com.
  for (const tld of tlds) {
    candidates.push(`${cleaned}${tld}`);
  }

  // Hyphenated variants second.
  if (hyphenated !== cleaned) {
    for (const tld of tlds) {
      candidates.push(`${hyphenated}${tld}`);
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
      headers: {
        "User-Agent": getRandomUserAgent()
      }
    });

    return res.status < 400 || res.status === 405;
  } catch {
    return false;
  }
}

async function tryFindWebsiteByDomain(companyName) {
  const candidates = generateDomainCandidates(companyName);

  if (!candidates.length) {
    return null;
  }

  const BATCH_SIZE = 4;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (domain) => ({
        domain,
        url: `https://www.${domain}`,
        ok: await probeUrl(`https://www.${domain}`)
      }))
    );

    const hit = results.find((r) => r.ok);

    if (hit) {
      return hit.url;
    }
  }

  return null;
}

function normaliseWebsiteUrl(rawWebsite) {
  if (!rawWebsite) {
    return null;
  }

  try {
    const value = String(rawWebsite).trim();

    if (!value) {
      return null;
    }

    const withProtocol = /^https?:\/\//i.test(value)
      ? value
      : `https://${value}`;

    const url = new URL(withProtocol);

    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }

    url.hash = "";

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

const EMAIL_RE =
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const JUNK_EMAIL =
  /example|test|youremail|your@|no-reply|noreply|support@support|info@info/i;

const FILE_EXT =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|pdf|docx?|xlsx?|zip|mp[34]|mov|css|js|ts|json|xml)$/i;

const TEL_HREF_RE =
  /href=["']tel:([^"']+)["']/gi;

const PHONE_RE =
  /(?:\+44|0044|\b0)[\s.\-()]?\d{2,5}[\s.\-()]?\d{3,4}[\s.\-()]?\d{3,4}/g;

function isValidEmail(email) {
  if (JUNK_EMAIL.test(email)) {
    return false;
  }

  if (FILE_EXT.test(email)) {
    return false;
  }

  const tld = email.split(".").pop() ?? "";

  return /^[a-zA-Z]{2,6}$/.test(tld);
}

function normalisePhone(raw) {
  const digits = raw.replace(/[\s.\-()]/g, "");

  if (digits.startsWith("+44")) {
    return digits;
  }

  if (digits.startsWith("0044")) {
    return "+44" + digits.slice(4);
  }

  if (digits.startsWith("0")) {
    return "+44" + digits.slice(1);
  }

  return digits;
}

function isValidUkPhone(phone) {
  return /^\+44\d{10}$/.test(phone);
}

async function fetchHtml(url, timeoutMs = 6000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": getRandomUserAgent()
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.text();
}

async function extractContactFromWebsite(baseUrl) {
  let email = null;
  let phone = null;

  const tryExtract = (html) => {
    // EMAIL
    if (!email) {
      const mailtoMatch = html.match(
        /href=["']mailto:([^"'?]+)/i
      );

      const hrefEmail = mailtoMatch?.[1]?.trim();

      if (hrefEmail && isValidEmail(hrefEmail)) {
        email = hrefEmail;
      } else {
        const emails = (html.match(EMAIL_RE) ?? [])
          .filter(isValidEmail);

        if (emails.length) {
          email = emails[0];
        }
      }
    }

    // PHONE
    if (!phone) {
      let found = false;
      let m;

      TEL_HREF_RE.lastIndex = 0;

      while ((m = TEL_HREF_RE.exec(html)) !== null) {
        const n = normalisePhone(m[1]);

        if (isValidUkPhone(n)) {
          phone = n;
          found = true;
          break;
        }
      }

      if (!found) {
        for (const raw of html.match(PHONE_RE) ?? []) {
          const n = normalisePhone(raw);

          if (isValidUkPhone(n)) {
            phone = n;
            break;
          }
        }
      }
    }
  };

  const pages = [
    baseUrl,
    `${baseUrl}/contact`,
    `${baseUrl}/contact-us`,
    `${baseUrl}/about`
  ];

  for (const url of pages) {
    if (email && phone) {
      break;
    }

    try {
      const html = await fetchHtml(url);
      tryExtract(html);
    } catch {
      // Try the next page.
    }
  }

  return {
    email,
    phone
  };
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
    country: address.country || null
  };
}

function dobKey(dob) {
  return dob && dob.year && dob.month
    ? `${dob.year}-${String(dob.month).padStart(2, "0")}`
    : "";
}

function nameParts(rawName) {
  const name = String(rawName || "").trim();

  if (!name) {
    return {
      firstName: "",
      lastName: ""
    };
  }

  const titleCase = (value) =>
    value
      .split(/\s+/)
      .map(
        (word) =>
          word.charAt(0).toUpperCase() +
          word.slice(1).toLowerCase()
      )
      .join(" ");

  if (name.includes(",")) {
    const [surname, forenames] = name
      .split(",")
      .map((part) => part.trim());

    return {
      firstName:
        (forenames || "").split(/\s+/)[0] || "",
      lastName: titleCase(surname || "")
    };
  }

  const parts = name.split(/\s+/);

  let surnameStart = parts.length - 1;

  while (
    surnameStart > 0 &&
    /^[A-Z][A-Z-'0-9]+$/.test(
      parts[surnameStart - 1]
    )
  ) {
    surnameStart--;
  }

  return {
    firstName: parts[0] || "",
    lastName: titleCase(
      parts.slice(surnameStart).join(" ")
    )
  };
}

function samePerson(nameA, dobA, nameB, dobB) {
  const a = nameParts(nameA);
  const b = nameParts(nameB);

  if (
    a.firstName.toLowerCase() !==
    b.firstName.toLowerCase()
  ) {
    return false;
  }

  if (
    a.lastName.toLowerCase() !==
    b.lastName.toLowerCase()
  ) {
    return false;
  }

  if (dobA && dobB) {
    return dobKey(dobA) === dobKey(dobB);
  }

  return !dobA && !dobB;
}

async function companiesHouse(path) {
  if (!COMPANIES_HOUSE_API_KEY) {
    throw new Error(
      "COMPANIES_HOUSE_API_KEY is not configured"
    );
  }

  const response = await fetch(
    `${CH_BASE}${path}`,
    {
      headers: {
        Authorization:
          `Basic ${Buffer.from(
            `${COMPANIES_HOUSE_API_KEY}:`
          ).toString("base64")}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Companies House returned HTTP ${response.status}`
    );
  }

  return response.json();
}

function companyResult(
  data,
  appointment,
  scraped = {}
) {
  const sicCodes = data?.sic_codes || [];

  const compWebsite =
    scraped.website ||
    data?.website ||
    null;

  const compNumber =
    appointment?.appointed_to?.company_number ||
    data?.company_number ||
    "";

  const chCompanyUrl = compNumber
    ? `https://find-and-update.company-information.service.gov.uk/company/${compNumber}`
    : null;

  return {
    companyNumber: compNumber,

    companyName:
      appointment?.appointed_to?.company_name ||
      data?.company_name ||
      "Unknown",

    companyStatus:
      appointment?.appointed_to?.company_status ||
      data?.company_status ||
      null,

    companyType:
      data?.type ||
      null,

    sicCodes,

    role:
      appointment?.officer_role ||
      "director",

    appointedOn:
      appointment?.appointed_on ||
      null,

    resignedOn:
      appointment?.resigned_on ||
      null,

    registeredAddress:
      address(
        data?.registered_office_address ||
        appointment?.address
      ),

    incorporatedOn:
      data?.date_of_creation ||
      null,

    website: compWebsite,

    websiteIsReal:
      !!scraped.website,

    email:
      scraped.email ||
      null,

    phone:
      scraped.phone ||
      null,

    emailSource:
      scraped.emailSource ||
      null,

    emailConfidence:
      scraped.emailConfidence ||
      null,

    emailScore:
      scraped.emailScore ||
      null,

    chCompanyUrl,

    isActive:
      !appointment?.resigned_on &&
      (
        appointment?.appointed_to?.company_status ||
        data?.company_status ||
        "active"
      ) !== "dissolved"
  };
}

async function getOfficer(officerId) {
  const data = await companiesHouse(
    `/officers/${encodeURIComponent(
      officerId
    )}/appointments?items_per_page=50`
  );

  if (!data) {
    return null;
  }

  const first = data.items?.[0];

  return {
    name: data.name || "",

    dateOfBirth:
      data.date_of_birth,

    nationality:
      first?.nationality ||
      null,

    occupation:
      first?.occupation ||
      null,

    address:
      address(first?.address),

    appointments:
      data.items ||
      []
  };
}

async function getAllOfficerIds(officer) {
  const data = await companiesHouse(
    `/search/officers?q=${encodeURIComponent(
      officer.name
    )}&items_per_page=50`
  );

  const ids = new Set();

  for (const item of data?.items || []) {
    if (
      !samePerson(
        officer.name,
        officer.dateOfBirth,
        item.title || item.name,
        item.date_of_birth
      )
    ) {
      continue;
    }

    const match =
      item.links?.self?.match(
        /\/officers\/([^/]+)/
      );

    if (match) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

async function getCompanies(
  officerIds,
  officerName = ""
) {
  const appointments = [];
  const seen = new Set();

  for (const id of officerIds) {
    const data = await companiesHouse(
      `/officers/${encodeURIComponent(
        id
      )}/appointments?items_per_page=50`
    );

    for (const item of data?.items || []) {
      const key =
        `${item.appointed_to?.company_number}|` +
        `${item.officer_role}|` +
        `${item.appointed_on || ""}`;

      if (!seen.has(key)) {
        seen.add(key);
        appointments.push(item);
      }
    }
  }

  appointments.sort(
    (a, b) =>
      Number(!b.resigned_on) -
        Number(!a.resigned_on) ||
      String(
        b.appointed_on || ""
      ).localeCompare(
        String(a.appointed_on || "")
      )
  );

  const companies = [];

  /*
   * WEBSITE SEARCH FIRST
   *
   * Absolutely no Hunter calls happen while this section
   * is discovering websites and scraping contact pages.
   */
  for (
    let i = 0;
    i < appointments.length;
    i += 5
  ) {
    const batch = appointments.slice(
      i,
      i + 5
    );

    const results = await Promise.all(
      batch.map(
        async (appointment) => {
          const number =
            appointment.appointed_to
              ?.company_number;

          const data = number
            ? await companiesHouse(
                `/company/${number}`
              ).catch(() => null)
            : null;

          const compName =
            appointment?.appointed_to
              ?.company_name ||
            data?.company_name ||
            "";

          const isActive =
            !appointment?.resigned_on &&
            (
              appointment?.appointed_to
                ?.company_status ||
              data?.company_status ||
              "active"
            ) !== "dissolved";

          let scraped = {};

          if (isActive && compName) {
            try {
              /*
               * STEP 1
               * Use the website already held by Companies House.
               */
              const knownWebsite =
                normaliseWebsiteUrl(
                  data?.website?.url ||
                  data?.website
                );

              if (knownWebsite) {
                const contacts =
                  await extractContactFromWebsite(
                    knownWebsite
                  );

                scraped = {
                  website:
                    knownWebsite,

                  email:
                    contacts.email,

                  phone:
                    contacts.phone,

                  emailSource:
                    contacts.email
                      ? "Website Scraping"
                      : null,

                  emailConfidence:
                    contacts.email
                      ? "high"
                      : null,

                  emailScore:
                    null
                };
              }

              /*
               * STEP 2
               * If Companies House gave us a website but that
               * website had no email, try to discover the website
               * from the company name.
               *
               * Still no Hunter calls here.
               */
              if (!scraped.email) {
                const foundWebsite =
                  await tryFindWebsiteByDomain(
                    compName
                  );

                if (
                  foundWebsite &&
                  foundWebsite !==
                    scraped.website
                ) {
                  const contacts =
                    await extractContactFromWebsite(
                      foundWebsite
                    );

                  scraped = {
                    website:
                      foundWebsite,

                    email:
                      contacts.email,

                    phone:
                      contacts.phone,

                    emailSource:
                      contacts.email
                        ? "Website Scraping"
                        : null,

                    emailConfidence:
                      contacts.email
                        ? "high"
                        : null,

                    emailScore:
                      null
                  };
                }
              }
            } catch (e) {
              /*
               * Website errors must never stop the rest of
               * the company/director search.
               */
            }
          }

          return companyResult(
            data,
            appointment,
            scraped
          );
        }
      )
    );

    companies.push(...results);

    if (
      i + 5 <
      appointments.length
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 150)
      );
    }
  }

  /*
   * WEBSITE SEARCH IS NOW COMPLETE.
   *
   * Only now do we allow Hunter to be used.
   */
  if (
    officerName &&
    HUNTER_FALLBACK_MAX_LOOKUPS > 0
  ) {
    await enrichMissingEmailsWithHunter(
      officerName,
      companies
    );
  }

  return companies;
}

function contactLeads(
  officer,
  companies,
  officerId
) {
  const emailLeads = [];
  const phoneLeads = [];
  const addressLeads = [];

  const emails = new Set();
  const phones = new Set();
  const addresses = new Set();

  for (const company of companies) {
    /*
     * EMAIL
     */
    if (
      company.email &&
      !emails.has(company.email)
    ) {
      emails.add(company.email);

      emailLeads.push({
        email:
          company.email,

        source:
          company.emailSource ||
          "Website Scraping",

        companyName:
          company.companyName,

        website:
          company.website,

        confidence:
          company.emailConfidence ||
          "high",

        score:
          company.emailScore ||
          null
      });
    }

    /*
     * PHONE
     */
    if (
      company.phone &&
      !phones.has(company.phone)
    ) {
      phones.add(company.phone);

      phoneLeads.push({
        phone:
          company.phone,

        source:
          "Website Scraping",

        companyName:
          company.companyName,

        website:
          company.website,

        confidence:
          "high"
      });
    }

    /*
     * REGISTERED ADDRESS
     */
    const key =
      `${company.registeredAddress.postalCode}|` +
      `${company.registeredAddress.addressLine1}`;

    if (
      key !== "|" &&
      !addresses.has(key)
    ) {
      addresses.add(key);

      addressLeads.push({
        address:
          company.registeredAddress,

        source:
          "Registered Office",

        companyName:
          company.companyName
      });
    }
  }

  const {
    firstName,
    lastName
  } = nameParts(officer.name);

  const searches = [];

  const salesNav = (keywords) =>
    `https://www.linkedin.com/sales/search/people?keywords=${encodeURIComponent(
      keywords
    )}&geoIncluded=101165590`;

  const shortName =
    `${firstName} ${lastName}`.trim();

  /*
   * Basic LinkedIn search
   */
  searches.push({
    searchUrl:
      salesNav(shortName),

    searchLabel:
      shortName,

    reasoning:
      "Name-only search. Add location and industry filters inside Sales Navigator.",

    confidence:
      "low",

    derivedFrom:
      "Director name"
  });

  /*
   * More targeted LinkedIn searches
   */
  for (
    const company of companies
      .filter(
        (item) => item.isActive
      )
      .slice(0, 3)
  ) {
    const pCode =
      company.registeredAddress
        ?.postalCode ||
      "";

    const searchKeywords =
      pCode
        ? `${shortName} ${pCode}`
        : `${shortName} ${company.companyName}`;

    searches.push({
      searchUrl:
        salesNav(searchKeywords),

      searchLabel:
        `${shortName} (${pCode || company.companyName})`,

      reasoning:
        `Searches director with postcode ${
          pCode || "N/A"
        } for precise location matching.`,

      confidence:
        "high",

      derivedFrom:
        `Active company: ${company.companyName} | Postcode: ${pCode}`
    });
  }

  const chAppointmentsUrl =
    `https://find-and-update.company-information.service.gov.uk/officers/${encodeURIComponent(
      officerId
    )}/appointments`;

  return {
    chAppointmentsUrl,

    linkedinSearchUrls:
      searches,

    emailLeads,

    phoneLeads,

    addressLeads,

    summary:
      emailLeads.length ||
      phoneLeads.length
        ? `Found ${emailLeads.length} email(s) and ${phoneLeads.length} phone number(s).`
        : `No direct contact details found for ${officer.name}. LinkedIn searches generated as backup.`
  };
}

// =============================================================================
// Hunter.io
// WEBSITE FIRST -> SMALL HUNTER FALLBACK
// =============================================================================

/*
 * Cache successful and unsuccessful Hunter lookups for 24 hours.
 *
 * This means refreshing/repeating the same director search does not
 * repeatedly make the exact same Hunter request.
 */
const hunterCache = new Map();

const CACHE_TTL =
  24 * 60 * 60 * 1000;

function hunterDomainFromWebsite(
  website
) {
  const normalised =
    normaliseWebsiteUrl(
      website
    );

  if (!normalised) {
    return null;
  }

  try {
    return new URL(
      normalised
    ).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

async function hunterCallDomain(
  domain,
  firstName,
  lastName
) {
  if (
    !HUNTER_API_KEY ||
    !domain ||
    !firstName ||
    !lastName
  ) {
    return null;
  }

  const cleanDomain =
    String(domain)
      .trim()
      .toLowerCase();

  const cacheKey =
    `${cleanDomain}|` +
    `${firstName.toLowerCase()}|` +
    `${lastName.toLowerCase()}`;

  /*
   * Check cache before using Hunter.
   */
  const cached =
    hunterCache.get(
      cacheKey
    );

  if (
    cached &&
    Date.now() -
      cached.timestamp <
      CACHE_TTL
  ) {
    return cached.data;
  }

  const params =
    new URLSearchParams({
      first_name:
        firstName,

      last_name:
        lastName,

      domain:
        cleanDomain
    });

  try {
    const response =
      await fetch(
        `${HUNTER_BASE}/email-finder?${params}`,
        {
          signal:
            AbortSignal.timeout(
              10000
            ),

          headers: {
            Accept:
              "application/json",

            "X-API-KEY":
              HUNTER_API_KEY
          }
        }
      );

    let data = null;

    try {
      data =
        await response.json();
    } catch {
      data = null;
    }

    /*
     * Hunter returned an error.
     */
    if (!response.ok) {
      const hunterError =
        data?.errors?.[0]?.details ||
        data?.errors?.[0]?.code ||
        `HTTP ${response.status}`;

      console.warn(
        `Hunter.io lookup failed for ${cleanDomain}: ${hunterError}`
      );

      /*
       * Do not cache authentication errors for 24 hours.
       * Otherwise fixing the key would still look broken until
       * the cache expired.
       */
      const cacheableFailure =
        response.status !== 401 &&
        response.status !== 403;

      if (cacheableFailure) {
        hunterCache.set(
          cacheKey,
          {
            timestamp:
              Date.now(),

            data:
              null
          }
        );
      }

      return null;
    }

    const score =
      Number(
        data?.data?.score || 0
      );

    const email =
      String(
        data?.data?.email || ""
      )
        .trim()
        .toLowerCase();

    /*
     * Ignore weak/invalid Hunter results.
     */
    if (
      !email ||
      score <
        HUNTER_MIN_SCORE ||
      !isValidEmail(email)
    ) {
      hunterCache.set(
        cacheKey,
        {
          timestamp:
            Date.now(),

          data:
            null
        }
      );

      return null;
    }

    const result = {
      email,

      score,

      confidence:
        score >= 80
          ? "high"
          : "medium"
    };

    /*
     * Cache good result.
     */
    hunterCache.set(
      cacheKey,
      {
        timestamp:
          Date.now(),

        data:
          result
      }
    );

    return result;
  } catch (error) {
    console.warn(
      `Hunter.io request error for ${cleanDomain}: ${error.message}`
    );

    return null;
  }
}

async function hunterEmail(
  directorName,
  website,
  companyName
) {
  if (!HUNTER_API_KEY) {
    return null;
  }

  const {
    firstName,
    lastName
  } = nameParts(
    directorName
  );

  if (
    !firstName ||
    !lastName
  ) {
    return null;
  }

  /*
   * CASE 1:
   * A real website was found.
   *
   * Use that exact domain in Hunter.
   */
  if (website) {
    const domain =
      hunterDomainFromWebsite(
        website
      );

    if (!domain) {
      return null;
    }

    const result =
      await hunterCallDomain(
        domain,
        firstName,
        lastName
      );

    if (!result) {
      return null;
    }

    return {
      email:
        result.email,

      source:
        "Hunter.io Email Finder",

      companyName,

      website:
        normaliseWebsiteUrl(
          website
        ),

      confidence:
        result.confidence,

      score:
        result.score
    };
  }

  /*
   * CASE 2:
   * No website was found.
   *
   * To keep Hunter usage tiny, we only test ONE guessed domain.
   *
   * We do NOT cycle through all .co.uk/.com/.io/etc candidates.
   */
  const candidate =
    generateDomainCandidates(
      companyName
    )[0];

  if (!candidate) {
    return null;
  }

  const result =
    await hunterCallDomain(
      candidate,
      firstName,
      lastName
    );

  if (!result) {
    return null;
  }

  return {
    email:
      result.email,

    source:
      "Hunter.io Email Finder (domain guessed)",

    companyName,

    website:
      `https://www.${candidate}`,

    confidence:
      result.confidence,

    score:
      result.score
  };
}

async function enrichMissingEmailsWithHunter(
  directorName,
  companies
) {
  /*
   * Hunter completely disabled.
   */
  if (
    !HUNTER_API_KEY ||
    HUNTER_FALLBACK_MAX_LOOKUPS <= 0
  ) {
    return [];
  }

  let lookupsUsed = 0;
  const hunterLeads = [];

  /*
   * ONLY ACTIVE COMPANIES WITH NO WEBSITE EMAIL
   * ARE ELIGIBLE FOR HUNTER.
   */
  const eligible =
    companies
      .filter(
        (company) =>
          company.isActive &&
          !company.email
      )
      .slice(
        0,
        HUNTER_FALLBACK_MAX_LOOKUPS
      );

  for (
    const company of eligible
  ) {
    if (
      lookupsUsed >=
      HUNTER_FALLBACK_MAX_LOOKUPS
    ) {
      break;
    }

    /*
     * ONE Hunter API call for this company.
     */
    const result =
      await hunterEmail(
        directorName,
        company.website,
        company.companyName
      );

    lookupsUsed += 1;

    if (result) {
      /*
       * Put the Hunter result directly onto the company.
       */
      company.email =
        result.email;

      company.emailSource =
        result.source;

      company.emailConfidence =
        result.confidence;

      company.emailScore =
        result.score;

      hunterLeads.push(
        result
      );

      /*
       * IMPORTANT:
       *
       * STOP immediately after the first good Hunter result.
       *
       * This prevents unnecessary Hunter usage.
       */
      break;
    }

    /*
     * Small pause between Hunter calls.
     */
    if (
      lookupsUsed <
      HUNTER_FALLBACK_MAX_LOOKUPS
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            HUNTER_FALLBACK_DELAY_MS
          )
      );
    }
  }

  return hunterLeads;
}

async function profile(
  officerId
) {
  const officer =
    await getOfficer(
      officerId
    );

  if (!officer) {
    return null;
  }

  const ids =
    await getAllOfficerIds(
      officer
    );

  if (
    !ids.includes(
      officerId
    )
  ) {
    ids.unshift(
      officerId
    );
  }

  /*
   * getCompanies performs all website searches first
   * and only then performs the small Hunter fallback.
   */
  const companies =
    await getCompanies(
      ids,
      officer.name
    );

  return {
    officerId,

    name:
      officer.name,

    title:
      null,

    dateOfBirth:
      officer.dateOfBirth
        ? dobKey(
            officer.dateOfBirth
          )
        : null,

    nationality:
      officer.nationality,

    occupation:
      officer.occupation,

    address:
      officer.address,

    companies,

    contactLeads:
      contactLeads(
        officer,
        companies,
        officerId
      )
  };
}

function asyncRoute(
  handler
) {
  return (
    req,
    res
  ) =>
    Promise
      .resolve(
        handler(
          req,
          res
        )
      )
      .catch(
        (error) => {
          console.error(
            error.message
          );

          if (
            !res.headersSent
          ) {
            res
              .status(500)
              .json({
                error:
                  "Request failed"
              });
          }
        }
      );
}

// =============================================================================
// API Routes
// =============================================================================

app.get(
  "/api/healthz",
  (_req, res) =>
    res.json({
      status:
        "ok"
    })
);

app.get(
  "/api/directors/search",
  asyncRoute(
    async (
      req,
      res
    ) => {
      const query =
        String(
          req.query.q ||
            ""
        ).trim();

      if (!query) {
        return res
          .status(400)
          .json({
            error:
              "Query parameter q is required"
          });
      }

      const data =
        await companiesHouse(
          `/search/officers?q=${encodeURIComponent(
            query
          )}&items_per_page=50`
        );

      const seen =
        new Map();

      for (
        const item of
          data?.items || []
      ) {
        const match =
          item.links?.self?.match(
            /\/officers\/([^/]+)/
          );

        const name =
          item.title ||
          item.name ||
          "";

        if (
          !match ||
          !name
        ) {
          continue;
        }

        const key =
          `${nameParts(name).firstName.toLowerCase()}|` +
          `${nameParts(name).lastName.toLowerCase()}|` +
          `${dobKey(item.date_of_birth)}`;

        const current =
          seen.get(key);

        const result = {
          officerId:
            match[1],

          name,

          title:
            item.officer_role ||
            null,

          dateOfBirth:
            item.date_of_birth
              ? dobKey(
                  item.date_of_birth
                )
              : null,

          nationality:
            item.nationality ||
            null,

          occupation:
            item.occupation ||
            null,

          address:
            address(
              item.address
            ),

          appointedBefore:
            null,

          totalAppointments:
            item.appointment_count ||
            0
        };

        if (
          !current ||
          result.totalAppointments >
            current.totalAppointments
        ) {
          seen.set(
            key,
            result
          );
        }
      }

      res.json(
        [...seen.values()]
      );
    }
  )
);

app.get(
  "/api/directors/:officerId/profile",
  asyncRoute(
    async (
      req,
      res
    ) => {
      const result =
        await profile(
          req.params.officerId
        );

      if (!result) {
        return res
          .status(404)
          .json({
            error:
              "Director not found"
          });
      }

      res.json(
        result
      );
    }
  )
);

app.get(
  "/api/directors/:officerId/companies",
  asyncRoute(
    async (
      req,
      res
    ) => {
      const result =
        await profile(
          req.params.officerId
        );

      if (!result) {
        return res
          .status(404)
          .json({
            error:
              "Director not found"
          });
      }

      res.json(
        result.companies
      );
    }
  )
);

app.get(
  "/api/directors/:officerId/contact-leads",
  asyncRoute(
    async (
      req,
      res
    ) => {
      const result =
        await profile(
          req.params.officerId
        );

      if (!result) {
        return res
          .status(404)
          .json({
            error:
              "Director not found"
          });
      }

      res.json(
        result.contactLeads
      );
    }
  )
);

app.get(
  "/api/companies/:companyNumber",
  asyncRoute(
    async (
      req,
      res
    ) => {
      const data =
        await companiesHouse(
          `/company/${encodeURIComponent(
            req.params.companyNumber
          )}`
        );

      if (!data) {
        return res
          .status(404)
          .json({
            error:
              "Company not found"
          });
      }

      res.json(
        companyResult(
          data
        )
      );
    }
  )
);

/*
 * Manual Hunter endpoint.
 *
 * This still has the same protections:
 * - only companies without an email
 * - hard lookup cap
 * - one result is enough
 */
app.post(
  "/api/directors/:officerId/hunter-emails",
  asyncRoute(
    async (
      req,
      res
    ) => {
      const officer =
        await getOfficer(
          req.params.officerId
        );

      if (!officer) {
        return res
          .status(404)
          .json({
            error:
              "Director not found"
          });
      }

      const companies =
        Array.isArray(
          req.body?.companies
        )
          ? req.body.companies
          : [];

      const emailLeads =
        [];

      let lookupsUsed =
        0;

      /*
       * Hunter not configured.
       */
      if (!HUNTER_API_KEY) {
        return res.json({
          emailLeads,

          hunterEnabled:
            false,

          lookupsUsed:
            0,

          maxLookups:
            HUNTER_FALLBACK_MAX_LOOKUPS
        });
      }

      /*
       * Only companies without existing emails are eligible.
       */
      const eligible =
        companies
          .filter(
            (company) =>
              !company.email
          )
          .slice(
            0,
            HUNTER_FALLBACK_MAX_LOOKUPS
          );

      for (
        const company of
          eligible
      ) {
        if (
          lookupsUsed >=
          HUNTER_FALLBACK_MAX_LOOKUPS
        ) {
          break;
        }

        const result =
          await hunterEmail(
            officer.name,
            company.website,
            company.companyName
          );

        lookupsUsed += 1;

        if (result) {
          emailLeads.push(
            result
          );

          /*
           * Stop after first successful result.
           */
          break;
        }

        if (
          lookupsUsed <
          HUNTER_FALLBACK_MAX_LOOKUPS
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                HUNTER_FALLBACK_DELAY_MS
              )
          );
        }
      }

      res.json({
        emailLeads,

        hunterEnabled:
          true,

        lookupsUsed,

        maxLookups:
          HUNTER_FALLBACK_MAX_LOOKUPS
      });
    }
  )
);

/*
 * Serve the frontend.
 */
app.get(
  "*",
  (_req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/*
 * Start server.
 */
app.listen(
  PORT,
  () => {
    console.log(
      `Director Finder API running at http://localhost:${PORT}`
    );

    if (
      !COMPANIES_HOUSE_API_KEY
    ) {
      console.warn(
        "Warning: COMPANIES_HOUSE_API_KEY is not set"
      );
    }

    if (
      !HUNTER_API_KEY
    ) {
      console.warn(
        "Warning: HUNTER_API_KEY is not set"
      );
    }

    console.log(
      `Hunter fallback: ${
        HUNTER_API_KEY
          ? "enabled"
          : "disabled"
      } | max lookups/director: ${
        HUNTER_FALLBACK_MAX_LOOKUPS
      } | minimum score: ${
        HUNTER_MIN_SCORE
      }`
    );
  }
);
