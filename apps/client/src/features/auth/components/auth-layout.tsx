import React from "react";
import { Group, Text } from "@mantine/core";
import classes from "./auth.module.css";
import { BrandLogo } from "@/components/common/brand-logo.tsx";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" gap={8} className={classes.logo}>
        <BrandLogo width={22} height={22} />
        <Text size="28px" fw={700} style={{ userSelect: "none" }}>
          Akasha
        </Text>
      </Group>
      <main>{children}</main>
    </>
  );
}
