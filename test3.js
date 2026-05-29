const { chromium } = require('playwright');
const levenshtein = require('fast-levenshtein');
const dotenv = require("dotenv");
const path = require('path');
const fs = require('fs');

dotenv.config();

// 🔧 Normalize team names
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\./g, '')
    .replace('...', '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 🧠 Levenshtein similarity (1 = perfect match)
function similarity(a, b) {
  const dist = levenshtein.get(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

// 🔍 Fuzzy team name matcher
function isTeamMatch(uiName, apiName) {
  const ui = normalize(uiName);
  const api = normalize(apiName);
  const score = similarity(ui, api);
  console.log(`   🔢 similarity("${ui}", "${api}") = ${score.toFixed(2)}`);
  return score > 0.6;
}

// 🧪 Toggle mock mode: set to true to skip the real API call
const USE_MOCK = true;

// 🚨 DRY RUN mode: set to true to click odds but NOT place the bet
const DRY_RUN = true;

// 💵 MIN BET MODE: when true, overrides all arb-calculated stakes
const MIN_BET_MODE = false;
const MIN_BET_AMOUNT = 1; // KES

// 🗂 Mock data
const MOCK_DATA = {
  success: true,
  bankroll: 1000,
  count: 2,
  opportunities: [
    {
      matchId: 4579183,
      competition: "PBA, Commissioner Cup",
      home: "Ust Growling Tigers",
      away: "Up Fighting Maroons",
      score: "114:117",
      time: "45:30",
      homeOdd: 2.6,
      awayOdd: 1.95,
      inverseSum: 0.8974358974358975,
      profitMargin: 0.10256410256410253,
      arbitrage: true,
      opportunity: {
        bankroll: 1000,
        stakePercent: 100,
        totalStake: 1000,
        stakes: { home: 428.57, away: 571.43 },
        guaranteedProfit: 102.56
      }
    },
    {
      matchId: 4579201,
      competition: "NBA",
      home: "Los Angeles Lakers",
      away: "Golden State Warriors",
      score: "88:91",
      time: "32:10",
      homeOdd: 3.1,
      awayOdd: 1.75,
      inverseSum: 0.8944,
      profitMargin: 0.1056,
      arbitrage: true,
      opportunity: {
        bankroll: 1000,
        stakePercent: 100,
        totalStake: 1000,
        stakes: { home: 360.66, away: 639.34 },
        guaranteedProfit: 118.74
      }
    }
  ]
};

function resolveStake(calculatedStake) {
  if (MIN_BET_MODE) {
    console.log(
      `  🔁 MIN_BET_MODE active — overriding KES ${calculatedStake.toFixed(2)} → KES ${MIN_BET_AMOUNT}`
    );
    return MIN_BET_AMOUNT;
  }
  return calculatedStake;
}

async function fetchArbOpportunities() {
  if (USE_MOCK) {
    console.log('🧪 MOCK MODE — using local test data');
    return MOCK_DATA.opportunities;
  }
  const res = await fetch('http://localhost:3000/api/arb/basketball');
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  if (!data.success || !Array.isArray(data.opportunities)) {
    throw new Error('Invalid API response structure');
  }
  return data.opportunities;
}

const BETIKA_PHONE = process.env.BETIKA_PHONE;
const BETIKA_PASSWORD = process.env.BETIKA_PASSWORD;

// 📁 Persistent Chrome profile directory.
//    This is the single source of truth for session state.
//    Cookies, localStorage, IndexedDB — everything lives here across runs.
//    As long as this directory exists and Betika hasn't invalidated the
//    server-side session, no login is needed on subsequent runs.
const PROFILE_DIR = path.resolve(__dirname, '.betika-profile');

// 📋 A lightweight sentinel file written after each successful login.
//    Its only purpose is to let us cheaply detect "we have logged in before"
//    without launching a browser — the real session lives in PROFILE_DIR.
const LOGIN_SENTINEL = path.resolve(PROFILE_DIR, '.login-ok');

function markLoginComplete() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(LOGIN_SENTINEL, new Date().toISOString(), 'utf8');
  console.log(`💾 Login sentinel written → ${LOGIN_SENTINEL}`);
}

function hasLoginSentinel() {
  return fs.existsSync(LOGIN_SENTINEL);
}

function clearLoginSentinel() {
  if (fs.existsSync(LOGIN_SENTINEL)) {
    fs.unlinkSync(LOGIN_SENTINEL);
    console.log('🗑  Login sentinel cleared — will re-authenticate.');
  }
}

const MAX_LOGIN_RETRIES = 3;

async function login(page) {
  if (!BETIKA_PHONE || !BETIKA_PASSWORD) {
    throw new Error(
      '❌ Missing credentials. Set BETIKA_PHONE and BETIKA_PASSWORD in your .env file.'
    );
  }

  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    console.log(`🔐 Login attempt ${attempt}/${MAX_LOGIN_RETRIES}...`);

    try {
      await page.goto('https://www.betika.com/en-ke/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (navErr) {
      console.log(`  ⚠️  Navigation error: ${navErr.message}`);
      if (attempt === MAX_LOGIN_RETRIES) throw navErr;
      await page.waitForTimeout(3000);
      continue;
    }

    await page.waitForTimeout(6000);

    // Dismiss consent/cookie banners
    const bannerSelectors = [
      'button.cookie-consent__accept',
      'button[data-testid="accept-cookies"]',
      '.modal__close',
      '.popup__close',
      'button.close',
    ];
    for (const sel of bannerSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          console.log(`  🍪 Dismissed overlay: ${sel}`);
          await page.waitForTimeout(1000);
        }
      } catch { /* not present */ }
    }

    // If Betika already redirected us away from /login, we're already authed
    if (!page.url().includes('/login')) {
      console.log('  ✅ Already authenticated (redirect away from /login).');
      markLoginComplete();
      return;
    }

    const phoneInput = page.locator('input[name="phone-number"]');
    try {
      await phoneInput.waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      console.log(`  ⚠️  Phone input not visible. URL: ${page.url()}`);
      if (attempt < MAX_LOGIN_RETRIES) { await page.waitForTimeout(6000); continue; }
      throw new Error('Phone input never appeared. Betika may have changed their markup.');
    }

    console.log('📱 Entering phone number...');
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.fill(BETIKA_PHONE);

    console.log('🔑 Entering password...');
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.fill(BETIKA_PASSWORD);

    console.log('🚀 Clicking Login...');
    await page.locator('button.session__form__button').click();

    console.log('⏳ Waiting for login to complete...');
    try {
      await page.waitForSelector('.session__form', { state: 'detached', timeout: 25000 });
    } catch {
      // Check for inline error messages
      const errorEls = page.locator('.session__form .input__desc span, .session__form__error');
      const errCount = await errorEls.count();
      for (let j = 0; j < errCount; j++) {
        const txt = (await errorEls.nth(j).textContent().catch(() => '')).trim();
        if (txt && !txt.toLowerCase().startsWith('enter your')) {
          throw new Error('Betika rejected login — ' + txt);
        }
      }
      if (attempt < MAX_LOGIN_RETRIES) {
        console.log('  ⚠️  Form still visible after 25s. Retrying...');
        await page.waitForTimeout(6000);
        continue;
      }
      throw new Error('Login timed out after all retries. Check credentials.');
    }

    console.log('✅ Logged in successfully!');
    await page.waitForTimeout(2000);
    // The persistent profile now holds all auth cookies automatically —
    // no explicit storageState export needed.
    markLoginComplete();
    return;
  }
}

/**
 * 🔍 Check whether the profile's session is still active.
 *
 * Strategy: navigate to the homepage and see if Betika redirects to /login.
 * This is more reliable than inspecting cookie names, which Betika rotates.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isSessionValid(page) {
  console.log('  🔍 Verifying session by loading Betika homepage...');
  try {
    await page.goto('https://www.betika.com/en-ke/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    // Allow JS redirects to fire
    await page.waitForTimeout(5000);

    const url = page.url();
    console.log(`  🌐 Post-load URL: ${url}`);

    if (url.includes('/login')) {
      console.log('  ℹ️  Redirected to /login — session expired.');
      return false;
    }

    // Extra check: look for a logged-in indicator (balance, username chip, etc.)
    // Betika renders a user-balance element only when authenticated.
    const loggedInSignals = [
      '[class*="user-balance"]',
      '[class*="account-balance"]',
      '[class*="wallet"]',
      '[class*="profile"]',
      '[class*="avatar"]',
    ];
    for (const sel of loggedInSignals) {
      try {
        const visible = await page.locator(sel).first().isVisible({ timeout: 2000 });
        if (visible) {
          console.log(`  ✅ Auth signal detected: "${sel}"`);
          return true;
        }
      } catch { /* not present */ }
    }

    // URL didn't hit /login and we didn't find an explicit signal — optimistically trust it
    console.log('  ✅ No /login redirect detected — treating session as active.');
    return true;

  } catch (err) {
    console.log(`  ⚠️  Session check error: ${err.message}`);
    return false;
  }
}

async function placeBet(page, stakeAmount) {
  const roundedStake = Math.max(1, Math.round(stakeAmount));

  console.log(`\n  💳 Opening betslip — stake: KES ${roundedStake}${MIN_BET_MODE ? ' (min-bet override)' : ''}`);

  const amountInput = page.locator('input[name="amount"]');
  try {
    await amountInput.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error('Betslip amount input never appeared — was the odd click missed?');
  }

  await amountInput.click({ clickCount: 3 });
  await amountInput.fill(String(roundedStake));
  console.log(`  ✏️  Stake entered: KES ${roundedStake}`);

  await page.waitForTimeout(1000);

  try {
    const payoutEl = page.locator('.betslip__details__row.finalpay .betslip__details__row__value');
    const payoutText = (await payoutEl.textContent({ timeout: 3000 })).trim();
    console.log(`  📊 Displayed payout: ${payoutText}`);
  } catch {
    console.log('  ⚠️  Could not read payout display (non-fatal)');
  }

  if (DRY_RUN) {
    console.log('  🚧 DRY RUN — "Place Bet" NOT clicked. Set DRY_RUN=false to go live.');
    return;
  }

  const placeBetBtn = page.locator('button.betslip__details__button__place');
  try {
    await placeBetBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    throw new Error('"Place Bet" button not found — betslip may not be ready.');
  }

  await placeBetBtn.click();
  console.log(`  ✅ "Place Bet" clicked — KES ${roundedStake} staked!`);

  try {
    await page.waitForSelector(
      '.betslip__success, .betslip__confirmation, .betslip__details__button__place:disabled',
      { timeout: 10000 }
    );
    console.log('  🎉 Bet confirmed!');
  } catch {
    console.log('  ⚠️  Could not confirm bet placement — check the browser window.');
  }
}

(async () => {
  console.log('─'.repeat(55));
  console.log(`  DRY_RUN     : ${DRY_RUN}`);
  console.log(`  MIN_BET_MODE: ${MIN_BET_MODE}${MIN_BET_MODE ? ` (KES ${MIN_BET_AMOUNT} per leg)` : ''}`);
  console.log(`  USE_MOCK    : ${USE_MOCK}`);
  console.log(`  PROFILE_DIR : ${PROFILE_DIR}`);
  console.log('─'.repeat(55));

  if (!DRY_RUN && MIN_BET_MODE) {
    console.log(`⚠️  LIVE MODE + MIN_BET: will stake KES ${MIN_BET_AMOUNT} on EACH leg with real money.`);
  }
  if (!DRY_RUN && !MIN_BET_MODE) {
    console.log('🔴 LIVE MODE: full arb-calculated stakes will be placed with real money!');
  }

  console.log('\n📡 Fetching arbitrage opportunities...');
  let opportunities;
  try {
    opportunities = await fetchArbOpportunities();
    console.log(`✅ Got ${opportunities.length} opportunity/ies`);
  } catch (err) {
    console.error('❌ Failed to fetch from API:', err.message);
    process.exit(1);
  }

  if (opportunities.length === 0) {
    console.log('⚠️  No arbitrage opportunities available. Exiting.');
    process.exit(0);
  }

  // Common Chrome binary locations
  const CHROME_CANDIDATES = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  const executablePath = CHROME_CANDIDATES.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });

  if (executablePath) {
    console.log(`🌐 Using system Chrome: ${executablePath}`);
  } else {
    console.log('⚠️  System Chrome not found — falling back to Playwright Chromium.');
  }

  // ── Launch with a persistent profile ─────────────────────────────────────
  // KEY DESIGN: we rely SOLELY on PROFILE_DIR for session persistence.
  // The profile dir stores all cookies, localStorage, and IndexedDB on disk.
  // We do NOT pass storageState — that would conflict with the persistent profile
  // and is redundant. The profile IS the session.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    ...(executablePath ? { executablePath } : {}),
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await context.newPage();

  // ── Session gate ──────────────────────────────────────────────────────────
  // 1. If we've never logged in (no sentinel), go straight to login.
  // 2. If we have a sentinel, verify the session is still alive on Betika's side.
  // 3. If the session has expired, clear the sentinel and log in fresh.
  if (!hasLoginSentinel()) {
    console.log('\n🔐 No prior login found — logging in for the first time...');
    try {
      await login(page);
    } catch (err) {
      console.error('❌ Login failed:', err.message);
      await context.close();
      process.exit(1);
    }
  } else {
    console.log(`\n🔄 Prior login detected — verifying session is still active...`);
    const valid = await isSessionValid(page);

    if (valid) {
      console.log('✅ Session is active — skipping login.');
    } else {
      console.log('⚠️  Session expired. Clearing sentinel and re-authenticating...');
      clearLoginSentinel();
      try {
        await login(page);
      } catch (err) {
        console.error('❌ Re-login failed:', err.message);
        await context.close();
        process.exit(1);
      }
    }
  }

  // ── Live betting page ─────────────────────────────────────────────────────
  console.log('\n🏀 Navigating to live betting page...');
  await page.goto('https://www.betika.com/en-ke/live', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  console.log('✅ Live page loaded');

  await page.waitForTimeout(15000);

  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(3000);
  }
  console.log('✅ Scrolling done');

  // Debug: log relevant CSS classes present on the page
  const liveClasses = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const classes = new Set();
    for (const el of all) {
      for (const cls of el.classList) {
        if (cls.includes('live') || cls.includes('match') || cls.includes('event') || cls.includes('team')) {
          classes.add(cls);
        }
      }
    }
    return [...classes].sort();
  });
  console.log('🔍 Relevant classes on page:', liveClasses.join(', ') || '(none)');

  const HOME_SELECTORS = [
    '.live-match__teams__home',
    '.live-event__teams__home',
    '.match__teams__home',
    '[class*="teams__home"]',
    '[class*="team--home"]',
  ];
  const CONTAINER_SELECTORS = [
    '.live-match__odd-market__container',
    '.live-event__odd-market__container',
    '[class*="odd-market__container"]',
    '[class*="live-match"]',
    '[class*="live-event"]',
  ];

  let resolvedHomeSelector = null;
  for (const sel of HOME_SELECTORS) {
    const found = await page.locator(sel).count();
    console.log(`  🔎 "${sel}" → ${found} element(s)`);
    if (found > 0 && !resolvedHomeSelector) resolvedHomeSelector = sel;
  }

  if (!resolvedHomeSelector) {
    console.log('❌ No live match home-team elements found.');
    await page.screenshot({ path: '/tmp/betika-live-debug.png', fullPage: true });
    await context.close();
    process.exit(0);
  }

  let resolvedContainerSelector = null;
  for (const sel of CONTAINER_SELECTORS) {
    const found = await page.locator(sel).count();
    console.log(`  🔎 "${sel}" → ${found} element(s)`);
    if (found > 0 && !resolvedContainerSelector) resolvedContainerSelector = sel;
  }

  if (!resolvedContainerSelector) {
    console.log('❌ No match container elements found.');
    await page.screenshot({ path: '/tmp/betika-live-debug.png', fullPage: true });
    await context.close();
    process.exit(0);
  }

  console.log(`✅ Using home selector      : "${resolvedHomeSelector}"`);
  console.log(`✅ Using container selector : "${resolvedContainerSelector}"`);

  const matchContainers = page.locator(resolvedContainerSelector);
  const count = await matchContainers.count();
  console.log(`🎯 Found ${count} live matches on page`);

  let clickedCount = 0;

  for (let i = 0; i < count; i++) {
    const match = matchContainers.nth(i);

    try {
      const awaySelector = resolvedHomeSelector.replace('home', 'away');
      const home = await match.locator(`${resolvedHomeSelector} span`).nth(1).textContent();
      const away = await match.locator(`${awaySelector} span`).nth(1).textContent();

      console.log(`\n🔎 UI Match: "${home}" vs "${away}"`);

      for (const opp of opportunities) {
        const homeMatch = isTeamMatch(home, opp.home);
        const awayMatch = isTeamMatch(away, opp.away);

        if (homeMatch && awayMatch) {
          console.log(`✅ MATCH FOUND! → ${opp.home} vs ${opp.away}`);
          console.log(`   📊 Profit margin: ${(opp.profitMargin * 100).toFixed(2)}%`);

          const homeStake = resolveStake(opp.opportunity.stakes.home);
          const awayStake = resolveStake(opp.opportunity.stakes.away);

          console.log(`   💰 Stakes — Home: KES ${homeStake}, Away: KES ${awayStake}`);

          const oddButtons = match.locator('.live-match__odd');

          // Leg 1: HOME
          const homeOddBtn = oddButtons.nth(0);
          await homeOddBtn.waitFor({ timeout: 20000 });
          await homeOddBtn.click();
          console.log(`🖱  Clicked HOME odd (${opp.homeOdd})`);

          try {
            await placeBet(page, homeStake);
          } catch (betErr) {
            console.error('  ❌ HOME bet failed:', betErr.message);
          }

          await page.waitForTimeout(4000);

          // Leg 2: AWAY
          const awayOddBtn = oddButtons.nth(1);
          await awayOddBtn.waitFor({ timeout: 20000 });
          await awayOddBtn.click();
          console.log(`🖱  Clicked AWAY odd (${opp.awayOdd})`);

          try {
            await placeBet(page, awayStake);
          } catch (betErr) {
            console.error('  ❌ AWAY bet failed:', betErr.message);
          }

          clickedCount++;
          await page.waitForTimeout(2000);
          break;
        }
      }

    } catch (err) {
      console.log('⚠️  Skipping match (not fully loaded):', err.message);
    }
  }

  if (clickedCount === 0) {
    console.log('\n❌ No matching arb opportunities found on page.');
  } else {
    console.log(`\n✅ Done. Placed bets for ${clickedCount} arbitrage opportunity/ies.`);
  }

  await page.waitForTimeout(5000);
  await context.close();
})();