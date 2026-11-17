import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";
import { getNodeType } from "@tiptap/react";
import { NodeType } from "@tiptap/pm/model";
import { Transaction } from "@tiptap/pm/state";

function autoJoin(
  transactions: readonly Transaction[],
  newTr: Transaction,
  nodeTypes: NodeType[],
) {
  let ranges: number[] = [];
  for (const tr of transactions) {
    for (let i = 0; i < tr.mapping.maps.length; i++) {
      let map = tr.mapping.maps[i];
      if (!map) continue;
      for (let j = 0; j < ranges.length; j++) ranges[j] = map.map(ranges[j]!);
      map.forEach((_s, _e, from, to) => ranges.push(from, to));
    }
  }

  let joinable: number[] = [];
  for (let i = 0; i < ranges.length; i += 2) {
    let from = ranges[i]!,
      to = ranges[i + 1]!;
    let $from = newTr.doc.resolve(from),
      depth = $from.sharedDepth(to),
      parent = $from.node(depth);
    for (
      let index = $from.indexAfter(depth), pos = $from.after(depth + 1);
      pos <= to;
      ++index
    ) {
      let after = parent.maybeChild(index);
      if (!after) break;
      if (index && joinable.indexOf(pos) == -1) {
        let before = parent.child(index - 1);
        if (before.type == after.type && nodeTypes.includes(before.type))
          joinable.push(pos);
      }
      pos += after.nodeSize;
    }
  }

  let joined = false;
  joinable.sort((a, b) => a - b);
  for (let i = joinable.length - 1; i >= 0; i--) {
    if (canJoin(newTr.doc, joinable[i]!)) {
      newTr.join(joinable[i]!);
      joined = true;
    }
  }

  return joined;
}

export interface AutoJoinerOptions {
  elementsToJoin: string[];
}

const AutoJoiner = Extension.create<AutoJoinerOptions>({
  name: "autoJoiner",

  addOptions() {
    return {
      elementsToJoin: [],
    };
  },

  addProseMirrorPlugins() {
    const plugin = new PluginKey(this.name);
    const joinableNodes = [
      this.editor.schema.nodes.bulletList,
      this.editor.schema.nodes.orderedList,
    ];
    this.options.elementsToJoin.forEach((element) => {
      const nodeTyp = getNodeType(element, this.editor.schema);
      joinableNodes.push(nodeTyp);
    });

    return [
      new Plugin({
        key: plugin,
        appendTransaction(transactions, _, newState) {
          let newTr = newState.tr;
          if (autoJoin(transactions, newTr, joinableNodes as NodeType[])) {
            return newTr;
          }
        },
      }),
    ];
  },
});

export default AutoJoiner;
