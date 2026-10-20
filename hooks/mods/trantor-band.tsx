// Read-only pilot band (#12091): "ctx 34% · handoff pending" above the prompt, OFF unless TRANTOR_MOD=1.
// It never calls the hub (no auth surface) and any error draws nothing.
// The one write is ~/.agent-bus/mod-context/<session>.json.
import type { EngineInterface, Register } from 'claude-code'

import {
  bandText, basename, contextPercent, contextRecord, handoffState, newestHandoffName, projectFromMarker, safeId,
} from './band-lib.mjs'

type Snapshot = { percent: number | null; handoff: string; at: number }

const REFRESH_MS = 15_000

// A reload starts these over; they are only a cache of what the files and the engine can say again.
let snap: Snapshot = { percent: null, handoff: '', at: 0 }

// AGENT_BUS_DIR mirrors hooks/lib/handoff.mjs; HOME is the fallback.
async function busDir($: EngineInterface): Promise<string> {
  const override = await $.env.get('AGENT_BUS_DIR')
  if (override) return override
  const home = await $.env.get('HOME')
  return home ? `${home}/.agent-bus` : ''
}

async function readHandoff($: EngineInterface, bus: string): Promise<string> {
  const root = await $.session.root()
  let project = ''
  try { project = projectFromMarker(await $.fs.read(`${root}/.trantor/project.json`)) } catch {}
  if (!project) project = basename(root)
  const dir = `${bus}/handoffs`
  const entries = await $.fs.list(dir)
  const name = newestHandoffName(entries.map(entry => entry.name), project)
  if (!name) return ''
  return handoffState(await $.fs.read(`${dir}/${name}`), Math.floor((await $.clock.now()) / 1000))
}

// One refresh: the live context from the native API, the handoff file, and the context JSON.
async function refresh($: EngineInterface, writeContext: boolean): Promise<void> {
  try {
    if ((await $.env.get('TRANTOR_MOD')) !== '1') return
    const bus = await busDir($)
    const usage = await $.session.usage()
    const now = await $.clock.now()
    let handoff = ''
    try { if (bus) handoff = await readHandoff($, bus) } catch {}
    snap = { percent: contextPercent(usage.context), handoff, at: now }
    if (writeContext && bus) {
      const record = contextRecord(usage.context, now)
      const id = safeId(await $.session.id())
      if (record && id) await $.fs.write(`${bus}/mod-context/${id}.json`, JSON.stringify(record))
    }
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($, false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($, true)
    try { $.ui.invalidate('ui.render') } catch {}
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if ((await $.env.get('TRANTOR_MOD')) !== '1' || e.props.hasSurvey) return next(e)
      if ((await $.clock.now()) - snap.at > REFRESH_MS) await refresh($, false)
      const text = bandText(snap)
      if (!text) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text dimColor>{text}</Text>
        </Box>
      )
    } catch {
      return next(e)
    }
  })
}
