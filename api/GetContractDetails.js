import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

// --- tiny cache (30s) ---
const cache = new Map();
const TTL = 30_000;

// --- skip a rate-limited source for 60s ---
const blockedUntil = new Map();
const COOLDOWN = 60_000;
const isBlocked = (name) => (blockedUntil.get(name) || 0) > Date.now();

const logError = (label, e) => {
  console.log(`[${label}] FAILED`, {
    code: e.code,
    status: e.response?.status,
    data: JSON.stringify(e.response?.data)?.slice(0, 200),
    message: e.message,
  });
};

const apiGet = async (name, url) => {
  try {
    return await axios.get(url, { timeout: 8000, headers: HEADERS });
  } catch (e) {
    if (e.response?.status === 429) {
      blockedUntil.set(name, Date.now() + COOLDOWN);
      console.log(`[${name}] 429, skipping this source for 60s`);
    }
    throw e;
  }
};

// Reads the token symbol from the Metaplex metadata account (works on any RPC)
const getSymbol = async (mintKey) => {
  try {
    const [metaPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mintKey.toBuffer()],
      METADATA_PROGRAM
    );
    const info = await connection.getAccountInfo(metaPda);
    if (!info || info.data.length < 115) return "N/A";
    const d = info.data;
    // key(1) + updateAuthority(32) + mint(32) + name(4 + 32) + symbol(4 + 10)
    const len = Math.min(d.readUInt32LE(101), 10);
    const symbol = d.slice(105, 105 + len).toString("utf8").replace(/\0/g, "").trim();
    return symbol || "N/A";
  } catch (e) {
    logError("symbol", e);
    return "N/A";
  }
};

const getSolUsd = async () => {
  try {
    const r = await axios.get("https://api.coinbase.com/v2/prices/SOL-USD/spot", { timeout: 5000 });
    const p = Number(r.data?.data?.amount);
    return p > 0 ? p : null;
  } catch (e) {
    logError("SOL price", e);
    return null;
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
  if (!isBlocked("GeckoTerminal")) {
    try {
      const res = await apiGet(
        "GeckoTerminal",
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
  } else {
    console.log("[GeckoTerminal] skipped (cooldown)");
  }

  // --- 2. DEXSCREENER ---
  if (!isBlocked("DexScreener")) {
    try {
      const res = await apiGet("DexScreener", `https://api.dexscreener.com/latest/dex/tokens/${mint}`);
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
  } else {
    console.log("[DexScreener] skipped (cooldown)");
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

      // symbol + SOL/USD in parallel
      const [symbol, solUsd] = await Promise.all([getSymbol(mintKey), getSolUsd()]);
      console.log(`[on-chain] symbol: ${symbol}, solUsd: ${solUsd}`);

      const priceUsdText = solUsd ? ` (~$${(priceSol * solUsd).toFixed(10)})` : "";
      const liqSol = (vSol / 1e9).toFixed(2);

      return done({
        source: "pump.fun (on-chain)",
        symbol,
        chain: "solana",
        dex: complete ? "Migrated (PumpSwap/Raydium)" : "pump.fun",
        price: `${priceSol.toFixed(9)} SOL${priceUsdText}`,
        liquidity: complete ? `${liqSol} SOL (stale, token migrated)` : `${liqSol} SOL (virtual)`,
      });
    }
  } catch (e) {
    logError("on-chain", e);
  }

  console.log("[CA] no data found in any source");
  return [];
};
