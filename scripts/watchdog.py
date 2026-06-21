#!/usr/bin/env python3
"""
9router Watchdog — 自驱动运维
监控 9router 健康状态，自动检测和修复问题。

功能:
1. 端口检查 → 服务不响应则重启
2. 日志分析 → 422/429/ERROR 模式统计
3. CAPABILITIES 状态 → 追踪模型能力变化
4. reasoning_content 累积 → 建议清理策略
5. 自动修复 → systemd restart

用法:
  python3 watchdog.py              # 持续监控
  python3 watchdog.py --once       # 单次检查
  python3 watchdog.py --stats      # 仅统计
"""

import subprocess
import time
import json
import sys
import re
from datetime import datetime, timedelta
from pathlib import Path

LOG_FILE = Path("/home/melody/cloud/source-code/github/ai/9router/data/logs/9router-20128.log")
SERVICE = "9router.service"
PORT = 20128
CHECK_INTERVAL = 60  # seconds
MAX_RESTART_DELAY = 300

class Watchdog:
    def __init__(self):
        self.stats = {
            "checks": 0,
            "restarts": 0,
            "errors": [],
            "last_check": None,
            "last_restart": None,
        }

    def check_port(self) -> bool:
        """Check if 9router is responding on port 20128."""
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 "--connect-timeout", "3", f"http://127.0.0.1:{PORT}/api/version"],
                capture_output=True, text=True, timeout=10
            )
            return result.stdout.strip() == "200"
        except:
            return False

    def check_service(self) -> dict:
        """Check systemd service status."""
        result = subprocess.run(
            ["systemctl", "is-active", SERVICE],
            capture_output=True, text=True
        )
        return {
            "active": result.stdout.strip() == "active",
            "status": result.stdout.strip()
        }

    def get_recent_logs(self, lines: int = 100) -> list:
        """Read recent log lines."""
        if not LOG_FILE.exists():
            return []
        try:
            result = subprocess.run(
                ["tail", f"-{lines}", str(LOG_FILE)],
                capture_output=True, text=True, timeout=5
            )
            return result.stdout.splitlines()
        except:
            return []

    def analyze_logs(self, logs: list) -> dict:
        """Analyze log patterns."""
        stats = {
            "errors_422": 0,
            "errors_429": 0,
            "errors_other": 0,
            "capabilities_hits": 0,
            "sanitize_strips": 0,
            "reasoning_content_max": 0,
            "models_used": set(),
            "last_error": None,
        }

        for line in logs:
            if "422" in line:
                stats["errors_422"] += 1
            if "429" in line:
                stats["errors_429"] += 1
            if "[ERROR]" in line:
                stats["errors_other"] += 1
                stats["last_error"] = line[:200]
            if "CAPABILITIES" in line:
                stats["capabilities_hits"] += 1
            if "SANITIZE" in line and "reasoning_content" in line:
                stats["sanitize_strips"] += 1
                match = re.search(r"reasoning_content×(\d+)", line)
                if match:
                    count = int(match.group(1))
                    stats["reasoning_content_max"] = max(stats["reasoning_content_max"], count)
            # Extract model names
            match = re.search(r"Model (\S+) succeeded", line)
            if match:
                stats["models_used"].add(match.group(1))

        stats["models_used"] = list(stats["models_used"])
        return stats

    def restart_service(self, reason: str) -> bool:
        """Restart 9router service."""
        print(f"[{datetime.now().isoformat()}] RESTART: {reason}")
        try:
            result = subprocess.run(
                ["sudo", "systemctl", "restart", SERVICE],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                self.stats["restarts"] += 1
                self.stats["last_restart"] = datetime.now().isoformat()
                print(f"[{datetime.now().isoformat()}] RESTART OK")
                time.sleep(5)  # Wait for service to stabilize
                return self.check_port()
            else:
                print(f"[{datetime.now().isoformat()}] RESTART FAILED: {result.stderr}")
                return False
        except Exception as e:
            print(f"[{datetime.now().isoformat()}] RESTART ERROR: {e}")
            return False

    def run_check(self) -> dict:
        """Run a single health check."""
        self.stats["checks"] += 1
        self.stats["last_check"] = datetime.now().isoformat()

        result = {
            "timestamp": datetime.now().isoformat(),
            "port_ok": False,
            "service_ok": False,
            "action": "none",
        }

        # Check port
        result["port_ok"] = self.check_port()

        # Check service
        svc = self.check_service()
        result["service_ok"] = svc["active"]

        # Auto-heal: service down
        if not result["service_ok"] or not result["port_ok"]:
            result["action"] = "restart"
            self.restart_service(f"Service unhealthy (port={result['port_ok']}, service={svc['status']})")

        # Analyze logs
        logs = self.get_recent_logs(200)
        log_stats = self.analyze_logs(logs)
        result["log_stats"] = {
            "422": log_stats["errors_422"],
            "429": log_stats["errors_429"],
            "errors": log_stats["errors_other"],
            "capabilities": log_stats["capabilities_hits"],
            "reasoning_content_max": log_stats["reasoning_content_max"],
            "models_count": len(log_stats["models_used"]),
        }

        # Alert: high 422 rate
        if log_stats["errors_422"] > 10:
            result["action"] = "alert_422"
            print(f"[{datetime.now().isoformat()}] ALERT: High 422 rate ({log_stats['errors_422']})")

        # Alert: high 429 rate (rate limiting)
        if log_stats["errors_429"] > 20:
            result["action"] = "alert_429"
            print(f"[{datetime.now().isoformat()}] ALERT: High 429 rate ({log_stats['errors_429']})")

        # Info: reasoning_content accumulation
        if log_stats["reasoning_content_max"] > 100:
            print(f"[{datetime.now().isoformat()}] INFO: reasoning_content accumulation: {log_stats['reasoning_content_max']} fields")

        return result

    def run(self, once=False):
        """Main monitoring loop."""
        print(f"[{datetime.now().isoformat()}] 9router Watchdog started (interval={CHECK_INTERVAL}s)")

        while True:
            try:
                result = self.run_check()
                print(f"[{result['timestamp']}] port={result['port_ok']} service={result['service_ok']} action={result['action']} 422={result['log_stats']['422']} 429={result['log_stats']['429']} rc_max={result['log_stats']['reasoning_content_max']}")
            except Exception as e:
                print(f"[{datetime.now().isoformat()}] CHECK ERROR: {e}")

            if once:
                break

            time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    w = Watchdog()
    if "--stats" in sys.argv:
        logs = w.get_recent_logs(500)
        stats = w.analyze_logs(logs)
        print(json.dumps(stats, indent=2, default=str))
    else:
        w.run(once="--once" in sys.argv)
