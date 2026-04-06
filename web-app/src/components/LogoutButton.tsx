"use client";

import { ActionIcon } from "@mantine/core";
import { IconLogout } from "@tabler/icons-react";
import { signOut } from "next-auth/react";

export function LogoutButton() {
  return (
    <ActionIcon 
      variant="subtle" 
      color="gray" 
      size="lg" 
      title="Sign out"
      onClick={() => signOut({ callbackUrl: "/api/auth/signin" })}
    >
      <IconLogout size={20} />
    </ActionIcon>
  );
}
