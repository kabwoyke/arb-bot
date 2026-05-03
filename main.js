const { chromium } = require('playwright');
const levenshtein = require('fast-levenshtein');
const dotenv = require("dotenv")

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
 
// 🗂 Mock data — mirrors the real API response shape
const MOCK_DATA = {
  success: true,
  bankroll: 1000,
  count: 2,
  opportunities: [
    {
      matchId: 4579183,
      competition: "PBA, Commissioner Cup",
      home: "galfi, dalma",
      away: "Tomljanovic",
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
 
async function login(page) {
  if (!BETIKA_PHONE || !BETIKA_PASSWORD) {
    throw new Error(
      '❌ Missing credentials. Set BETIKA_PHONE and BETIKA_PASSWORD environment variables.'
    );
  }
 
  console.log('🔐 Navigating to login page...');
  await page.goto('https://www.betika.com/en-ke/login', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="phone-number"]', { timeout: 15000 });
 
  console.log('📱 Entering phone number...');
  await page.locator('input[name="phone-number"]').fill(BETIKA_PHONE);
 
  console.log('🔑 Entering password...');
  await page.locator('input[name="password"]').fill(BETIKA_PASSWORD);
 
  console.log('🚀 Clicking Login button...');
  await page.locator('button.session__form__button').click();
 
  console.log('⏳ Waiting for login to complete...');
  try {
    await page.waitForSelector('.session__form', { state: 'detached', timeout: 20000 });
  } catch {
    const errorEls = page.locator('.session__form .input__desc span, .session__form__error');
    const count = await errorEls.count();
    for (let i = 0; i < count; i++) {
      const txt = (await errorEls.nth(i).textContent().catch(() => '')).trim();
      if (txt && !txt.toLowerCase().startsWith('enter your')) {
        throw new Error('Login rejected — ' + txt);
      }
    }
    throw new Error('Login timed out — form still visible after 20s. Check credentials.');
  }
 
  console.log('✅ Logged in successfully!');
  await page.waitForTimeout(2000);
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
  const roundedStake = Math.round(stakeAmount); // Betika only accepts integers

  console.log(`\n  💳 Opening betslip — stake: KES ${roundedStake}`);

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
    // Betika shows a success state — betslip either clears or shows confirmation
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
  console.log('📡 Fetching arbitrage opportunities...');
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
 
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
 
  try {
    await login(page);
  } catch (err) {
    console.error('❌ Login failed:', err.message);
    await browser.close();
    process.exit(1);
  }
 
  // 🏀 Navigate to live betting page
  console.log('🏀 Navigating to live betting page...');
  await page.goto('https://www.betika.com/en-ke/live/', { waitUntil: 'networkidle' });
  console.log('✅ Live page loaded');
 
  await page.waitForTimeout(5000);
 
  // Scroll to load more matches
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(1500);
  }
  console.log('✅ Scrolling done');
 
  await page.waitForSelector('.live-match__teams__home', { timeout: 60000 });
 
  const matchContainers = page.locator('.live-match__odd-market__container');
  const count = await matchContainers.count();
  console.log(`🎯 Found ${count} live matches on page`);
 
  let clickedCount = 0;
 
  for (let i = 0; i < count; i++) {
    const match = matchContainers.nth(i);
 
    try {
      const home = await match.locator('.live-match__teams__home span').nth(1).textContent();
      const away = await match.locator('.live-match__teams__away span').nth(1).textContent();
 
      console.log(`\n🔎 UI Match: "${home}" vs "${away}"`);
 
      for (const opp of opportunities) {
        const homeMatch = isTeamMatch(home, opp.home);
        const awayMatch = isTeamMatch(away, opp.away);
 
        if (homeMatch && awayMatch) {
          console.log(`✅ MATCH FOUND! → ${opp.home} vs ${opp.away}`);
          console.log(`   📊 Profit margin: ${(opp.profitMargin * 100).toFixed(2)}%`);
          console.log(`   💰 Stakes — Home: KES ${opp.opportunity.stakes.home.toFixed(2)}, Away: KES ${opp.opportunity.stakes.away.toFixed(2)}`);

          const oddButtons = match.locator('.live-match__odd');
 
          // ── Leg 1: HOME ──────────────────────────────────────────────────
          const homeOddBtn = oddButtons.nth(0);
          await homeOddBtn.waitFor({ timeout: 10000 });
          await homeOddBtn.click();
          console.log(`🖱  Clicked HOME odd (${opp.homeOdd})`);

          // Place the HOME leg bet
          try {
            await placeBet(page, opp.opportunity.stakes.home);
          } catch (betErr) {
            console.error('  ❌ HOME bet placement failed:', betErr.message);
          }

          await page.waitForTimeout(2000);
 
          // ── Leg 2: AWAY ──────────────────────────────────────────────────
          const awayOddBtn = oddButtons.nth(1);
          await awayOddBtn.waitFor({ timeout: 10000 });
          await awayOddBtn.click();
          console.log(`🖱  Clicked AWAY odd (${opp.awayOdd})`);

          // Place the AWAY leg bet
          try {
            await placeBet(page, opp.opportunity.stakes.away);
          } catch (betErr) {
            console.error('  ❌ AWAY bet placement failed:', betErr.message);
          }
 
          clickedCount++;
          await page.waitForTimeout(2000);
          break; // This opportunity is handled — move to next match
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
  await browser.close();
})();