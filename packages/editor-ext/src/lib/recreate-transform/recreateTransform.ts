import { Transform } from '@tiptap/pm/transform';
import { Mark, Node, Schema } from '@tiptap/pm/model';
import { createPatch, Operation } from 'rfc6902';
import { diffWordsWithSpace, diffChars } from 'diff';
import { AnyObject } from './types';
import { getReplaceStep } from './getReplaceStep';
import { simplifyTransform } from './simplifyTransform';
import { removeMarks } from './removeMarks';
import { diffJsonArrays } from './diffJsonArrays';
import { getFromPath } from './getFromPath';
import { patchCopy } from './patchCopy';

export interface Options {
  complexSteps?: boolean;
  wordDiffs?: boolean;
  simplifyDiff?: boolean;
}

export class RecreateTransform {
  fromDoc: Node;
  toDoc: Node;
  complexSteps: boolean;
  wordDiffs: boolean;
  simplifyDiff: boolean;
  schema: Schema;
  tr: Transform;
  currentJSON: AnyObject;
  finalJSON: AnyObject;
  ops: Array<Operation>;
  nodes = new WeakMap<AnyObject, Node>();
  checked = new WeakSet<Node>();
  nodeSchema: Schema;

  constructor(fromDoc: Node, toDoc: Node, options: Options = {}) {
    const o = {
      complexSteps: true,
      wordDiffs: false,
      simplifyDiff: true,
      ...options,
    };

    this.fromDoc = fromDoc;
    this.toDoc = toDoc;
    this.complexSteps = o.complexSteps;
    this.wordDiffs = o.wordDiffs;
    this.simplifyDiff = o.simplifyDiff;
    this.schema = fromDoc.type.schema;
    this.tr = new Transform(fromDoc);
    this.nodeSchema = Object.create(this.schema);
    this.nodeSchema.nodeFromJSON = (json) => this.nodeFromJSON(json);
  }

  nodeFromJSON(json: AnyObject): Node {
    let node = this.nodes.get(json);
    if (!node) {
      node = Node.fromJSON(this.nodeSchema, json);
      this.nodes.set(json, node);
    }
    return node;
  }

  checkNode(node: Node) {
    if (this.checked.has(node)) return;
    if (!node.type.validContent(node.content)) {
      throw new RangeError(`Invalid content for node ${node.type.name}`);
    }
    let marks = Mark.none;
    for (const mark of node.marks) marks = mark.addToSet(marks);
    if (!Mark.sameSet(marks, node.marks)) {
      throw new RangeError(`Invalid marks for node ${node.type.name}`);
    }
    node.content.forEach((child) => this.checkNode(child));
    this.checked.add(node);
  }

  init() {
    if (this.complexSteps) {
      this.currentJSON = removeMarks(this.fromDoc).toJSON();
      this.finalJSON = removeMarks(this.toDoc).toJSON();
      this.ops = createPatch(this.currentJSON, this.finalJSON, diffJsonArrays);
      this.recreateChangeContentSteps();
      this.recreateChangeMarkSteps();
    } else {
      this.currentJSON = this.fromDoc.toJSON();
      this.finalJSON = this.toDoc.toJSON();
      this.ops = createPatch(this.currentJSON, this.finalJSON, diffJsonArrays);
      this.recreateChangeContentSteps();
    }

    if (this.simplifyDiff) {
      this.tr = simplifyTransform(this.tr) || this.tr;
    }

    return this.tr;
  }

  recreateChangeContentSteps() {
    let ops = [];
    while (this.ops.length) {
      let op = this.ops.shift();
      ops.push(op);

      let toDoc;
      let afterStepJSON = this.currentJSON;
      const pathParts = op.path.split('/');

      while (toDoc == null) {
        afterStepJSON = patchCopy(afterStepJSON, op);

        try {
          toDoc = this.nodeFromJSON(afterStepJSON);
          this.checkNode(toDoc);
        } catch (error) {
          toDoc = null;
          if (this.ops.length > 0) {
            op = this.ops.shift();
            ops.push(op);
          } else {
            throw new Error(`No valid diff possible applying ${op.path}`);
          }
        }
      }

      if (
        this.complexSteps &&
        ops.length === 1 &&
        (pathParts.includes('attrs') || pathParts.includes('type'))
      ) {
        this.addSetNodeMarkup();
        ops = [];
        // console.log("%cop", logStyle, "- update node", ops);
      } else if (
        ops.length === 1 &&
        op.op === 'replace' &&
        pathParts[pathParts.length - 1] === 'text'
      ) {
        this.addReplaceTextSteps(op, afterStepJSON);
        ops = [];
        // console.log("%cop", logStyle, "- replace", ops);
      } else if (this.addReplaceStep(toDoc, afterStepJSON)) {
        ops = [];
        // console.log("%cop", logStyle, "- other", ops);
      } else {
        this.currentJSON = afterStepJSON;
        ops = [];
      }
    }
  }

  addSetNodeMarkup() {
    const fromDoc = this.schema.nodeFromJSON(this.currentJSON);
    const toDoc = this.schema.nodeFromJSON(this.finalJSON);
    const start = toDoc.content.findDiffStart(fromDoc.content);
    const fromNode = fromDoc.nodeAt(start);
    const toNode = toDoc.nodeAt(start);

    if (start != null) {
      const nodeType = fromNode.type === toNode.type ? null : toNode.type;
      try {
        this.tr.setNodeMarkup(start, nodeType, toNode.attrs, toNode.marks);
      } catch (e) {
        if (nodeType && e.message.includes('Invalid content')) {
          this.tr.replaceWith(start, start + fromNode.nodeSize, toNode);
        } else {
          throw e;
        }
      }
      this.currentJSON = removeMarks(this.tr.doc).toJSON();
      this.ops = createPatch(this.currentJSON, this.finalJSON, diffJsonArrays);
      return true;
    }
    return false;
  }

  recreateChangeMarkSteps() {
    this.toDoc.descendants((tNode, tPos) => {
      if (!tNode.isInline) {
        return true;
      }

      this.tr.doc.nodesBetween(tPos, tPos + tNode.nodeSize, (fNode, fPos) => {
        if (!fNode.isInline) {
          return true;
        }
        const from = Math.max(tPos, fPos);
        const to = Math.min(tPos + tNode.nodeSize, fPos + fNode.nodeSize);
        fNode.marks.forEach((nodeMark) => {
          if (!nodeMark.isInSet(tNode.marks)) {
            this.tr.removeMark(from, to, nodeMark);
          }
        });
        tNode.marks.forEach((nodeMark) => {
          if (!nodeMark.isInSet(fNode.marks)) {
            this.tr.addMark(from, to, nodeMark);
          }
        });
      });
    });
  }

  addReplaceStep(toDoc: Node, afterStepJSON: AnyObject) {
    const fromDoc = this.nodeFromJSON(this.currentJSON);
    const step = getReplaceStep(fromDoc, toDoc);

    if (!step) {
      return false;
    } else if (!this.tr.maybeStep(step).failed) {
      this.currentJSON = afterStepJSON;
      return true;
    }

    throw new Error('No valid step found.');
  }

  addReplaceTextSteps(op, afterStepJSON) {
    const op1 = { ...op, value: 'xx' };
    const op2 = { ...op, value: 'yy' };
    const op1Doc = this.nodeFromJSON(patchCopy(this.currentJSON, op1));
    const op2Doc = this.nodeFromJSON(patchCopy(this.currentJSON, op2));

    const finalText = op.value;
    const currentText = getFromPath(this.currentJSON, op.path);
    const textDiffs = this.wordDiffs
      ? diffWordsWithSpace(currentText, finalText)
      : diffChars(currentText, finalText);

    let offset = op1Doc.content.findDiffStart(op2Doc.content);
    const marks = op1Doc.resolve(offset + 1).marks();

    while (textDiffs.length) {
      const diff = textDiffs.shift();

      if (diff.added) {
        const textNode = this.schema
          .nodeFromJSON({ type: 'text', text: diff.value })
          .mark(marks);

        if (textDiffs.length && textDiffs[0].removed) {
          const nextDiff = textDiffs.shift();
          this.tr.replaceWith(offset, offset + nextDiff.value.length, textNode);
        } else {
          this.tr.insert(offset, textNode);
        }
        offset += diff.value.length;
      } else if (diff.removed) {
        if (textDiffs.length && textDiffs[0].added) {
          const nextDiff = textDiffs.shift();
          const textNode = this.schema
            .nodeFromJSON({ type: 'text', text: nextDiff.value })
            .mark(marks);
          this.tr.replaceWith(offset, offset + diff.value.length, textNode);
          offset += nextDiff.value.length;
        } else {
          this.tr.delete(offset, offset + diff.value.length);
        }
      } else {
        offset += diff.value.length;
      }
    }

    this.currentJSON = afterStepJSON;
  }
}

export function recreateTransform(
  fromDoc: Node,
  toDoc: Node,
  options: Options = {},
): Transform {
  const recreator = new RecreateTransform(fromDoc, toDoc, options);
  return recreator.init();
}
