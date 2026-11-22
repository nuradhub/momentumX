import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

// --- tiny cache (30s) ---
const cache = new Map();
const TTL = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logError = (label, e) => {
  console.log(`[${label}] FAILED`, {
    code: e.code,
    status: e.response?.status,
    data: JSON.stringify(e.response?.data)?.slice(0, 200),
    message: e.message,
  });
};

const getWithRetry = async (url, opts = {}, retries = 1) => {
  try {
    return await axios.get(url, { timeout: 8000, headers: HEADERS, ...opts });
  } catch (e) {
    if (e.response?.status === 429 && retries > 0) {
      console.log(`[retry] 429 on ${url.split("/")[2]}, waiting 2s`);
      await sleep(2000);
      return getWithRetry(url, opts, retries - 1);
    }
    throw e;
  }
};

export const GetContractDetails = async (ctx, ca) => {
  const userId = ctx?.from?.id || "N/A";
  const mint = String(ca ?? "").trim();
  console.log(`[CA] received: ${JSON.stringify(mint)} (length ${mint.length})`);

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    console.log("[CA] invalid format");
    return [];
  }

  const hit = cache.get(mint);
  if (hit && Date.now() - hit.t < TTL) {
    console.log("[cache] hit");
    return [{ ...hit.v, userId }];
  }
  const done = (v) => {
    cache.set(mint, { t: Date.now(), v });
    return [{ ...v, userId }];
  };

  // --- 1. GECKOTERMINAL ---
  try {
    const res = await getWithRetry(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`
    );
    const a = res.data?.data?.attributes;
    console.log(`[GeckoTerminal] status ${res.status}, symbol: ${a?.symbol}, price: ${a?.price_usd}`);
    if (a?.symbol && a?.price_usd) {
      return done({
        source: "GeckoTerminal",
        symbol: a.symbol,
        chain: "solana",
        dex: "Aggregated",
        price: `$${a.price_usd}`,
        liquidity: a.total_reserve_in_usd
          ? `$${Number(a.total_reserve_in_usd).toLocaleString()}`
          : "N/A",
      });
    }
  } catch (e) {
    logError("GeckoTerminal", e);
  }

  // --- 2. DEXSCREENER ---
  try {
    const res = await getWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = res.data?.pairs;
    console.log(`[DexScreener] status ${res.status}, pairs: ${Array.isArray(pairs) ? pairs.length : pairs}`);
    if (Array.isArray(pairs) && pairs.length > 0) {
      const best = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      return done({
        source: "DexScreener",
        price: best.priceUsd ? `$${best.priceUsd}` : "N/A",
        liquidity: best.liquidity?.usd ? `$${best.liquidity.usd.toLocaleString()}` : "N/A",
        dex: best.dexId || "N/A",
        chain: best.chainId || "N/A",
        symbol: best.baseToken?.symbol || "N/A",
      });
    }
  } catch (e) {
    logError("DexScreener", e);
  }

  // --- 3. ON-CHAIN PUMP.FUN BONDING CURVE ---
  try {
    const mintKey = new PublicKey(mint);
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintKey.toBuffer()],
      PUMP_PROGRAM
    );
    const info = await connection.getAccountInfo(curve);
    console.log(`[on-chain] curve ${curve.toBase58()} exists: ${!!info}`);

    if (info && info.data.length >= 49) {
      const d = info.data; // 8-byte discriminator, then u64 fields
      const vTok = Number(d.readBigUInt64LE(8));
      const vSol = Number(d.readBigUInt64LE(16));
      const complete = d[48] === 1;
      const priceSol = vSol && vTok ? (vSol / 1e9) / (vTok / 1e6) : 0;
      return done({
        source: "pump.fun (on-chain)",
        symbol: "N/A", // not stored in the curve account
        chain: "solana",
        dex: complete ? "Migrated (PumpSwap/Raydium)" : "pump.fun",
        price: `${priceSol.toFixed(9)} SOL`,
        liquidity: `${(vSol / 1e9).toFixed(2)} SOL`,
      });
    }
  } catch (e) {
    logError("on-chain", e);
  }

  console.log("[CA] no data found in any source");
  return [];
};
