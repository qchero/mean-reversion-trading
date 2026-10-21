"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Container, Paper, Text, Title } from "@mantine/core";

// Shown instead of a bare 500 when a server component throws — in practice almost always
// the database being temporarily unreachable (Supabase pooler checkout timeouts).
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Container size="sm" py="xl">
      <Paper p="xl" radius="md" withBorder>
        <Title order={3} mb="xs">Couldn&apos;t load the dashboard</Title>
        <Text c="dimmed" size="sm" mb="lg">
          The database didn&apos;t respond in time. This is usually temporary; the trading engine keeps running independently.
          {error.digest && <> (ref {error.digest})</>}
        </Text>
        <Button
          loading={retrying}
          onClick={() => startRetry(() => { router.refresh(); reset(); })}
        >
          Retry
        </Button>
      </Paper>
    </Container>
  );
}
