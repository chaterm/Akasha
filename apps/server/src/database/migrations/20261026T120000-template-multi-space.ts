import { Kysely, sql } from 'kysely';

/**
 * 模板可用范围从"单个空间 / 全局"改为"所有空间 / 多个指定空间"：
 * - templates.all_spaces：是否对所有空间可用；
 * - template_spaces：指定空间列表（多对多）。
 * templates.space_id 不再被应用读写，保留以便回滚；回填后数据以新结构为准。
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 可重复执行：库可能已手工应用过本迁移（之后台账被清理、baseline 重放时会再跑一次），
  // 此时不能再回填，否则新模型下 space_id 为空的"指定空间"模板会被误判为所有空间
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'templates' AND column_name = 'all_spaces'
    ) AS exists
  `.execute(db);
  const alreadyApplied = rows[0]?.exists === true;

  if (!alreadyApplied) {
    await db.schema
      .alterTable('templates')
      .addColumn('all_spaces', 'boolean', (col) =>
        col.notNull().defaultTo(false),
      )
      .execute();
  }

  await db.schema
    .createTable('template_spaces')
    .ifNotExists()
    .addColumn('template_id', 'uuid', (col) =>
      col.notNull().references('templates.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('template_spaces_pkey', ['template_id', 'space_id'])
    .execute();

  await db.schema
    .createIndex('idx_template_spaces_space_id')
    .ifNotExists()
    .on('template_spaces')
    .column('space_id')
    .execute();

  if (alreadyApplied) return;

  await sql`UPDATE templates SET all_spaces = true WHERE space_id IS NULL`.execute(
    db,
  );
  await sql`
    INSERT INTO template_spaces (template_id, space_id)
    SELECT id, space_id FROM templates WHERE space_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // 尽量还原单空间语义：多空间模板只保留其中一个空间
  await sql`
    UPDATE templates t SET space_id = CASE
      WHEN t.all_spaces THEN NULL
      ELSE (
        SELECT ts.space_id FROM template_spaces ts
        WHERE ts.template_id = t.id
        ORDER BY ts.created_at, ts.space_id
        LIMIT 1
      )
    END
  `.execute(db);
  await db.schema.dropTable('template_spaces').ifExists().execute();
  await db.schema.alterTable('templates').dropColumn('all_spaces').execute();
}
