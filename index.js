import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "fmv-snapshot.json");

const THRESHOLD = Number(process.env.FMV_THRESHOLD_PERCENT || 20);
const INTERVAL_MS =
  Number(process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL in .env");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// Parse USDT amount from 18-decimal string to number
function parseUSDT(raw) {
  if (!raw) return null;
  const str = raw.padStart(19, "0");
  const integer = str.slice(0, str.length - 18);
  const decimal = str.slice(str.length - 18, str.length - 16);
  return parseFloat(`${integer}.${decimal}`);
}

// Fetch all listed cards from renaiss marketplace
async function fetchAllListed() {
  const allCards = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const raw = execSync(
      `npx renaiss marketplace --listed --limit ${limit} --offset ${offset} --json`,
      { encoding: "utf-8", timeout: 60000 }
    );

    // Extract JSON (skip banner output)
    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) break;
    const data = JSON.parse(raw.slice(jsonStart));

    if (!data.collection || data.collection.length === 0) break;
    allCards.push(...data.collection);

    if (!data.pagination.hasMore) break;
    offset += limit;

    // Small delay to avoid hammering the API
    await new Promise((r) => setTimeout(r, 1000));
  }

  return allCards;
}

// Load previous snapshot
function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
}

// Save snapshot
function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

// Build FMV map: tokenId -> { fmv, name, askPrice, owner, ... }
function buildFmvMap(cards) {
  const map = {};
  for (const card of cards) {
    map[card.tokenId] = {
      name: card.name,
      fmv: Number(card.fmvPriceInUSD) / 100,
      askPrice: parseUSDT(card.askPriceInUSDT),
      owner: card.owner?.username || "unknown",
      grade: card.grade,
      gradingCompany: card.gradingCompany,
      year: card.year,
    };
  }
  return map;
}

// Send Discord webhook message
async function sendDiscordAlert(embeds) {
  const batchSize = 10; // Discord allows max 10 embeds per message
  for (let i = 0; i < embeds.length; i += batchSize) {
    const batch = embeds.slice(i, i + batchSize);
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "FMV Alert Bot",
        embeds: batch,
      }),
    });

    if (!res.ok) {
      console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
    } else {
      console.log(`Sent ${batch.length} alert(s) to Discord`);
    }

    if (i + batchSize < embeds.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Main check logic
async function check() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Fetching listed cards...`);

  const cards = await fetchAllListed();
  console.log(`Fetched ${cards.length} listed cards`);

  const currentMap = buildFmvMap(cards);
  const previousSnapshot = loadSnapshot();

  if (!previousSnapshot) {
    console.log("No previous snapshot found. Saving initial FMV snapshot...");
    saveSnapshot({ timestamp, fmv: currentMap });
    console.log(`Saved ${Object.keys(currentMap).length} cards to snapshot.`);
    return;
  }

  const previousMap = previousSnapshot.fmv;
  const alerts = [];

  // Check for FMV changes and list price gap
  for (const [tokenId, current] of Object.entries(currentMap)) {
    const prev = previousMap[tokenId];
    if (!prev) continue; // New listing, skip

    // Check if FMV changed
    if (current.fmv === prev.fmv) continue;

    const fmvChange = current.fmv - prev.fmv;
    const fmvChangePercent = ((fmvChange / prev.fmv) * 100).toFixed(1);

    // Check list price vs new FMV gap
    if (current.askPrice === null) continue;
    const gap = Math.abs(current.askPrice - current.fmv);
    const gapPercent = (gap / current.fmv) * 100;

    if (gapPercent >= THRESHOLD) {
      const isOverpriced = current.askPrice > current.fmv;
      alerts.push({
        tokenId,
        ...current,
        prevFmv: prev.fmv,
        fmvChange,
        fmvChangePercent,
        gapPercent: gapPercent.toFixed(1),
        isOverpriced,
      });
    }
  }

  console.log(`FMV changes detected: ${Object.entries(currentMap).filter(([id, c]) => previousMap[id] && c.fmv !== previousMap[id].fmv).length}`);
  console.log(`Alerts (>=${THRESHOLD}% gap): ${alerts.length}`);

  if (alerts.length > 0) {
    const embeds = alerts.map((a) => ({
      title: `${a.isOverpriced ? "Overpriced" : "Underpriced"} Alert`,
      color: a.isOverpriced ? 0xff4444 : 0x44ff44,
      fields: [
        { name: "Card", value: a.name, inline: false },
        { name: "Owner", value: a.owner, inline: true },
        { name: "Grade", value: `${a.gradingCompany} ${a.grade}`, inline: true },
        { name: "Year", value: String(a.year), inline: true },
        { name: "Previous FMV", value: `$${a.prevFmv.toLocaleString()}`, inline: true },
        { name: "Current FMV", value: `$${a.fmv.toLocaleString()}`, inline: true },
        {
          name: "FMV Change",
          value: `${a.fmvChange > 0 ? "+" : ""}$${a.fmvChange.toLocaleString()} (${a.fmvChangePercent}%)`,
          inline: true,
        },
        { name: "List Price", value: `$${a.askPrice.toLocaleString()}`, inline: true },
        { name: "Gap", value: `${a.gapPercent}%`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }));

    await sendDiscordAlert(embeds);
  }

  // Update snapshot
  saveSnapshot({ timestamp, fmv: currentMap });
  console.log("Snapshot updated.");
}

// Run
async function main() {
  console.log("=== Renaiss FMV Alert System ===");
  console.log(`Threshold: ${THRESHOLD}%`);
  console.log(`Interval: ${INTERVAL_MS / 60000} minutes`);

  // Initial check
  await check();

  // Schedule recurring checks
  setInterval(check, INTERVAL_MS);
  console.log(`\nNext check in ${INTERVAL_MS / 60000} minutes...`);
}

main().catch(console.error);
