import { useComputedColorScheme } from "@mantine/core";
import { useEffect, type ComponentPropsWithoutRef } from "react";

const logoPaths = {
  dark: {
    16: "/icons/logo-dark-16x16.png",
    32: "/icons/logo-dark-32x32.png",
  },
  light: {
    16: "/icons/logo-light-16x16.png",
    32: "/icons/logo-light-32x32.png",
  },
} as const;

const wordmarkPaths = {
  dark: "/icons/akasha-wordmark-dark.png",
  light: "/icons/akasha-wordmark-light.png",
} as const;

type BrandLogoProps = Omit<ComponentPropsWithoutRef<"img">, "src">;

export function BrandLogo({ alt = "Akasha", ...props }: BrandLogoProps) {
  const colorScheme = useComputedColorScheme();

  return <img src={logoPaths[colorScheme][32]} alt={alt} {...props} />;
}

export function BrandWordmark({ alt = "Akasha", ...props }: BrandLogoProps) {
  const colorScheme = useComputedColorScheme();

  return <img src={wordmarkPaths[colorScheme]} alt={alt} {...props} />;
}

export function ThemeFavicon() {
  const colorScheme = useComputedColorScheme();

  useEffect(() => {
    document
      .querySelectorAll<HTMLLinkElement>('link[rel~="icon"][sizes]')
      .forEach((link) => {
        const size = link.getAttribute("sizes") === "16x16" ? 16 : 32;
        link.href = logoPaths[colorScheme][size];
      });
  }, [colorScheme]);

  return null;
}
