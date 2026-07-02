"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Modal, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [headroomUrl, setHeadroomUrl] = useState("http://localhost:8787");
  const [headroomStatus, setHeadroomStatus] = useState({
    installed: false,
    running: false,
    python: null,
    loading: true,
  });
  const [showHeadroomInstallModal, setShowHeadroomInstallModal] =
    useState(false);
  const [headroomActionLoading, setHeadroomActionLoading] = useState(false);
  const [headroomActionError, setHeadroomActionError] = useState("");
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [openvikingEnabled, setOpenvikingEnabled] = useState(false);
  const [openvikingUrl, setOpenvikingUrl] = useState("http://localhost:1933");
  const [openvikingUser, setOpenvikingUser] = useState("hermes");
  const [openvikingApiKey, setOpenvikingApiKey] = useState("");
  const [openvikingSkipModels, setOpenvikingSkipModels] = useState("vlm,embed,rerank,whisper,vl");
  const [rateLimitMaxReqs, setRateLimitMaxReqs] = useState(0);
  const [rateLimitMaxTokens, setRateLimitMaxTokens] = useState(0);
  const [budgetDaily, setBudgetDaily] = useState(0);
  const [budgetMonthly, setBudgetMonthly] = useState(0);
  const [budgetHard, setBudgetHard] = useState(0);
  const [locale, setLocale] = useState("en");

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel);
    if (current?.wenyan && !isWenyanLocale) {
      setCavemanLevel("ultra");
      patchSetting({ cavemanLevel: "ultra" });
    }
  }, [isWenyanLocale, cavemanLevel]);

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleHeadroomEnabled = (value) => {
    const nextUrl = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(nextUrl);
    setHeadroomEnabled(value);
    patchSetting({ headroomEnabled: value, headroomUrl: nextUrl });
  };

  const handleHeadroomUrlBlur = async () => {
    const next = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(next);
    await patchSetting({ headroomUrl: next });
    refreshHeadroomStatus();
  };

  const refreshHeadroomStatus = useCallback(async () => {
    setHeadroomStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/headroom/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setHeadroomStatus({ ...data, loading: false });
    } catch {
      setHeadroomStatus({
        installed: false,
        running: false,
        python: null,
        loading: false,
      });
    }
  }, []);

  const handleHeadroomStart = useCallback(async () => {
    setHeadroomActionError("");
    setHeadroomActionLoading(true);
    try {
      const res = await fetch("/api/headroom/start", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start proxy");
      await refreshHeadroomStatus();
    } catch (e) {
      setHeadroomActionError(e.message);
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const handleHeadroomStop = useCallback(async () => {
    setHeadroomActionLoading(true);
    try {
      await fetch("/api/headroom/stop", { method: "POST" });
      await refreshHeadroomStatus();
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  const handleOpenvikingEnabled = (value) => {
    setOpenvikingEnabled(value);
    patchSetting({ openvikingEnabled: value, openvikingUrl, openvikingUser });
  };

  const handleOpenvikingUrl = (url) => {
    setOpenvikingUrl(url);
    patchSetting({ openvikingUrl: url });
  };

  const handleOpenvikingUser = (user) => {
    setOpenvikingUser(user);
    patchSetting({ openvikingUser: user });
  };
  const handleOpenvikingApiKey = (val) => {
    setOpenvikingApiKey(val);
    patchSetting({ openvikingApiKey: val });
  };
  const handleOpenvikingSkipModels = (val) => {
    setOpenvikingSkipModels(val);
    patchSetting({ openvikingSkipModels: val });
  };

  const handleRateLimitReqs = (val) => {
    setRateLimitMaxReqs(Number(val));
    patchSetting({ rateLimitMaxRequests: Number(val) });
  };
  const handleRateLimitTokens = (val) => {
    setRateLimitMaxTokens(Number(val));
    patchSetting({ rateLimitMaxTokens: Number(val) });
  };
  const handleBudgetDaily = (val) => {
    setBudgetDaily(Number(val));
    patchSetting({ budgetDaily: Number(val) });
  };
  const handleBudgetMonthly = (val) => {
    setBudgetMonthly(Number(val));
    patchSetting({ budgetMonthly: Number(val) });
  };
  const handleBudgetHard = (val) => {
    setBudgetHard(Number(val));
    patchSetting({ budgetHard: Number(val) });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setHeadroomEnabled(!!data.headroomEnabled);
          setHeadroomUrl(data.headroomUrl || "http://localhost:8787");
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setOpenvikingEnabled(!!data.openvikingEnabled);
          if (data.openvikingUrl) setOpenvikingUrl(data.openvikingUrl);
          if (data.openvikingUser) setOpenvikingUser(data.openvikingUser);
          if (data.openvikingApiKey) setOpenvikingApiKey(data.openvikingApiKey);
          if (data.openvikingSkipModels) setOpenvikingSkipModels(data.openvikingSkipModels);
          if (data.rateLimitMaxRequests) setRateLimitMaxReqs(data.rateLimitMaxRequests);
          if (data.rateLimitMaxTokens) setRateLimitMaxTokens(data.rateLimitMaxTokens);
          if (data.budgetDaily) setBudgetDaily(data.budgetDaily);
          if (data.budgetMonthly) setBudgetMonthly(data.budgetMonthly);
          if (data.budgetHard) setBudgetHard(data.budgetHard);
          refreshHeadroomStatus();
        }
      } catch {}
    };
    loadSettings();
  }, [refreshHeadroomStatus]);

  const headroomRunning = !!headroomStatus.running;
  const headroomStatusLabel = headroomStatus.loading
    ? "Checking…"
    : headroomRunning
      ? "Running"
      : headroomStatus.localUrl !== false && !headroomStatus.installed
        ? "Not installed"
        : headroomStatus.localUrl !== false
          ? "Stopped"
          : "External";
  const headroomLocalUrl = headroomStatus.localUrl !== false;
  const headroomCanStart = !!headroomStatus.canStart;
  const headroomManaged =
    headroomLocalUrl && !!headroomStatus.managedPid;

  return (
    <div className="space-y-6 p-6">
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        <div className="flex items-center justify-between py-4 border-b border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress context{" "}
                <a
                  href="https://github.com/chopratejas/headroom"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (Headroom)
                </a>
              </p>
              <span
                className={`text-xs px-2 py-0.5 rounded ${headroomRunning ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
              >
                {headroomStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowHeadroomInstallModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {headroomRunning ? "Manage" : "Setup"}
              </button>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Compress prompts via /v1/compress before routing to the model
            </p>
          </div>
          <Toggle
            checked={headroomEnabled && headroomRunning}
            disabled={!headroomRunning}
            onChange={() => handleHeadroomEnabled(!headroomEnabled)}
          />
        </div>
        <div className="flex items-center justify-between pt-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Bias the model toward minimal code: YAGNI, reuse stdlib,
              deletion over addition
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
      </Card>

      <Card title="OpenViking Memory">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Shared Memory</p>
              <p className="text-xs text-text-muted">
                Inject cross-agent memories from OpenViking into system prompt
              </p>
            </div>
            <Toggle
              checked={openvikingEnabled}
              onChange={() => handleOpenvikingEnabled(!openvikingEnabled)}
            />
          </div>
          {openvikingEnabled && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Server URL</p>
                <Input
                  value={openvikingUrl}
                  onChange={(e) => setOpenvikingUrl(e.target.value)}
                  onBlur={() => handleOpenvikingUrl(openvikingUrl)}
                  placeholder="http://localhost:1933"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Memory User</p>
                <Input
                  value={openvikingUser}
                  onChange={(e) => setOpenvikingUser(e.target.value)}
                  onBlur={() => handleOpenvikingUser(openvikingUser)}
                  placeholder="hermes"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">API Key</p>
                <Input
                  type="password"
                  value={openvikingApiKey}
                  onChange={(e) => setOpenvikingApiKey(e.target.value)}
                  onBlur={() => handleOpenvikingApiKey(openvikingApiKey)}
                  placeholder="base64 api key"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Skip Models (comma-separated)</p>
                <p className="text-xs text-text-muted">Dead-loop prevention: models that skip OV injection</p>
                <Input
                  value={openvikingSkipModels}
                  onChange={(e) => setOpenvikingSkipModels(e.target.value)}
                  onBlur={() => handleOpenvikingSkipModels(openvikingSkipModels)}
                  placeholder="vlm,embed,rerank,whisper,vl"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Rate Limit & Budget">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Rate Limit</p>
            <p className="text-xs text-text-muted">Sliding-window per API key</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Max RPM</p>
                <Input
                  type="number" min="0"
                  value={rateLimitMaxReqs}
                  onChange={(e) => handleRateLimitReqs(e.target.value)}
                  placeholder="0 = unlimited"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Max TPM</p>
                <Input
                  type="number" min="0"
                  value={rateLimitMaxTokens}
                  onChange={(e) => handleRateLimitTokens(e.target.value)}
                  placeholder="0 = unlimited"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Budget Hard Ceiling (USD)</p>
            <p className="text-xs text-text-muted">Block requests that exceed limit</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Per Request</p>
                <Input
                  type="number" min="0" step="0.01"
                  value={budgetHard}
                  onChange={(e) => handleBudgetHard(e.target.value)}
                  placeholder="0 = no limit"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Daily</p>
                <Input
                  type="number" min="0" step="0.01"
                  value={budgetDaily}
                  onChange={(e) => handleBudgetDaily(e.target.value)}
                  placeholder="0 = unlimited"
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Monthly</p>
                <Input
                  type="number" min="0" step="0.01"
                  value={budgetMonthly}
                  onChange={(e) => handleBudgetMonthly(e.target.value)}
                  placeholder="0 = unlimited"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Modal
        isOpen={showHeadroomInstallModal}
        title={headroomRunning ? "Headroom" : "Setup Headroom"}
        onClose={() => setShowHeadroomInstallModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span
              className={headroomRunning ? "text-success" : "text-warning"}
            >
              {headroomStatusLabel}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Proxy URL</p>
            <Input
              value={headroomUrl}
              onChange={(e) => setHeadroomUrl(e.target.value)}
              onBlur={handleHeadroomUrlBlur}
              placeholder="http://localhost:8787"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Use a local proxy for Start/Stop, or an external Docker sidecar
              like http://headroom:8787.
            </p>
          </div>
          {headroomManaged ? (
            <Button
              onClick={handleHeadroomStop}
              variant="ghost"
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Stopping…" : "Stop Headroom"}
            </Button>
          ) : headroomRunning ? (
            <p className="text-sm text-success">
              Headroom proxy is reachable. You can enable the token saver.
            </p>
          ) : headroomCanStart ? (
            <Button
              onClick={handleHeadroomStart}
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Starting…" : "Start Headroom"}
            </Button>
          ) : !headroomLocalUrl ? (
            <p className="text-sm text-warning">
              Start Headroom separately at the configured URL, then recheck.
            </p>
          ) : !headroomStatus.python ? (
            <p className="text-sm text-warning">
              Python ≥ 3.10 required for local managed mode. Install Python
              first, or use an external proxy URL.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Install then click Start:</p>
              <div className="flex items-center gap-2">
                <pre className="flex-1 rounded bg-black/5 dark:bg-white/5 p-2 text-xs font-mono overflow-x-auto">
                  {`pip install "headroom-ai[proxy]"`}
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    copy(`pip install "headroom-ai[proxy]"`)
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {headroomActionError && (
            <p className="text-sm text-warning">{headroomActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshHeadroomStatus()}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button
              onClick={() => setShowHeadroomInstallModal(false)}
              fullWidth
            >
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
