import { useState } from "react";
import {
  Button,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Text,
} from "@mantine/core";
import { useTranslation } from "react-i18next";

interface Props {
  // The key being copied (metadata only — never its token). `null` closes.
  keyName: string | null;
  opened: boolean;
  onClose: () => void;
  // Step-up: resolves true when the password was accepted, the token was copied
  // to the clipboard and the modal should close; false to keep it open (wrong
  // password) so the user can retry. The password is passed straight through and
  // never persisted here.
  onConfirm: (password: string) => Promise<boolean>;
  loading?: boolean;
}

// Password step-up before a copyable key is re-minted + copied. This modal only
// ever holds the PASSWORD (transient, cleared on close) — never the revealed
// token, which the parent writes straight to the clipboard.
export function RevealKeyModal({
  keyName,
  opened,
  onClose,
  onConfirm,
  loading,
}: Props) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");

  const close = () => {
    setPassword("");
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length === 0) return;
    const ok = await onConfirm(password);
    if (ok) close();
    // On failure keep the modal open; clear the field so a retry starts clean.
    else setPassword("");
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("Confirm your password")}
      centered
    >
      <form onSubmit={handleSubmit}>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t(
              'Enter your password to copy the API key "{{name}}" to your clipboard.',
              { name: keyName ?? "" },
            )}
          </Text>
          <PasswordInput
            label={t("Password")}
            data-autofocus
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={close} type="button">
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={loading} disabled={password.length === 0}>
              {t("Copy to clipboard")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
