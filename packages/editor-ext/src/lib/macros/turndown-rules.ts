import * as _TurndownService from '@joplin/turndown';

/**
 * Markdown-export rules for Confluence-parity macros.
 *
 * A node with no rule here is silently dropped from Markdown export (Turndown
 * falls back to text content, and block atoms have none). Adding a macro means
 * appending one plugin function to `macroTurndownRules` below.
 *
 * The only upstream touchpoint is a single `...macroTurndownRules` spread in
 * `lib/markdown/utils/turndown.utils.ts`.
 */

function toc(turndownService: _TurndownService) {
  turndownService.addRule('toc', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.getAttribute('data-type') === 'toc'
      );
    },
    replacement: function () {
      return '\n\n[[toc]]\n\n';
    },
  });
}

function escapePanelAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function panel(turndownService: _TurndownService) {
  turndownService.addRule('panel', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.getAttribute('data-type') === 'panel'
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const attrs = [
        ['title', node.getAttribute('data-panel-title')],
        ['borderStyle', node.getAttribute('data-panel-border-style')],
        ['borderColor', node.getAttribute('data-panel-border-color')],
        ['borderWidth', node.getAttribute('data-panel-border-width')],
        ['bgColor', node.getAttribute('data-panel-bg-color')],
        ['titleBGColor', node.getAttribute('data-panel-title-bg-color')],
        ['titleColor', node.getAttribute('data-panel-title-color')],
      ]
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}="${escapePanelAttribute(value!)}"`)
        .join(' ');
      return `\n\n:::panel${attrs ? ` ${attrs}` : ''}\n${content.trim()}\n:::\n\n`;
    },
  });
}

export const macroTurndownRules = [toc, panel];
