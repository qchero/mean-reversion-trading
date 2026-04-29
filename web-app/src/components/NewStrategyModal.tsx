"use client";

import { useState } from "react";
import { Button, Modal, Stack, TextInput, NumberInput } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { createLinearStrategy } from "@/app/actions-v2";

export function NewStrategyModal() {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    symbol: "",
    bandLo: 6,
    bandHi: 14,
    maxBudget: 50000,
    minTradeAmount: 5000,
  });

  const handleSubmit = async () => {
    setError("");
    if (!form.symbol.trim()) {
      setError("Symbol is required");
      return;
    }

    setLoading(true);
    try {
      await createLinearStrategy({
        symbol: form.symbol,
        bandLo: form.bandLo,
        bandHi: form.bandHi,
        maxBudget: form.maxBudget,
        minTradeAmount: form.minTradeAmount,
      });
      setOpened(false);
      setForm({ symbol: "", bandLo: 6, bandHi: 14, maxBudget: 50000, minTradeAmount: 5000 });
    } catch (err: any) {
      setError(err.message || "Failed to create strategy");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button 
        id="new-strategy-btn"
        onClick={() => setOpened(true)} 
        leftSection={<IconPlus size={16} />}
        variant="gradient" 
        gradient={{ from: 'indigo', to: 'cyan' }}
      >
        Add Strategy
      </Button>

      <Modal opened={opened} onClose={() => setOpened(false)} title="New Linear Strategy" centered>
        <Stack>
          <TextInput
            label="Ticker Symbol"
            placeholder="e.g. SPY"
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
            error={error}
          />
          <NumberInput 
            label="Band Low (σ)" 
            value={form.bandLo} 
            onChange={(v) => setForm({...form, bandLo: Number(v) || form.bandLo})} 
            step={0.5}
            description="Lower bound for linear scaling (fully out of the market)"
          />
          <NumberInput 
            label="Band High (σ)" 
            value={form.bandHi} 
            onChange={(v) => setForm({...form, bandHi: Number(v) || form.bandHi})} 
            step={0.5}
            description="Upper bound for linear scaling (fully invested)"
          />
          <NumberInput 
            label="Max Budget ($)" 
            value={form.maxBudget} 
            onChange={(v) => setForm({...form, maxBudget: Number(v) || form.maxBudget})} 
            step={1000}
            leftSection="$"
            description="Maximum capital to deploy for this ticker"
          />
          <NumberInput 
            label="Min Trade Amount ($)" 
            value={form.minTradeAmount} 
            onChange={(v) => setForm({...form, minTradeAmount: Number(v) || form.minTradeAmount})} 
            step={1000}
            leftSection="$"
            description="Minimum value per transaction to avoid small trades"
          />
          <Button onClick={handleSubmit} loading={loading} mt="md" fullWidth>
            Create Strategy
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
