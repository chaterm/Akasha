import { useEffect, useState } from 'react'
import { api } from '../api'
import type {
  AkashaFeature,
  AkashaModelProvider,
  Connection,
  ConnectionTest,
  ModelConfigsView,
  Provider,
  ProviderProbe,
  ProviderRole,
} from '../types'
import {
  Failed,
  Field,
  Loading,
  Pass,
  SecretField,
  downloadText,
  pickFile,
  useAction,
  useAsync,
} from '../ui'

export function Settings() {
  return (
    <>
      <div className="panel-head">
        <h2>配置</h2>
        <div className="row tight">
          <ImportButton />
          <ExportButton />
        </div>
      </div>
      <ConnectionForm />
      <ModelConfigs />
      <AkashaModels />
      <Providers role="judge" title="评估模型" />
      <Providers role="attribution" title="归因模型" />
      <Providers role="generation" title="样本生成模型" />
    </>
  )
}

function ExportButton() {
  const save = useAction<unknown>()
  return (
    <button
      className="action"
      disabled={save.busy}
      onClick={() =>
        save.run(async () => {
          const data = await api.exportConfig()
          downloadText(
            JSON.stringify(data, null, 2),
            `akasha-config-${new Date().toISOString().slice(0, 10)}.json`,
            'application/json',
          )
          return data
        })
      }
    >
      {save.busy ? '导出中…' : '导出配置'}
    </button>
  )
}

function ImportButton() {
  const load = useAction<unknown>()

  const pick = () =>
    pickFile('application/json,.json', (file) =>
      load.run(async () => {
        const data = JSON.parse(await file.text()) as Record<string, unknown>
        const result = await api.importConfig(data)
        window.location.reload()
        return result
      }),
    )

  return (
    <button className="action" disabled={load.busy} onClick={pick}>
      {load.busy ? '导入中…' : '导入配置'}
    </button>
  )
}

const NUMBER_FIELDS = [
  ['timeout_seconds', '模型请求超时（秒）', 1],
  ['request_interval_seconds', '模型请求间隔（秒）', 0],
] as const

type Form = Record<string, string>

function toForm(data: Connection): Form {
  const { compiles: _compiles, updated_at: _updated, ...rest } = data
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, String(value)]))
}

function ConnectionForm() {
  const { data, error, loading, reload } = useAsync(() => api.connection(), [])
  const [form, setForm] = useState<Form>({})
  const save = useAction<{ updated: string[] }>()
  const test = useAction<ConnectionTest>()

  useEffect(() => {
    if (data) setForm(toForm(data))
  }, [data])

  if (loading && !data) return <Loading what="连接配置" />
  if (error) return <Failed error={error} />
  if (!data) return null

  const loaded = toForm(data)

  const set = (key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    save.reset()
    test.reset()
  }
  const revert = () => {
    setForm(loaded)
    save.reset()
    test.reset()
  }

  const dirty = Object.keys(loaded).some((key) => form[key] !== loaded[key])
  const invalid = NUMBER_FIELDS.filter(([key, , min]) => {
    const value = Number(form[key])
    return form[key]?.trim() === '' || !Number.isFinite(value) || value < min
  })

  const payload = () => ({
    ...form,
    ...Object.fromEntries(NUMBER_FIELDS.map(([key]) => [key, Number(form[key])])),
  })

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Akasha 连接</h3>
        {dirty && <span className="tag warn">有未保存的改动</span>}
      </div>

      {save.error && <Failed error={save.error} />}
      {test.error && <Failed error={test.error} />}
      {save.result && (
        <div className="note">已保存 {save.result.updated.length} 个字段。</div>
      )}

      <div className="form-grid">
        <Field label="base_url">
          <input value={form.base_url ?? ''} onChange={(e) => set('base_url', e.target.value)} />
        </Field>
        <Field label="登录邮箱">
          <input value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <SecretField
          label="登录密码"
          value={form.password ?? ''}
          onChange={(value) => set('password', value)}
        />
        <SecretField
          label="只读 PostgreSQL"
          hint="归因链路用，可不填"
          value={form.database_url ?? ''}
          onChange={(value) => set('database_url', value)}
          placeholder="postgresql://…"
        />
      </div>

      <div className="form-grid compact">
        {NUMBER_FIELDS.map(([key, label, min]) => (
          <Field key={key} label={label}>
            <input
              type="number"
              min={min}
              value={form[key] ?? ''}
              onChange={(e) => set(key, e.target.value)}
            />
          </Field>
        ))}
      </div>

      {invalid.length > 0 && (
        <div className="note bad">
          <strong>这些字段要填数字：</strong>
          {invalid.map(([, label, min]) => `${label}（≥ ${min}）`).join('、')}
        </div>
      )}

      <div className="panel-actions">
        <button
          className="action primary"
          disabled={save.busy || !dirty || invalid.length > 0}
          onClick={() =>
            save.run(async () => {
              const result = await api.saveConnection(payload())
              reload()
              return result
            })
          }
        >
          {save.busy ? '保存中…' : '保存'}
        </button>
        <button className="action" disabled={!dirty || save.busy} onClick={revert}>
          放弃改动
        </button>
        <button
          className="action"
          disabled={test.busy}
          onClick={() => test.run(() => api.testConnection())}
        >
          {test.busy ? '测试中…' : '测试连接'}
        </button>
        {dirty && <span className="small muted">测试连接用的是已保存的配置</span>}
      </div>

      {test.result && (
        <div className={`note${test.result.is_owner ? '' : ' warn'}`}>
          <strong>连接成功。</strong> {test.result.user.email} · 角色 {test.result.user.role} ·{' '}
          workspace {test.result.workspace.name ?? test.result.workspace.id}
          <span style={{ marginLeft: 8 }}>
            <Pass ok={test.result.is_owner} yes="owner" no="非 owner" />
          </span>
          {test.result.owner_warning && (
            <div className="small" style={{ marginTop: 4 }}>
              {test.result.owner_warning}
            </div>
          )}
        </div>
      )}

      {test.result && test.result.blocked_compiles.length > 0 && (
        <div className="note bad">
          <strong>{test.result.blocked_compiles.length} 次编译在当前连接下用不了。</strong>
          <ul>
            {test.result.blocked_compiles.map((entry) => (
              <li key={entry.id} className="small">
                <span className="mono">{entry.run_id}</span> · {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

    </div>
  )
}

const FEATURE_LABELS: Record<string, string> = {
  compiler: '编译模型',
  embedding: '嵌入模型',
  answer: '回答模型',
  image: '图像模型',
}

function ModelConfigs() {
  const { data, error, loading } = useAsync(() => api.modelConfigs(), [])

  if (loading && !data) return <Loading what="模型配置" />

  return (
    <div className="panel">
      <h3>Akasha 远端模型配置</h3>
      {error ? <Failed error={error} /> : data && <LiveTable data={data} />}
    </div>
  )
}

function LiveTable({ data }: { data: ModelConfigsView }) {
  const byFeature = new Map(data.live.configs.map((entry) => [entry.feature, entry]))
  return (
    <table>
      <thead>
        <tr>
          <th>配置项</th>
          <th>模型</th>
          <th>base_url(/v1)</th>
          <th>parameters</th>
          <th>密钥</th>
        </tr>
      </thead>
      <tbody>
        {data.features.map((feature) => {
          const row = byFeature.get(feature)
          return (
            <tr key={feature}>
              <td>
                <div className="stack">
                  <span>{FEATURE_LABELS[feature] ?? feature}</span>
                  <span className="mono muted">{feature}</span>
                </div>
              </td>
              <td className="small mono">{row?.model ?? '—'}</td>
              <td className="small mono muted truncate">{row?.baseUrl ?? '—'}</td>
              <td
                className="small mono muted truncate"
                title={formatParameters(row?.parameters)}
              >
                {formatParameters(row?.parameters)}
              </td>
              <td>
                <Pass ok={Boolean(row?.apiKeySet)} yes="已设置" no="缺失" />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const BLANK = { label: '', base_url: '', model: '', api_key: '' }

type AkashaModelForm = {
  feature: AkashaFeature
  label: string
  base_url: string
  model: string
  api_key: string
  parameters: string
}

const emptyAkashaModel = (feature: AkashaFeature): AkashaModelForm => ({
  feature, label: '', base_url: '', model: '', api_key: '', parameters: '{}',
})

const TUNABLE_KEYS =
  'temperature（0-2）、topP（0-1）、seed（整数）、thinkingMode（qwen|openai）、' +
  'thinkingEnabled（布尔）、reasoningEffort（low|medium|high）'

const PARAMETER_KEYS: Record<AkashaFeature, string> = {
  compiler: TUNABLE_KEYS,
  answer: TUNABLE_KEYS,
  image: TUNABLE_KEYS,
  embedding: 'dimension（正整数）、supportsMrl（布尔）',
}

function parseParameters(text: string): {
  value: Record<string, unknown> | null
  error: string | null
} {
  const raw = text.trim()
  if (!raw) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (exc) {
    return { value: null, error: `JSON 解析失败：${(exc as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'parameters 必须是 JSON 对象' }
  }
  const value = parsed as Record<string, unknown>
  const dimension = value.dimension
  if (
    dimension !== undefined &&
    (typeof dimension !== 'number' || !Number.isInteger(dimension) || dimension <= 0)
  ) {
    return { value: null, error: 'dimension 必须是正整数' }
  }
  return { value, error: null }
}

const formatParameters = (parameters: Record<string, unknown> | undefined) =>
  parameters && Object.keys(parameters).length ? JSON.stringify(parameters) : '—'

function AkashaModels() {
  const { data, error, loading, reload } = useAsync(() => api.akashaModels(), [])
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<AkashaModelForm>(emptyAkashaModel('answer'))
  const save = useAction<unknown>()
  const remove = useAction<unknown>()
  const apply = useAction<unknown>()
  const models = data?.models ?? []

  if (loading && !data) return <Loading what="Akasha 模型配置" />

  const edit = (item: AkashaModelProvider) => {
    setEditing(item.id)
    setForm({
      feature: item.feature, label: item.label, base_url: item.base_url,
      model: item.model, api_key: '',
      parameters: JSON.stringify(item.parameters ?? {}, null, 2),
    })
    save.reset()
  }
  const create = (feature: AkashaFeature) => {
    setEditing('new')
    setForm(emptyAkashaModel(feature))
    save.reset()
  }
  const close = () => {
    setEditing(null)
    save.reset()
  }
  const parameters = parseParameters(form.parameters)
  const label = form.label.trim()
  const taken = models.some((item) =>
    item.feature === form.feature && item.label === label && item.id !== editing)

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Akasha 独立模型配置</h3>
      </div>
      {error && <Failed error={error} />}
      {save.error && <Failed error={save.error} />}
      {remove.error && <Failed error={remove.error} />}
      {apply.error && <Failed error={apply.error} />}
      {data?.features.map((feature) => (
        <div key={feature} className="metric-family">
          <div className="spread">
            <h4>{FEATURE_LABELS[feature] ?? feature}</h4>
            <button className="action small" disabled={save.busy} onClick={() => create(feature)}>
              新增端点
            </button>
          </div>
          <table className="endpoint-table akasha-endpoint-table">
            <colgroup>
              <col className="endpoint-label-col" />
              <col className="endpoint-name-col" />
              <col className="endpoint-url-col" />
              <col className="endpoint-params-col" />
              <col className="endpoint-key-col" />
              <col className="endpoint-actions-col" />
            </colgroup>
            <thead><tr><th>标签</th><th>模型</th><th>base_url(/v1)</th><th>parameters</th><th>密钥</th><th /></tr></thead>
            <tbody>
              {models.filter((item) => item.feature === feature).map((item) => (
                <AkashaModelRow
                  key={item.id}
                  model={item}
                  selected={item.id === editing}
                  applyBusy={apply.busy}
                  removeBusy={remove.busy}
                  onEdit={() => edit(item)}
                  onApply={() => apply.run(() => api.applyAkashaModel(item.id))}
                  onDeleted={() => remove.run(async () => {
                    const result = await api.deleteAkashaModel(item.id)
                    reload()
                    return result
                  })}
                />
              ))}
            </tbody>
          </table>
          {models.every((item) => item.feature !== feature) && editing === null && (
            <p className="small muted">还没有配端点。</p>
          )}
          {editing !== null && form.feature === feature && (
            <>
              <h4>{typeof editing === 'number' ? `编辑端点 #${editing}` : '新增端点'}</h4>
              <div className="form-grid inline">
                <Field label="标签" hint="同一类型下不重名"><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="default" /></Field>
                <Field label="模型"><input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
                <Field label="base_url"><input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
                <SecretField label="api_key" hint={typeof editing === 'number' ? '留空保留原值' : undefined} value={form.api_key} onChange={(api_key) => setForm({ ...form, api_key })} />
                <Field label="parameters" hint={`JSON 对象，可用：${PARAMETER_KEYS[feature]}`} wide>
                  <textarea
                    className="mono"
                    rows={5}
                    spellCheck={false}
                    value={form.parameters}
                    onChange={(e) => setForm({ ...form, parameters: e.target.value })}
                    placeholder="{}"
                  />
                </Field>
              </div>
              {parameters.error && <div className="note bad">{parameters.error}</div>}
              {taken && <div className="note bad">该类型下已经有一个叫「{label}」的端点。</div>}
              <div className="panel-actions">
                <button className="action primary" disabled={save.busy || !parameters.value || taken || !label || !form.model.trim() || !form.base_url.trim()} onClick={() => save.run(async () => {
                  const result = await api.saveAkashaModel({
                    feature: form.feature, label, base_url: form.base_url.trim(),
                    model: form.model.trim(), api_key: form.api_key,
                    parameters: parameters.value ?? {},
                    ...(typeof editing === 'number' ? { id: editing } : {}),
                  })
                  close(); reload(); return result
                })}>保存</button>
                <button className="action" onClick={close}>取消</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function AkashaModelRow({
  model,
  selected,
  applyBusy,
  removeBusy,
  onEdit,
  onApply,
  onDeleted,
}: {
  model: AkashaModelProvider
  selected: boolean
  applyBusy: boolean
  removeBusy: boolean
  onEdit: () => void
  onApply: () => void
  onDeleted: () => void
}) {
  const probe = useAction<ProviderProbe>()
  const embedding = model.feature === 'embedding'

  return (
    <>
      <tr className={selected ? 'selected' : ''}>
        <td>{model.label}</td>
        <td className="mono small">{model.model}</td>
        <td className="mono small muted truncate">{model.base_url}</td>
        <td className="mono small muted truncate" title={formatParameters(model.parameters)}>
          {formatParameters(model.parameters)}
        </td>
        <td><Pass ok={model.api_key_set} yes="已设置" no="缺失" /></td>
        <td className="table-actions-cell"><div className="table-actions">
          <button className="action small" onClick={onEdit}>编辑</button>
          <button
            className="action small"
            disabled={probe.busy}
            title={embedding ? '发送最小 embedding 请求 hi' : '发送最小 hi 请求'}
            onClick={() => probe.run(() => api.probeAkashaModel(model.id))}
          >
            {probe.busy ? '探测中…' : '探测'}
          </button>
          <button className="action small" disabled={applyBusy} onClick={onApply}>应用</button>
          <button className="action small danger" disabled={removeBusy} onClick={() => {
            if (window.confirm(`删除「${model.label}」？`)) onDeleted()
          }}>删除</button>
        </div></td>
      </tr>
      {(probe.result || probe.error) && (
        <tr>
          <td colSpan={6}>
            {probe.error && <Failed error={probe.error} />}
            {probe.result && <ProbeResult result={probe.result} onClose={probe.reset} />}
          </td>
        </tr>
      )}
    </>
  )
}

function ProviderRow({
  provider,
  selected,
  onEdit,
  onDeleted,
}: {
  provider: Provider
  selected: boolean
  onEdit: () => void
  onDeleted: () => void
}) {
  const probe = useAction<ProviderProbe>()
  const remove = useAction<unknown>()

  return (
    <>
      <tr className={selected ? 'selected' : ''}>
        <td>{provider.label}</td>
        <td className="small mono">{provider.model}</td>
        <td className="small mono muted truncate">{provider.base_url}</td>
        <td>
          <Pass ok={provider.api_key_set} yes="已设置" no="缺失" />
        </td>
        <td>
          <div className="table-actions">
            <button className="action small" onClick={onEdit}>
              编辑
            </button>
            <button
              className="action small"
              disabled={probe.busy}
              title="向这个端点发一句 hi，真实调用模型"
              onClick={() => probe.run(() => api.probeProvider(provider.id))}
            >
              {probe.busy ? '探测中…' : '探测'}
            </button>
            <button
              className="action small danger"
              disabled={remove.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `删除端点「${provider.label}」？\n\n引用它的评测与归因记录会失去关联。`,
                  )
                )
                  return
                remove.run(async () => {
                  const result = await api.deleteProvider(provider.id)
                  onDeleted()
                  return result
                })
              }}
            >
              删除
            </button>
          </div>
        </td>
      </tr>
      {(probe.result || probe.error || remove.error) && (
        <tr>
          <td colSpan={5}>
            {remove.error && <Failed error={remove.error} />}
            {probe.error && <Failed error={probe.error} />}
            {probe.result && <ProbeResult result={probe.result} onClose={probe.reset} />}
          </td>
        </tr>
      )}
    </>
  )
}

function ProbeResult({ result, onClose }: { result: ProviderProbe; onClose: () => void }) {
  return (
    <div className={`note ${result.ok ? 'ok' : 'bad'}`}>
      <div className="spread">
        <strong>
          {result.ok ? 'Success' : 'Fail'}
          {result.status !== null && <span className="small mono muted"> HTTP {result.status}</span>}
          {result.failure && <span className="small mono"> {result.failure}</span>}
        </strong>
        <button className="action small" onClick={onClose}>
          收起
        </button>
      </div>
      {result.ok && result.reply && (
        <pre className="block" style={{ marginTop: 6 }}>
          {result.reply}
        </pre>
      )}
      {!result.ok && result.detail && (
        <pre className="block" style={{ marginTop: 6 }}>
          {result.detail}
        </pre>
      )}
    </div>
  )
}

function Providers({ role, title }: { role: ProviderRole; title: string }) {
  const { data, error, loading, reload } = useAsync<Provider[]>(() => api.providers(role), [role])
  const [mode, setMode] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(BLANK)
  const save = useAction<{ id: number }>()

  const providers = data ?? []
  const editing = typeof mode === 'number' ? mode : null
  const set = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch })
    save.reset()
  }
  const close = () => {
    setMode(null)
    setForm(BLANK)
    save.reset()
  }
  const create = () => {
    setMode('new')
    setForm(BLANK)
    save.reset()
  }
  const edit = (provider: Provider) => {
    setMode(provider.id)
    setForm({
      label: provider.label,
      base_url: provider.base_url,
      model: provider.model,
      api_key: '',
    })
    save.reset()
  }

  const label = form.label.trim() || 'default'
  const taken = providers.some((p) => p.label === label && p.id !== editing)

  if (loading && !data) return <Loading what={title} />

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <button className="action small" disabled={save.busy} onClick={create}>
          新增端点
        </button>
      </div>

      {error && <Failed error={error} />}
      {save.error && <Failed error={save.error} />}

      {providers.length > 0 && (
        <table className="endpoint-table">
          <colgroup>
            <col className="endpoint-label-col" />
            <col className="endpoint-name-col" />
            <col className="endpoint-url-col" />
            <col className="endpoint-key-col" />
            <col className="endpoint-actions-col" />
          </colgroup>
          <thead>
            <tr>
              <th>标签</th>
              <th>模型</th>
              <th>base_url(/v1)</th>
              <th>密钥</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                selected={provider.id === editing}
                onEdit={() => edit(provider)}
                onDeleted={() => {
                  if (editing === provider.id) close()
                  reload()
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      {providers.length === 0 && !error && mode === null && (
        <p className="small muted">还没有配端点。</p>
      )}

      {save.result && <div className="note">已保存端点。</div>}

      {mode !== null && (
        <>
          <h4>{editing === null ? '新增端点' : `编辑端点 #${editing}`}</h4>
          <div className="form-grid inline">
            <Field label="标签" hint="同一类型下不重名">
              <input
                value={form.label}
                onChange={(e) => set({ label: e.target.value })}
                placeholder="default"
              />
            </Field>
            <Field label="模型">
              <input value={form.model} onChange={(e) => set({ model: e.target.value })} />
            </Field>
            <Field label="base_url">
              <input
                value={form.base_url}
                onChange={(e) => set({ base_url: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </Field>
            <SecretField
              label="api_key"
              hint={editing === null ? undefined : '留空保留原值'}
              value={form.api_key}
              onChange={(value) => set({ api_key: value })}
            />
          </div>

          {taken && (
            <div className="note bad">
              已经有一个叫「{label}」的端点了。换个标签，或者在上表里点它的「编辑」。
            </div>
          )}

          <div className="panel-actions">
            <button
              className="action primary"
              disabled={save.busy || taken || !form.base_url || !form.model}
              onClick={() =>
                save.run(async () => {
                  const result = await api.saveProvider(role, {
                    ...form,
                    label,
                    ...(editing === null ? {} : { id: editing }),
                  })
                  setMode(null)
                  setForm(BLANK)
                  reload()
                  return result
                })
              }
            >
              {save.busy ? '保存中…' : '保存'}
            </button>
            <button className="action" disabled={save.busy} onClick={close}>
              取消
            </button>
          </div>
        </>
      )}
    </div>
  )
}
