import { MAC_DESKTOP_BETA_RELEASE } from '../../../shared/desktop-release.js'

export const MAC_DESKTOP_BETA = {
  version: MAC_DESKTOP_BETA_RELEASE.version,
  checksumsUrl: `/downloads/mac/v${MAC_DESKTOP_BETA_RELEASE.version}/checksums`,
  downloads: {
    arm64: MAC_DESKTOP_BETA_RELEASE.assets.arm64.publicUrl,
    x64: MAC_DESKTOP_BETA_RELEASE.assets.x64.publicUrl,
  },
} as const
