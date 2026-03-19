"use client";

import { useState } from 'react';
import { TextInput, NumberInput, Button, Paper, Title, Stack, Alert } from '@mantine/core';
import { useForm } from '@mantine/form';
import { createStrategy } from '@/app/actions';
import { IconInfoCircle } from '@tabler/icons-react';

interface StrategyFormProps {
  onStrategyCreated: () => void;
}

export default function StrategyForm({ onStrategyCreated }: StrategyFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const form = useForm({
    initialValues: {
      symbol: '',
      initialParamJ: 7,
      stepParamK: 2,
      maxSteps: 2,
      stepAmount: 5000,
    },

    validate: {
      symbol: (value) => (value.trim().length > 0 ? null : 'Symbol is required'),
      initialParamJ: (value) => (value > 0 ? null : 'Initial Multiplier must be > 0'),
      stepParamK: (value) => (value > 0 ? null : 'Step Multiplier must be > 0'),
      maxSteps: (value) => (value >= 1 ? null : 'Must have at least 1 step'),
      stepAmount: (value) => (value > 0 ? null : 'Amount must be > 0'),
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    setError('');
    
    try {
      await createStrategy({
        symbol: values.symbol.toUpperCase(),
        initialParamJ: values.initialParamJ,
        stepParamK: values.stepParamK,
        maxSteps: values.maxSteps,
        stepAmount: values.stepAmount
      });
      form.reset();
      onStrategyCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create strategy. Check symbol and API limits.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Paper shadow="sm" radius="md" p="xl" className="glass-card" mb="xl">
      <Title order={3} mb="md">New Strategy</Title>
      
      {error && (
        <Alert icon={<IconInfoCircle size={16} />} title="Error" color="red" mb="md" variant="light">
          {error}
        </Alert>
      )}

      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            required
            label="Symbol (Ticker)"
            placeholder="e.g. AAPL, SPY"
            {...form.getInputProps('symbol')}
          />
          
          <NumberInput
            required
            label="Initial Multiplier"
            description="First drop from SMA 200 (SMA × (1 - j × σ))"
            min={0.1}
            step={0.1}
            allowNegative={false}
            {...form.getInputProps('initialParamJ')}
          />

          <NumberInput
            required
            label="Step Drop Multiplier"
            description="Subsequent step drops from SMA 200"
            min={0.1}
            step={0.1}
            allowNegative={false}
            {...form.getInputProps('stepParamK')}
          />

          <NumberInput
            required
            label="Max Steps"
            description="Maximum number of buy steps"
            min={1}
            max={20}
            allowNegative={false}
            {...form.getInputProps('maxSteps')}
          />

          <NumberInput
            required
            label="Step Amount ($)"
            description="Capital allocated per buy step"
            min={1}
            prefix="$"
            allowNegative={false}
            {...form.getInputProps('stepAmount')}
          />

          <Button type="submit" mt="md" loading={loading} color="teal">
            Create Strategy
          </Button>
        </Stack>
      </form>
    </Paper>
  );
}
