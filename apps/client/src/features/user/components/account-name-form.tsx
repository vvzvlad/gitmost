import { useAtom } from "jotai";
import { z } from "zod/v4";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { userAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateUser } from "@/features/user/services/user-service.ts";
import { IUser } from "@/features/user/types/user.types.ts";
import { useState } from "react";
import { TextInput, Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

type FormValues = {
  name: string;
};

export default function AccountNameForm() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useAtom(userAtom);

  // Build the schema with friendly, translated validation messages (issue #130)
  const formSchema = z.object({
    name: z
      .string()
      .min(1, t("Name is required"))
      .max(40, t("Name must be 40 characters or fewer")),
  });

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      name: user?.name,
    },
  });

  async function handleSubmit(data: Partial<IUser>) {
    setIsLoading(true);

    try {
      const updatedUser = await updateUser(data);
      setUser(updatedUser);
      // Reset the dirty baseline so the Save button disables again on a clean
      // form right after a successful save.
      form.resetDirty(data as FormValues);
      notifications.show({
        message: t("Updated successfully"),
      });
    } catch (err) {
      console.log(err);
      notifications.show({
        message: t("Failed to update data"),
        color: "red",
      });
    }

    setIsLoading(false);
  }

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <TextInput
        id="name"
        label={t("Name")}
        placeholder={t("Your name")}
        variant="filled"
        {...form.getInputProps("name")}
      />
      <Button
        type="submit"
        mt="sm"
        disabled={isLoading || !form.isDirty()}
        loading={isLoading}
      >
        {t("Save")}
      </Button>
    </form>
  );
}

/*
<div className={classes.controls}>
          <TextInput
            placeholder="Your email"
            classNames={{ input: classes.input, root: classes.inputWrapper }}
          />
          <Button className={classes.control}>Subscribe</Button>
        </div>
*/
