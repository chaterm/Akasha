import { ActionIcon, Group, Image, Modal, Stack, Text } from "@mantine/core";
import {
  IconArrowsMaximize,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IMAGE_VIEWER_EVENT } from "@docmost/editor-ext";

type ImageDetail = { src: string; alt?: string };

export default function ImageViewer() {
  const { t } = useTranslation();
  const [image, setImage] = useState<ImageDetail | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<ImageDetail>).detail;
      setImage(detail);
      setScale(1);
      setOffset({ x: 0, y: 0 });
    };
    document.addEventListener(IMAGE_VIEWER_EVENT, onOpen);
    return () => document.removeEventListener(IMAGE_VIEWER_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImage(null);
      if (event.key === "+" || event.key === "=")
        setScale((v) => Math.min(8, v * 1.2));
      if (event.key === "-") setScale((v) => Math.max(0.1, v / 1.2));
      if (event.key === "0") {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [image]);

  return (
    <Modal
      opened={Boolean(image)}
      onClose={() => setImage(null)}
      fullScreen
      withCloseButton={false}
      padding={0}
    >
      <Stack h="100vh" gap={0} bg="dark.9">
        <Group justify="space-between" px="md" py="xs" bg="dark.8">
          <Text c="white" size="sm" truncate>
            {image?.alt || "Image preview"}
          </Text>
          <ActionIcon
            aria-label={t("Close")}
            onClick={() => setImage(null)}
            variant="subtle"
            c="white"
          >
            <IconX size={20} />
          </ActionIcon>
        </Group>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            cursor: scale > 1 ? "grab" : "default",
          }}
          onWheel={(event) => {
            event.preventDefault();
            setScale((v) =>
              Math.min(
                8,
                Math.max(0.1, v * (event.deltaY < 0 ? 1.2 : 1 / 1.2)),
              ),
            );
          }}
          onPointerDown={(event) => {
            if (scale > 1) {
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                ox: offset.x,
                oy: offset.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          }}
          onPointerMove={(event) => {
            if (drag.current)
              setOffset({
                x: drag.current.ox + event.clientX - drag.current.x,
                y: drag.current.oy + event.clientY - drag.current.y,
              });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          {image && (
            <Image
              src={image.src}
              alt={image.alt}
              fit="contain"
              mah="calc(100vh - 120px)"
              maw="calc(100vw - 40px)"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                userSelect: "none",
              }}
              draggable={false}
            />
          )}
        </div>
        <Group justify="center" gap={4} py="sm" bg="dark.8">
          <ActionIcon
            aria-label={t("Zoom out")}
            onClick={() => setScale((v) => Math.max(0.1, v / 1.2))}
            variant="filled"
            color="dark.5"
            c="gray.2"
          >
            <IconMinus size={18} />
          </ActionIcon>
          <ActionIcon
            aria-label={t("Zoom in")}
            onClick={() => setScale((v) => Math.min(8, v * 1.2))}
            variant="filled"
            color="dark.5"
            c="gray.2"
          >
            <IconPlus size={18} />
          </ActionIcon>
          <ActionIcon
            aria-label={t("Reset zoom")}
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
            variant="filled"
            color="dark.5"
            c="gray.2"
          >
            <IconRefresh size={18} />
          </ActionIcon>
          <ActionIcon
            aria-label={t("Fullscreen")}
            onClick={() => document.documentElement.requestFullscreen?.()}
            variant="filled"
            color="dark.5"
            c="gray.2"
          >
            <IconArrowsMaximize size={18} />
          </ActionIcon>
        </Group>
      </Stack>
    </Modal>
  );
}
