# PolyScope — Polymarket Analytics

> **Community-built estimate model based on historical activity and ecosystem participation.**
> Not affiliated with, endorsed by, or connected to Polymarket. POLY token does not exist.
> All allocation estimates are speculative and for research/entertainment purposes only.

---

## Step-by-Step: Deploy to Netlify via GitHub

### What this does
Checks any Polymarket wallet address using Polymarket's public API, computes a participation score,
and shows estimated allocation, badges, and market stats. Fully free to host.

---

### Step 1 — Create GitHub Repository

1. Go to [github.com](https://github.com) and click **New repository**
2. Name it `polyscope` (or anything you like)
3. Set it to **Public**
4. Click **Create repository**

---

### Step 2 — Upload the Files

You need exactly **3 files** in this structure:

```
your-repo/
├── index.html
├── netlify.toml
└── netlify/
    └── functions/
        └── wallet.js
```

**Option A — GitHub web upload (easiest):**

1. In your new repo, click **Add file → Upload files**
2. Upload `index.html` and `netlify.toml`
3. Then click **Add file → Create new file**
4. Type the path: `netlify/functions/wallet.js`
5. Paste the contents of `wallet.js` into the editor
6. Click **Commit new file**

**Option B — Git command line:**
```bash
git clone https://github.com/YOUR_USERNAME/polyscope.git
cd polyscope

# Copy the 3 files into this folder, then:
git add .
git commit -m "Initial PolyScope deployment"
git push origin main
```

---

### Step 3 — Connect to Netlify

1. Go to [netlify.com](https://netlify.com) and sign up (free)
2. Click **Add new site → Import an existing project**
3. Choose **GitHub** and authorize Netlify
4. Select your `polyscope` repository
5. Netlify will auto-detect settings from `netlify.toml`
6. Click **Deploy site**

Netlify will give you a URL like `https://random-name-12345.netlify.app`

You can change it to a custom name under **Site settings → Change site name**.

---

### Step 4 — Test It

1. Wait ~1-2 minutes for the first deploy to finish
2. Open your Netlify URL
3. Paste a Polymarket wallet address (any address that has traded on Polymarket)
4. Click **Analyze Wallet**

**Find a wallet to test with:**
- Go to [polymarket.com](https://polymarket.com) → any market → "View all traders"
- Copy any trader's wallet address

---

### That's it! 🎉

Your site is live. Every time you push changes to GitHub, Netlify auto-redeploys.

---

## File Structure Explained

| File | Purpose |
|------|---------|
| `index.html` | The entire frontend — landing page, wallet checker, results UI, charts, badges |
| `netlify.toml` | Tells Netlify where the functions folder is |
| `netlify/functions/wallet.js` | Serverless function that proxies Polymarket's API and computes scoring |

---

## How the Scoring Works

The scoring engine is in `netlify/functions/wallet.js`:

```
Score (max 9,000) = sum of weighted sub-scores × quality multiplier

Volume Score      → log-normalized, up to $500K
Activity Score    → log-normalized, up to 500 positions
Diversity Score   → log-normalized, up to 200 unique markets
Category Score    → linear, up to 8 categories
Win Rate Score    → linear, 0–100%
Profitability     → PnL-based
Early Adopter     → flat bonus for any ecosystem participant
```

Estimated allocation uses a power-curve (`score^0.7`) distribution
against a hypothetical 150M token community pool.

---

## Customization

### Change the scoring formula
Edit `netlify/functions/wallet.js` → `computeScore()` function.

### Change the UI colors
Edit `index.html` → `:root { }` CSS variables at the top:
```css
--green:   #00E596;   /* main accent */
--purple:  #9B6DFF;   /* secondary accent */
--bg:      #060608;   /* background */
```

### Add a custom domain
In Netlify: **Site settings → Domain management → Add custom domain**

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Failed to fetch" error | Polymarket API may be temporarily down — try again |
| "Invalid wallet address" | Make sure it starts with `0x` and is 42 characters |
| No positions shown | Wallet may not have traded on Polymarket, or API returned no data |
| Function timeout | Very large wallets (500+ positions) may be slow — refresh and retry |
| Site not deploying | Check the Netlify deploy log for errors |

---

## Disclaimer

This is a community-built tool. POLY token does not exist. No airdrop has been announced by Polymarket.
All score calculations and allocation estimates are speculative, for entertainment/research purposes only.
Not affiliated with Polymarket in any capacity.
