import { generateNodeId } from "../utils";
import { UniqueID as TiptapUniqueID } from "@tiptap/extension-unique-id";
import {
  combineTransactionSteps,
  findChildrenInRange,
  getChangedRanges,
  splitExtensions,
  type Extensions,
} from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";

type IdOptions = {
  types: string[];
  attributeName: string;
  generateID: (ctx: { node: PMNode; pos: number }) => string;
};

export function resolveUniqueIdTypes(
  types: string[] | "all",
  extensions: Extensions,
): string[] {
  if (types !== "all") return types;
  return splitExtensions(extensions)
    .nodeExtensions.map((extension) => extension.name)
    .filter((type) => type !== "doc" && type !== "text");
}

function fillFragmentIds(fragment: Fragment, options: IdOptions): Fragment {
  const { types, attributeName, generateID } = options;
  let changed = false;
  const children: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      children.push(node);
      return;
    }
    const content = fillFragmentIds(node.content, options);
    const needsId =
      types.includes(node.type.name) && !node.attrs[attributeName];
    if (!needsId && content === node.content) {
      children.push(node);
      return;
    }
    changed = true;
    children.push(
      needsId
        ? node.type.create(
            { ...node.attrs, [attributeName]: generateID({ node, pos: -1 }) },
            content,
            node.marks,
          )
        : node.copy(content),
    );
  });
  return changed ? Fragment.from(children) : fragment;
}

export function fillSliceIds(slice: Slice, options: IdOptions): Slice {
  const content = fillFragmentIds(slice.content, options);
  return content === slice.content
    ? slice
    : new Slice(content, slice.openStart, slice.openEnd);
}

const MAX_ATTR_STEPS = 100;

function withAssignedIds(
  node: PMNode,
  pos: number,
  assigned: Map<number, string>,
  attributeName: string,
): PMNode {
  let changed = false;
  const children: PMNode[] = [];
  node.forEach((child, offset) => {
    const next = child.isText
      ? child
      : withAssignedIds(child, pos + 1 + offset, assigned, attributeName);
    if (next !== child) changed = true;
    children.push(next);
  });
  const id = assigned.get(pos);
  if (id === undefined && !changed) return node;
  return node.type.create(
    id === undefined ? node.attrs : { ...node.attrs, [attributeName]: id },
    changed ? children : node.content,
    node.marks,
  );
}

function replaceWithIds(
  tr: Transaction,
  assigned: Map<number, string>,
  attributeName: string,
) {
  let min = Infinity;
  let max = -Infinity;
  assigned.forEach((_, pos) => {
    min = Math.min(min, pos);
    max = Math.max(max, pos);
  });
  let from = -1;
  let to = -1;
  const blocks: PMNode[] = [];
  tr.doc.forEach((child, offset) => {
    if (offset + child.nodeSize <= min || offset > max) return;
    if (from < 0) from = offset;
    to = offset + child.nodeSize;
    blocks.push(withAssignedIds(child, offset, assigned, attributeName));
  });
  const { selection } = tr;
  tr.replaceWith(from, to, blocks);
  tr.setSelection(selection.map(tr.doc, new Mapping()));
}

function assignIds(
  transactions: readonly Transaction[],
  oldDoc: PMNode,
  newState: { doc: PMNode; tr: Transaction; storedMarks: unknown },
  options: IdOptions,
) {
  const { types, attributeName, generateID } = options;
  const transform = combineTransactionSteps(oldDoc, [...transactions]);
  let inverted: ReturnType<typeof transform.mapping.invert> | null = null;
  const assigned = new Map<number, string>();
  const currentId = (pos: number, node: PMNode) =>
    assigned.has(pos) ? assigned.get(pos) : node.attrs[attributeName];

  getChangedRanges(transform).forEach(({ newRange }) => {
    const nodes = findChildrenInRange(newState.doc, newRange, (node) =>
      types.includes(node.type.name),
    );
    const counts = new Map<string, number>();
    nodes.forEach(({ node, pos }) => {
      const id = currentId(pos, node);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    });
    const assign = (pos: number, node: PMNode) => {
      const id = generateID({ node, pos });
      counts.set(id, 1);
      assigned.set(pos, id);
    };

    nodes.forEach(({ node, pos }, i) => {
      const id = currentId(pos, node);
      if (!id) {
        assign(pos, node);
        return;
      }
      const next = nodes[i + 1];
      if (next && node.content.size === 0) {
        const nextId = currentId(next.pos, next.node);
        if (!nextId || nextId === id) {
          if (nextId === id) counts.set(id, counts.get(id)! - 1);
          else assigned.set(next.pos, id);
          assign(pos, node);
          return;
        }
      }
      if (counts.get(id)! > 1) {
        inverted ??= transform.mapping.invert();
        if (inverted.mapResult(pos).deleted) assign(pos, node);
      }
    });
  });

  if (!assigned.size) return undefined;
  const { tr } = newState;
  if (assigned.size <= MAX_ATTR_STEPS) {
    assigned.forEach((id, pos) => tr.setNodeAttribute(pos, attributeName, id));
  } else {
    replaceWithIds(tr, assigned, attributeName);
  }
  tr.setStoredMarks(newState.storedMarks as never);
  tr.setMeta("__uniqueIDTransaction", true);
  return tr;
}

export const UniqueID = TiptapUniqueID.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      generateID: () => generateNodeId(),
    };
  },

  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? [];
    if (!parentPlugins.length) return parentPlugins;
    const [parent] = parentPlugins;
    const options = (): IdOptions => ({
      types: resolveUniqueIdTypes(
        this.options.types,
        this.editor.extensionManager.extensions,
      ),
      attributeName: this.options.attributeName,
      generateID: this.options.generateID,
    });
    const parentTransformPasted = parent.spec.props?.transformPasted;

    return [
      new Plugin({
        ...parent.spec,
        props: {
          ...parent.spec.props,
          transformPasted: (slice, view) => {
            const transformed = parentTransformPasted
              ? parentTransformPasted.call(parent, slice, view)
              : slice;
            return fillSliceIds(transformed, options());
          },
        },
        appendTransaction: (transactions, oldState, newState) => {
          if (transactions.some((tr) => tr.getMeta("y-sync$"))) {
            return parent.spec.appendTransaction?.call(
              parent,
              transactions,
              oldState,
              newState,
            );
          }
          const { filterTransaction } = this.options;
          if (
            !transactions.some((tr) => tr.docChanged) ||
            oldState.doc.eq(newState.doc) ||
            (filterTransaction &&
              transactions.some((tr) => !filterTransaction(tr)))
          ) {
            return undefined;
          }
          return assignIds(transactions, oldState.doc, newState, options());
        },
      }),
    ];
  },
});
