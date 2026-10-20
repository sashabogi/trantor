// The engine's own headless harness for mods. `claude plugin test` scans the whole folder it is
// given, so run it on a folder that holds only the mod (see docs/SYSTEM-CONTRACT.md section 9),
// copied there as plugin "trantor": hooks/hooks.json modules plus hooks/mods/*.
import { expect, mock, test } from 'claude-code/testing'

// The stand-ins below only need the fields the mod reads; the full engine types are not the point.
const PROPS: any = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const USAGE: any = {
  startedAt: 0,
  context: { tokens: 34_000, window: 100_000, percent: 34 },
  rateLimits: [],
}

const FILES: any = [
  { name: 'demo-100.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  { name: 'demo-200.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
]

// What the engine would draw there when the mod passes: a plain Text.
const engineBand = ($: any, e: any): any => {
  const { Text } = $.ui.resolve(e)
  return h(Text, null, 'engine band')
}

const mountBand = ($: any): Promise<any> =>
  $.ui.mount({ plugin: 'trantor', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

test('the band passes through to the engine band while TRANTOR_MOD is unset', async ($, on) => {
  mock.env(on, {})
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', engineBand)
  const ui = await mountBand($)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine band')
  await ui.unmount()
})

test('the band shows the live context fill when TRANTOR_MOD=1', async ($, on) => {
  mock.env(on, { TRANTOR_MOD: '1', HOME: '/h' })
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: USAGE }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('ui.render', engineBand)
  const ui = await mountBand($)
  expect((await ui.find({ type: 'Text', text: /ctx 34%/ }))?.text).toContain('ctx 34%')
  await ui.unmount()
})

test('the band names the newest unconsumed handoff of the project', async ($, on) => {
  mock.env(on, { TRANTOR_MOD: '1', HOME: '/h' })
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: USAGE }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.list', () => ({ value: FILES }))
  on('fs.read', (_$: any, e: any) => {
    if (e.path.endsWith('project.json')) return { deny: 'ENOENT' }
    return { value: e.path.endsWith('demo-200.json') ? '{"consumed":false}' : '{"consumed":true}' }
  })
  on('ui.render', engineBand)
  const ui = await mountBand($)
  expect((await ui.find({ type: 'Text', text: /handoff/ }))?.text).toContain('ctx 34% · handoff pending')
  await ui.unmount()
})
