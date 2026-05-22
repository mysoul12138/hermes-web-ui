import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []

function createHermesHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hwui-hermes-cli-profiles-'))
  tempHomes.push(home)
  return home
}

async function loadHermesCli(stdout: string, hermesHome: string) {
  process.env.HERMES_HOME = hermesHome
  vi.resetModules()
  vi.doMock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process')
    const { promisify } = await import('util')
    const execFileMock = vi.fn((...args: any[]) => {
      const callback = args.findLast((arg: any) => typeof arg === 'function')
      callback(null, stdout, '')
      return {} as any
    })
    ;(execFileMock as any)[promisify.custom] = vi.fn(async () => ({ stdout, stderr: '' }))
    return {
      ...actual,
      execFile: execFileMock,
    }
  })

  return import('../../packages/server/src/services/hermes/hermes-cli')
}

afterEach(() => {
  vi.doUnmock('child_process')
  vi.restoreAllMocks()
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome

  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('Hermes CLI profile list', () => {
  it('keeps gateway parsing stable when profile or model fills the table column', async () => {
    const hermesHome = createHermesHome()
    mkdirSync(join(hermesHome, 'profiles', 'daily_assistant'), { recursive: true })
    mkdirSync(join(hermesHome, 'profiles', 'long_model'), { recursive: true })
    writeFileSync(join(hermesHome, 'active_profile'), 'long_model')
    writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  default: gpt-5\n')
    writeFileSync(join(hermesHome, 'profiles', 'daily_assistant', 'config.yaml'), 'model: deepseek-v4-flash\n')
    writeFileSync(join(hermesHome, 'profiles', 'long_model', 'config.yaml'), 'model:\n  default: provider/model-name-that-fills-column\n')
    const stdout = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
  daily_assistant deepseek-v4-flash            running      —            —
◆ long_model      provider/model-name-that-fills-column stopped      work         —
`

    const hermesCli = await loadHermesCli(stdout, hermesHome)

    await expect(hermesCli.listProfiles()).resolves.toEqual([
      { name: 'default', active: false, model: 'gpt-5', gateway: '', alias: '' },
      { name: 'daily_assistant', active: false, model: 'deepseek-v4-flash', gateway: 'running', alias: '' },
      { name: 'long_model', active: true, model: 'provider/model-name-that-fills-column', gateway: 'stopped', alias: 'work' },
    ])
  })
})
