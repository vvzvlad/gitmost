import * as React from "react";
import { z } from "zod/v4";

import { useForm } from "@mantine/form";
import {
  Container,
  Title,
  TextInput,
  Button,
  PasswordInput,
  Box,
  Stack,
  Group,
  Text,
} from "@mantine/core";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { Link, useParams, useSearchParams } from "react-router-dom";
import APP_ROUTE from "@/lib/app-route";
import useAuth from "@/features/auth/hooks/use-auth";
import classes from "@/features/auth/components/auth.module.css";
import { useGetInvitationQuery } from "@/features/workspace/queries/workspace-query.ts";
import { useRedirectIfAuthenticated } from "@/features/auth/hooks/use-redirect-if-authenticated.ts";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "./auth-layout.tsx";

const formSchema = z.object({
  name: z.string().trim().min(1),
  password: z.string().min(8),
});

type FormValues = z.infer<typeof formSchema>;

export function InviteSignUpForm() {
  const { t } = useTranslation();
  const params = useParams();
  const [searchParams] = useSearchParams();

  const { data: invitation, isError } = useGetInvitationQuery(
    params?.invitationId,
  );
  const { invitationSignup, isLoading } = useAuth();
  useRedirectIfAuthenticated();

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      name: "",
      password: "",
    },
  });

  async function onSubmit(data: FormValues) {
    const invitationToken = searchParams.get("token");

    await invitationSignup({
      invitationId: invitation.id,
      name: data.name,
      password: data.password,
      token: invitationToken,
    });
  }

  if (isError) {
    // Styled error with a CTA to login, mirroring the password-reset
    // error page and the 404 page (issue #133)
    return (
      <AuthLayout>
        <Container my={40}>
          <Text size="lg" ta="center">
            {t("Invalid invitation link")}
          </Text>
          <Group justify="center">
            <Button
              component={Link}
              to={APP_ROUTE.AUTH.LOGIN}
              variant="subtle"
              size="md"
            >
              {t("Go to login page")}
            </Button>
          </Group>
        </Container>
      </AuthLayout>
    );
  }

  if (!invitation) {
    return <div></div>;
  }

  return (
    <AuthLayout>
    <Container size={420} className={classes.container}>
      <Box p="xl" className={classes.containerBox}>
        <Title order={2} ta="center" fw={500} mb="md">
          {t("Join the workspace")}
        </Title>

        <Stack align="stretch" justify="center" gap="xl">
          <form onSubmit={form.onSubmit(onSubmit)}>
            <TextInput
              id="name"
              type="text"
              label={t("Name")}
              placeholder={t("enter your full name")}
              variant="filled"
              {...form.getInputProps("name")}
            />

            <TextInput
              id="email"
              type="email"
              label={t("Email")}
              value={invitation.email}
              disabled
              variant="filled"
              mt="md"
            />

            <PasswordInput
              label={t("Password")}
              placeholder={t("Your password")}
              variant="filled"
              mt="md"
              visibilityToggleButtonProps={{
                "aria-label": t("Toggle password visibility"),
                "aria-hidden": false,
                tabIndex: 0,
              }}
              {...form.getInputProps("password")}
            />
            <Button type="submit" fullWidth mt="xl" loading={isLoading}>
              {t("Sign Up")}
            </Button>
          </form>
        </Stack>
      </Box>
    </Container>
    </AuthLayout>
  );
}
