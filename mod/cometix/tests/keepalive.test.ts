import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const IDLE = 3_000_000
const PING = '[CCometixLine 保活] 仅回复 OK。不要调用工具，不要继续之前的任务。'

async function setup($: any, on: On) {
  // Offset only the wall clock reading; scheduled timers still advance on
  // the deterministic clock, so a suspended machine is observable as a gap.
  const clock = mock.clock(((event: any, handler: any) => {
    if (event === 'clock.now') on(event, async ($, e, next) => {
      const result = await handler($, e, next)
      return { value: result.value + state.wallOffset }
    })
    else on(event, handler)
  }) as On, { now: 1_000_000 })
  const state = {
    wallOffset: 0, session: 's1', enabled: true, ttl: '1h', warm: true, stale: false,
    expires: 4_600_000, draft: '', active: false, rejected: false, refreshOnComplete: true,
    readError: false, submitted: [] as string[], aborts: [] as string[],
    writes: {} as any, model: 'claude-test', beforeModel: undefined as (() => Promise<void>) | undefined,
    beforeDraft: undefined as (() => void) | undefined,
    toolGate: undefined as Promise<void> | undefined,
  }
  on('fs.read', (_, e) => {
    if (e.path.endsWith('bridge.json')) return { value: JSON.stringify({ dir: '/ccline/bridge' }) }
    if (state.readError) return { value: '{incomplete' }
    return { value: JSON.stringify({ saved_at: (clock.now() + state.wallOffset - (state.stale ? 60_000 : 0)) / 1000,
      keepalive: { enabled: state.enabled }, last_input: { session_id: state.session, model: { id: state.model },
        prompt_cache: { ttl: state.ttl, warm: state.warm, caching_observed: true, expires_at: state.expires / 1000 } } }) }
  })
  on('fs.write', (_, e) => { state.writes = JSON.parse(e.text); return { value: undefined } })
  on('session.id', () => ({ value: state.session }))
  on('session.model', async () => {
    const action = state.beforeModel; state.beforeModel = undefined
    await action?.()
    return { value: state.model }
  })
  on('session.usage', () => ({ value: { context: {}, rateLimits: [] } }))
  on('agent.list', () => ({ value: state.active ? [{ id: 'a1', status: 'running' }] : [] }))
  on('prompt.read', () => {
    state.beforeDraft?.()
    return { value: { text: state.draft, cursor: 0 } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: state.session }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => {
    if (e.reason === 'answer' && e.agentId === undefined && state.refreshOnComplete) {
      state.expires = clock.now() + state.wallOffset + 3_600_000
    }
    return { text: e.answer }
  })
  on('turn.abort', (_, e) => { state.aborts.push(e.turnId); return { value: undefined } })
  on('prompt.edit', (_, e) => {
    state.draft = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text: state.draft, cursor: e.start + e.inputText.length }
  })
  on('tool.call', async () => { await state.toolGate; return { result: 'ordinary result' } })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', async (_, e) => {
    if (e.text !== PING) { state.draft = ''; return { text: e.text, origin: e.origin } }
    state.submitted.push(e.text)
    if (state.rejected) return { drop: 'test policy rejection' }
    await $.session.append({ door: 'prompt', origin: { kind: 'plugin', name: 'cometix' },
      uuid: 'ping-row', message: { type: 'user', content: [{ type: 'text', text: PING }] } })
    await $.turn.start({ text: `The cometix plugin sent a message:\n${PING}`, turnId: 'ping' })
    return { text: e.text, origin: { kind: 'plugin', name: 'cometix' } }
  })
  const complete = (id = 'human', reason = 'answer') => $.turn.complete({
    turnId: id, answer: 'OK', durationMs: 1, isAborted: reason === 'aborted', reason,
    usage: { input_tokens: 4, output_tokens: 4, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100, model: 'claude-test' },
  })
  const human = async () => {
    await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: 'hello', turnId: 'human' })
    await complete()
  }
  await $.session.start({ cwd: '/test', surface: 'terminal', isInteractive: true })
  return { state, clock, human, complete }
}

test('cache reaches ten minutes remaining, one in-flight prompt, and renewed cycles', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  await human()
  await clock.advance(IDLE - 1)
  expect(state.submitted.length).toBe(0)
  await clock.advance(1)
  expect(state.submitted).toEqual([PING])
  await clock.advance(20_000)
  expect(state.submitted.length).toBe(1)
  await complete('ping')
  await clock.advance(200)
  expect(state.writes.keepalive.replies).toBe(1)
  expect(state.writes.keepalive.cache_read_tokens).toBe(2000)
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(2)
})

test('drafts, foreground turns, short/unknown TTL, expiry and stale snapshots defer sending', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  await human()
  state.draft = 'unfinished'
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(0)
  state.draft = ''
  await $.turn.start({ text: 'foreground', turnId: 'foreground' })
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  state.refreshOnComplete = false; state.ttl = '5m'
  await complete('foreground')
  for (const ttl of ['5m', 'unknown']) {
    state.ttl = ttl; await clock.advance(10_000)
    expect(state.submitted.length).toBe(0)
  }
  state.ttl = '1h'; state.warm = false
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  state.warm = true; state.stale = true
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  state.stale = false; state.readError = true
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  state.readError = false; state.expires = clock.now()
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  state.expires = clock.now() + 600_000
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(1)
})

test('rejected or failed keepalive pauses until a normal user turn succeeds', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  state.rejected = true
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
  state.rejected = false; state.expires = clock.now() + 10_000_000
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(2)
  await complete('ping', 'error')
  await clock.advance(200)
  expect(state.writes.keepalive.reason).toContain('error')
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(2)
})

test('native keepalive refuses tools and user input cancels only its own turn', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  await human(); await clock.advance(IDLE)
  const result = await $.tool.call({ tool: 'Glob', pattern: '*' })
  expect(result.deny).toContain('保活')
  expect(state.aborts).toEqual(['ping'])
  await complete('ping', 'aborted')
  await clock.advance(200)
  expect(state.writes.keepalive.reason).toContain('调用工具')
  expect(await $.tool.call({ tool: 'Glob', pattern: '*' })).toEqual(expect.objectContaining({ result: 'ordinary result' }))
  // Completing off the poll boundary may defer the next send by up to 10s.
  await human(); await clock.advance(IDLE + 10_000)
  expect(state.submitted.length).toBe(2)
  await $.prompt.submit({ text: 'new user task', origin: { kind: 'composer' }, wait: false } as any)
  expect(state.aborts).toEqual(['ping', 'ping'])
})

test('disabled and restarted sessions do not replay timers; exit stops the timer', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(0)
  await human(); state.enabled = false
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(0)
  state.enabled = true
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  await human(); await $.session.end({ reason: 'exit' } as any)
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(0)
})


test('busy turns are never interrupted and session changes need a fresh human turn', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  await human()
  await $.prompt.submit({ text: 'long task', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'long task', turnId: 'long' })
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(0)
  expect(state.aborts.length).toBe(0)
  await complete('long')
  await clock.advance(IDLE - 1)
  expect(state.submitted.length).toBe(0)
  await clock.advance(1)
  expect(state.submitted.length).toBe(1)
  await complete('ping')
  state.session = 's2'; state.expires = clock.now() + 10_000_000
  await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(2)
  expect(state.writes.session).toBe('s2')
})

test('a repeated SessionStart replaces the old timer and does not replay old idle time', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await human(); await clock.advance(IDLE - 10_000)
  await $.session.start({ cwd: '/test', surface: 'terminal', isInteractive: true })
  await clock.advance(20_000)
  expect(state.submitted.length).toBe(0)
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
})

for (const reason of ['clear', 'resume']) {
  test(`${reason} keeps monitoring the new session without another SessionStart`, async ($, on) => {
    const { state, clock, human } = await setup($, on)
    await human(); await clock.advance(IDLE - 10_000)
    await $.session.end({ reason, sessionId: state.session } as any)
    state.session = `after-${reason}`
    await clock.advance(20_000)
    expect(state.writes.session).toBe(state.session)
    expect(state.writes.keepalive.state).toBe('waiting')
    // These transitions emit no SessionStart. Editing must bind the new
    // session, and deleting the last character must clear its draft state.
    await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0,
      start: 0, end: 0, inputText: 'draft' })
    await clock.advance(200)
    expect(state.writes.session).toBe(state.session)
    expect(state.writes.keepalive.state).toBe('draft')
    await $.prompt.edit({ origin: { kind: 'composer' }, text: 'draft', cursor: 5,
      start: 0, end: 5, inputText: '' })
    await clock.advance(200)
    expect(state.writes.keepalive.state).toBe('waiting')
    expect(state.writes.keepalive.next_at).toBeUndefined()
    await clock.advance(40_000)
    expect(clock.now() - state.writes.updated_at < 10_000).toBe(true)
    expect(state.submitted.length).toBe(0)
    // A successful new user turn, rather than the restored old deadline,
    // arms the next cycle; the monitor must still be running then.
    await human(); await clock.advance(IDLE + 10_000)
    expect(state.submitted.length).toBe(1)
    expect(state.writes.session).toBe(state.session)
  })
}


test('a sleep or clock discontinuity never backfills an overdue ping', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await human(); await clock.advance(20_000)
  state.wallOffset = IDLE
  state.expires = clock.now() + state.wallOffset + 10_000_000
  await clock.advance(20_000)
  expect(state.submitted.length).toBe(0)
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
})

test('noninteractive sessions do not arm automatic prompts', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await $.session.start({ cwd: '/test', surface: null, isInteractive: false })
  await human(); await clock.advance(IDLE * 2)
  expect(state.submitted.length).toBe(0)
})


test('session end during eligibility reads prevents the pending timer from submitting', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await human(); await clock.advance(IDLE - 10_000)
  state.beforeModel = async () => { await $.session.end({ reason: 'exit' } as any) }
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  expect(state.writes.keepalive.reason).toBe('会话已结束')
})

test('a model switch during the final draft read invalidates the cache check', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await human(); await clock.advance(IDLE - 10_000)
  let reads = 0
  state.beforeDraft = () => { if (++reads === 2) state.model = 'claude-other' }
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
})


test('activity follows prompt events immediately and busy overrides a new draft', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  const edit = async (text: string) => {
    await $.prompt.edit({ origin: { kind: 'composer' }, text: state.draft, cursor: state.draft.length,
      start: 0, end: state.draft.length, inputText: text })
    await clock.advance(200)
  }
  await human(); await clock.advance(10_000)
  await edit('unfinished')
  expect(state.writes.keepalive.state).toBe('draft')
  expect(state.writes.keepalive.reason).toBeUndefined()
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  await clock.advance(200)
  expect(state.writes.keepalive.state).toBe('busy')
  expect(state.writes.keepalive.reason).toBeUndefined()
  expect(state.writes.keepalive.next_at).toBeUndefined()
  await $.turn.start({ text: 'hello', turnId: 'human' })
  await edit('next question')
  expect(state.writes.keepalive.state).toBe('busy')
  await clock.advance(10_000)
  expect(state.writes.keepalive.state).toBe('busy')
  expect(state.writes.keepalive.reason).toBeUndefined()
  await complete(); await clock.advance(200)
  expect(state.writes.keepalive.state).toBe('draft')
  await edit('')
  expect(state.writes.keepalive.state).toBe('countdown')
  expect(state.writes.keepalive.reason).toBeUndefined()
  expect(state.submitted.length).toBe(0)
})

test('prompt activity leaves disabled keepalive off', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  state.enabled = false
  await clock.advance(10_000)
  await human(); await clock.advance(200)
  expect(state.writes.keepalive.state).toBe('off')
  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'draft' })
  await clock.advance(200)
  expect(state.writes.keepalive.state).toBe('off')
  expect(state.writes.keepalive.reason).toBeUndefined()
})

for (const origin of ['task-notification', 'scheduled-trigger']) {
  test(`${origin} completion arms cache-based keepalive while background tasks remain`, async ($, on) => {
    const { state, clock, human, complete } = await setup($, on)
    await human(); await clock.advance(120_000)
    await $.prompt.submit({ text: 'monitor result', origin: { kind: origin }, wait: false } as any)
    await $.turn.start({ text: 'monitor result', turnId: 'monitor' })
    state.active = true
    await complete('monitor'); await clock.advance(200)
    expect(state.writes.keepalive.state).toBe('countdown')
    expect(state.writes.keepalive.next_at).toBe(state.expires - 600_000)
    await clock.advance(IDLE - 201)
    expect(state.submitted.length).toBe(0)
    await clock.advance(10_001)
    expect(state.submitted.length).toBe(1)
  })
}

test('cache expiry rather than reply completion defines the send time', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  await human()
  await $.prompt.submit({ text: 'long answer', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'long answer', turnId: 'long' })
  await clock.advance(20 * 60_000)
  state.refreshOnComplete = false
  await complete('long'); await clock.advance(200)
  expect(state.writes.keepalive.next_at).toBe(state.expires - 600_000)
  await clock.advance(30 * 60_000 - 201)
  expect(state.submitted.length).toBe(0)
  await clock.advance(1)
  expect(state.submitted.length).toBe(1)
})

test('a cache refresh during final validation postpones the pending send', async ($, on) => {
  const { state, clock, human } = await setup($, on)
  await human(); await clock.advance(IDLE - 10_000)
  let reads = 0
  // The final snapshot must see a fresh expiry before committing a prompt.
  state.beforeDraft = () => { if (++reads === 1) state.expires = clock.now() + 3_600_000 }
  await clock.advance(10_000)
  expect(state.submitted.length).toBe(0)
  expect(state.writes.keepalive.next_at).toBe(state.expires - 600_000)
})

test('a reply without an observed cache renewal cannot send every ten seconds', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
  state.refreshOnComplete = false
  await complete('ping'); await clock.advance(60_000)
  expect(state.submitted.length).toBe(1)
  expect(state.writes.keepalive.reason).toBe('等待缓存续期确认')
  state.expires = clock.now() + 3_600_000
  await clock.advance(10_000)
  expect(state.writes.keepalive.state).toBe('countdown')
  await clock.advance(IDLE - 10_000)
  expect(state.submitted.length).toBe(2)
})

test('background notifications cannot clear a keepalive failure latch', async ($, on) => {
  const { state, clock, human, complete } = await setup($, on)
  state.rejected = true
  await human(); await clock.advance(IDLE)
  state.rejected = false
  await $.prompt.submit({ text: 'monitor', origin: { kind: 'task-notification' }, wait: false })
  await $.turn.start({ text: 'monitor', turnId: 'monitor' })
  await complete('monitor'); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(1)
  await human(); await clock.advance(IDLE)
  expect(state.submitted.length).toBe(2)
})

for (const agentId of [undefined, 'background-agent']) {
  test(`only foreground tool execution defers a cache-due prompt (${agentId ?? 'main'})`, async ($, on) => {
    const { state, clock, human } = await setup($, on)
    await human()
    let release!: () => void
    state.toolGate = new Promise<void>(resolve => { release = resolve })
    const tool = $.tool.call({ tool: 'Bash', command: 'mock-only', agentId } as any)
    try {
      await clock.advance(200)
      expect(state.writes.tools.length).toBe(1)
      await clock.advance(IDLE - 200)
      expect(state.submitted.length).toBe(agentId === undefined ? 0 : 1)
    } finally { release(); await tool }
    await clock.advance(10_000)
    expect(state.submitted.length).toBe(1)
  })
}
