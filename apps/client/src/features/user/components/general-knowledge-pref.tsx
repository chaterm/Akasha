import { userAtom } from "@/features/user/atoms/current-user-atom";
import { updateUser } from "@/features/user/services/user-service";
import { Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveSettingsRow,
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
} from "@/components/ui/responsive-settings-row";

/** Controls automatic fallback to the model's general knowledge. */
export default function GeneralKnowledgePref() {
  const { t } = useTranslation();
  const switchId = useId();
  const descriptionId = useId();
  const [user, setUser] = useAtom(userAtom);
  const [checked, setChecked] = useState(
    user.settings?.preferences?.generalKnowledge ?? true,
  );

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setChecked(value);
    try {
      const updatedUser = await updateUser({ generalKnowledge: value });
      setUser(updatedUser);
    } catch {
      setChecked(!value);
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text
          component="label"
          htmlFor={switchId}
          size="md"
          style={{ cursor: "pointer" }}
        >
          {t("General knowledge mode")}
        </Text>
        <Text id={descriptionId} size="sm" c="dimmed">
          {t(
            "Answer with general AI knowledge when no usable workspace knowledge is found.",
          )}
        </Text>
      </ResponsiveSettingsContent>

      <ResponsiveSettingsControl>
        <Switch
          id={switchId}
          checked={checked}
          onChange={handleChange}
          aria-describedby={descriptionId}
          aria-label={t("Toggle general knowledge mode")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
