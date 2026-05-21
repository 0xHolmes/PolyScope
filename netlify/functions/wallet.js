// netlify/functions/wallet.js
// Fixed: tries multiple Polymarket API endpoints to find user data

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_BASE  = "https://data-api.polymarket.com";
const CLOB_BASE  = "https://clob.polymarket.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const FETCH_OPTS = {
  headers: {
    Accept: "application/json",
    "User-Agent": "PolyScope-Community/1.0",
  },
  signal: AbortSignal.timeout(12_000),
};

// ─── Try multiple endpoints ──────────────────────────────────────────────────

async function fetchPositions(address) {
  // Polymarket has several API surfaces — try each one
  const endpoints = [
    // Data API (most likely for user positions)
    `${DATA_BASE}/positions?user=${address}&sizeThreshold=0&limit=500`,
    `${DATA_BASE}/positions?user_address=${address}&limit=500`,
    // Gamma API variants
    `${GAMMA_BASE}/positions?user=${address}&sizeThreshold=0&limit=500`,
    `${GAMMA_BASE}/positions?user_address=${address}&limit=500`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`Trying positions endpoint: ${url}`);
      const res = await fetch(url, FETCH_OPTS);
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || data.results || data.positions || []);
        console.log(`Success: ${arr.length} positions from ${url}`);
        return { positions: arr, source: "positions" };
      }
      console.log(`${url} returned ${res.status}`);
    } catch (err) {
      console.log(`${url} failed: ${err.message}`);
    }
  }

  return { positions: [], source: "none" };
}

async function fetchClobTrades(address) {
  // CLOB API gives raw trade history even without a positions endpoint
  const endpoints = [
    `${CLOB_BASE}/data/trades?user=${address}&limit=500`,
    `${CLOB_BASE}/trades?taker=${address}&limit=500`,
    `${CLOB_BASE}/trades?maker=${address}&limit=500`,
  ];

  const allTrades = [];
  const seen = new Set();

  for (const url of endpoints) {
    try {
      console.log(`Trying CLOB: ${url}`);
      const res = await fetch(url, FETCH_OPTS);
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.data || data.trades || []);
        for (const t of arr) {
          const id = t.id || t.transaction_hash || JSON.stringify(t).slice(0,40);
          if (!seen.has(id)) { seen.add(id); allTrades.push(t); }
        }
        console.log(`CLOB ${url}: got ${arr.length} trades`);
      }
    } catch (err) {
      console.log(`CLOB ${url} failed: ${err.message}`);
    }
  }

  return allTrades;
}

async function fetchGammaActivity(address) {
  // Gamma API activity endpoint
  try {
    const url = `${GAMMA_BASE}/activity?user=${address}&limit=200`;
    const res = await fetch(url, FETCH_OPTS);
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : (data.data || data.activity || []);
    }
  } catch {}
  return [];
}

// ─── Normalize different data formats into a common position shape ────────────

function normalizeClobTrades(trades) {
  // Group CLOB trades by market into position-like objects
  const markets = {};
  for (const t of trades) {
    const mid = t.market || t.condition_id || t.conditionId || "unknown";
    if (!markets[mid]) {
      markets[mid] = {
        conditionId: mid,
        title: t.title || t.market_question || t.question || "Unknown market",
        category: t.category || t.event_slug || "Other",
        outcome: t.outcome || t.side || "Yes",
        initialValue: 0,
        currentValue: 0,
        cashPnl: 0,
        realizedPnl: 0,
        closed: false,
        tradeCount: 0,
      };
    }
    const price  = parseFloat(t.price || 0);
    const size   = parseFloat(t.size  || t.amount || 0);
    const spent  = price * size;
    markets[mid].initialValue += spent;
    markets[mid].tradeCount++;
    if (t.outcome_price !== undefined) {
      const gain = parseFloat(t.outcome_price || 0) * size;
      markets[mid].cashPnl += (gain - spent);
    }
  }
  return Object.values(markets);
}

function normalizeGammaActivity(activity) {
  return activity.map(a => ({
    conditionId: a.conditionId || a.market_id || "unknown",
    title:       a.title       || a.question   || "Unknown market",
    category:    a.category    || "Other",
    outcome:     a.outcome     || "Yes",
    initialValue:parseFloat(a.usdcAmount || a.amount || a.initialValue || 0),
    currentValue:parseFloat(a.currentValue || 0),
    cashPnl:     parseFloat(a.profit      || a.pnl   || a.cashPnl || 0),
    realizedPnl: parseFloat(a.realizedPnl || 0),
    closed:      a.type === "REDEEM" || a.closed || false,
    size:        parseFloat(a.size || 0),
  }));
}

// ─── Scoring Engine ───────────────────────────────────────────────────────────

function logScale(value, max) {
  if (value <= 0) return 0;
  return Math.min(Math.log10(value + 1) / Math.log10(max + 1), 1);
}

function computeScore(stats) {
  if (!stats.hasActivity) return { total: 0, breakdown: {} };

  const volumeRaw    = logScale(stats.totalVolume,    500_000) * 10_000;
  const activityRaw  = logScale(stats.positionCount,  500)     * 10_000;
  const diversityRaw = logScale(stats.uniqueMarkets,  200)     * 10_000;
  const categoryRaw  = Math.min(stats.uniqueCategories / 8, 1) * 10_000;
  const winRaw       = (stats.resolvedCount > 0 ? stats.winRate : 0.5) * 10_000;
  const pnlRaw       = Math.min(Math.max((stats.totalPnl + 10_000) / 20_000, 0), 1) * 10_000;

  const tradingScore = Math.round(
    volumeRaw    * 0.30 +
    activityRaw  * 0.22 +
    diversityRaw * 0.16 +
    categoryRaw  * 0.08 +
    winRaw       * 0.12 +
    pnlRaw       * 0.12
  );

  const earlyBonus = 400;
  const total = Math.min(Math.round((tradingScore / 10_000) * 8600) + earlyBonus, 9000);

  return {
    total,
    breakdown: {
      volume:        Math.round((volumeRaw    / 10_000) * 8600 * 0.30),
      activity:      Math.round((activityRaw  / 10_000) * 8600 * 0.22),
      diversity:     Math.round((diversityRaw / 10_000) * 8600 * 0.16),
      categories:    Math.round((categoryRaw  / 10_000) * 8600 * 0.08),
      winRate:       Math.round((winRaw       / 10_000) * 8600 * 0.12),
      profitability: Math.round((pnlRaw       / 10_000) * 8600 * 0.12),
      earlyAdopter:  earlyBonus,
    },
  };
}

function estimateAllocation(score) {
  const POOL = 150_000_000;
  const walletPower = Math.pow(Math.max(score, 1), 0.7);
  const totalPower  = 50_000 * Math.pow(1200, 0.7);
  const share       = walletPower / totalPower;
  const mid         = Math.round(share * POOL);
  return { low: Math.round(mid * 0.65), mid, high: Math.round(mid * 1.45) };
}

function estimatePercentile(score) {
  if (score >= 8000) return 99.5;
  if (score >= 6000) return 98;
  if (score >= 4500) return 95;
  if (score >= 3000) return 90;
  if (score >= 2000) return 80;
  if (score >= 1200) return 65;
  if (score >= 700)  return 50;
  if (score >= 300)  return 35;
  return 20;
}

// ─── Process positions into stats ────────────────────────────────────────────

function processPositions(positions) {
  if (!positions || positions.length === 0) {
    return { hasActivity: false, positionCount: 0, totalVolume: 0, currentValue: 0,
             totalPnl: 0, totalRealizedPnl: 0, winRate: 0, uniqueMarkets: 0,
             uniqueCategories: 0, categories: {}, resolvedCount: 0, winsCount: 0,
             activePositions: [], recentPositions: [] };
  }

  const uniqueMarketIds = new Set();
  const categoryCounts  = {};
  let totalVolume = 0, currentValue = 0, totalPnl = 0, realizedPnl = 0;
  let wins = 0, resolved = 0;

  for (const pos of positions) {
    const marketId  = pos.conditionId || pos.market_id || pos.marketId || "unknown";
    const category  = pos.category    || pos.market?.category || pos.event_slug || "Other";
    const initial   = parseFloat(pos.initialValue  || pos.costBasis || pos.usdcAmount || 0);
    const current   = parseFloat(pos.currentValue  || pos.value     || 0);
    const cashPnl   = parseFloat(pos.cashPnl       || pos.profit    || pos.pnl || 0);
    const realPnl   = parseFloat(pos.realizedPnl   || 0);
    const isClosed  = pos.closed || pos.redeemed   || pos.resolved  || false;

    uniqueMarketIds.add(marketId);
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    totalVolume  += initial;
    currentValue += isClosed ? 0 : current;
    totalPnl     += cashPnl;
    realizedPnl  += realPnl;

    if (isClosed) {
      resolved++;
      if (cashPnl > 0 || realPnl > 0) wins++;
    }
  }

  return {
    hasActivity:      true,
    positionCount:    positions.length,
    totalVolume:      Math.round(totalVolume  * 100) / 100,
    currentValue:     Math.round(currentValue * 100) / 100,
    totalPnl:         Math.round(totalPnl     * 100) / 100,
    totalRealizedPnl: Math.round(realizedPnl  * 100) / 100,
    winRate:          resolved > 0 ? Math.round((wins / resolved) * 1000) / 1000 : 0,
    uniqueMarkets:    uniqueMarketIds.size,
    uniqueCategories: Object.keys(categoryCounts).length,
    categories:       categoryCounts,
    resolvedCount:    resolved,
    winsCount:        wins,
    recentPositions:  positions.slice(0, 15).map(p => ({
      question:     p.title       || p.question || p.market?.question || "Unknown market",
      outcome:      p.outcome     || "—",
      category:     p.category    || p.market?.category || "Other",
      initialValue: parseFloat(p.initialValue  || p.costBasis || 0),
      currentValue: parseFloat(p.currentValue  || p.value     || 0),
      cashPnl:      parseFloat(p.cashPnl       || p.profit    || 0),
      closed:       p.closed      || p.redeemed || false,
      size:         parseFloat(p.size || 0),
    })),
  };
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function computeBadges(stats, score) {
  const badges = [];
  const { totalVolume, positionCount, uniqueMarkets, uniqueCategories, winRate, resolvedCount } = stats;

  if      (totalVolume >= 1_000_000) badges.push({ id:"vol_legend",   name:"Volume Legend",        icon:"💎", tier:"platinum", desc:"Lifetime volume over $1M" });
  else if (totalVolume >= 100_000)   badges.push({ id:"high_roller",  name:"High Roller",           icon:"💰", tier:"gold",    desc:"Lifetime volume over $100K" });
  else if (totalVolume >= 10_000)    badges.push({ id:"active_trader",name:"Active Trader",          icon:"📈", tier:"silver",  desc:"Lifetime volume over $10K" });
  else if (totalVolume >= 1_000)     badges.push({ id:"starter",      name:"Getting Started",        icon:"🌱", tier:"bronze",  desc:"Lifetime volume over $1K" });

  if      (positionCount >= 500)     badges.push({ id:"power_user",   name:"Power User",             icon:"⚡", tier:"gold",    desc:"500+ positions placed" });
  else if (positionCount >= 100)     badges.push({ id:"frequent",     name:"Frequent Trader",        icon:"🔄", tier:"silver",  desc:"100+ positions" });
  else if (positionCount >= 10)      badges.push({ id:"trading",      name:"Trader",                 icon:"🎲", tier:"bronze",  desc:"10+ positions" });

  if      (uniqueMarkets >= 100)     badges.push({ id:"explorer",     name:"Market Explorer",        icon:"🗺️", tier:"gold",   desc:"100+ unique markets" });
  else if (uniqueMarkets >= 25)      badges.push({ id:"diversified",  name:"Diversified",            icon:"🎯", tier:"silver",  desc:"25+ unique markets" });

  if (uniqueCategories >= 6)         badges.push({ id:"generalist",   name:"Generalist",             icon:"🌐", tier:"silver",  desc:"6+ categories traded" });

  if (winRate >= 0.70 && resolvedCount >= 20) badges.push({ id:"alpha",  name:"Alpha Predictor",    icon:"🧠", tier:"gold",    desc:"70%+ win rate (20+ resolved)" });
  else if (winRate >= 0.55 && resolvedCount >= 10) badges.push({ id:"sharp", name:"Sharp Mind",     icon:"🎯", tier:"silver",  desc:"55%+ win rate" });

  if      (score.total >= 5000)      badges.push({ id:"pillar",       name:"Ecosystem Pillar",       icon:"🏛️", tier:"platinum",desc:"Top ecosystem score" });
  else if (score.total >= 2500)      badges.push({ id:"member",       name:"Ecosystem Member",       icon:"⭐", tier:"gold",    desc:"Strong ecosystem score" });

  badges.push({ id:"participant", name:"Polymarket Participant", icon:"✅", tier:"bronze", desc:"Active in the Polymarket ecosystem" });
  return badges;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  const address = event.queryStringParameters?.address;

  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: "Please enter a valid Ethereum wallet address (0x...)" }),
    };
  }

  const addr = address.toLowerCase();

  try {
    // 1. Try positions endpoints
    let { positions } = await fetchPositions(addr);

    // 2. If no positions, try CLOB trades API
    if (positions.length === 0) {
      const clobTrades = await fetchClobTrades(addr);
      if (clobTrades.length > 0) {
        positions = normalizeClobTrades(clobTrades);
        console.log(`Using ${positions.length} CLOB-derived positions`);
      }
    }

    // 3. If still nothing, try Gamma activity feed
    if (positions.length === 0) {
      const activity = await fetchGammaActivity(addr);
      if (activity.length > 0) {
        positions = normalizeGammaActivity(activity);
        console.log(`Using ${positions.length} Gamma-activity-derived positions`);
      }
    }

    const stats  = processPositions(positions);
    const score  = computeScore(stats);
    const alloc  = estimateAllocation(score.total);
    const pctile = estimatePercentile(score.total);
    const badges = computeBadges(stats, score);

    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=60, stale-while-revalidate=120" },
      body: JSON.stringify({
        address: addr,
        stats,
        score,
        allocation: alloc,
        percentile: pctile,
        badges,
        disclaimer: "Community-generated estimate. POLY token does not exist. Not affiliated with Polymarket.",
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("wallet function error:", err.message);

    if (err.name === "TimeoutError" || err.message.includes("timeout")) {
      return { statusCode: 504, headers: CORS, body: JSON.stringify({ error: "Request timed out. Try again in a moment." }) };
    }

    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Fetch failed: ${err.message}` }) };
  }
};
