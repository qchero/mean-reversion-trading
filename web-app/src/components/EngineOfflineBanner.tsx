"use client";

import { useState, useEffect } from "react";
import { Alert } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

const STALE_MS = 20 * 60 * 1000; // 20 min — > 15 min after-hours heartbeat interval

export function EngineOfflineBanner({ heartbeat }: { heartbeat: Date | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const ageMs = heartbeat ? Date.now() - new Date(heartbeat).getTime() : Infinity;
  const stale = ageMs > STALE_MS;
  if (!stale) return null;

  const label = !heartbeat
    ? "never"
    : ageMs > 60 * 60 * 1000
      ? `${Math.floor(ageMs / 3_600_000)}h ago`
      : `${Math.floor(ageMs / 60_000)}m ago`;

  return (
    <Alert
      variant="light"
      color="red"
      icon={<IconAlertTriangle size={18} />}
      title="Trading engine offline"
      mb="md"
    >
      No heartbeat received from the engine since {label}. Auto-execution is not running — restart <code>npm run trade</code> on the trading host.
    </Alert>
  );
}
