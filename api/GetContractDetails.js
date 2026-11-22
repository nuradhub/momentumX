import axios from "axios";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

const logError = (label, e) => {
  console.log(`[${label}] FAILED`, {
    code: e.code,                                   // ENOTFOUND, ECONNRESET, ECONNABORTED...
    status: e.response?.status,                     // 400, 403, 404, 429...
    data: JSON.stringify(e.response?.data)?.slice(0, 300),
    message: e.message,
  });
};

export const GetContractDetails = async (ctx, ca) => {
  const userId = ctx?.from?.id || "N/A";
  const mint = String(ca ?? "").trim();

  console.log(`[CA] received: ${JSON.stringify(mint)} (length ${mint.length})`);

  // Solana addresses are base58 and 32-44 chars
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    console.log("[CA] invalid format, skipping all APIs");
    return [];
  }

  try {
    // --- OPTION 1: DEXSCREENER ---
    try {
      const res = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeout: 8000, headers: HEADERS }
      );
      const pairs = res.data?.pairs;
      console.log(`[DexScreener] status ${res.status}, pairs: ${Array.isArray(pairs) ? pairs.length : pairs}`);

      if (Array.isArray(pairs) && pairs.length > 0) {
        const best = [...pairs].sort(
          (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];

        return [{
          source: "DexScreener",
          userId,
          price: best.priceUsd ? `$${best.priceUsd}` : "N/A",
          liquidity: best.liquidity?.usd ? `$${best.liquidity.usd.toLocaleString()}` : "N/A",
          dex: best.dexId || "N/A",
          chain: best.chainId || "N/A",
          symbol: best.baseToken?.symbol || "N/A",
        }];
      }
      console.log("[DexScreener] no pairs, trying next source");
    } catch (e) {
      logError("DexScreener", e);
    }

    // --- OPTION 2: PUMP.FUN FRONTEND API (bonding curve) ---
    try {
      const res = await axios.get(
        `https://frontend-api-v3.pump.fun/coins/${mint}`,
        { timeout: 8000, headers: HEADERS }
      );
      const d = res.data;
      console.log(`[pump.fun] status ${res.status}, symbol: ${d?.symbol}, complete: ${d?.complete}`);

      if (d?.symbol) {
        const vSol = Number(d.virtual_sol_reserves);
        const vTok = Number(d.virtual_token_reserves);
        const priceSol = vSol && vTok ? (vSol / 1e9) / (vTok / 1e6) : 0;

        return [{
          source: "pump.fun",
          userId,
          symbol: d.symbol,
          chain: "solana",
          dex: d.complete ? "Raydium/PumpSwap" : "pump.fun",
          price: `${priceSol.toFixed(9)} SOL`,
          liquidity: `${(vSol / 1e9).toFixed(2)} SOL`,
        }];
      }
      console.log("[pump.fun] no symbol in response, trying next source");
    } catch (e) {
      logError("pump.fun", e);
    }

    // --- OPTION 3: JUPITER (needs API key from portal.jup.ag) ---
    if (process.env.JUPITER_API_KEY) {
      try {
        const res = await axios.get(
          `https://api.jup.ag/price/v3?ids=${mint}`,
          { timeout: 8000, headers: { ...HEADERS, "x-api-key": process.env.JUPITER_API_KEY } }
        );
        console.log(`[Jupiter] status ${res.status}, body: ${JSON.stringify(res.data)?.slice(0, 200)}`);

        const jup = res.data?.[mint];
        const price = jup?.usdPrice ?? jup?.price;

        if (price) {
          return [{
            source: "Jupiter",
            userId,
            symbol: "TOKEN",
            chain: "solana",
            dex: "Aggregated",
            price: `$${Number(price).toFixed(10)}`,
            liquidity: jup?.liquidity ? `$${Number(jup.liquidity).toLocaleString()}` : "Check Dex",
          }];
        }
        console.log("[Jupiter] no price for this mint");
      } catch (e) {
        logError("Jupiter", e);
      }
    } else {
      console.log("[Jupiter] skipped: JUPITER_API_KEY not set");
    }

    console.log("[CA] no data found in any source");
    return [];
  } catch (err) {
    console.error("General Data Fetch Error:", err.message);
    return [];
  }
};
