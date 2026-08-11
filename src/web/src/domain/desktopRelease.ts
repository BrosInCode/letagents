import { MAC_DESKTOP_BETA_RELEASE } from '../../../shared/desktop-release.js'

export const MAC_DESKTOP_BETA = {
  version: MAC_DESKTOP_BETA_RELEASE.version,
  checksumsUrl: `/downloads/mac/v${MAC_DESKTOP_BETA_RELEASE.version}/checksums`,
  downloads: {
    arm64: '/downloads/mac/arm64',
    x64: '/downloads/mac/x64',
  },
} as const
