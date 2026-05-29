const { chromium } = require('playwright');
const levenshtein = require('fast-levenshtein');
const dotenv = require("dotenv")
const path = require('path');
const fs = require('fs');

dotenv.config()

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
// Set to false only when you're ready to stake real money
const DRY_RUN = true;

// 💵 MIN BET MODE: when true, overrides all arb-calculated stakes and bets
// exactly MIN_BET_AMOUNT (KES) on each leg — home AND away.
// Use this to verify the full browser flow with real money but minimal risk.
// Set DRY_RUN=false AND MIN_BET_MODE=true to place real 1 KES test bets.
const MIN_BET_MODE = false;
const MIN_BET_AMOUNT = 1; // KES — must be ≥ Betika's minimum stake (currently 1 KES)
 
// 🗂 Mock data — mirrors the real API response shape
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

/**
 * 🎯 Resolve the stake for a single leg, respecting MIN_BET_MODE.
 * @param {number} calculatedStake  - the arb-optimal stake in KES
 * @returns {number} the stake that will actually be entered
 */
function resolveStake(calculatedStake) {
  if (MIN_BET_MODE) {
    console.log(
      `  🔁 MIN_BET_MODE active — overriding KES ${calculatedStake.toFixed(2)} → KES ${MIN_BET_AMOUNT}`
    );
    return MIN_BET_AMOUNT;
  }
  return calculatedStake;
}
 
// 🌐 Fetch arbitrage opportunities (real API or mock)
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
 
// 🔐 Login credentials — set via environment variables for security
const BETIKA_PHONE = process.env.BETIKA_PHONE;
const BETIKA_PASSWORD = process.env.BETIKA_PASSWORD;

// 📁 Path where the browser session (cookies + localStorage) is stored.
//    As long as this file exists and the session hasn't expired on Betika's
//    side, the script will skip the login form entirely on the next run.
const SESSION_FILE = path.resolve(__dirname, '.betika-session.json');

/**
 * 💾 Persist the current browser session to disk.
 * Saves cookies + origins so they can be restored on the next run.
 */
async function saveSession(context) {
  const storage = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
  console.log(`💾 Session saved → ${SESSION_FILE}`);
}

/**
 * ✅ Check whether a saved session file exists.
 */
function hasSavedSession() {
  return fs.existsSync(SESSION_FILE);
}

/**
 * 🔐 Log in via the Betika login form and persist the resulting session.
 * Only called when no valid saved session is found.
 *
 * Handles:
 *  - Slow page loads (extended timeout + domcontentloaded fallback)
 *  - Cookie/GDPR consent banners that overlay the form
 *  - Betika redirecting to home when already logged in
 *  - Up to MAX_LOGIN_RETRIES attempts before giving up
 */
const MAX_LOGIN_RETRIES = 3;

async function login(page, context) {
  if (!BETIKA_PHONE || !BETIKA_PASSWORD) {
    throw new Error(
      '❌ Missing credentials. Set BETIKA_PHONE and BETIKA_PASSWORD environment variables.'
    );
  }

  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    console.log(`🔐 Login attempt ${attempt}/${MAX_LOGIN_RETRIES} — navigating to login page...`);

    // Use domcontentloaded instead of networkidle — Betika's page can hang
    // waiting for ad/analytics scripts that never fully settle.
    try {
      await page.goto('https://www.betika.com/en-ke/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (navErr) {
      console.log(`  ⚠️  Navigation error (attempt ${attempt}): ${navErr.message}`);
      if (attempt === MAX_LOGIN_RETRIES) throw navErr;
      await page.waitForTimeout(3000);
      continue;
    }

    // Give JS-heavy SPA a moment to render the form after DOM loads
    await page.waitForTimeout(6000);

    // ── Dismiss cookie / consent banners ─────────────────────────────────
    // Betika occasionally shows a GDPR or promo overlay — click it away so
    // it doesn't swallow our form interactions.
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
      } catch { /* banner not present — ignore */ }
    }

    // ── Wait for the phone input ──────────────────────────────────────────
    const phoneInput = page.locator('input[name="phone-number"]');
    let inputReady = false;
    try {
      await phoneInput.waitFor({ state: 'visible', timeout: 20000 });
      inputReady = true;
    } catch {
      // If Betika redirected us away from the login page (e.g. already
      // logged in from a lingering cookie), catch that here.
      const url = page.url();
      console.log(`  ⚠️  Phone input not found. Current URL: ${url}`);

      if (!url.includes('/login')) {
        // We're already on an authenticated page — treat as success.
        console.log('  ✅ Already authenticated — no form needed.');
        await saveSession(context);
        return;
      }

      if (attempt < MAX_LOGIN_RETRIES) {
        console.log(`  🔄 Retrying in 6 s…`);
        await page.waitForTimeout(6000);
        continue;
      }
      throw new Error(
        'Login page loaded but phone input never appeared. ' +
        'Betika may have changed their markup — check the selector.'
      );
    }

    if (!inputReady) continue;

    // ── Fill credentials ──────────────────────────────────────────────────
    console.log('📱 Entering phone number...');
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.fill(BETIKA_PHONE);

    console.log('🔑 Entering password...');
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.fill(BETIKA_PASSWORD);

    console.log('🚀 Clicking Login button...');
    await page.locator('button.session__form__button').click();

    // ── Wait for the form to disappear (success) or show an error ─────────
    console.log('⏳ Waiting for login to complete...');
    try {
      await page.waitForSelector('.session__form', { state: 'detached', timeout: 25000 });
    } catch {
      // Form is still visible — check for an inline error message
      const errorEls = page.locator('.session__form .input__desc span, .session__form__error');
      const errCount = await errorEls.count();
      for (let j = 0; j < errCount; j++) {
        const txt = (await errorEls.nth(j).textContent().catch(() => '')).trim();
        if (txt && !txt.toLowerCase().startsWith('enter your')) {
          // Betika returned a credential error — no point retrying
          throw new Error('Login rejected by Betika — ' + txt);
        }
      }

      if (attempt < MAX_LOGIN_RETRIES) {
        console.log(`  ⚠️  Form still visible after 25 s. Retrying…`);
        await page.waitForTimeout(6000);
        continue;
      }
      throw new Error('Login timed out — form still visible after all retries. Check credentials.');
    }

    // ── Success ───────────────────────────────────────────────────────────
    console.log('✅ Logged in successfully!');
    await page.waitForTimeout(2000);
    await saveSession(context);
    return; // done — exit the retry loop
  }
}

/**
 * 🔍 Verify the restored session is still valid.
 *
 * Primary signal: Betika redirects unauthenticated users to /login.
 * If after loading the homepage the URL still contains /login we know
 * the session has expired. Otherwise we trust we're logged in.
 *
 * This avoids depending on CSS class names that Betika can change
 * at any time without notice.
 *
 * @returns {boolean} true if the session is still active
 */
async function isSessionValid(page) {
  // DEBUG: dump full session state
  const cookies = await page.context().cookies().catch(() => []);
  console.log(`  🍪 Session cookies loaded: ${cookies.length}`);
  console.log(`  🍪 Cookie names: ${cookies.map(c => c.name).join(", ") || "(none)"}`);

  try {
    // Navigate to a page that requires auth — Betika redirects to /login if not authed
    await page.goto('https://www.betika.com/en-ke/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait a moment for any JS-driven redirect to fire
    await page.waitForTimeout(6000);

    const url = page.url();
    console.log(`  🌐 Post-load URL: ${url}`);

    if (url.includes('/login')) {
      console.log('  ℹ️  Redirected to /login — session expired.');
      return false;
    }

    console.log('  ✅ Not redirected to /login — session is active.');
    return true;

  } catch (err) {
    console.log(`  ⚠️  Session check error: ${err.message}`);
    return false;
  }
}

/**
 * 💰 Place a single bet leg on the open betslip.
 *
 * Flow:
 *  1. Wait for the betslip amount input to appear
 *  2. Clear it and type the stake amount
 *  3. Verify the payout looks sensible (optional sanity check)
 *  4. Click "Place Bet" — skipped in DRY_RUN mode
 *
 * @param {import('playwright').Page} page
 * @param {number} stakeAmount  - KES amount to stake (integer, min 1)
 */
async function placeBet(page, stakeAmount) {
  const roundedStake = Math.max(1, Math.round(stakeAmount)); // never go below 1 KES

  console.log(`\n  💳 Opening betslip — stake: KES ${roundedStake}${MIN_BET_MODE ? ' (min-bet override)' : ''}`);

  // ── 1. Wait for the betslip to fully render ──────────────────────────────
  const amountInput = page.locator('input[name="amount"]');
  try {
    await amountInput.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error('Betslip amount input never appeared — was the odd click missed?');
  }

  // ── 2. Fill in the stake ─────────────────────────────────────────────────
  // Use triple-click to select-all then type, so any pre-filled value is replaced.
  await amountInput.click({ clickCount: 3 });
  await amountInput.fill(String(roundedStake));
  console.log(`  ✏️  Stake entered: KES ${roundedStake}`);

  // Give the SPA a moment to re-calculate odds / payout display
  await page.waitForTimeout(1000);

  // ── 3. Optional: read back the displayed payout for logging ─────────────
  try {
    const payoutEl = page.locator('.betslip__details__row.finalpay .betslip__details__row__value');
    const payoutText = (await payoutEl.textContent({ timeout: 3000 })).trim();
    console.log(`  📊 Displayed payout: ${payoutText}`);
  } catch {
    console.log('  ⚠️  Could not read payout display (non-fatal)');
  }

  // ── 4. Place the bet (or skip in DRY_RUN) ────────────────────────────────
  if (DRY_RUN) {
    console.log('  🚧 DRY RUN — "Place Bet" button NOT clicked. Set DRY_RUN=false to go live.');
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

  // Wait for the bet confirmation to appear (betslip usually resets or shows a success modal)
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
  // ── Mode summary banner ───────────────────────────────────────────────────
  console.log('─'.repeat(55));
  console.log(`  DRY_RUN    : ${DRY_RUN}`);
  console.log(`  MIN_BET_MODE: ${MIN_BET_MODE}${MIN_BET_MODE ? ` (KES ${MIN_BET_AMOUNT} per leg)` : ''}`);
  console.log(`  USE_MOCK   : ${USE_MOCK}`);
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
    console.log(`✅ Got ${opportunities.length} opportunity/ies from API`);
  } catch (err) {
    console.error('❌ Failed to fetch from API:', err.message);
    process.exit(1);
  }
 
  if (opportunities.length === 0) {
    console.log('⚠️  No arbitrage opportunities available. Exiting.');
    process.exit(0);
  }

  // ── Launch system Chrome with a persistent profile ──────────────────────
  // We use the real Chrome installed on this machine (not Playwright's bundled
  // Chromium) so pages load with the same speed as a normal browser visit.
  // The persistent profile dir means the disk cache, cookies and localStorage
  // all survive between runs — no cold-cache penalty after the first run.
  const PROFILE_DIR = path.resolve(__dirname, '.betika-profile');

  // Common Chrome binary locations on Linux/Mac/Windows — first one found wins.
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
    try { return require('fs').existsSync(p); } catch { return false; }
  });

  if (executablePath) {
    console.log(`🌐 Using system Chrome: ${executablePath}`);
  } else {
    console.log('⚠️  System Chrome not found — falling back to Playwright Chromium.');
    console.log('   Install Chrome for faster loads: https://www.google.com/chrome/');
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    ...(executablePath ? { executablePath } : {}),
    ...(hasSavedSession() ? { storageState: SESSION_FILE } : {}),
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled', // avoid bot detection
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // launchPersistentContext returns a context directly (no separate browser object)
  const page = await context.newPage();

  if (hasSavedSession()) {
    console.log(`\n🔄 Found saved session (${SESSION_FILE}) — checking if still valid...`);
    const valid = await isSessionValid(page);

    if (valid) {
      console.log('✅ Session restored — skipping login form.');
    } else {
      console.log('⚠️  Saved session has expired. Logging in fresh...');
      fs.unlinkSync(SESSION_FILE);
      try {
        await login(page, context);
      } catch (err) {
        console.error('❌ Login failed:', err.message);
        await context.close();
        process.exit(1);
      }
    }
  } else {
    console.log('\n🔐 No saved session found — logging in...');
    try {
      await login(page, context);
    } catch (err) {
      console.error('❌ Login failed:', err.message);
      await context.close();
      process.exit(1);
    }
  }
 
  // 🏀 Navigate to live betting page
  console.log('🏀 Navigating to live betting page...');
  await page.goto('https://www.betika.com/en-ke/live', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('✅ Live page loaded');

  // Give the SPA extra time to render live match data
  await page.waitForTimeout(15000); // extra wait for slow Betika loads
 
  // Scroll to load more matches
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(3000);
  }
  console.log('✅ Scrolling done');

  // ── DEBUG: find out what selectors are actually on the page ─────────────
  // This block logs every unique class that contains "live" or "match" so we
  // can identify the real selector if Betika has changed their markup.
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
  console.log('🔍 Relevant classes found on page:', liveClasses.join(', ') || '(none)');

  // ── Try multiple known selectors, fall back gracefully ──────────────────
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
    console.log('❌ No live match home-team elements found. Page may have no live games right now, or Betika changed their markup.');
    console.log('📸 Saving screenshot for inspection → /tmp/betika-live-debug.png');
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

  console.log(`✅ Using home selector   : "${resolvedHomeSelector}"`);
  console.log(`✅ Using container selector: "${resolvedContainerSelector}"`);

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
 
          // ── Leg 1: HOME ──────────────────────────────────────────────────
          const homeOddBtn = oddButtons.nth(0);
          await homeOddBtn.waitFor({ timeout: 20000 });
          await homeOddBtn.click();
          console.log(`🖱  Clicked HOME odd (${opp.homeOdd})`);

          try {
            await placeBet(page, homeStake);
          } catch (betErr) {
            console.error('  ❌ HOME bet placement failed:', betErr.message);
          }

          await page.waitForTimeout(4000);
 
          // ── Leg 2: AWAY ──────────────────────────────────────────────────
          const awayOddBtn = oddButtons.nth(1);
          await awayOddBtn.waitFor({ timeout: 20000 });
          await awayOddBtn.click();
          console.log(`🖱  Clicked AWAY odd (${opp.awayOdd})`);

          try {
            await placeBet(page, awayStake);
          } catch (betErr) {
            console.error('  ❌ AWAY bet placement failed:', betErr.message);
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