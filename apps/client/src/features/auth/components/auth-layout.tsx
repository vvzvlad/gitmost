import React from "react";
import { Group } from "@mantine/core";
import classes from "./auth.module.css";
import { BrandLogo } from "@/components/ui/brand-logo";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" gap={8} className={classes.logo}>
        <BrandLogo height={40} />
      </Group>
      <main>{children}</main>
    </>
  );
}
