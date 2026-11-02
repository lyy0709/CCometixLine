// The ccline companion mod: session data and opt-in native prompt keepalive. It watches the
// session from inside Claude Code and writes what the status line's JSON
// lacks to `<ccline home>/bridge/<session id>.json`, which ccline reads when
// it renders. Keepalive submits visible prompts through the official engine.
//
// Written by ccline from the copy built into it. Format: src/state/bridge.rs
// in CCometixLine.

import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

/** Bridge format version; ccline ignores files with another. */
const VERSION = 1
/** Events within this many milliseconds share one write. */
const FLUSH_MS = 200
/** A response that streamed for less than this gives no speed. */
const MIN_STREAM_MS = 100

type Category = { name: string; kind: string; tokens: number }
type Context = {
  threshold?: number
  auto: boolean
  window?: number
  used?: number
  categories: Category[]
}
/** The main loop's last model request, and how long its last turn took. */
type Turn = {
  model?: string
  ttft_ms?: number
  tps?: number
  /** The last finished turn's wall-clock length. */
  duration_ms?: number
  /** The last request's. */
  output_tokens?: number
  ended_at?: number
}
type Tool = { name: string; since: number; agent?: string }
type Agent = { id: string; type: string; status: string; description?: string }
type Chunk = { kind?: string; usage?: { output_tokens?: number; model?: string } | null }

const CACHE_MARGIN_MS = 10 * 60 * 1000
const CHECK_MS = 10_000
const FRESH_MS = 30_000
const PING = '[CCometixLine 保活] 仅回复 OK。不要调用工具，不要继续之前的任务。'
type Keepalive = {
  state: string; reason?: string; next_at?: number; last_at?: number
  attempts: number; replies: number; cache_read_tokens: number; cache_write_tokens: number
  last_result?: string
}
function freshKeepalive() {
  return {
    view: { state: 'waiting', reason: '等待正常对话', attempts: 0, replies: 0,
      cache_read_tokens: 0, cache_write_tokens: 0 } as Keepalive,
    timer: undefined as { cancel(): void } | undefined,
    enabled: undefined as boolean | undefined, hasDraft: false,
    interactive: false, checking: false, eligible: false, human: false, queuedHuman: false,
    busy: false, needsHuman: false, lastTick: 0, revision: 0,
    nextAt: undefined as number | undefined, sentExpiresAt: undefined as number | undefined,
    turn: undefined as string | undefined,
    ownTurn: undefined as string | undefined,
    ownRow: false,
    pending: undefined as { cancelled: boolean } | undefined,
  }
}
let keep = freshKeepalive()
// Normal activity replaces a pause reason; never retain a draft warning on
// a running turn. Disabled keepalive stays disabled through session events.
function activity(state: 'busy' | 'draft' | 'sending' | 'waiting' | 'countdown') {
  if (keep.enabled === false) return
  keep.view.state = state
  keep.view.reason = undefined
  keep.view.next_at = state === 'countdown' ? keep.nextAt : undefined
}
function pause(reason: string) {
  keep.view.state = 'paused'; keep.view.reason = reason; keep.view.next_at = undefined
}
function failed(reason: string) {
  keep.eligible = false; keep.needsHuman = true
  keep.view.last_result = reason
  pause(reason)
}
async function cancelOwn($: $) {
  if (keep.pending) keep.pending.cancelled = true
  if (keep.ownTurn && keep.ownTurn === keep.turn) {
    try {
      await $.turn.abort({ turnId: keep.ownTurn })
    } catch (error) {
      failed(`取消保活失败：${String(error)}`)
      $.ui.log(`ccline keepalive: ${String(error)}`, { to: 'debug' })
    }
  }
}
async function snapshot($: $) {
  const dir = await where($)
  const session = live.session
  if (!dir || !session || !/^[a-zA-Z0-9_-]{1,80}$/.test(session)) throw new Error('会话数据不可用')
  const doc = JSON.parse(String(await $.fs.read(`${dir}/../state/sessions/${session}.json`)))
  const now = await $.clock.now()
  if (doc.last_input?.session_id !== session || !Number.isFinite(doc.saved_at)
      || now - doc.saved_at * 1000 > FRESH_MS || doc.saved_at * 1000 > now + 1000) {
    throw new Error('状态栏数据过旧；检查 2 秒刷新设置')
  }
  return doc
}
async function checkKeepalive($: $) {
  const k = keep
  if (!k.interactive || k.checking) return
  k.checking = true
  try {
    await follow($)
    if (k !== keep) { await write($); return }
    const revision = k.revision
    const now = await $.clock.now()
    if (k.lastTick && (now - k.lastTick > FRESH_MS || now < k.lastTick)) {
      k.eligible = false; k.needsHuman = true
      pause('时钟中断；等待正常对话')
    }
    k.lastTick = now
    const doc = await snapshot($)
    if (k !== keep) return
    k.enabled = doc.keepalive?.enabled === true
    if (!k.enabled) {
      k.eligible = false
      k.view.state = 'off'; k.view.reason = undefined; k.view.next_at = undefined
      await cancelOwn($)
      return
    }
    if (k.pending || k.busy) { activity(k.ownTurn ? 'sending' : 'busy'); return }
    if ([...live.tools.values()].some(t => t.agent === undefined)) {
      activity('busy'); return
    }
    const draftText = (await $.prompt.read()).text
    if (k !== keep || revision !== k.revision || !k.interactive) return
    k.hasDraft = draftText !== ''
    if (k.hasDraft) { activity('draft'); return }
    if (!k.eligible) {
      if (k.view.state !== 'paused') {
        if (k.needsHuman) pause('等待正常对话恢复保活')
        else activity('waiting')
      }
      return
    }
    const pc = doc.last_input?.prompt_cache
    if (pc?.ttl !== '1h') { pause(pc?.ttl === '5m' ? '五分钟缓存，已暂停' : '缓存 TTL 未知'); return }
    if (pc.caching_observed !== true || pc.warm !== true || !Number.isFinite(pc.expires_at)
        || pc.expires_at * 1000 <= now) { pause('缓存不存在或已过期'); return }
    const model = await $.session.model()
    if (k !== keep || !k.interactive || !k.eligible || revision !== k.revision) return
    if (doc.last_input?.model?.id !== model) { pause('模型已变化；等待状态同步'); return }
    k.nextAt = pc.expires_at * 1000 - CACHE_MARGIN_MS
    if (k.sentExpiresAt !== undefined && pc.expires_at * 1000 <= k.sentExpiresAt) {
      pause('等待缓存续期确认'); return
    }
    activity('countdown')
    if (now < k.nextAt) return
    // Recheck immediately before handing the prompt to the engine. No await
    // between the final revision check and submit: a human prompt wins a race.
    const latest = await snapshot($)
    const draft = await $.prompt.read()
    const id = await $.session.id()
    const at = await $.clock.now()
    const currentModel = await $.session.model()
    if (k !== keep || !k.interactive || !k.eligible || revision !== k.revision || k.busy || k.pending || draft.text !== '' || id !== live.session) return
    const cache = latest.last_input?.prompt_cache
    if (currentModel !== model || latest.last_input?.model?.id !== model) { pause('模型已变化；等待状态同步'); return }
    if (latest.keepalive?.enabled !== true || cache?.ttl !== '1h' || cache.warm !== true
        || cache.caching_observed !== true || !Number.isFinite(cache.expires_at) || cache.expires_at * 1000 <= at) return
    // A normal request can refresh the cache during the final reads. Use
    // the same expiry as the cache/hit metric, never the turn end time.
    k.nextAt = cache.expires_at * 1000 - CACHE_MARGIN_MS
    if (k.sentExpiresAt !== undefined && cache.expires_at * 1000 <= k.sentExpiresAt) {
      pause('等待缓存续期确认'); return
    }
    if (at < k.nextAt) { activity('countdown'); return }
    k.sentExpiresAt = cache.expires_at * 1000
    const pending = { cancelled: false }
    k.pending = pending; k.ownRow = false
    activity('sending')
    k.view.last_at = at; k.view.attempts++
    const result = await $.prompt.submit({ text: PING })
    if (k !== keep) return
    if (result.drop !== undefined) {
      k.pending = undefined
      failed(`提交被拒绝：${result.drop}`)
    }
  } catch (error) {
    if (k === keep) {
      if (k.pending) { k.pending = undefined; failed(`保活失败：${String(error)}`) }
      else pause(String(error))
    }
  } finally {
    k.checking = false
    if (k === keep) await write($)
  }
}

/** What the bridge holds, kept between events. */
const live = {
  dir: undefined as string | undefined,
  session: undefined as string | undefined,
  context: undefined as Context | undefined,
  turn: undefined as Turn | undefined,
  agents: [] as Agent[],
  tools: new Map<string, Tool>(),
  pending: false,
  seq: 0,
}

// Where to write: the path the installer left beside the mod, else the
// home ccline uses by default.
async function where($: $): Promise<string | undefined> {
  if (live.dir !== undefined) return live.dir
  try {
    const saved = JSON.parse(String(await $.fs.read(`${$.plugin.root}/bridge.json`)))
    if (typeof saved?.dir === 'string' && saved.dir !== '') live.dir = saved.dir
  } catch {}
  if (live.dir === undefined) {
    const own = await $.env.get('CCLINE_HOME')
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (own) live.dir = `${own}/bridge`
    else if (home) live.dir = `${home}/.claude/ccline/bridge`
  }
  return live.dir
}

// Forget what the bridge held for another session.
function reset(session: string) {
  keep.timer?.cancel()
  keep = freshKeepalive()
  live.session = session
  live.context = undefined
  live.turn = undefined
  live.agents = []
  live.tools.clear()
}

// The session can change under a running process (/clear, /resume), and
// each one's figures are its own: start over when the id moves.
async function follow($: $) {
  try {
    const id = await $.session.id()
    if (id && id !== live.session) {
      const interactive = keep.interactive
      reset(id)
      keep.interactive = interactive
      if (interactive) keep.timer = $.clock.every(CHECK_MS, () => { void checkKeepalive($) })
    }
  } catch {}
}

async function write($: $) {
  try {
    const to = await where($)
    live.session ??= await $.session.id()
    if (to === undefined || !live.session) return
    const doc = {
      v: VERSION,
      session: live.session,
      updated_at: await $.clock.now(),
      context: live.context,
      turn: live.turn,
      tools: [...live.tools.values()],
      agents: live.agents,
      keepalive: keep.view,
    }
    await $.fs.write(`${to}/${live.session}.json`, JSON.stringify(doc))
  } catch (error) {
    keep.eligible = false; keep.needsHuman = true
    pause('状态写入失败')
    $.ui.log(`ccline keepalive: ${String(error)}`, { to: 'debug' })
  }
}

// Coalesce a burst of events into one write shortly after.
function flush($: $) {
  if (live.pending) return
  live.pending = true
  try {
    $.clock.after(FLUSH_MS, () => {
      live.pending = false
      void write($)
    })
  } catch {
    live.pending = false
  }
}

async function measure($: $) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (b === undefined) return
    live.context = {
      threshold: b.autoCompactThreshold,
      auto: b.isAutoCompactEnabled,
      window: b.rawMaxTokens,
      used: b.totalTokens,
      categories: b.categories.map((c) => ({ name: c.name, kind: c.kind, tokens: c.tokens })),
    }
  } catch {}
}

async function listAgents($: $) {
  try {
    live.agents = (await $.agent.list()).map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      description: a.description,
    }))
  } catch {}
}

async function now($: $): Promise<number> {
  return $.clock.now()
}

// One main-loop request is done: its time to first token and its speed,
// shown while the turn goes on rather than once it ends.
function timed(sent: number, first: number, last: number, output?: number, model?: string) {
  const streamed = last - first
  live.turn = {
    ...live.turn,
    model: model ?? live.turn?.model,
    ttft_ms: first - sent,
    tps: output && streamed >= MIN_STREAM_MS ? (output * 1000) / streamed : live.turn?.tps,
    output_tokens: output,
    ended_at: last,
  }
}

export const register: Register = (on) => {
  live.dir = undefined
  live.pending = false
  keep.timer?.cancel()
  keep = freshKeepalive()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    keep.timer?.cancel()
    keep = freshKeepalive()
    try {
      await follow($)
      keep.interactive = e.isInteractive && e.surface === 'terminal'
      if (keep.interactive) keep.timer = $.clock.every(CHECK_MS, () => { void checkKeepalive($) })
      await measure($)
      await write($)
    } catch {}
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    await follow($)
    keep.revision++
    keep.eligible = false
    keep.queuedHuman = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    await cancelOwn($)
    keep.hasDraft = false
    activity('busy')
    flush($)
    const submitted = await next(e)
    if (submitted.drop !== undefined && !keep.busy) { activity('waiting'); flush($) }
    return submitted
  })
  on('prompt.edit', async ($, e, next) => {
    await follow($)
    const k = keep, revision = ++k.revision
    const edited = await next(e)
    if (k === keep && revision === k.revision) {
      k.hasDraft = edited.text !== ''
      if (!k.busy && !k.pending) {
        if (k.hasDraft) activity('draft')
        else void checkKeepalive($)
      }
      flush($)
    }
    return edited
  })
  on('session.append', async ($, e, next) => {
    if (e.door === 'prompt' && e.agentId === undefined) {
      keep.queuedHuman = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      keep.ownRow = !!keep.pending && e.origin.kind === 'plugin' && e.origin.name === 'cometix'
    }
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    keep.busy = true; keep.turn = e.turnId; keep.revision++
    keep.human = keep.queuedHuman
    keep.queuedHuman = false
    if (keep.ownRow && keep.pending) {
      keep.ownTurn = e.turnId
      if (keep.pending.cancelled) await cancelOwn($)
    }
    keep.ownRow = false
    activity(keep.ownTurn === e.turnId ? 'sending' : 'busy')
    flush($)
    return next(e)
  })

  // After each main-thread turn, and when a rate limit moves.
  on('session.measure', async ($, e, next) => {
    const echoed = await next(e)
    await follow($)
    if (e.changed.includes('context')) {
      await measure($)
      flush($)
    }
    return echoed
  })

  // Time each model request on the main loop as Claude Code does: from
  // sending it to the first thing back (the response's envelope), then the
  // output its stop counted over the time it streamed, thinking included.
  // Subagents' requests pass straight through.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await follow($)
    const sent = await now($)
    let first: number | undefined
    let output: number | undefined
    let model: string | undefined
    const stream = next(e)
    let ended = false
    try {
      for (;;) {
        const piece = await stream.next()
        if (piece.done) {
          ended = true
          try {
            if (first !== undefined) {
              const usage = piece.value?.usage
              timed(sent, first, await now($), output ?? usage?.output_tokens, model ?? usage?.model)
              flush($)
            }
          } catch {}
          return piece.value
        }
        const c = piece.value as Chunk
        if (first === undefined) first = await now($)
        if (c.kind === 'stop' && c.usage) {
          output = c.usage.output_tokens
          model = c.usage.model
        }
        yield piece.value
      }
    } finally {
      // Left early (the answer was interrupted): close the stream beneath,
      // as a for-await loop would.
      if (!ended) await stream.return?.(undefined as never)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    try {
      await follow($)
      if (e.agentId === undefined) {
        const own = keep.ownTurn === e.turnId
        const cancelled = own && keep.pending?.cancelled === true
        keep.busy = false; keep.turn = undefined; keep.revision++
        if (own) {
          keep.ownTurn = undefined; keep.pending = undefined
          if (e.reason === 'answer' && !cancelled) {
            keep.view.replies++
            keep.view.cache_read_tokens += e.usage?.cache_read_input_tokens ?? 0
            keep.view.cache_write_tokens += e.usage?.cache_creation_input_tokens ?? 0
            keep.view.last_result = (e.usage?.cache_read_input_tokens ?? 0) > 0 ? '缓存命中' : '收到回复，未确认缓存命中'
          } else failed((keep.view.state === 'paused' ? keep.view.reason : undefined) ?? `保活结束：${e.reason}`)
        }
        if (e.reason === 'answer' && !cancelled && (!keep.needsHuman || keep.human)) {
          // Background notifications and scheduled monitoring also refresh
          // the main cache. Only recovery from failure requires a human turn.
          keep.eligible = true; keep.needsHuman = false
          activity(keep.hasDraft ? 'draft' : 'waiting')
          if (!own) keep.view.last_result = undefined
        }
        keep.human = false
        live.turn = { ...live.turn, duration_ms: e.durationMs, ended_at: await now($) }
      }
      await listAgents($)
      // Let the completed turn leave the hook before a due prompt is queued.
      if (e.agentId === undefined && keep.eligible) {
        $.clock.after(0, () => { void checkKeepalive($) })
      }
      flush($)
    } catch {}
    return answered
  })

  // Tools running now, the main loop's and the agents'.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && keep.ownTurn && keep.ownTurn === keep.turn) {
      failed('保活尝试调用工具，已停止')
      await cancelOwn($)
      return { deny: '保活仅允许文本回复，不能调用工具。' }
    }
    const key = e.tool_use_id ?? `ccline-${live.seq++}`
    try {
      await follow($)
      live.tools.set(key, { name: e.tool, since: await now($), agent: e.agentId })
      flush($)
    } catch {}
    try {
      return await next(e)
    } finally {
      live.tools.delete(key)
      flush($)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await follow($)
    await listAgents($)
    flush($)
    return spawned
  })

  on('session.end', async ($, e, next) => {
    // /clear and /resume end a transcript, not the interactive process.
    // They emit no new session.start: retain the monitor so follow() can
    // bind the new id, resetting eligibility and the old idle deadline.
    const switching = e.reason === 'clear' || e.reason === 'resume'
    if (!switching) {
      keep.timer?.cancel()
      keep.interactive = false
    }
    keep.revision++; keep.eligible = false
    if (keep.pending) keep.pending.cancelled = true
    pause(switching ? '正在切换会话' : '会话已结束')
    live.tools.clear()
    live.agents = []
    await write($)
    return next(e)
  })
}
