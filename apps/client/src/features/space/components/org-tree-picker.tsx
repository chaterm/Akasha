import React, { useCallback, useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Checkbox,
  CloseButton,
  Group,
  Loader,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconSearch,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useDebouncedValue } from "@mantine/hooks";
import { useGroupTreeQuery } from "@/features/group/queries/group-query.ts";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query.ts";
import { IGroupTreeNode, IGroupTreeMember } from "@/features/group/types/group.types.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { IconGroupCircle } from "@/components/icons/icon-people-circle.tsx";
import { useTranslation } from "react-i18next";

interface OrgTreePickerProps {
  value: string[];
  onChange: (value: string[]) => void;
}

interface SelectedItem {
  id: string;
  label: string;
  type: "user" | "group";
}

function filterTree(
  nodes: IGroupTreeNode[],
  query: string,
): { filtered: IGroupTreeNode[]; matchedIds: Set<string> } {
  const lowerQuery = query.toLowerCase();
  const matchedIds = new Set<string>();

  function walk(node: IGroupTreeNode): IGroupTreeNode | null {
    const selfMatch = node.displayName.toLowerCase().includes(lowerQuery) ||
      node.name.toLowerCase().includes(lowerQuery);

    const filteredChildren: IGroupTreeNode[] = [];
    for (const child of node.children) {
      const result = walk(child);
      if (result) filteredChildren.push(result);
    }

    if (selfMatch || filteredChildren.length > 0) {
      if (filteredChildren.length > 0) {
        matchedIds.add(node.id);
      }
      return { ...node, children: filteredChildren };
    }
    return null;
  }

  const filtered: IGroupTreeNode[] = [];
  for (const node of nodes) {
    const result = walk(node);
    if (result) filtered.push(result);
  }
  return { filtered, matchedIds };
}

function GroupTreeNode({
  node,
  depth,
  selectedIds,
  expandedIds,
  onToggle,
  onSelect,
}: {
  node: IGroupTreeNode;
  depth: number;
  selectedIds: Set<string>;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string, type: "user" | "group") => void;
}) {
  const expanded = expandedIds.has(node.id);
  const checked = selectedIds.has(`group-${node.id}`);
  const indent = 16 + depth * 32;

  return (
    <>
      <UnstyledButton
        py={6}
        w="100%"
        style={{ paddingLeft: `${indent}px`, paddingRight: 12, borderRadius: 0 }}
      >
        <Group gap="xs" wrap="nowrap">
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            {expanded ? (
              <IconChevronDown size={14} />
            ) : (
              <IconChevronRight size={14} />
            )}
          </ActionIcon>
          <Checkbox
            size="xs"
            checked={checked}
            onChange={() => onSelect(node.id, "group")}
            onClick={(e) => e.stopPropagation()}
          />
          <IconGroupCircle />
          <Text size="sm" lineClamp={1} style={{ flex: 1 }}>
            {node.displayName}
          </Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {node.memberCount}
          </Text>
        </Group>
      </UnstyledButton>

      {expanded && (
        <>
          {node.children.map((child) => (
            <GroupTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedIds={selectedIds}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
          {node.members.map((user: IGroupTreeMember) => (
            <UnstyledButton
              key={user.id}
              py={6}
              w="100%"
              style={{ paddingLeft: `${16 + (depth + 1) * 32}px`, paddingRight: 12, borderRadius: 0 }}
            >
              <Group gap="xs" wrap="nowrap">
                <div style={{ width: 22 }} />
                <Checkbox
                  size="xs"
                  checked={selectedIds.has(`user-${user.id}`)}
                  onChange={() => onSelect(user.id, "user")}
                  onClick={(e) => e.stopPropagation()}
                />
                <CustomAvatar
                  avatarUrl={user.avatarUrl}
                  size={24}
                  name={user.name}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" lineClamp={1}>
                    {user.name}
                  </Text>
                  {user.email && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {user.email}
                    </Text>
                  )}
                </div>
              </Group>
            </UnstyledButton>
          ))}
        </>
      )}
    </>
  );
}

function UserSearchResults({
  query,
  selectedIds,
  onSelect,
}: {
  query: string;
  selectedIds: Set<string>;
  onSelect: (id: string, type: "user" | "group") => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useSearchSuggestionsQuery({
    query,
    includeUsers: true,
    excludeDeactivatedUsers: true,
    includeGroups: false,
  });

  if (isLoading) {
    return (
      <Group justify="center" py="xs">
        <Loader size="xs" />
      </Group>
    );
  }

  const users = data?.users ?? [];
  if (!users.length) return null;

  return (
    <>
      <Text size="xs" c="dimmed" px="sm" pt="xs" fw={500}>
        {t("Users")}
      </Text>
      {users.map((user) => (
        <UnstyledButton key={user.id} py={6} px="sm" w="100%">
          <Group gap="xs" wrap="nowrap">
            <div style={{ width: 22 }} />
            <Checkbox
              size="xs"
              checked={selectedIds.has(`user-${user.id}`)}
              onChange={() => onSelect(user.id, "user")}
              onClick={(e) => e.stopPropagation()}
            />
            <CustomAvatar
              avatarUrl={user.avatarUrl}
              size={24}
              name={user.name}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" lineClamp={1}>
                {user.name}
              </Text>
              {user.email && (
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {user.email}
                </Text>
              )}
            </div>
          </Group>
        </UnstyledButton>
      ))}
    </>
  );
}

export function OrgTreePicker({ value, onChange }: OrgTreePickerProps) {
  const { t } = useTranslation();
  const [searchValue, setSearchValue] = useState("");
  const [debouncedQuery] = useDebouncedValue(searchValue, 300);
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(
    new Set(),
  );
  const [opened, setOpened] = useState(false);
  const { data: tree, isLoading: treeLoading } = useGroupTreeQuery();

  const selectedIds = useMemo(() => new Set(value), [value]);

  const { displayTree, autoExpandedIds } = useMemo(() => {
    if (!tree) return { displayTree: [], autoExpandedIds: new Set<string>() };
    if (!debouncedQuery) {
      return { displayTree: tree, autoExpandedIds: new Set<string>() };
    }
    const { filtered, matchedIds } = filterTree(tree, debouncedQuery);
    return { displayTree: filtered, autoExpandedIds: matchedIds };
  }, [tree, debouncedQuery]);

  const expandedIds = useMemo(() => {
    const merged = new Set(manualExpanded);
    for (const id of autoExpandedIds) merged.add(id);
    return merged;
  }, [manualExpanded, autoExpandedIds]);

  const selectedItems: SelectedItem[] = useMemo(() => {
    const items: SelectedItem[] = [];
    for (const v of value) {
      if (v.startsWith("group-")) {
        const groupId = v.slice(6);
        const label = findGroupLabel(tree ?? [], groupId);
        items.push({ id: v, label: label ?? groupId, type: "group" });
      } else if (v.startsWith("user-")) {
        items.push({ id: v, label: v.slice(5), type: "user" });
      }
    }
    return items;
  }, [value, tree]);

  const handleToggle = useCallback((id: string) => {
    setManualExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (id: string, type: "user" | "group") => {
      const key = `${type}-${id}`;
      if (selectedIds.has(key)) {
        onChange(value.filter((v) => v !== key));
      } else {
        onChange([...value, key]);
      }
    },
    [value, onChange, selectedIds],
  );

  const handleRemove = useCallback(
    (id: string) => {
      onChange(value.filter((v) => v !== id));
    },
    [value, onChange],
  );

  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        {t("Add members")}
      </Text>

      {selectedItems.length > 0 && (
        <Group gap={4} wrap="wrap">
          {selectedItems.map((item) => (
            <Badge
              key={item.id}
              variant="light"
              size="lg"
              leftSection={
                item.type === "group" ? (
                  <IconUsersGroup size={14} />
                ) : undefined
              }
              rightSection={
                <CloseButton
                  size="xs"
                  variant="transparent"
                  onClick={() => handleRemove(item.id)}
                />
              }
            >
              {item.label}
            </Badge>
          ))}
        </Group>
      )}

      <Popover
        opened={opened}
        onChange={setOpened}
        position="bottom-start"
        shadow="lg"
        width="target"
        trapFocus={false}
      >
        <Popover.Target>
          <TextInput
            placeholder={t("Search for users and groups")}
            leftSection={<IconSearch size={16} />}
            value={searchValue}
            onChange={(e) => setSearchValue(e.currentTarget.value)}
            onFocus={() => setOpened(true)}
            variant="filled"
          />
        </Popover.Target>

        <Popover.Dropdown p={0}>
          <ScrollArea.Autosize mah={450}>
            {treeLoading ? (
              <Group justify="center" py="md">
                <Loader size="sm" />
              </Group>
            ) : displayTree.length > 0 ? (
              <>
                {displayTree.map((node) => (
                  <GroupTreeNode
                    key={node.id}
                    node={node}
                    depth={0}
                    selectedIds={selectedIds}
                    expandedIds={expandedIds}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                  />
                ))}
                {debouncedQuery && (
                  <UserSearchResults
                    query={debouncedQuery}
                    selectedIds={selectedIds}
                    onSelect={handleSelect}
                  />
                )}
              </>
            ) : debouncedQuery ? (
              <>
                <Text size="sm" c="dimmed" ta="center" py="xs">
                  {t("No groups found")}
                </Text>
                <UserSearchResults
                  query={debouncedQuery}
                  selectedIds={selectedIds}
                  onSelect={handleSelect}
                />
              </>
            ) : (
              <Text size="sm" c="dimmed" ta="center" py="md">
                {t("No groups")}
              </Text>
            )}
          </ScrollArea.Autosize>
        </Popover.Dropdown>
      </Popover>
    </Stack>
  );
}

function findGroupLabel(
  nodes: IGroupTreeNode[],
  id: string,
): string | undefined {
  for (const node of nodes) {
    if (node.id === id) return node.displayName;
    const found = findGroupLabel(node.children, id);
    if (found) return found;
  }
  return undefined;
}
