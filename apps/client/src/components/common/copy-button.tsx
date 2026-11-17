import React from "react";
import { useClipboard } from "@/hooks/use-clipboard";
import { useProps } from "@mantine/core";

interface CopyButtonProps {
  children: (payload: { copied: boolean; copy: () => void }) => React.ReactNode;

  value: string;

  timeout?: number;
}

const defaultProps = {
  timeout: 1000,
} satisfies Partial<CopyButtonProps>;

export function CopyButton(props: CopyButtonProps) {
  const { children, timeout, value, ...others } = useProps(
    "CopyButton",
    defaultProps,
    props,
  );
  const clipboard = useClipboard({ timeout });
  const copy = () => clipboard.copy(value);
  return <>{children({ copy, copied: clipboard.copied, ...others })}</>;
}

CopyButton.displayName = "@mantine/core/CopyButton";
