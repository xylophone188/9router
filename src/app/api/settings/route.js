import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

const LOCAL_FEATURE_KEYS = new Set([
  "localFeaturesEnabled",
  "advisorEnabled",
  "advisorClassifier",
  "advisorHighCombo",
  "advisorWorkCombo",
  "advisorReviewCombo",
  "advisorRuleThreshold",
  "forceAdvisorRouting",
  "advisorTiers",
  "blastMaxModels",
  "blastTimeoutMs",
  "blastBatchSize",
  "blastBatchDelay",
  "blastJudgeEnabled",
  "blastJudgeProvider",
  "blastJudgeModel",
  "blastTopN",
  "quotaWarmUpEnabled",
  "quotaWarmUpProvider",
  "quotaWarmUpModel",
  "quotaWarmUpThresholdPercent",
  "quotaWarmUpMinHours",
]);

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = { ...body };

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete updates[key];

    // If updating password, hash it
    if (updates.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!updates.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(updates.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (updates.currentPassword && updates.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      updates.password = await bcrypt.hash(updates.newPassword, salt);
      delete updates.newPassword;
      delete updates.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(updates, "oidcClientSecret")) {
      if (!updates.oidcClientSecret || !String(updates.oidcClientSecret).trim()) {
        delete updates.oidcClientSecret;
      }
    }

    const currentSettings = await getSettings();
    if (updates.localFeaturesEnabled === false) {
      for (const key of LOCAL_FEATURE_KEYS) {
        if (key === "localFeaturesEnabled") continue;
        if (Object.prototype.hasOwnProperty.call(updates, key)) continue;
        if (Object.prototype.hasOwnProperty.call(currentSettings, key)) {
          updates[key] = currentSettings[key];
        }
      }
    }

    const settings = await updateSettings(updates);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(updates, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(updates, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(updates, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(updates, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(updates, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(updates, "comboStrategies")
    ) {
      resetComboRotation();
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
