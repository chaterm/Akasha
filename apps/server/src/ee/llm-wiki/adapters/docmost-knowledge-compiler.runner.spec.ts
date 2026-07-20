import { DocmostKnowledgeCompilerRunner } from './docmost-knowledge-compiler.runner';

describe('DocmostKnowledgeCompilerRunner', () => {
  it('emits structural evidence children with parent metadata and exact lineage', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-06-16T00:00:00.000Z'),
    );
    const text =
      '# Architecture\nWiki is the source of truth.\n## Retrieval\nACL runs before LIMIT.';

    const result = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@2',
      promptVersion: 'wiki-structural-v1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
          title: 'Engineering',
          text,
          references: [],
        },
      ],
    });

    const artifact = result.artifacts[0];
    expect(
      artifact.parentSections?.map((parent) => parent.headingPath),
    ).toEqual([['Architecture'], ['Architecture', 'Retrieval']]);
    expect(artifact.chunks).toHaveLength(2);
    for (const chunk of artifact.chunks ?? []) {
      expect(chunk).toEqual(
        expect.objectContaining({
          chunkRole: 'child',
          retrievalChannel: 'evidence',
          stableKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          parentStableKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          embeddingText: expect.stringContaining('Engineering'),
        }),
      );
      const source = chunk.inputSourceRefs?.[0];
      expect(source?.sourceRange).toBeDefined();
      expect(
        text.slice(
          source!.sourceRange!.startOffset,
          source!.sourceRange!.endOffset,
        ),
      ).toBe(chunk.text);
      expect(source?.quoteHash).toMatch(/^sha256:/);
    }
  });

  it('compiles source snapshots into lineage-preserving page capsules and chunks', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-06-16T00:00:00.000Z'),
    );

    const result = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'akasha-enterprise-kb-v1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
          title: '项目架构',
          text: 'Chaterm Flutter 使用分层架构。\n\nUI、service、data 模块按职责拆分。',
          references: [],
        },
      ],
    });

    expect(result).toEqual({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
        },
      ],
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'akasha-enterprise-kb-v1',
      compilerRunId: 'workspace-1:space-1:2026-06-16T00:00:00.000Z',
      artifacts: [
        expect.objectContaining({
          artifactId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: '项目架构',
          contentMarkdown:
            '# 项目架构\n\nChaterm Flutter 使用分层架构。\n\nUI、service、data 模块按职责拆分。',
          sourcePageIds: ['page-1'],
          artifactKind: 'source_summary',
          compilerVersion: 'akasha-internal@1',
          promptVersion: 'akasha-enterprise-kb-v1',
          compilerRunId: 'workspace-1:space-1:2026-06-16T00:00:00.000Z',
          compileTaskId: 'akasha-page:page-1',
          inputSourceRefs: [
            {
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              sourcePageId: 'page-1',
              sourceVersion: 'v1',
              contentHash: 'hash-1',
            },
          ],
          claims: [
            {
              text: '项目架构: Chaterm Flutter 使用分层架构。',
              confidence: null,
              inputSourceRefs: [
                {
                  workspaceId: 'workspace-1',
                  spaceId: 'space-1',
                  sourcePageId: 'page-1',
                  sourceVersion: 'v1',
                  contentHash: 'hash-1',
                },
              ],
            },
          ],
          parentSections: expect.any(Array),
          chunks: [
            expect.objectContaining({
              text: 'Chaterm Flutter 使用分层架构。\n\nUI、service、data 模块按职责拆分。',
              claimIndex: 0,
              retrievalChannel: 'evidence',
              inputSourceRefs: [
                expect.objectContaining({
                  workspaceId: 'workspace-1',
                  spaceId: 'space-1',
                  sourcePageId: 'page-1',
                  sourceVersion: 'v1',
                  contentHash: 'hash-1',
                }),
              ],
            }),
          ],
        }),
      ],
      diagnostics: { warnings: [], errors: [] },
    });
  });

  it('creates a typed overview artifact with union lineage for multi-source spaces', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-06-16T00:00:00.000Z'),
    );

    const result = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'akasha-enterprise-kb-v1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
          title: 'KMS 加密架构',
          text: 'KMS 使用信封加密保护敏感字段。',
          references: [],
        },
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-2',
          sourceVersion: 'v2',
          contentHash: 'hash-2',
          title: '密钥轮换策略',
          text: '密钥按季度轮换并保留审计记录。',
          references: [],
        },
      ],
    });

    const overview = result.artifacts.find(
      (artifact) => artifact.artifactKind === 'overview',
    );

    expect(overview).toEqual(
      expect.objectContaining({
        artifactKind: 'overview',
        title: 'Space knowledge overview',
        sourcePageIds: ['page-1', 'page-2'],
        compileTaskId: 'akasha-overview:space-1',
        inputSourceRefs: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'hash-1',
          },
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-2',
            sourceVersion: 'v2',
            contentHash: 'hash-2',
          },
        ],
        claims: [
          {
            text: 'This overview summarizes 2 source pages in the selected space.',
            confidence: null,
            inputSourceRefs: [
              {
                workspaceId: 'workspace-1',
                spaceId: 'space-1',
                sourcePageId: 'page-1',
                sourceVersion: 'v1',
                contentHash: 'hash-1',
              },
              {
                workspaceId: 'workspace-1',
                spaceId: 'space-1',
                sourcePageId: 'page-2',
                sourceVersion: 'v2',
                contentHash: 'hash-2',
              },
            ],
          },
        ],
        chunks: [
          {
            text:
              'KMS 加密架构: KMS 使用信封加密保护敏感字段。\n\n' +
              '密钥轮换策略: 密钥按季度轮换并保留审计记录。',
            claimIndex: 0,
            inputSourceRefs: [
              {
                workspaceId: 'workspace-1',
                spaceId: 'space-1',
                sourcePageId: 'page-1',
                sourceVersion: 'v1',
                contentHash: 'hash-1',
              },
              {
                workspaceId: 'workspace-1',
                spaceId: 'space-1',
                sourcePageId: 'page-2',
                sourceVersion: 'v2',
                contentHash: 'hash-2',
              },
            ],
          },
        ],
      }),
    );
  });

  it('skips empty sources and reports diagnostics', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-06-16T00:00:00.000Z'),
    );

    const result = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'akasha-enterprise-kb-v1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
          title: 'Empty',
          text: '   ',
          references: [],
        },
      ],
    });

    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics.warnings).toEqual([
      {
        code: 'empty_source',
        message: 'Source page has no text content and was skipped.',
        sourcePageId: 'page-1',
      },
    ]);
  });

  it('creates same-space links from exported Wiki backlinks', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-06-16T00:00:00.000Z'),
    );

    const result = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'akasha-enterprise-kb-v1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-registration',
          sourceVersion: 'v1',
          contentHash: 'hash-registration',
          title: 'Chaterm 企业版登记信息',
          text:
            'Chaterm 企业版软件的登记批准日期是 2026年06月05日。\n\n' +
            '该登记信息引用了另一篇安全设计文档。',
          references: [
            {
              sourcePageId: 'page-registration',
              targetPageId: 'page-kms',
              targetSpaceId: 'space-1',
              kind: 'same_space_reference',
              mode: 'opaque',
            },
          ],
        },
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-kms',
          sourceVersion: 'v1',
          contentHash: 'hash-kms',
          title: 'Chaterm KMS 加密架构',
          text: 'Chaterm KMS 加密架构使用 AWS KMS 和信封加密保护敏感数据。',
          references: [],
        },
      ],
    });

    expect(result.artifacts[0].links).toEqual([
      {
        linkType: 'same_space_reference',
        linkText: 'Chaterm KMS 加密架构',
        targetPageId: 'page-kms',
        targetSpaceId: 'space-1',
        toKnowledgePageId: result.artifacts[1].artifactId,
        isDangling: false,
        inputSourceRefs: result.artifacts[0].inputSourceRefs,
      },
    ]);
  });

  it('compiles one page without a space overview and preserves explicit links', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-07-20T00:00:00.000Z'),
    );
    const source = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v2',
      contentHash: 'hash-v2',
      title: 'Changed page',
      text: 'This page links to another Wiki page.',
      references: [
        {
          sourcePageId: 'page-1',
          targetPageId: 'page-2',
          targetSpaceId: 'space-1',
          kind: 'same_space_reference' as const,
          mode: 'opaque' as const,
        },
      ],
    };

    const first = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'wiki-v1',
      compileMode: 'pages',
      sources: [source],
    });
    const next = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'wiki-v1',
      compileMode: 'pages',
      sources: [{ ...source, sourceVersion: 'v3', contentHash: 'hash-v3' }],
    });

    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts[0].artifactKind).toBe('source_summary');
    expect(first.artifacts[0].artifactId).toBe(next.artifacts[0].artifactId);
    expect(first.artifacts[0].links).toEqual([
      expect.objectContaining({
        targetPageId: 'page-2',
        targetSpaceId: 'space-1',
        toKnowledgePageId: expect.any(String),
        isDangling: false,
      }),
    ]);
  });

  it('creates semantic graph edges for related pages without explicit title mentions', async () => {
    const runner = new TestDocmostKnowledgeCompilerRunner(
      () => new Date('2026-06-16T00:00:00.000Z'),
    );

    const result = await runner.compileSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'akasha-internal@1',
      promptVersion: 'akasha-enterprise-kb-v1',
      sources: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-kms',
          sourceVersion: 'v1',
          contentHash: 'hash-kms',
          title: 'KMS 密钥轮换策略',
          text:
            '服务端使用 KMS 管理主密钥，按周期轮换数据密钥。' +
            '敏感字段采用信封加密，密钥材料不会落入业务日志。',
          references: [],
        },
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-encryption',
          sourceVersion: 'v1',
          contentHash: 'hash-encryption',
          title: '企业数据加密方案',
          text:
            '企业版保护敏感字段时使用信封加密。' +
            '数据密钥由 KMS 派生并定期轮换，主密钥只在托管服务中使用。',
          references: [],
        },
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-mobile',
          sourceVersion: 'v1',
          contentHash: 'hash-mobile',
          title: '移动端登录交互',
          text: '移动端登录页包含手机号输入、验证码倒计时和错误提示。',
          references: [],
        },
      ],
    });

    expect(result.artifacts[0].graphEdges).toEqual([
      {
        toKnowledgePageId: result.artifacts[1].artifactId,
        relation: expect.stringContaining('共同主题'),
        inputSourceRefs: [
          result.artifacts[0].inputSourceRefs?.[0],
          result.artifacts[1].inputSourceRefs?.[0],
        ],
      },
    ]);
    expect(result.artifacts[0].links).toBeUndefined();
    expect(result.artifacts[2].graphEdges).toBeUndefined();
  });
});

class TestDocmostKnowledgeCompilerRunner extends DocmostKnowledgeCompilerRunner {
  constructor(private readonly testNow: () => Date) {
    super();
  }

  protected now(): Date {
    return this.testNow();
  }
}
