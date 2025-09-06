// Single-file logger: (1) gETH/ETH ratio from a pool slot0, (2) ETH/USDC 24h volume & TVL via The Graph
import 'dotenv/config';
import { JsonRpcProvider, Contract } from "ethers";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const {
  RPC_URL,
  GETH_ETH_POOL,             // optional (can be empty)
  ETH_USDC_V3_POOL,          // required for vol/TVL (we set a default in workflow)
  TOKEN0_DECIMALS,
  TOKEN1_DECIMALS,
  THEGRAPH_API_KEY,          // optional (if empty, vol/TVL is skipped)
  THEGRAPH_SUBGRAPH_ID,      // provided by workflow
  INTERVAL_SEC
} = process.env;

if (!RPC_URL) throw new Error("Set RPC_URL (Base Mainnet HTTPS from Alchemy等)");

const V3_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_MIN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const provider = new JsonRpcProvider(RPC_URL);

function priceFromSqrtPriceX96(sqrtPriceX96, dec0, dec1) {
  const bn = BigInt(sqrtPriceX96);
  const num = bn * bn; // Q192
  const q192 = 2n ** 192n;
  const ratio = Number(num) / Number(q192);
  return ratio * Math.pow(10, Number(dec0) - Number(dec1));
}

async function getPoolState(poolAddr) {
  const pool = new Contract(poolAddr, V3_ABI, provider);
  const [slot0, token0, token1] = await Promise.all([pool.slot0(), pool.token0(), pool.token1()]);
  const t0 = new Contract(token0, ERC20_MIN_ABI, provider);
  const t1 = new Contract(token1, ERC20_MIN_ABI, provider);
  const [d0, d1] = await Promise.all([t0.decimals(), t1.decimals()]);
  return { slot0, token0, token1, dec0: Number(TOKEN0_DECIMALS)||Number(d0), dec1: Number(TOKEN1_DECIMALS)||Number(d1) };
}

function appendCSV(file, headerArray, rowArray) {
  const exists = fs.existsSync(file);
  if (!exists) fs.writeFileSync(file, headerArray.join(",") + "\n");
  fs.appendFileSync(file, rowArray.join(",") + "\n");
}

async function logGethEth() {
  if (!GETH_ETH_POOL || GETH_ETH_POOL === "0x0000000000000000000000000000000000000000") return; // optional
  const ts = new Date().toISOString();
  const { slot0, token0, token1, dec0, dec1 } = await getPoolState(GETH_ETH_POOL);
  const p0in1 = priceFromSqrtPriceX96(slot0[0], dec0, dec1);
  const p1in0 = 1 / p0in1;
  const header = ["timestamp_iso","pool","token0","token1","dec0","dec1","price_token0_in_token1","price_token1_in_token0"];
  const row = [ts, GETH_ETH_POOL, token0, token1, dec0, dec1, p0in1, p1in0];
  appendCSV(path.join(dataDir, "geth_eth_price.csv"), header, row);
  console.log(`[gETH/ETH] ${ts} ${p0in1} (${token0}->${token1})`);
}

function buildGraphURL(apiKey, subgraphId) {
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

async function graphQL(url, query, variables = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchPool24h(url, poolId, nowSec = Math.floor(Date.now()/1000)) {
  const startTime = nowSec - 24*3600;
  const q = `
    query Pool24h($poolId: ID!, $start: Int!) {
      pool(id: $poolId) { id feeTier totalValueLockedUSD }
      poolHourDatas(where: { pool: $poolId, periodStartUnix_gte: $start }, orderBy: periodStartUnix, orderDirection: asc) {
        periodStartUnix volumeUSD tvlUSD
      }
    }`;
  const d = await graphQL(url, q, { poolId: poolId.toLowerCase(), start: startTime });
  const vols = (d.poolHourDatas||[]).map(h=>Number(h.volumeUSD));
  const tvls = (d.poolHourDatas||[]).map(h=>Number(h.tvlUSD));
  const sum24h = vols.reduce((a,b)=>a+b,0);
  const lastTvl = tvls.length ? tvls[tvls.length-1] : Number(d.pool?.totalValueLockedUSD ?? 0);
  return { feeTier: d.pool?.feeTier ?? "", volume24hUSD: sum24h, tvlUSD: lastTvl };
}

async function logEthUsdcStats() {
  if (!ETH_USDC_V3_POOL || !THEGRAPH_API_KEY || !THEGRAPH_SUBGRAPH_ID) return; // optional
  const ts = new Date().toISOString();
  const url = buildGraphURL(THEGRAPH_API_KEY, THEGRAPH_SUBGRAPH_ID);
  const out = await fetchPool24h(url, ETH_USDC_V3_POOL);
  const header = ["timestamp_iso","pool","feeTier","volume24hUSD","tvlUSD"];
  const row = [ts, ETH_USDC_V3_POOL, out.feeTier, out.volume24hUSD, out.tvlUSD];
  appendCSV(path.join(dataDir, "ethusdc_stats.csv"), header, row);
  console.log(`[ETH/USDC stats] ${ts} vol24h=$${out.volume24hUSD.toFixed(0)} tvl=$${out.tvlUSD.toFixed(0)} fee=${out.feeTier}`);
}

async function tick(){ await Promise.all([logGethEth(), logEthUsdcStats()]).catch(e=>console.error(e.message)); }
const once = process.argv.includes("--once");
const intervalMs = (Number(INTERVAL_SEC)||300)*1000;
await tick(); if (!once) setInterval(tick, intervalMs);
