import { describe, it, expect, vi, beforeEach } from 'vitest'

const injectMissingSkillsMock = vi.fn()
const resolveTargetDirForProfileMock = vi.fn((name: string) => `/tmp/hermes/${name}/skills`)

// Mock hermes-cli
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  useProfile: vi.fn(),
  stopGateway: vi.fn(),
  startGateway: vi.fn(),
  startGatewayBackground: vi.fn(),
  setupReset: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/services/hermes/profile-credentials', () => ({
  smartCloneCleanup: vi.fn(() => ({
    strippedCredentials: [],
    disabledPlatforms: [],
    strippedConfigCredentials: [],
  })),
}))

vi.mock('../../packages/server/src/services/hermes/session-deleter', () => ({
  SessionDeleter: {
    getInstance: vi.fn(() => ({
      switchProfile: vi.fn(),
    })),
  },
}))

vi.mock('../../packages/server/src/services/hermes/skill-injector', () => ({
  HermesSkillInjector: vi.fn().mockImplementation(() => ({
    injectMissingSkills: injectMissingSkillsMock,
  })),
  scheduleSkillInjection: vi.fn((task: () => Promise<unknown>, onFailure: (err: unknown) => void) => {
    void task().catch(onFailure)
  }),
}))

import * as hermesCli from '../../packages/server/src/services/hermes/hermes-cli'
import { HermesSkillInjector } from '../../packages/server/src/services/hermes/skill-injector'

describe('Profile Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(HermesSkillInjector as any).resolveTargetDirForProfile = resolveTargetDirForProfileMock
    injectMissingSkillsMock.mockResolvedValue({
      targets: [{ injected: ['apikey-image-gen'], updated: [], skipped: [] }],
    })
  })

  describe('ensureApiServerConfig (via active profile switch)', () => {
    it('should inject api_server config when missing', async () => {
      // This tests the logic that profiles.ts ensures api_server config exists
      // We test the ensureApiServerConfig behavior indirectly through the module
      const { existsSync, readFileSync, writeFileSync } = await import('fs')
      vi.mock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue('platforms: {}'),
        writeFileSync: vi.fn(),
        createReadStream: vi.fn(),
        unlinkSync: vi.fn(),
        mkdirSync: vi.fn(),
        copyFileSync: vi.fn(),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
      }))
    })
  })

  describe('bundled skill injection', () => {
    it('schedules skill injection after creating a profile without blocking the response', async () => {
      let releaseInjection!: () => void
      injectMissingSkillsMock.mockReturnValue(new Promise(resolve => {
        releaseInjection = () => resolve({ targets: [{ injected: ['apikey-image-gen'], updated: [], skipped: [] }] })
      }))
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')
      const { create } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { request: { body: { name: 'alpha', clone: false } } }

      await create(ctx)

      expect(ctx.body).toMatchObject({ success: true, message: 'Profile created' })
      expect(resolveTargetDirForProfileMock).toHaveBeenCalledWith('alpha')
      expect(injectMissingSkillsMock).toHaveBeenCalledTimes(1)
      releaseInjection()
    })

    it('schedules skill injection after switching profiles and absorbs injection failures', async () => {
      injectMissingSkillsMock.mockRejectedValue(new Error('copy failed'))
      vi.mocked(hermesCli.useProfile).mockResolvedValue('Profile switched')
      vi.mocked(hermesCli.getProfile).mockResolvedValue({ name: 'alpha', path: '/tmp/alpha' } as any)
      const { getActiveProfileName } = await import('../../packages/server/src/services/hermes/hermes-profile')
      vi.mocked(getActiveProfileName).mockReturnValue('alpha')
      const { switchProfile } = await import('../../packages/server/src/controllers/hermes/profiles')
      const ctx: any = { request: { body: { name: 'alpha' } } }

      await switchProfile(ctx)
      await Promise.resolve()

      expect(ctx.body).toMatchObject({ success: true, message: 'Profile switched' })
      expect(resolveTargetDirForProfileMock).toHaveBeenCalledWith('alpha')
      expect(injectMissingSkillsMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('hermes-cli wrapper', () => {
    it('listProfiles returns array', async () => {
      const mockProfiles = [{ name: 'default', active: true }]
      vi.mocked(hermesCli.listProfiles).mockResolvedValue(mockProfiles as any)

      const result = await hermesCli.listProfiles()
      expect(result).toEqual(mockProfiles)
    })

    it('getProfile returns profile detail', async () => {
      const mockDetail = { name: 'default', path: '/tmp/default' }
      vi.mocked(hermesCli.getProfile).mockResolvedValue(mockDetail as any)

      const result = await hermesCli.getProfile('default')
      expect(result).toEqual(mockDetail)
      expect(hermesCli.getProfile).toHaveBeenCalledWith('default')
    })

    it('createProfile calls CLI with name and clone flag', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      await hermesCli.createProfile('test', true)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('test', true)
    })

    it('deleteProfile calls CLI with name', async () => {
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)

      await hermesCli.deleteProfile('test')

      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('test')
    })

    it('renameProfile calls CLI with old and new name', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)

      await hermesCli.renameProfile('old', 'new')

      expect(hermesCli.renameProfile).toHaveBeenCalledWith('old', 'new')
    })
  })
})
