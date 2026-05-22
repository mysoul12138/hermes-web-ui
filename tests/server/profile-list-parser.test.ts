import { describe, expect, it } from 'vitest'
import { parseProfileListRuntimeInfo } from '../../packages/server/src/services/hermes/profile-list-parser'

describe('profile list parser', () => {
  it('parses gateway status and alias from aligned table output', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
◆ default        gpt-5                        running      main         —
  akri            glm-5-turbo                  running      akri         —
  tester          gpt-5.5                      stopped      tester       —
`

    const profiles = parseProfileListRuntimeInfo(output, ['default', 'akri', 'tester'])

    expect(profiles.get('default')).toEqual({ active: true, gateway: 'running', alias: 'main' })
    expect(profiles.get('akri')).toEqual({ active: false, gateway: 'running', alias: 'akri' })
    expect(profiles.get('tester')).toEqual({ active: false, gateway: 'stopped', alias: 'tester' })
  })

  it('parses gateway status when profile or model fills the table column', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
  daily_assistant deepseek-v4-flash            running      —            —
  long_model      provider/model-name-that-fills-column stopped      —            —
`

    const profiles = parseProfileListRuntimeInfo(output, ['daily_assistant', 'long_model'])

    expect(profiles.get('daily_assistant')).toEqual({ active: false, gateway: 'running' })
    expect(profiles.get('long_model')).toEqual({ active: false, gateway: 'stopped' })
  })

  it('prefers the longest profile name when one name is a prefix of another', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
  dev             gpt-5                        stopped      —            —
  dev_long        gpt-5                        running      work         —
`

    const profiles = parseProfileListRuntimeInfo(output, ['dev', 'dev_long'])

    expect(profiles.get('dev')).toEqual({ active: false, gateway: 'stopped' })
    expect(profiles.get('dev_long')).toEqual({ active: false, gateway: 'running', alias: 'work' })
  })
})
