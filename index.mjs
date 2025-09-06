// ETH/USDC（Base, UniV3 0.05%）の「直近24h出来高USD」と「TVL USD」だけをCSVに追記
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

if (THEGRAPH_API_KEY.includes('http')) throw new Error('THEGRAPH_API_KEY には URL ではなく「キー文字列」だけを入れてください');
if (THEGRAPH_SUBGRAPH_ID.includes('/') || THEGRAPH_SUBGRAPH_ID.startsWith('http')) throw new Error('THEGRAPH_SUBGRAPH_ID には ID だけを入れてください（subgraphs/id/ は不要）');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const { ETH_USDC_V3_POOL, THEGRAPH_API_KEY, THEGRAPH_SUBGRAPH_ID } = process.env;
if (!ETH_USDC_V3_POOL) throw new Error('ETH_USDC_V3_POOL is required');
if (!THEGRAPH_API_KEY) throw new Error('THEGRAPH_API_KEY is required');
if (!THEGRAPH_SUBGRAPH_ID) throw new Error('THEGRAPH_SUBGRAPH_ID is required');

const GRAPH_URL = `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${THEGRAPH_SUBGRAPH_ID}`;

async function graphQL(query, variables = {}) {
  const res = await fetch(GRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchPool24h(poolId, nowSec = Math.floor(Date.now() / 1000)) {
  const start = nowSec - 24 * 3600;
  const q = `
    query Pool24h($poolId: ID!, $start: Int!) {
      pool(id: $poolId) { id feeTier totalValueLockedUSD }
      poolHourDatas(
        where: { pool: $poolId, periodStartUnix_gte: $start }
        orderBy: periodStartUnix, orderDirection: asc
      ) { periodStartUnix volumeUSD tvlUSD }
    }`;
  const d = await graphQL(q, { poolId: poolId.toLowerCase(), start });
  const vols = (d.poolHourDatas || []).map(h => Number(h.volumeUSD));
  const tvls = (d.poolHourDatas || []).map(h => Number(h.tvlUSD));
  const volume24hUSD = vols.reduce((a, b) => a + b, 0);
  const tvlUSD = tvls.length ? tvls[tvls.length - 1] : Number(d.pool?.totalValueLockedUSD ?? 0);
  return { feeTier: d.pool?.feeTier ?? '', volume24hUSD, tvlUSD };
}

function appendCSV(file, header, row) {
  const exists = fs.existsSync(file);
  if (!exists) fs.writeFileSync(file, header.join(',') + '\n');
  fs.appendFileSync(file, row.join(',') + '\n');
}

async function run() {
  const ts = new Date().toISOString();
  const out = await fetchPool24h(ETH_USDC_V3_POOL);
  const file = path.join(dataDir, 'ethusdc_stats.csv');
  const header = ['timestamp_iso', 'pool', 'feeTier', 'volume24hUSD', 'tvlUSD'];
  const row = [ts, ETH_USDC_V3_POOL, out.feeTier, out.volume24hUSD, out.tvlUSD];
  appendCSV(file, header, row);
  console.log(`[ETH/USDC stats] ${ts} vol24h=$${out.volume24hUSD.toFixed(0)} tvl=$${out.tvlUSD.toFixed(0)} fee=${out.feeTier}`);
}

// GitHub Actions では1回だけ実行（スケジュールで繰り返し）
await run();
