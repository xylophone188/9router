/**
 * Claude Quota Warm-up Script
 * Runs periodically to ensure Claude Pro quota is utilized
 * 
 * Strategy:
 * 1. Check quota status every hour
 * 2. If session expired → trigger warm-up request immediately
 * 3. If quota < 20% used and > 4h passed → trigger warm-up
 * 4. If quota > 80% used → skip (preserving quota)
 */

import { getQuotaStatus, recordRequest, getTimeUntilRefresh } from "./quotaTracker.js";
import { getSettings } from "@/lib/localDb.js";

const WARMUP_PROMPTS = [
  "Hello, this is a quota warm-up request. Please respond with 'OK' only.",
  "Warm-up ping. Reply with 'ack'.",
  "System check. Respond with timestamp.",
];

/**
 * Check if warm-up is needed
 */
export function shouldWarmUp() {
  const status = getQuotaStatus();
  const now = Date.now();
  
  // If session expired, definitely warm up
  if (status.isExpired) {
    return { should: true, reason: "Session expired" };
  }
  
  // If quota < 20% and > 4h since session start, warm up
  if (status.percentUsed < 20 && status.sessionStart) {
    const hoursSinceStart = (now - status.sessionStart) / (60 * 60 * 1000);
    if (hoursSinceStart > 4) {
      return { should: true, reason: `Low usage (${status.percentUsed}%) after ${hoursSinceStart.toFixed(1)}h` };
    }
  }
  
  // If quota > 80%, don't waste on warm-up
  if (status.percentUsed > 80) {
    return { should: false, reason: `Quota high (${status.percentUsed}%)` };
  }
  
  return { should: false, reason: "No warm-up needed" };
}

/**
 * Generate warm-up prompt
 */
export function getWarmUpPrompt() {
  return WARMUP_PROMPTS[Math.floor(Math.random() * WARMUP_PROMPTS.length)];
}

/**
 * Get warm-up status for logging
 */
export function getWarmUpStatus() {
  const quotaStatus = getQuotaStatus();
  const timeUntilRefresh = getTimeUntilRefresh();
  const warmUpCheck = shouldWarmUp();
  
  return {
    quota: quotaStatus,
    refresh: timeUntilRefresh,
    warmUp: warmUpCheck,
  };
}

export async function shouldWarmUpWithSettings() {
  const settings = await getSettings();
  if (settings.localFeaturesEnabled === false || settings.quotaWarmUpEnabled === false) {
    return { should: false, reason: "Local features disabled" };
  }
  return shouldWarmUp();
}
