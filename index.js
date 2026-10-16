"use strict";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");

puppeteer.use(StealthPlugin());

const IG_APP_ID = "936619743392459";

const CONFIG = {
  HEADLESS: false,
  EXECUTABLE_PATH: null, // set "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" nếu cần
  // argv[7] = "640,720" (window size), argv[8] = "0,0" (window position)
  WINDOW_SIZE: process.argv[7] || "640,720",
  WINDOW_POSITION: process.argv[8] || "0,0",
  BROWSER_ARGS: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    `--window-size=${process.argv[7] || "640,720"}`,
    `--window-position=${process.argv[8] || "0,0"}`,
    "--lang=en-US",
  ],
  FILES: {
    IG: process.argv[2] || "ig.txt",
    META: process.argv[3] || "meta.txt",
    OUTPUT: process.argv[4] || "result.txt",
    IG_FAIL: process.argv[5] || "ig_fail.txt",
    META_FAIL: process.argv[6] || "meta_fail.txt",
    ALREADY: process.argv[9] || "already_added.txt",
  },
  DELAYS: {
    SHORT: 1000,
    MEDIUM: 2000,
    LONG: 3000,
    PAGE_LOAD: 4000,
    MONITOR_INTERVAL: 1500,
    META_RULES_DURATION: 50000,
  },
};

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(msg) {
  const ts = new Date().toLocaleTimeString("vi-VN");
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════
// PARSE INPUT FILES
// ═══════════════════════════════════════════════════════════════════
function parseIGLine(line) {
  const jsonStart = line.indexOf("[{");
  if (jsonStart === -1) return null;
  const beforeCookie = line.substring(0, jsonStart).replace(/\|$/, "");
  const cookieJson = line.substring(jsonStart);
  const parts = beforeCookie.split("|");
  if (parts.length < 7) return null;
  let cookies;
  try {
    cookies = JSON.parse(cookieJson);
  } catch {
    return null;
  }
  return {
    username: parts[0],
    password: parts[1],
    twofa: parts[2],
    posts: parts[3],
    followers: parts[4],
    following: parts[5],
    yopmail: parts[6],
    cookies,
    raw: line,
  };
}

function parseMetaLine(line) {
  const parts = line.split("|");
  if (parts.length < 7) return null;
  return {
    hotmail: parts[0],
    passhot: parts[1],
    refresh_token: parts[2],
    client_id: parts[3],
    mail_recovery: parts[4],
    name: parts[5],
    cookieStr: parts.slice(6).join("|").trim(),
    raw: line,
  };
}

// ═══════════════════════════════════════════════════════════════════
// COOKIE CONVERSION
// ═══════════════════════════════════════════════════════════════════
const SAME_SITE_MAP = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
  unspecified: "Lax",
};

function igCookiesToPuppeteer(cookies) {
  return cookies
    .filter((c) => c && c.name && c.value !== undefined)
    .map((c) => {
      const out = {
        name: c.name,
        value: String(c.value),
        domain: c.domain || ".instagram.com",
        path: c.path || "/",
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
      };
      if (c.expirationDate && isFinite(c.expirationDate))
        out.expires = Math.floor(c.expirationDate);
      if (c.sameSite)
        out.sameSite = SAME_SITE_MAP[String(c.sameSite).toLowerCase()] || "Lax";
      return out;
    });
}

function metaCookieStrToPuppeteer(cookieStr, domain) {
  return cookieStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) return null;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
      };
    })
    .filter(Boolean);
}

function buildCookieStr(cookies) {
  const ORDER = [
    "datr",
    "ig_did",
    "mid",
    "csrftoken",
    "ds_user_id",
    "sessionid",
    "rur",
  ];
  return [...cookies]
    .sort((a, b) => {
      const ia = ORDER.indexOf(a.name),
        ib = ORDER.indexOf(b.name);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
async function safeGoto(page, url, opts = {}) {
  const merged = { waitUntil: "domcontentloaded", timeout: 30000, ...opts };
  try {
    await page.goto(url, merged);
  } catch (e) {
    const ignorable =
      e.message.includes("ERR_ABORTED") ||
      e.message.includes("net::ERR_") ||
      e.message.includes("Navigation timeout");
    if (!ignorable) throw e;
    log.warn(`safeGoto ignored: ${e.message}`);
  }
  await delay(500);
}
// ═══════════════════════════════════════════════════════════════════
// CLICK HELPERS
// ═══════════════════════════════════════════════════════════════════
async function clickButtonInPage(page, ...texts) {
  return page
    .evaluate((textsArr) => {
      for (const text of textsArr) {
        const spans = [...document.querySelectorAll("span, div")].filter(
          (s) =>
            s.textContent.trim() === text &&
            !s.closest('[aria-hidden="true"]') &&
            !s.querySelector("span, div"),
        );
        for (const span of spans) {
          let p = span.parentElement;
          while (p && p !== document.body) {
            const role = p.getAttribute("role");
            if (
              (role === "button" ||
                role === "none" ||
                role === "presentation") &&
              p.getBoundingClientRect().width > 0
            ) {
              p.scrollIntoView({ block: "center", behavior: "instant" });
              p.click();
              return text;
            }
            p = p.parentElement;
          }
        }
      }
      const candidates = [
        ...document.querySelectorAll('[role="button"]'),
        ...document.querySelectorAll("button"),
      ];
      for (const el of candidates) {
        const txt = (el.innerText || "").trim();
        for (const text of textsArr) {
          if (txt === text) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              el.scrollIntoView({ block: "center", behavior: "instant" });
              el.click();
              return text;
            }
          }
        }
      }
      return null;
    }, texts)
    .catch(() => null);
}

async function clickAriaLabelInPage(page, ...labels) {
  return page
    .evaluate((labelsArr) => {
      for (const label of labelsArr) {
        const el = [...document.querySelectorAll("a[aria-label]")].find((e) =>
          e.getAttribute("aria-label")?.startsWith(label),
        );
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          return label;
        }
      }
      return null;
    }, labels)
    .catch(() => null);
}

// ═══════════════════════════════════════════════════════════════════
// IG MONITOR — die detection + URL handlers
// ═══════════════════════════════════════════════════════════════════

// IG die errors — throw with prefix so main knows it's IG's fault
class IGDieError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "IGDieError";
  }
}

async function selectAge18(page) {
  try {
    if (!(await page.$("#IGDSRadioButtonabove_18"))) return false;

    await page.evaluate(() => {
      const r = document.getElementById("IGDSRadioButtonabove_18");
      if (!r) return;
      const btn = r.closest('[role="button"]');
      if (btn) {
        btn.click();
        return;
      }
      r.checked = true;
      ["click", "change", "input"].forEach((e) =>
        r.dispatchEvent(new Event(e, { bubbles: true })),
      );
    });

    await page
      .waitForFunction(
        () => {
          const r = document.getElementById("IGDSRadioButtonabove_18");
          return r && r.getAttribute("aria-checked") === "true";
        },
        { timeout: 3000 },
      )
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function igMonitorLoop(page, maxMs = 60000) {
  const start = Date.now();
  let lastUrl = "";
  while (Date.now() - start < maxMs) {
    await sleep(CONFIG.DELAYS.MONITOR_INTERVAL);
    const url = page.url();

    // ── IG die ──
    if (url.includes("no_challenge")) throw new IGDieError("no_challenge");
    if (url.includes("accounts/login/"))
      throw new IGDieError("Not registered successfully");
    if (url.includes("lrr_limbo")) throw new IGDieError("lrr_limbo");
    if (url.includes("afad")) throw new IGDieError("afad");
    if (url.includes("auth_platform/challengepicker"))
      throw new IGDieError("challengepicker");
    if (url.includes("/accounts/suspended/"))
      throw new IGDieError("account_suspended");

    if (url === lastUrl) continue;
    log(`IG monitor: ${url.substring(0, 80)}`);

    if (url.includes("/terms/unblock/")) {
      log("IG: terms → Next → Agree");
      await selectAge18(page);
      await sleep(CONFIG.DELAYS.MEDIUM);
      await clickButtonInPage(page, "Next");
      await sleep(CONFIG.DELAYS.MEDIUM);
      await clickButtonInPage(page, "Agree to Terms", "I agree", "Agree");
      await sleep(CONFIG.DELAYS.LONG);
      if (
        url.includes("chrome-error://") ||
        url.includes("chromewebdata/") ||
        url.includes("/api/v1/")
      ) {
        await safeGoto(page, `https://www.instagram.com/`);
        await sleep(CONFIG.DELAYS.MEDIUM);
        return;
      }

      if (
        url.includes("ig_sso_users") ||
        url === "https://www.instagram.com/" ||
        url === "https://www.instagram.com" ||
        url.includes(`instagram.com/${username}`)
      ) {
        await safeGoto(page, `https://www.instagram.com/`);
        await sleep(CONFIG.DELAYS.MEDIUM);
        return;
      }
      lastUrl = url;
      continue;
    }

    if (
      url.includes("chrome-error://") ||
      url.includes("chromewebdata/") ||
      url.includes("/api/v1/") ||
      url.includes("discover/ayml")
    ) {
      await safeGoto(page, `https://www.instagram.com/`);
      await sleep(CONFIG.DELAYS.MEDIUM);
      lastUrl = "";
      continue;
    }

    if (url.includes("consent")) {
      log("IG: consent → Allow all cookies");
      await clickButtonInPage(
        page,
        "Allow all cookies",
        "Allow essential and optional cookies",
        "Allow all",
      );
      await sleep(CONFIG.DELAYS.LONG);
      lastUrl = "";
      continue;
    }
    if (url.includes("challenge/?next=")) {
      log("IG: challenge → Continue");
      await clickButtonInPage(page, "Continue", "Submit");
      await sleep(CONFIG.DELAYS.LONG);
      lastUrl = url;
      continue;
    }
    if (url.includes("/accounts/scraping_warning")) {
      log("IG: scraping → Dismiss");
      await clickButtonInPage(page, "Dismiss", "OK", "Got it");
      await sleep(CONFIG.DELAYS.LONG);
      lastUrl = "";
      continue;
    }
    if (url.includes("onetap") || url.includes("__coig_challenged")) {
      log("IG: onetap → Not now");
      await clickButtonInPage(page, "Not now", "Not Now");
      await sleep(CONFIG.DELAYS.LONG);
      lastUrl = "";
      continue;
    }

    // Homepage OK
    if (
      url === "https://www.instagram.com/" ||
      url === "https://www.instagram.com" ||
      url.startsWith("https://www.instagram.com/?")
    ) {
      const cookies = await page.cookies("https://www.instagram.com");
      const loggedIn = cookies.some((c) => c.name === "sessionid" && c.value);
      if (loggedIn) {
        log("IG: homepage OK ✅");
        return true;
      }
    }
    lastUrl = url;
  }
  throw new IGDieError("IG monitor timeout");
}

// ═══════════════════════════════════════════════════════════════════
// META COOKIE CONSENT
// ═══════════════════════════════════════════════════════════════════
async function handleMetaCookieConsent(page) {
  const url = page.url();
  if (
    !url.includes("auth.meta.com") &&
    !url.includes("consent") &&
    !url.includes("cookie_choice")
  )
    return false;
  log("META: cookie consent → Allow all cookies");
  await sleep(2000);
  const clicked = await page
    .evaluate(() => {
      for (const el of [
        ...document.querySelectorAll('[role="none"]'),
        ...document.querySelectorAll('[role="button"]'),
        ...document.querySelectorAll("button"),
      ]) {
        const txt = (el.innerText || "").trim();
        if (txt.includes("Allow all cookies")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            el.scrollIntoView({ block: "center", behavior: "instant" });
            el.click();
            return true;
          }
        }
      }
      return false;
    })
    .catch(() => false);
  if (clicked) {
    log("META: clicked Allow all cookies");
    await sleep(4000);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// IG ACCOUNT CENTER CLICKS
// ═══════════════════════════════════════════════════════════════════
async function clickAddProfilesAndDevices(page) {
  log("IG AC: looking for 'Add profiles and devices'...");
  for (let i = 0; i < 8; i++) {
    const clicked = await page
      .evaluate(() => {
        const TEXTS = [
          "Add profiles and devices",
          "Add accounts and profiles",
          "Add accounts",
        ];
        for (const el of document.querySelectorAll('[role="button"]')) {
          const txt = (el.innerText || "").trim();
          for (const t of TEXTS) {
            if (txt === t || txt.includes(t)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.height < 200) {
                el.scrollIntoView({ block: "center", behavior: "instant" });
                el.click();
                return t;
              }
            }
          }
        }
        return null;
      })
      .catch(() => null);
    if (clicked) {
      log(`IG AC: clicked "${clicked}"`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function clickAddAIDevicesAndMore(page) {
  log("IG AC: looking for 'Add AI, devices and more'...");
  for (let i = 0; i < 8; i++) {
    const clicked = await clickAriaLabelInPage(
      page,
      "Add AI, devices and more",
      "AI, devices and more",
    );
    if (clicked) {
      log(`IG AC: clicked aria "${clicked}"`);
      return true;
    }
    const clickedText = await page
      .evaluate(() => {
        for (const el of document.querySelectorAll(
          'a[href*="fxauth"], a[href*="auth.meta.com"]',
        )) {
          const txt = (el.innerText || "").trim();
          if (txt.includes("AI, devices and more") || txt.includes("Add AI")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              el.scrollIntoView({ block: "center", behavior: "instant" });
              el.click();
              return txt;
            }
          }
        }
        return null;
      })
      .catch(() => null);
    if (clickedText) {
      log(`IG AC: clicked "${clickedText}"`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// META ACCOUNT CENTER: click "Add accounts" (reverse flow)
// ═══════════════════════════════════════════════════════════════════
async function clickAddAccountsMeta(page) {
  log("META AC: looking for 'Add accounts'...");
  for (let i = 0; i < 8; i++) {
    const clicked = await page
      .evaluate(() => {
        const TEXTS = [
          "Add accounts",
          "Add profiles and devices",
          "Add accounts and profiles",
        ];
        for (const el of [
          ...document.querySelectorAll('[role="button"]'),
          ...document.querySelectorAll('[role="presentation"]'),
        ]) {
          const txt = (el.innerText || "").trim();
          for (const t of TEXTS) {
            if (txt === t || txt.includes(t)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.height < 200) {
                el.scrollIntoView({ block: "center", behavior: "instant" });
                el.click();
                return t;
              }
            }
          }
        }
        return null;
      })
      .catch(() => null);
    if (clicked) {
      log(`META AC: clicked "${clicked}"`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function clickAddInstagramMeta(page) {
  log("META AC: looking for 'Add Instagram'...");
  for (let i = 0; i < 8; i++) {
    const clicked = await clickAriaLabelInPage(page, "Add Instagram");
    if (clicked) {
      log(`META AC: clicked "${clicked}"`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// AUTH.META.COM: "Continue as [name]"
// ═══════════════════════════════════════════════════════════════════
async function clickContinueAsName(page) {
  log("AUTH: looking for 'Continue as ...'...");
  for (let i = 0; i < 10; i++) {
    const url = page.url();
    if (url.includes("consent") || url.includes("cookie_choice")) {
      await handleMetaCookieConsent(page);
      await sleep(2000);
      continue;
    }
    const clicked = await page
      .evaluate(() => {
        for (const el of document.querySelectorAll('[role="button"]')) {
          const txt = (el.innerText || el.textContent || "").trim();
          if (txt.startsWith("Continue as") || txt.startsWith("Log in as")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              el.scrollIntoView({ block: "center", behavior: "instant" });
              el.click();
              return txt;
            }
          }
        }
        return null;
      })
      .catch(() => null);
    if (clicked) {
      log(`AUTH: clicked "${clicked}"`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// META RULES MONITOR — English only
// ═══════════════════════════════════════════════════════════════════
async function runMetaRulesOnce(page) {
  return page
    .evaluate(() => {
      const txt = document.body?.innerText || "";
      const url = location.href;
      function hasAriaLink(l) {
        return !!document.querySelector(`a[aria-label^="${l}"]`);
      }
      function clickAriaLbl(l) {
        const el = [...document.querySelectorAll("a[aria-label]")].find((e) =>
          e.getAttribute("aria-label")?.startsWith(l),
        );
        if (!el) return false;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        return true;
      }
      function clickBtn(...texts) {
        for (const text of texts) {
          for (const span of [...document.querySelectorAll("span, div")].filter(
            (s) =>
              s.textContent.trim() === text &&
              !s.closest('[aria-hidden="true"]') &&
              !s.querySelector("span, div"),
          )) {
            let p = span.parentElement;
            while (p && p !== document.body) {
              const role = p.getAttribute("role");
              if (
                (role === "none" ||
                  role === "presentation" ||
                  role === "button") &&
                p.getBoundingClientRect().width > 0
              ) {
                p.scrollIntoView({ block: "center", behavior: "instant" });
                p.click();
                return true;
              }
              p = p.parentElement;
            }
          }
        }
        return false;
      }

      // Something went wrong
      if (txt.includes("Something went wrong")) return "something_wrong";

      // 1. Add profiles → Confirm + Continue
      if (
        txt.includes("Add your profiles and tools to the same Meta Account") ||
        txt.includes("Finish adding your profiles and tools?") ||
        txt.includes("Finish adding to your Meta Account?") ||
        txt.includes("Do you want to add your profiles and tools now?")
      ) {
        clickBtn("Confirm");
        clickBtn("Continue");
        return "rule1";
      }
      // Permission allow
      if (
        txt.includes("To add your profiles and tools now") ||
        txt.includes(
          "To finish adding your profiles and tools, allow the following",
        ) ||
        txt.includes(
          "To finish adding to your Meta Account, allow the following",
        ) ||
        txt.includes("To add your profiles and tools, allow the following") ||
        txt.includes("allow the following")
      ) {
        clickBtn(
          "Allow and add now",
          "Allow and finish adding",
          "Allow and finish",
          "Continue",
        );
        return "rule_allow";
      }
      // 2. AI devices → Remove
      if (
        url.includes("/manage") &&
        !url.includes("/remove") &&
        !url.includes("/add") &&
        txt.includes("AI, devices and more") &&
        hasAriaLink("Remove from this Meta Account")
      ) {
        clickAriaLbl("Remove from this Meta Account");
        return "rule2_remove";
      }
      // 2b. Add to this Meta Account
      if (txt.includes("Add to this Meta Account")) {
        clickAriaLbl("Add Instagram");
        return "rule2b";
      }
      // 3. Select account
      if (
        txt.includes("Select the account you want to add") ||
        txt.includes("Select an account to add")
      ) {
        clickAriaLbl("Add Instagram account");
        return "rule3";
      }
      // 4. Add Instagram account link
      if (hasAriaLink("Add Instagram account")) {
        clickAriaLbl("Add Instagram account");
        return "rule4";
      }
      // 5. fxcal
      if (url.includes("/fxcal/auth/login")) {
        clickBtn("Continue");
        return "rule5";
      }
      // 6. Unlock cross-profile
      if (txt.includes("Unlock cross-profile")) {
        clickBtn("Confirm");
        clickBtn("Continue");
        return "rule6";
      }
      // 7. Birthday
      if (
        txt.includes("What's your birthday") ||
        txt.includes("What\u2019s your birthday") ||
        txt.includes("What's your date of birth") ||
        txt.includes("What\u2019s your date of birth") ||
        txt.includes("When is your birthday") ||
        txt.includes("What's your birthday?") ||
        txt.includes("What\u2019s your birthday?")
      ) {
        clickBtn("Continue");
        return "rule7";
      }
      // 7b. Move out
      if (
        document.querySelector('a[aria-label^="Move out of this Meta Account"]')
      ) {
        clickAriaLbl("Move out of this Meta Account");
        return "rule7b";
      }
      // 7c. Sure move
      if (txt.includes("Are you sure you want to move")) {
        clickBtn("Yes, continue");
        return "rule7c";
      }
      // 8. Sure remove
      if (txt.includes("Are you sure you want to remove")) {
        clickBtn("Yes, continue");
        return "rule8";
      }
      // 9. Lose access
      if (txt.includes("You will lose access")) {
        clickBtn("Continue");
        return "rule9";
      }
      // 10. Password page
      if (txt.includes("Move your Meta tools to a new Meta Account"))
        return "rule10_wait";
      // 12. All set
      if (
        txt.includes("You're all set") ||
        txt.includes("You\u2019re all set")
      ) {
        clickBtn("OK", "Ok");
        return "rule12_done";
      }
      // 12b. Finish moving
      if (txt.includes("Finish moving")) {
        clickBtn("Yes, finish moving");
        return "rule12b";
      }
      // 13. Move now
      if (txt.includes("Do you want to move your Meta tools now")) {
        clickBtn("Yes, move now");
        return "rule13";
      }
      return null;
    })
    .catch(() => null);
}

async function metaRulesMonitorLoop(page, durationMs) {
  const start = Date.now();
  let lastRule = "";
  while (Date.now() - start < durationMs) {
    const rule = await runMetaRulesOnce(page);
    if (rule && rule !== lastRule) {
      log(`META rule: ${rule}`);
      lastRule = rule;
      if (rule === "rule12_done") {
        log("META: all set!");
        return "done";
      }
      if (rule === "something_wrong") {
        log("META: Something went wrong!");
        return "something_wrong";
      }
      await sleep(2500);
    } else {
      lastRule = "";
      await sleep(1000);
    }

    // Early exit: "AI, devices and more" as a LISTED ITEM (not dialog text)
    // Chỉ khi URL đang ở /manage hoặc /home VÀ có link "Manage" hoặc "Remove" bên cạnh
    const addSuccess = await page
      .evaluate(() => {
        const url = location.href;
        if (!url.includes("/manage") && !url.includes("/home")) return false;
        // Phải có listitem chứa "AI, devices and more" + link "Manage" hoặc "Remove"
        const items = document.querySelectorAll('[role="listitem"]');
        for (const item of items) {
          const txt = item.innerText || "";
          if (
            txt.includes("AI, devices and more") &&
            (txt.includes("Manage") || txt.includes("Remove"))
          )
            return true;
        }
        return false;
      })
      .catch(() => false);
    if (addSuccess) {
      log("META: AI devices listed on manage page → success");
      return "done";
    }
  }
  return "timeout";
}

// ═══════════════════════════════════════════════════════════════════
// CHECK SUCCESS + EXTRACT PROFILE
// ═══════════════════════════════════════════════════════════════════
async function checkHotmailAdded(page, hotmail) {
  return page
    .evaluate((email) => {
      for (const span of document.querySelectorAll("span")) {
        if (span.textContent.trim().toLowerCase() === email.toLowerCase())
          return true;
      }
      return (document.body?.innerText || "")
        .toLowerCase()
        .includes(email.toLowerCase());
    }, hotmail)
    .catch(() => false);
}

async function checkIGUsernameOnMeta(page, username) {
  return page
    .evaluate((uname) => {
      return (document.body?.innerText || "")
        .toLowerCase()
        .includes(uname.toLowerCase());
    }, username)
    .catch(() => false);
}

async function getIGProfileViaAPI(page) {
  return page
    .evaluate((appId) => {
      const getCookie = (n) => {
        const v = `; ${document.cookie}`;
        const p = v.split(`; ${n}=`);
        if (p.length === 2) return p.pop().split(";").shift();
      };
      const userId = getCookie("ds_user_id");
      if (!userId) return { ok: false, error: "no_ds_user_id" };
      return fetch(`https://www.instagram.com/api/v1/users/${userId}/info/`, {
        method: "GET",
        headers: { "X-IG-App-ID": appId },
      })
        .then((r) =>
          r.status !== 200
            ? { ok: false, error: `status_${r.status}` }
            : r.json(),
        )
        .then((data) => {
          if (data.ok === false) return data;
          const u = data.user;
          if (!u) return { ok: false, error: "no_user" };
          return {
            ok: true,
            username: u.username || "",
            posts: String(u.media_count ?? 0),
            followers: String(u.follower_count ?? 0),
            following: String(u.following_count ?? 0),
          };
        })
        .catch((e) => ({ ok: false, error: e.message }));
    }, IG_APP_ID)
    .catch(() => ({ ok: false, error: "evaluate_failed" }));
}

// ═══════════════════════════════════════════════════════════════════
// SELECT HOTMAIL AS PRIMARY on contact_points page
// ═══════════════════════════════════════════════════════════════════

async function selectHotmailAsPrimary(page, hotmail) {
  log(`CONTACT: navigating to contact_points for ${hotmail}...`);

  await page.goto(
    "https://accountscenter.instagram.com/account_overview/contact_points/",
    {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    },
  );

  await sleep(CONFIG.DELAYS.PAGE_LOAD);

  log(`CONTACT: current URL = ${page.url()}`);

  // Đợi radio xuất hiện
  try {
    await page.waitForSelector('input[type="radio"]', {
      timeout: 15000,
    });
  } catch (err) {
    log(`CONTACT: radio không xuất hiện: ${err.message}`);

    const debug = await page
      .evaluate(() => ({
        url: location.href,
        title: document.title,
        radios: [...document.querySelectorAll('input[type="radio"]')].map(
          (el) => ({
            value: el.value,
            checked: el.checked,
            ariaChecked: el.getAttribute("aria-checked"),
            name: el.name,
          }),
        ),
        text: document.body?.innerText?.slice(0, 1000),
      }))
      .catch(() => null);

    if (debug) {
      log(`CONTACT DEBUG URL: ${debug.url}`);
      log(`CONTACT DEBUG TITLE: ${debug.title}`);
      log(`CONTACT DEBUG RADIOS: ${JSON.stringify(debug.radios)}`);
    }

    return false;
  }

  const target = String(hotmail).trim().toLowerCase();

  // Lấy tất cả radio trên page
  const info = await page.evaluate((target) => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];

    const items = radios.map((el) => ({
      value: String(el.value || "").trim(),
      checked: el.checked,
      ariaChecked: el.getAttribute("aria-checked"),
      name: el.name,
    }));

    const radio = radios.find(
      (el) =>
        String(el.value || "")
          .trim()
          .toLowerCase() === target,
    );

    if (!radio) {
      return {
        found: false,
        items,
      };
    }

    return {
      found: true,
      value: String(radio.value).trim(),
      checked: radio.checked,
      ariaChecked: radio.getAttribute("aria-checked"),
    };
  }, target);

  // Không tìm thấy email
  if (!info.found) {
    log(`CONTACT: ${hotmail} NOT FOUND ❌`);
    log(`CONTACT: radios trên page:`);

    for (const item of info.items) {
      log(
        `  - ${item.value} | checked=${item.checked} | aria=${item.ariaChecked}`,
      );
    }

    return false;
  }

  log(
    `CONTACT: found ${info.value} | checked=${info.checked} | aria=${info.ariaChecked}`,
  );

  // Đã là primary
  if (info.checked || info.ariaChecked === "true") {
    log(`CONTACT: ${hotmail} already primary ✅`);
    return true;
  }

  // Click đúng radio
  const clicked = await page.evaluate((target) => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];

    const radio = radios.find(
      (el) =>
        String(el.value || "")
          .trim()
          .toLowerCase() === target,
    );

    if (!radio) return false;

    radio.scrollIntoView({
      block: "center",
      behavior: "instant",
    });

    radio.click();

    return true;
  }, target);

  if (!clicked) {
    log(`CONTACT: cannot click ${hotmail} ❌`);
    return false;
  }

  log(`CONTACT: clicked ${hotmail} ✅`);

  await sleep(3000);

  // Kiểm tra sau click
  const afterClick = await page.evaluate((target) => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];

    const radio = radios.find(
      (el) =>
        String(el.value || "")
          .trim()
          .toLowerCase() === target,
    );

    if (!radio) return null;

    return {
      value: String(radio.value).trim(),
      checked: radio.checked,
      ariaChecked: radio.getAttribute("aria-checked"),
    };
  }, target);

  log(`CONTACT: after click = ${JSON.stringify(afterClick)}`);

  if (afterClick && (afterClick.checked || afterClick.ariaChecked === "true")) {
    log(`CONTACT: ${hotmail} selected primary ✅`);
  } else {
    log(`CONTACT: ${hotmail} click chưa được xác nhận ⚠️`);
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════
// REVERSE ADD: từ META tab add IG vào
// ═══════════════════════════════════════════════════════════════════
async function reverseAddFromMeta(metaTab, igUsername) {
  log("── REVERSE: add IG from META side ──");

  await metaTab.bringToFront();
  await metaTab.goto("https://accountscenter.meta.com/manage/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(CONFIG.DELAYS.PAGE_LOAD);

  // Cookie consent nếu cần
  for (let i = 0; i < 3; i++) {
    if (
      metaTab.url().includes("consent") ||
      metaTab.url().includes("cookie_choice")
    ) {
      await handleMetaCookieConsent(metaTab);
      await sleep(3000);
    } else break;
  }

  // Click "Add accounts"
  if (!(await clickAddAccountsMeta(metaTab))) {
    log("REVERSE: could not click Add accounts");
    return false;
  }
  await sleep(CONFIG.DELAYS.MEDIUM);

  // Click "Add Instagram"
  if (!(await clickAddInstagramMeta(metaTab))) {
    log("REVERSE: could not click Add Instagram");
    return false;
  }
  await sleep(CONFIG.DELAYS.PAGE_LOAD);

  // Handle fxcal/auth → Continue
  for (let i = 0; i < 5; i++) {
    const url = metaTab.url();
    if (url.includes("/fxcal/auth/login")) {
      await clickButtonInPage(metaTab, "Continue");
      await sleep(CONFIG.DELAYS.LONG);
      break;
    }
    await sleep(2000);
  }

  // Run META rules monitor
  log("REVERSE: running rules monitor...");
  const result = await metaRulesMonitorLoop(
    metaTab,
    CONFIG.DELAYS.META_RULES_DURATION,
  );
  log(`REVERSE result: ${result}`);

  if (result === "something_wrong") return false;

  // Check IG username xuất hiện trên meta account center
  await metaTab.goto("https://accountscenter.meta.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(CONFIG.DELAYS.PAGE_LOAD);

  const found = await checkIGUsernameOnMeta(metaTab, igUsername);
  log(`REVERSE: IG username "${igUsername}" on META AC: ${found}`);
  return found;
}

// ═══════════════════════════════════════════════════════════════════
// PROCESS SINGLE PAIR
// result: { success, failType: 'ig'|'meta'|'both'|null, line, error }
// ═══════════════════════════════════════════════════════════════════
async function processPair(ig, meta, index) {
  log(`\n${"═".repeat(60)}`);
  log(`PAIR #${index + 1}: ${ig.username} ↔ ${meta.hotmail}`);
  log(`${"═".repeat(60)}`);

  let browser = null;

  try {
    const launchOpts = { headless: CONFIG.HEADLESS, args: CONFIG.BROWSER_ARGS };
    if (CONFIG.EXECUTABLE_PATH)
      launchOpts.executablePath = CONFIG.EXECUTABLE_PATH;
    browser = await puppeteer.launch(launchOpts);

    const pages = await browser.pages();
    const igTab = pages[0] || (await browser.newPage());
    const metaTab = await browser.newPage();
    await igTab.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await metaTab.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    // ── STEP 1: META tab — import cookies ──
    log("── STEP 1: META cookies ──");
    await metaTab
      .goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      })
      .catch(() => {});
    await sleep(1500);
    await metaTab.setCookie(
      ...metaCookieStrToPuppeteer(meta.cookieStr, ".facebook.com"),
    );
    await metaTab.setCookie(
      ...metaCookieStrToPuppeteer(meta.cookieStr, ".meta.com"),
    );
    log("META cookies imported");

    await metaTab.goto("https://accountscenter.meta.com/manage", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(CONFIG.DELAYS.PAGE_LOAD);
    for (let i = 0; i < 5; i++) {
      if (
        metaTab.url().includes("auth.meta.com") ||
        metaTab.url().includes("consent") ||
        metaTab.url().includes("cookie_choice")
      ) {
        await handleMetaCookieConsent(metaTab);
        await sleep(3000);
      } else break;
    }
    log(`META tab: ${metaTab.url().substring(0, 60)}`);

    // ── STEP 2: IG tab — import cookies → homepage ──
    log("── STEP 2: IG cookies → homepage ──");
    await igTab.bringToFront();
    await igTab
      .goto("https://www.instagram.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      })
      .catch(() => {});
    await sleep(1500);
    await igTab.setCookie(...igCookiesToPuppeteer(ig.cookies));
    log("IG cookies imported");
    await igTab.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(CONFIG.DELAYS.PAGE_LOAD);
    await igMonitorLoop(igTab, 60000); // throws IGDieError if IG is dead

    // ── STEP 3: IG AC → check if meta already added → add meta ──
    log("── STEP 3: IG AC → add meta ──");
    await igTab.goto("https://accountscenter.instagram.com/manage/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(CONFIG.DELAYS.PAGE_LOAD);

    // Check nếu đã có meta account (listitem có "AI, devices and more" + "Manage"/"Remove")
    const alreadyAdded = await igTab
      .evaluate(() => {
        const items = document.querySelectorAll('[role="listitem"]');
        for (const item of items) {
          const txt = item.innerText || "";
          if (
            txt.includes("AI, devices and more") &&
            (txt.includes("Manage") || txt.includes("Remove"))
          ) {
            // Tìm email hotmail trong cùng section
            const allText = document.body?.innerText || "";
            const emailMatch = allText.match(
              /[\w.-]+@hotmail\.com|[\w.-]+@outlook\.com|[\w.-]+@live\.com/i,
            );
            return { has: true, email: emailMatch ? emailMatch[0] : "unknown" };
          }
        }
        return { has: false };
      })
      .catch(() => ({ has: false }));

    if (alreadyAdded.has) {
      log(`⚠ IG ${ig.username} already has meta: ${alreadyAdded.email} → skip`);
      // Lấy lại profile info trước khi skip
      await igTab.goto("https://www.instagram.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await sleep(CONFIG.DELAYS.PAGE_LOAD);
      try {
        await igMonitorLoop(igTab, 20000);
      } catch {}
      await sleep(2000);
      const profile = await getIGProfileViaAPI(igTab);
      const rawCookies = await igTab.cookies("https://www.instagram.com");
      const cookieStr = buildCookieStr(rawCookies);
      const username = profile.ok ? profile.username : ig.username;
      const posts = (profile.ok ? profile.posts : "0") + " posts";
      const followers = (profile.ok ? profile.followers : "0") + " followers";
      const following = (profile.ok ? profile.following : "0") + " following";

      // username|password|2fa|posts|followers|following|yopmail|cookie|already_meta_email
      const alreadyLine = [
        username,
        ig.password,
        ig.twofa,
        posts,
        followers,
        following,
        ig.yopmail,
        cookieStr,
        alreadyAdded.email,
      ].join("|");
      return { success: false, failType: "already", line: alreadyLine };
    }

    if (!(await clickAddProfilesAndDevices(igTab)))
      throw new Error("Could not click Add profiles");
    await sleep(CONFIG.DELAYS.MEDIUM);
    if (!(await clickAddAIDevicesAndMore(igTab)))
      throw new Error("Could not click Add AI devices");
    await sleep(CONFIG.DELAYS.PAGE_LOAD);

    // ── STEP 4: auth.meta.com → Continue as ──
    log("── STEP 4: auth.meta.com ──");
    for (let i = 0; i < 10; i++) {
      if (
        igTab.url().includes("auth.meta.com") ||
        igTab.url().includes("fxauth")
      )
        break;
      await sleep(1500);
    }
    for (let i = 0; i < 3; i++) {
      if (
        igTab.url().includes("consent") ||
        igTab.url().includes("cookie_choice")
      ) {
        await handleMetaCookieConsent(igTab);
        await sleep(2000);
      } else break;
    }
    if (!(await clickContinueAsName(igTab)))
      throw new Error("Could not click Continue as name");
    await sleep(CONFIG.DELAYS.LONG);

    // ── STEP 5: META rules monitor ──
    log("── STEP 5: META rules ──");
    let rulesResult = await metaRulesMonitorLoop(
      igTab,
      CONFIG.DELAYS.META_RULES_DURATION,
    );

    // ── STEP 5b: Something went wrong → reverse add from META side ──
    if (rulesResult === "something_wrong") {
      log("── STEP 5b: REVERSE ADD from META ──");
      const reverseOk = await reverseAddFromMeta(metaTab, ig.username);
      if (!reverseOk) {
        // IG lỗi — chỉ fail IG, giữ meta
        throw new IGDieError("Something went wrong + reverse failed");
      }
      log("REVERSE: success! ✅");
      rulesResult = "done";
    }

    // ── STEP 6: Check & select hotmail as primary ──
    log("── STEP 6: Check & select hotmail as primary ──");
    await igTab.bringToFront();
    const primaryOk = await selectHotmailAsPrimary(igTab, meta.hotmail);
    if (!primaryOk) {
      throw new Error(`Hotmail ${meta.hotmail} not found in contact_points`);
    }

    // ── STEP 7: Back to homepage → extract profile ──
    log("── STEP 7: Extract profile ──");
    await igTab.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(CONFIG.DELAYS.PAGE_LOAD);
    try {
      await igMonitorLoop(igTab, 30000);
    } catch {}
    await sleep(2000);

    const profile = await getIGProfileViaAPI(igTab);
    const rawCookies = await igTab.cookies("https://www.instagram.com");
    const cookieStr = buildCookieStr(rawCookies);
    const username = profile.ok ? profile.username : ig.username;
    const posts = (profile.ok ? profile.posts : "0") + " posts";
    const followers = (profile.ok ? profile.followers : "0") + " followers";
    const following = (profile.ok ? profile.following : "0") + " following";
    log(`Profile: ${username} | ${posts} | ${followers} | ${following}`);

    // username|passhot|password|2fa|posts|followers|following|yopmail|cookie|hotmail|passhot|refresh_token|client_id|mail_recovery
    const outputLine = [
      username,
      meta.passhot,
      ig.password,
      ig.twofa,
      posts,
      followers,
      following,
      ig.yopmail,
      cookieStr,
      meta.hotmail,
      meta.passhot,
      meta.refresh_token,
      meta.client_id,
      meta.mail_recovery,
    ].join("|");
    return { success: true, failType: null, line: outputLine };
  } catch (err) {
    log(`❌ FAILED: ${ig.username} — ${err.message}`);
    const failType = err instanceof IGDieError ? "ig" : "both";
    return { success: false, failType, error: err.message };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      log("Browser closed");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// FILE HELPERS
// ═══════════════════════════════════════════════════════════════════
function removeFirstLine(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  lines.shift();
  fs.writeFileSync(filePath, lines.join("\n"));
}

function readFirstLine(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[0] : null;
}

function countLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  log("Meta Add IG Tool — starting...");
  log(`IG: ${CONFIG.FILES.IG} | META: ${CONFIG.FILES.META}`);
  log(
    `OUT: ${CONFIG.FILES.OUTPUT} | IG_FAIL: ${CONFIG.FILES.IG_FAIL} | META_FAIL: ${CONFIG.FILES.META_FAIL}`,
  );

  while (true) {
    const igLine = readFirstLine(CONFIG.FILES.IG);
    const metaLine = readFirstLine(CONFIG.FILES.META);
    if (!igLine || !metaLine) {
      log("No more pairs.");
      break;
    }

    const igRemain = countLines(CONFIG.FILES.IG);
    const metaRemain = countLines(CONFIG.FILES.META);
    log(`Remaining: ${igRemain} IG + ${metaRemain} META`);

    const ig = parseIGLine(igLine);
    const meta = parseMetaLine(metaLine);

    if (!ig) {
      log("⚠ IG parse failed — removing IG line");
      fs.appendFileSync(CONFIG.FILES.IG_FAIL, igLine + "|PARSE_FAILED\n");
      removeFirstLine(CONFIG.FILES.IG);
      continue;
    }
    if (!meta) {
      log("⚠ META parse failed — removing META line");
      fs.appendFileSync(CONFIG.FILES.META_FAIL, metaLine + "|PARSE_FAILED\n");
      removeFirstLine(CONFIG.FILES.META);
      continue;
    }

    const result = await processPair(ig, meta, 0);

    if (result.success) {
      // Thành công → xóa cả 2 dòng đầu
      fs.appendFileSync(CONFIG.FILES.OUTPUT, result.line + "\n");
      log(`✅ SAVED: ${ig.username}`);
      removeFirstLine(CONFIG.FILES.IG);
      removeFirstLine(CONFIG.FILES.META);
    } else if (result.failType === "already") {
      // IG đã có meta → ghi file riêng, xóa IG, giữ META (chưa dùng)
      log(
        `ALREADY: ${ig.username} already has meta → removing IG, keeping META`,
      );
      fs.appendFileSync(CONFIG.FILES.ALREADY, result.line + "\n");
      removeFirstLine(CONFIG.FILES.IG);
    } else if (result.failType === "ig") {
      // IG hư → xóa IG, giữ META cho acc ig tiếp theo
      log(`IG fail → removing IG, keeping META`);
      fs.appendFileSync(
        CONFIG.FILES.IG_FAIL,
        ig.raw + "|" + result.error + "\n",
      );
      removeFirstLine(CONFIG.FILES.IG);
    } else if (result.failType === "meta") {
      // META hư → xóa META, giữ IG cho meta tiếp theo
      log(`META fail → removing META, keeping IG`);
      fs.appendFileSync(
        CONFIG.FILES.META_FAIL,
        meta.raw + "|" + result.error + "\n",
      );
      removeFirstLine(CONFIG.FILES.META);
    } else {
      // Cả 2 hư → xóa cả 2
      log(`Both fail → removing both`);
      fs.appendFileSync(
        CONFIG.FILES.IG_FAIL,
        ig.raw + "|" + result.error + "\n",
      );
      fs.appendFileSync(
        CONFIG.FILES.META_FAIL,
        meta.raw + "|" + result.error + "\n",
      );
      removeFirstLine(CONFIG.FILES.IG);
      removeFirstLine(CONFIG.FILES.META);
    }

    log("Wait 5s...");
    await sleep(5000);
  }

  log("\nALL DONE");
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
