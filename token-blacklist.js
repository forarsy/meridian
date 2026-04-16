/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 * Also tracks deploy limits per mint — auto-blacklist when limit reached.
 */

import fs from "fs";
import { log } from "./logger.js";

const LESSONS_FILE = "./lessons.json";

function loadLessonsData() {
  if (!fs.existsSync(LESSONS_FILE)) return { performance: [] };
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { performance: [] };
  }
}

const BLACKLIST_FILE = "./token-blacklist.json";

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = load();
  return !!db[mint];
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
    };
  }

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist() {
  const db = load();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}

// ─── Deploy Limit per Mint ─────────────────────────────────────

/**
 * Count how many times a token mint has been deployed (from performance history).
 */
export function getDeployCountByMint(baseMint) {
  if (!baseMint) return 0;
  try {
    const data = loadLessonsData();
    const records = data.performance || [];
    return records.filter((r) => r.base_mint === baseMint).length;
  } catch {
    return 0;
  }
}

/**
 * Calculate win rate and avg PnL for a token mint from performance history.
 */
export function getMintPerformance(baseMint) {
  if (!baseMint) return { winRate: 0, avgPnl: 0, total: 0 };
  try {
    const data = loadLessonsData();
    const records = (data.performance || []).filter((r) => r.base_mint === baseMint);
    if (records.length === 0) return { winRate: 0, avgPnl: 0, total: 0 };

    const wins = records.filter((r) => (r.pnl_pct || 0) > 0).length;
    const winRate = (wins / records.length) * 100;
    const avgPnl = records.reduce((sum, r) => sum + (r.pnl_pct || 0), 0) / records.length;

    return { winRate: Math.round(winRate * 10) / 10, avgPnl: Math.round(avgPnl * 100) / 100, total: records.length };
  } catch {
    return { winRate: 0, avgPnl: 0, total: 0 };
  }
}

/**
 * Check if a token mint can still be deployed.
 * Base limit: 3x deployments.
 * High performer (winRate > 60% AND avgPnl > 5%): limit raised to 5x.
 * When limit is reached → auto-blacklist.
 */
export function canDeployByMint(baseMint, symbol) {
  if (!baseMint) return { allowed: true };

  // Already blacklisted?
  if (isBlacklisted(baseMint)) return { allowed: false, reason: "Token is blacklisted" };

  const deployCount = getDeployCountByMint(baseMint);
  const perf = getMintPerformance(baseMint);

  let maxAllowed = 3; // Base limit
  if (perf.winRate > 60 && perf.avgPnl > 5) {
    maxAllowed = 5; // High performer bonus
  }

  if (deployCount >= maxAllowed) {
    // Auto-blacklist this mint — reached deploy limit
    addToBlacklist({
      mint: baseMint,
      symbol: symbol || "UNKNOWN",
      reason: `Deploy limit reached: deployed ${deployCount}x (max ${maxAllowed}). Win rate: ${perf.winRate}%, avg PnL: ${perf.avgPnl}%`,
    });
    log("blacklist", `Auto-blacklisted ${symbol || baseMint.slice(0, 8)}: deploy limit reached (${deployCount}/${maxAllowed})`);
    return {
      allowed: false,
      reason: `Token already deployed ${deployCount}x across ${perf.total} closed position(s) (max ${maxAllowed}). Auto-blacklisted.`,
      deploy_count: deployCount,
      max_allowed: maxAllowed,
    };
  }

  return {
    allowed: true,
    deploy_count: deployCount,
    max_allowed: maxAllowed,
    win_rate: perf.winRate,
    avg_pnl: perf.avgPnl,
  };
}
