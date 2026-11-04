import {
  ActionIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import classes from "./theme-toggle.module.css";

export function ThemeToggle() {
  const { t } = useTranslation();
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme();

  return (
    <Tooltip label={t("Toggle color scheme")}>
      <ActionIcon
        variant="default"
        onClick={() => {
          setColorScheme(computedColorScheme === "light" ? "dark" : "light");
        }}
        aria-label={t("Toggle color scheme")}
      >
        <IconSun className={classes.light} size={18} stroke={1.5} />
        <IconMoon className={classes.dark} size={18} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  );
}
