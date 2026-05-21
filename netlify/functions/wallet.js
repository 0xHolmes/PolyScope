// netlify/functions/wallet.js
// Proxies Polymarket Gamma API + computes analytics + scoring

const GAMMA_BASE = "https://gamma-api.polymarket.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ─── Scoring Engine ──────────────────────────────────────────────────────────

function logScale(value, max) {
  if (value <= 0) return 0;
  return Math.min(Math.log10(value + 1) / Math.log10(max + 1), 1);
}

function computeScore(stats) {
  const {
    totalVolume,
    positionCount,
    uniqueMarkets,
    uniqueCategories,
    winRate,
    totalPnl,
    hasActivity,
  } = stats;

  if (!hasActivity) return { total: 0, breakdown: {} };

  // Sub-scores (each 0-10000 internally)
  const volumeRaw    = logScale(totalVolume,    500_000) * 10_000; // up to $500K
  const activityRaw  = logScale(positionCount,  500)     * 10_000; // up to 500 trades
  const diversityRaw = logScale(uniqueMarkets,  200)     * 10_000; // up to 200 markets
  const categoryRaw  = Math.min(uniqueCategories / 8, 1) * 10_000; // up to 8 categories
  const winRaw       = winRate                           * 10_000;
  const pnlRaw       = Math.min(Math.max((totalPnl + 10_000) / 20_000, 0), 1) * 10_000;

  // Weighted combination → 9000 max (leaves room for LP/social in future)
  const tradingScore = Math.round(
    volumeRaw    * 0.30 +
    activityRaw  * 0.22 +
    diversityRaw * 0.16 +
    categoryRaw  * 0.08 +
    winRaw       * 0.12 +
    pnlRaw       * 0.12
  );

  // Early adopter flat bonus (all wallets currently get it for participating)
  const earlyBonus = 400;

  const total = Math.min(Math.round((tradingScore / 10_000) * 8600) + earlyBonus, 9000);

  return {
    total,
    breakdown: {
      volume:       Math.round((volumeRaw    / 10_000) * 8600 * 0.30),
      activity:     Math.round((activityRaw  / 10_000) * 8600 * 0.22),
      diversity:    Math.round((diversityRaw / 10_000) * 8600 * 0.16),
      categories:   Math.round((categoryRaw  / 10_000) * 8600 * 0.08),
      winRate:      Math.round((winRaw       / 10_000) * 8600 * 0.12),
      profitability:Math.round((pnlRaw       / 10_000) * 8600 * 0.12),
      earlyAdopter: earlyBonus,
    },
  };
}

function estimateAllocation(score) {
  // Community pool assumption: 150,000,000 hypothetical tokens
  // Power curve distribution (score^0.7)
  // Uses a reference distribution against ~50,000 estimated active wallets
  const POOL       = 150_000_000;
  const EST_WALLETS = 50_000;
  const AVG_SCORE  = 1200; // assumed ecosystem average

  const walletPower = Math.pow(Math.max(score, 1), 0.7);
  const totalPower  = EST_WALLETS * Math.pow(AVG_SCORE, 0.7);
  const share       = walletPower / totalPower;

  const mid  = Math.round(share * POOL);
  return { low: Math.round(mid * 0.65), mid, high: Math.round(mid * 1.45) };
}

function estimatePercentile(score) {
  // Rough percentile based on score distribution
  // Assumes most wallets cluster in 500-2000 range
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

// ─── Badge Engine ────────────────────────────────────────────────────────────

function computeBadges(stats, score) {
  const badges = [];
  const { totalVolume, positionCount, uniqueMarkets, uniqueCategories, winRate } = stats;

  if (totalVolume >= 1_000_000)  badges.push({ id: "volume_legend",    name: "Volume Legend",    icon: "💎", tier: "platinum", desc: "Lifetime volume over $1M" });
  else if (totalVolume >= 100_000) badges.push({ id: "high_roller",    name: "High Roller",      icon: "💰", tier: "gold",     desc: "Lifetime volume over $100K" });
  else if (totalVolume >= 10_000)  badges.push({ id: "active_trader",  name: "Active Trader",    icon: "📈", tier: "silver",   desc: "Lifetime volume over $10K" });
  else if (totalVolume >= 1_000)   badges.push({ id: "getting_started",name: "Getting Started",  icon: "🌱", tier: "bronze",   desc: "Lifetime volume over $1K" });

  if (positionCount >= 500)  badges.push({ id: "power_user",    name: "Power User",      icon: "⚡", tier: "gold",     desc: "Over 500 trades placed" });
  else if (positionCount >= 100) badges.push({ id: "frequent",  name: "Frequent Trader", icon: "🔄", tier: "silver",   desc: "Over 100 trades placed" });

  if (uniqueMarkets >= 100)  badges.push({ id: "explorer",       name: "Market Explorer", icon: "🗺️", tier: "gold",    desc: "Traded in 100+ markets" });
  else if (uniqueMarkets >= 25) badges.push({ id: "diversified", name: "Diversified",     icon: "🎯", tier: "silver",  desc: "Traded in 25+ markets" });

  if (uniqueCategories >= 6) badges.push({ id: "generalist",    name: "Generalist",      icon: "🌐", tier: "silver",  desc: "Active across 6+ categories" });

  if (winRate >= 0.70 && positionCount >= 20) badges.push({ id: "alpha",   name: "Alpha Predictor", icon: "🧠", tier: "gold",    desc: "70%+ win rate on 20+ resolved markets" });
  else if (winRate >= 0.55 && positionCount >= 10) badges.push({ id: "sharp", name: "Sharp Mind",  icon: "🎯", tier: "silver",  desc: "55%+ win rate" });

  if (score.total >= 5000) badges.push({ id: "ecosystem_pillar", name: "Ecosystem Pillar", icon: "🏛️", tier: "platinum", desc: "Top ecosystem participant" });
  else if (score.total >= 2500) badges.push({ id: "ecosystem_member", name: "Ecosystem Member", icon: "⭐", tier: "gold", desc: "Significant ecosystem contribution" });

  // Always award participation badge
  badges.push({ id: "participant", name: "Polymarket Participant", icon: "✅", tier: "bronze", desc: "Active in the Polymarket ecosystem" });

  return badges;
}

// ─── Data Processing ─────────────────────────────────────────────────────────

function processPositions(positions) {
  if (!positions || !Array.isArray(positions) || positions.length === 0) {
    return {
      hasActivity: false,
      positionCount: 0,
      totalVolume: 0,
      currentValue: 0,
      totalPnl: 0,
      totalRealizedPnl: 0,
      winRate: 0,
      uniqueMarkets: 0,
      uniqueCategories: 0,
      categories: {},
      resolvedPositions: [],
      activePositions: [],
      recentPositions: [],
    };
  }

  const uniqueMarketIds  = new Set();
  const categoryCounts   = {};
  let totalVolume        = 0;
  let currentValue       = 0;
  let totalPnl           = 0;
  let realizedPnl        = 0;
  let wins               = 0;
  let resolved           = 0;

  const active   = [];
  const closed   = [];

  for (const pos of positions) {
    // Handle multiple possible field name formats from Gamma API
    const marketId  = pos.conditionId || pos.market?.conditionId || pos.marketId || "unknown";
    const category  = pos.category || pos.market?.category || pos.groupItemTitle || "Other";
    const initial   = parseFloat(pos.initialValue  || pos.costBasis      || 0);
    const current   = parseFloat(pos.currentValue  || pos.value          || 0);
    const cashPnl   = parseFloat(pos.cashPnl       || pos.profit         || 0);
    const realPnl   = parseFloat(pos.realizedPnl   || pos.realized_pnl   || 0);
    const isClosed  = pos.closed || pos.redeemed || pos.resolved || false;

    uniqueMarketIds.add(marketId);
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    totalVolume  += initial;
    currentValue += isClosed ? 0 : current;
    totalPnl     += cashPnl;
    realizedPnl  += realPnl;

    if (isClosed) {
      resolved++;
      if (cashPnl > 0 || realPnl > 0) wins++;
      closed.push(pos);
    } else {
      active.push(pos);
    }
  }

  const winRate = resolved > 0 ? wins / resolved : 0.5;

  return {
    hasActivity: true,
    positionCount: positions.length,
    totalVolume: Math.round(totalVolume * 100) / 100,
    currentValue: Math.round(currentValue * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalRealizedPnl: Math.round(realizedPnl * 100) / 100,
    winRate: Math.round(winRate * 1000) / 1000,
    uniqueMarkets: uniqueMarketIds.size,
    uniqueCategories: Object.keys(categoryCounts).length,
    categories: categoryCounts,
    resolvedCount: resolved,
    winsCount: wins,
    activePositions: active.slice(0, 10),
    recentPositions: positions.slice(0, 15).map(p => ({
      question:    p.title       || p.market?.question || p.question || "Unknown market",
      outcome:     p.outcome     || "—",
      category:    p.category    || p.market?.category || "Other",
      initialValue:parseFloat(p.initialValue  || p.costBasis   || 0),
      currentValue:parseFloat(p.currentValue  || p.value       || 0),
      cashPnl:     parseFloat(p.cashPnl       || p.profit      || 0),
      closed:      p.closed      || p.redeemed || false,
      size:        parseFloat(p.size || 0),
    })),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

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

  const normalizedAddress = address.toLowerCase();

  try {
    // Fetch positions from Polymarket Gamma API
    const url = `${GAMMA_BASE}/positions?user=${normalizedAddress}&sizeThreshold=0&limit=500`;

    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "PolyScope-Community/1.0" },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      throw new Error(`Gamma API responded with status ${response.status}`);
    }

    const rawData = await response.json();

    // Gamma API can return the array directly or wrapped in { data: [...] }
    const positions = Array.isArray(rawData) ? rawData : (rawData.data || rawData.results || []);

    const stats    = processPositions(positions);
    const score    = computeScore(stats);
    const alloc    = estimateAllocation(score.total);
    const pctile   = estimatePercentile(score.total);
    const badges   = computeBadges(stats, score);

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
      },
      body: JSON.stringify({
        address: normalizedAddress,
        stats,
        score,
        allocation: alloc,
        percentile: pctile,
        badges,
        disclaimer:
          "Community-generated estimate. POLY token does not exist. Not affiliated with Polymarket.",
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("wallet function error:", err.message);

    if (err.name === "TimeoutError" || err.message.includes("timeout")) {
      return {
        statusCode: 504,
        headers: CORS,
        body: JSON.stringify({ error: "Request timed out. Polymarket API may be slow — try again in a moment." }),
      };
    }

    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: `Failed to fetch data: ${err.message}` }),
    };
  }
};
