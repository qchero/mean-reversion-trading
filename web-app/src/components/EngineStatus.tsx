"use client";

import { useState, useEffect } from "react";
import { Badge } from "@mantine/core";

export function EngineStatus({ heartbeat }: { heartbeat: Date | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(interval);
  }, []);

  if (!heartbeat) return <Badge variant="dot" color="gray" size="sm" style={{ flexShrink: 0 }}>Engine: offline</Badge>;

  const agoSec = Math.floor((Date.now() - new Date(heartbeat).getTime()) / 1000);
  const label = agoSec < 60 ? `${agoSec}s ago` : `${Math.floor(agoSec / 60)}m ago`;
  const alive = agoSec < 120;

  return (
    <Badge variant="dot" color={alive ? "green" : "red"} size="sm" style={{ flexShrink: 0 }}>
      Engine: {label}
    </Badge>
  );
}
