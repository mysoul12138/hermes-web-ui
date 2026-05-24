import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mockGetSkillUsageStatsFromDb = vi.hoisted(() => vi.fn())
const mockReadConfigYaml = vi.hoisted(() => vi.fn())
const mockUpdateConfigYaml = vi.hoisted(() => vi.fn())
const mockGetHermesDir = vi.hoisted(() => vi.fn())
const mockSafeReadFile = vi.hoisted(() => vi.fn())
const mockExtractDescription = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: mockGetSkillUsageStatsFromDb,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  pinSkill: vi.fn(),
}))

vi.mock('../../packages/server/src/services/config-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/config-helpers')>()
  return {
    ...actual,
    readConfigYaml: mockReadConfigYaml,
    updateConfigYaml: mockUpdateConfigYaml,
    getHermesDir: mockGetHermesDir,
    safeReadFile: mockSafeReadFile,
    extractDescription: mockExtractDescription,
  }
})

async function loadController() {
  vi.resetModules()
  return import('../../packages/server/src/controllers/hermes/skills')
}

describe('skills controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadConfigYaml.mockResolvedValue({})
    mockSafeReadFile.mockImplementation(async (path: string) => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    })
    mockExtractDescription.mockImplementation((content: string) => {
      return content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() || ''
    })
    mockUpdateConfigYaml.mockImplementation(async (updater: (config: Record<string, any>) => Record<string, any>) => updater({}))
    mockGetSkillUsageStatsFromDb.mockResolvedValue({
      period_days: 7,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('loads skill usage stats', async () => {
    const { usageStats } = await loadController()
    const ctx: any = { query: { days: '30' }, body: null }

    await usageStats(ctx)

    expect(mockGetSkillUsageStatsFromDb).toHaveBeenCalledWith(30)
    expect(ctx.body.period_days).toBe(7)
  })

  it('toggles skills in the config file', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYaml.mockImplementation(async (updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { toggle } = await loadController()
    const ctx: any = {
      request: { body: { name: 'new-skill', enabled: false } },
      body: null,
    }

    await toggle(ctx)

    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill', 'new-skill'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true })
  })

  it('lists configured external skill directories with external source while keeping local skills first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-external-skills-'))
    const hermesDir = join(root, 'hermes')
    const localSkillDir = join(hermesDir, 'skills', 'tools', 'dupe-skill')
    const externalDir = join(root, 'external-skills')
    const externalSkillDir = join(externalDir, 'tools', 'external-skill')
    const externalDupeDir = join(externalDir, 'tools', 'dupe-skill')

    await mkdir(localSkillDir, { recursive: true })
    await mkdir(externalSkillDir, { recursive: true })
    await mkdir(externalDupeDir, { recursive: true })
    await writeFile(join(localSkillDir, 'SKILL.md'), '# Local Dupe\nlocal copy\n', 'utf-8')
    await writeFile(join(externalSkillDir, 'SKILL.md'), '# External Skill\nexternal copy\n', 'utf-8')
    await writeFile(join(externalDupeDir, 'SKILL.md'), '# External Dupe\nexternal duplicate\n', 'utf-8')

    mockGetHermesDir.mockReturnValue(hermesDir)
    mockReadConfigYaml.mockResolvedValue({
      skills: { external_dirs: [externalDir] },
    })

    try {
      const { list } = await loadController()
      const ctx: any = { body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'dupe-skill', source: 'local', description: 'local copy' }),
        expect.objectContaining({ name: 'external-skill', source: 'external', description: 'external copy' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
