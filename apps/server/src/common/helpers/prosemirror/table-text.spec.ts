import { extractKnowledgeTableRows, serializeTableNode } from './table-text';

const table = {
  type: 'table',
  content: [
    {
      type: 'tableRow',
      content: [
        cell('tableHeader', 'Service'),
        cell('tableHeader', 'Version'),
        cell('tableHeader', 'Primary IP'),
        cell('tableHeader', 'Contact'),
      ],
    },
    {
      type: 'tableRow',
      content: [
        cell('tableCell', 'service-alpha'),
        cell('tableCell', '5.7-test'),
        cell('tableCell', '192.0.2.8'),
        cell('tableCell', 'owner-a'),
      ],
    },
  ],
};

describe('table text serialization', () => {
  it('keeps headers paired with values in each data row', () => {
    expect(serializeTableNode(table)).toEqual([
      'Headers: Service; Version; Primary IP; Contact',
      'Service=service-alpha; Version=5.7-test; Primary IP=192.0.2.8; Contact=owner-a',
    ]);
    expect(
      extractKnowledgeTableRows({ type: 'doc', content: [table] }),
    ).toEqual([
      {
        tableIndex: 0,
        rowIndex: 1,
        text: 'Service=service-alpha; Version=5.7-test; Primary IP=192.0.2.8; Contact=owner-a',
      },
    ]);
  });

  it('fills rowspan values into later logical rows and honors colspan', () => {
    const mergedTable = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            cell('tableHeader', 'Index'),
            cell('tableHeader', 'Owner'),
            cell('tableHeader', 'Component'),
            cell('tableHeader', 'IP'),
          ],
        },
        {
          type: 'tableRow',
          content: [
            cell('tableCell', '1', { rowspan: 2 }),
            cell('tableCell', 'owner-a', { rowspan: 2 }),
            cell('tableCell', 'component-alpha', { rowspan: 2 }),
            cell('tableCell', '192.0.2.134'),
          ],
        },
        {
          type: 'tableRow',
          content: [cell('tableCell', '192.0.2.135')],
        },
      ],
    };

    expect(serializeTableNode(mergedTable)).toEqual([
      'Headers: Index; Owner; Component; IP',
      'Index=1; Owner=owner-a; Component=component-alpha; IP=192.0.2.134',
      'Index=1; Owner=owner-a; Component=component-alpha; IP=192.0.2.135',
    ]);

    expect(
      serializeTableNode({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              cell('tableHeader', 'Node', { colspan: 2 }),
              cell('tableHeader', 'IP'),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell('tableCell', 'component-alpha'),
              cell('tableCell', 'primary'),
              cell('tableCell', '192.0.2.134'),
            ],
          },
        ],
      }),
    ).toEqual([
      'Headers: Node; Node; IP',
      'Node=component-alpha; Node=primary; IP=192.0.2.134',
    ]);
  });
});

function cell(type: string, text: string, attrs?: Record<string, unknown>) {
  return {
    type,
    ...(attrs ? { attrs } : {}),
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}
