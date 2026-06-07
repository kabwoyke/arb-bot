const { chromium } = require('playwright');
const levenshtein = require('fast-levenshtein');
const dotenv = require("dotenv");
const path = require('path');
const fs = require('fs');

dotenv.config();

// ─── Timer utility ───────────────────────────────────────────────────────────
// Usage:
//   const t = timer('Login');   // starts the clock
//   ...
//   t.end();                    // prints "⏱  Login: 1234ms"
//   t.end('✅ Login done');     // prints "✅ Login done (1234ms)"
//
// lap(label) logs an intermediate split without stopping the clock:
//   t.lap('Phone entered');     // prints "   ↳ Phone entered: 456ms"
function timer(label) {
  const start = Date.now();
  let lastLap = start;
  return {
    lap(lapLabel) {
      const now = Date.now();
      console.log(`   ↳ ${lapLabel}: ${now - lastLap}ms`);
      lastLap = now;
    },
    end(msg) {
      const ms = Date.now() - start;
      if (msg) {
        console.log(`${msg} (${ms}ms)`);
      } else {
        console.log(`⏱  ${label}: ${ms}ms`);
      }
      return ms;
    },
  };
}

// Formats a ms value into a human-readable string: "1m 4s 230ms" or "830ms"
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const rem  = ms % 1000;
  const parts = [];
  if (mins) parts.push(`${mins}m`);
  if (secs) parts.push(`${secs}s`);
  parts.push(`${rem}ms`);
  return parts.join(' ');
}

// ─── Normalize team names ────────────────────────────────────────────────────
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\./g, '')
    .replace('...', '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Levenshtein similarity (1 = perfect match) ──────────────────────────────
function similarity(a, b) {
  const dist = levenshtein.get(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

// ─── Fuzzy team name matcher ─────────────────────────────────────────────────
function isTeamMatch(uiName, apiName) {
  const ui = normalize(uiName);
  const api = normalize(apiName);
  const score = similarity(ui, api);
  console.log(`   🔢 similarity("${ui}", "${api}") = ${score.toFixed(2)}`);
  return score > 0.6;
}

// ─── Flags ───────────────────────────────────────────────────────────────────
const USE_MOCK    = true;
const DRY_RUN     = true;
const MIN_BET_MODE   = false;
const MIN_BET_AMOUNT = 1; // KES

// ─── Mock data ───────────────────────────────────────────────────────────────
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

// ─── Fetch opportunities ─────────────────────────────────────────────────────
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

const BETIKA_PHONE    = process.env.BETIKA_PHONE;
const BETIKA_PASSWORD = process.env.BETIKA_PASSWORD;

const PROFILE_DIR    = path.resolve(__dirname, '.betika-profile');
const LOGIN_SENTINEL = path.resolve(PROFILE_DIR, '.login-ok');

function markLoginComplete() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(LOGIN_SENTINEL, new Date().toISOString(), 'utf8');
  console.log(`💾 Login sentinel written → ${LOGIN_SENTINEL}`);
}
function hasLoginSentinel() { return fs.existsSync(LOGIN_SENTINEL); }
function clearLoginSentinel() {
  if (fs.existsSync(LOGIN_SENTINEL)) {
    fs.unlinkSync(LOGIN_SENTINEL);
    console.log('🗑  Login sentinel cleared — will re-authenticate.');
  }
}

const MAX_LOGIN_RETRIES = 3;

// ─── Login ───────────────────────────────────────────────────────────────────
async function login(page) {
  if (!BETIKA_PHONE || !BETIKA_PASSWORD) {
    throw new Error('❌ Missing credentials. Set BETIKA_PHONE and BETIKA_PASSWORD in your .env file.');
  }

  const t = timer('Login');

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
      await page.waitForTimeout(1000);
      continue;
    }

    // ✅ 'networkidle' on Betika never truly fires — it polls forever (ads, websockets).
    //    Wait for DOM + a short fixed settle instead: reliable and fast.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(400);
    t.lap('Page loaded');

    // Dismiss banners in parallel
    const bannerSelectors = [
      'button.cookie-consent__accept',
      'button[data-testid="accept-cookies"]',
      '.modal__close',
      '.popup__close',
      'button.close',
    ];
    await Promise.race(
      bannerSelectors.map(sel =>
        page.locator(sel).first().click({ timeout: 1500 }).catch(() => {})
      )
    );

    if (!page.url().includes('/login')) {
      console.log('  ✅ Already authenticated (redirect away from /login).');
      t.end('✅ Login (already authed)');
      markLoginComplete();
      return;
    }

    const phoneInput = page.locator('input[name="phone-number"]');
    try {
      await phoneInput.waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      console.log(`  ⚠️  Phone input not visible. URL: ${page.url()}`);
      if (attempt < MAX_LOGIN_RETRIES) { await page.waitForTimeout(1000); continue; }
      throw new Error('Phone input never appeared. Betika may have changed their markup.');
    }

    console.log('📱 Entering phone number...');
    await phoneInput.click({ clickCount: 3 });
    await phoneInput.fill(BETIKA_PHONE);
    t.lap('Phone entered');

    console.log('🔑 Entering password...');
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.fill(BETIKA_PASSWORD);
    t.lap('Password entered');

    console.log('🚀 Clicking Login...');
    await page.locator('button.session__form__button').click();

    console.log('⏳ Waiting for login to complete...');
    try {
      await page.waitForSelector('.session__form', { state: 'detached', timeout: 25000 });
    } catch {
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
        await page.waitForTimeout(1000);
        continue;
      }
      throw new Error('Login timed out after all retries. Check credentials.');
    }

    t.lap('Form detached (login accepted)');
    console.log('✅ Logged in successfully!');
    t.end('✅ Login complete');
    markLoginComplete();
    return;
  }
}

// ─── Session validation ──────────────────────────────────────────────────────
async function isSessionValid(page) {
  const t = timer('Session check');
  console.log('  🔍 Verifying session by loading Betika homepage...');
  try {
    await page.goto('https://www.betika.com/en-ke/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(400);
    t.lap('Page settled');

    const url = page.url();
    console.log(`  🌐 Post-load URL: ${url}`);

    if (url.includes('/login')) {
      console.log('  ℹ️  Redirected to /login — session expired.');
      t.end('⏱  Session check (expired)');
      return false;
    }

    const loggedInSignals = [
      '[class*="user-balance"]',
      '[class*="account-balance"]',
      '[class*="wallet"]',
      '[class*="profile"]',
      '[class*="avatar"]',
    ];

    const found = await Promise.race([
      ...loggedInSignals.map(sel =>
        page.locator(sel).first().isVisible({ timeout: 2000 })
          .then(v => v ? sel : null)
          .catch(() => null)
      ),
      new Promise(res => setTimeout(() => res(null), 2500)),
    ]);

    if (found) {
      console.log(`  ✅ Auth signal detected: "${found}"`);
      t.end('⏱  Session check (valid)');
      return true;
    }

    console.log('  ✅ No /login redirect — treating session as active.');
    t.end('⏱  Session check (assumed valid)');
    return true;

  } catch (err) {
    console.log(`  ⚠️  Session check error: ${err.message}`);
    t.end('⏱  Session check (error)');
    return false;
  }
}

// ─── Place bet ───────────────────────────────────────────────────────────────
async function placeBet(page, stakeAmount, legLabel = 'Bet') {
  const roundedStake = Math.max(1, Math.round(stakeAmount));
  const t = timer(`${legLabel} KES ${roundedStake}`);

  console.log(`\n  💳 Opening betslip — stake: KES ${roundedStake}${MIN_BET_MODE ? ' (min-bet override)' : ''}`);

  const amountInput = page.locator('input[name="amount"]');
  try {
    await amountInput.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error('Betslip amount input never appeared — was the odd click missed?');
  }
  t.lap('Betslip visible');

  await amountInput.click({ clickCount: 3 });
  await amountInput.fill(String(roundedStake));
  console.log(`  ✏️  Stake entered: KES ${roundedStake}`);
  t.lap('Stake entered');

  await page.waitForFunction(
    () => {
      const el = document.querySelector('.betslip__details__row.finalpay .betslip__details__row__value');
      return el && el.textContent.trim().length > 0;
    },
    { timeout: 3000 }
  ).catch(() => {});

  try {
    const payoutEl = page.locator('.betslip__details__row.finalpay .betslip__details__row__value');
    const payoutText = (await payoutEl.textContent({ timeout: 2000 })).trim();
    console.log(`  📊 Displayed payout: ${payoutText}`);
    t.lap('Payout displayed');
  } catch {
    console.log('  ⚠️  Could not read payout display (non-fatal)');
  }

  if (DRY_RUN) {
    console.log('  🚧 DRY RUN — "Place Bet" NOT clicked. Set DRY_RUN=false to go live.');
    t.end(`⏱  ${legLabel} (dry run)`);
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
  t.lap('"Place Bet" clicked');

  try {
    await page.waitForSelector(
      '.betslip__success, .betslip__confirmation, .betslip__details__button__place:disabled',
      { timeout: 10000 }
    );
    console.log('  🎉 Bet confirmed!');
  } catch {
    console.log('  ⚠️  Could not confirm bet placement — check the browser window.');
  }

  t.end(`⏱  ${legLabel} placed`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const RUN_START = Date.now();

  // Per-phase timing registry — printed in the summary at the end
  const timings = {};
  function record(key, ms) { timings[key] = ms; }

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

  // ── Fetch opportunities ───────────────────────────────────────────────────
  console.log('\n📡 Fetching arbitrage opportunities...');
  let opportunities;
  {
    const t = timer('API fetch');
    try {
      opportunities = await fetchArbOpportunities();
      console.log(`✅ Got ${opportunities.length} opportunity/ies`);
      record('API fetch', t.end());
    } catch (err) {
      console.error('❌ Failed to fetch from API:', err.message);
      t.end('⏱  API fetch (failed)');
      process.exit(1);
    }
  }

  if (opportunities.length === 0) {
    console.log('⚠️  No arbitrage opportunities available. Exiting.');
    process.exit(0);
  }

  // ── Browser launch ────────────────────────────────────────────────────────
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

  {
    const t = timer('Browser launch');
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
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
    record('Browser launch', t.end());

    const page = await context.newPage();

    // ── Session gate ────────────────────────────────────────────────────────
    if (!hasLoginSentinel()) {
      console.log('\n🔐 No prior login found — logging in for the first time...');
      const lt = timer('First login');
      try {
        await login(page);
        record('Login', lt.end());
      } catch (err) {
        console.error('❌ Login failed:', err.message);
        lt.end('⏱  Login (failed)');
        await context.close();
        process.exit(1);
      }
    } else {
      console.log('\n🔄 Prior login detected — verifying session...');
      const st = timer('Session validation');
      const valid = await isSessionValid(page);
      record('Session check', st.end());

      if (valid) {
        console.log('✅ Session is active — skipping login.');
      } else {
        console.log('⚠️  Session expired. Clearing sentinel and re-authenticating...');
        clearLoginSentinel();
        const lt = timer('Re-login');
        try {
          await login(page);
          record('Re-login', lt.end());
        } catch (err) {
          console.error('❌ Re-login failed:', err.message);
          lt.end('⏱  Re-login (failed)');
          await context.close();
          process.exit(1);
        }
      }
    }

    // ── Navigate to live page ───────────────────────────────────────────────
    console.log('\n🏀 Navigating to live betting page...');
    {
      const t = timer('Live page load');
      await page.goto('https://www.betika.com/en-ke/live', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      console.log('✅ Live page loaded');
      record('Live page load', t.end());
    }

    // ── Scroll & settle ─────────────────────────────────────────────────────
    {
      const t = timer('Scroll + settle');
      // ✅ Scroll instantly via JS, then wait for actual match elements rather
      //    than networkidle — Betika keeps background connections open forever
      //    so networkidle was burning the full 8s timeout every time.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await Promise.race([
        page.waitForSelector(
          '[class*="live-match"], [class*="live-event"], [class*="odd-market__container"]',
          { timeout: 6000 }
        ).catch(() => {}),
        page.waitForTimeout(2000), // fallback: give up after 2s if no matches live
      ]);
      console.log('✅ Scrolling done');
      record('Scroll + settle', t.end());
    }

    // ── Selector resolution ─────────────────────────────────────────────────
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

    {
      const t = timer('Selector probe');
      const [homeResults, containerResults] = await Promise.all([
        Promise.all(
          HOME_SELECTORS.map(async sel => {
            const found = await page.locator(sel).count();
            console.log(`  🔎 "${sel}" → ${found} element(s)`);
            return { sel, found };
          })
        ),
        Promise.all(
          CONTAINER_SELECTORS.map(async sel => {
            const found = await page.locator(sel).count();
            console.log(`  🔎 "${sel}" → ${found} element(s)`);
            return { sel, found };
          })
        ),
      ]);

      const resolvedHomeSelector      = homeResults.find(r => r.found > 0)?.sel ?? null;
      const resolvedContainerSelector = containerResults.find(r => r.found > 0)?.sel ?? null;
      record('Selector probe', t.end());

      if (!resolvedHomeSelector) {
        console.log('❌ No live match home-team elements found.');
        await page.screenshot({ path: '/tmp/betika-live-debug.png', fullPage: true });
        await context.close();
        process.exit(0);
      }
      if (!resolvedContainerSelector) {
        console.log('❌ No match container elements found.');
        await page.screenshot({ path: '/tmp/betika-live-debug.png', fullPage: true });
        await context.close();
        process.exit(0);
      }

      console.log(`✅ Using home selector      : "${resolvedHomeSelector}"`);
      console.log(`✅ Using container selector : "${resolvedContainerSelector}"`);

      // ── Match loop ──────────────────────────────────────────────────────
      const matchContainers = page.locator(resolvedContainerSelector);
      const count = await matchContainers.count();
      console.log(`🎯 Found ${count} live matches on page`);

      let clickedCount = 0;
      const betTimings = []; // per-opportunity timing

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

              const oppTimer = timer(`${opp.home} vs ${opp.away}`);
              const oddButtons = match.locator('.live-match__odd');

              // Leg 1: HOME
              const homeOddBtn = oddButtons.nth(0);
              await homeOddBtn.waitFor({ timeout: 20000 });
              await homeOddBtn.click();
              console.log(`🖱  Clicked HOME odd (${opp.homeOdd})`);

              let homeBetMs = 0;
              try {
                const bt = timer('Home bet');
                await placeBet(page, homeStake, 'Home leg');
                homeBetMs = bt.end();
              } catch (betErr) {
                console.error('  ❌ HOME bet failed:', betErr.message);
              }

              // Wait for betslip to reset before placing away leg
              await page.waitForFunction(
                () => {
                  const input = document.querySelector('input[name="amount"]');
                  return !input || input.value === '' || input.value === '0';
                },
                { timeout: 5000 }
              ).catch(() => {});

              // Leg 2: AWAY
              const awayOddBtn = oddButtons.nth(1);
              await awayOddBtn.waitFor({ timeout: 20000 });
              await awayOddBtn.click();
              console.log(`🖱  Clicked AWAY odd (${opp.awayOdd})`);

              let awayBetMs = 0;
              try {
                const bt = timer('Away bet');
                await placeBet(page, awayStake, 'Away leg');
                awayBetMs = bt.end();
              } catch (betErr) {
                console.error('  ❌ AWAY bet failed:', betErr.message);
              }

              const oppMs = oppTimer.end(`⏱  Opportunity done`);
              betTimings.push({
                match: `${opp.home} vs ${opp.away}`,
                homeMs: homeBetMs,
                awayMs: awayBetMs,
                totalMs: oppMs,
              });

              clickedCount++;
              await page.waitForTimeout(500);
              break;
            }
          }

        } catch (err) {
          console.log('⚠️  Skipping match (not fully loaded):', err.message);
        }
      }

      // ── Summary ─────────────────────────────────────────────────────────
      const TOTAL_MS = Date.now() - RUN_START;

      console.log('\n' + '═'.repeat(55));
      console.log('  📊 TIMING SUMMARY');
      console.log('═'.repeat(55));

      const phases = [
        ['API fetch',       timings['API fetch']],
        ['Browser launch',  timings['Browser launch']],
        ['Login',           timings['Login'] ?? timings['Re-login'] ?? timings['Session check']],
        ['Live page load',  timings['Live page load']],
        ['Scroll + settle', timings['Scroll + settle']],
        ['Selector probe',  timings['Selector probe']],
      ];

      for (const [label, ms] of phases) {
        if (ms == null) continue;
        const bar = '█'.repeat(Math.max(1, Math.round(ms / 500)));
        console.log(`  ${label.padEnd(18)} ${String(ms + 'ms').padStart(7)}  ${bar}`);
      }

      if (betTimings.length > 0) {
        console.log('  ' + '─'.repeat(51));
        for (const bt of betTimings) {
          console.log(`  Bet: ${bt.match}`);
          console.log(`    Home leg : ${bt.homeMs}ms`);
          console.log(`    Away leg : ${bt.awayMs}ms`);
          console.log(`    Total    : ${bt.totalMs}ms`);
        }
      }

      console.log('  ' + '─'.repeat(51));
      console.log(`  ${'TOTAL RUN TIME'.padEnd(18)} ${formatDuration(TOTAL_MS).padStart(7)}`);
      console.log('═'.repeat(55));

      if (clickedCount === 0) {
        console.log('\n❌ No matching arb opportunities found on page.');
      } else {
        console.log(`\n✅ Done. Placed bets for ${clickedCount} arbitrage opportunity/ies.`);
      }
    }

    await context.close();
  }
})();