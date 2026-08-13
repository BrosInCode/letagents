import {
  parseMacDesktopPublicReleaseManifest,
} from '../../../shared/desktop-release-manifest.js'
import { MAC_DESKTOP_BETA_RELEASE } from '../../../shared/desktop-release.js'

export interface MacDesktopBetaPresentation {
  version: string
  checksumsUrl: string
  downloads: {
    arm64: string
    x64: string
  }
}

function toPresentation(release: {
  version: string
  checksumsUrl?: string
  assets: Record<'arm64' | 'x64', { publicUrl: string }>
}): MacDesktopBetaPresentation {
  return {
    version: release.version,
    checksumsUrl: release.checksumsUrl ?? `/downloads/mac/v${release.version}/checksums`,
    downloads: {
      arm64: release.assets.arm64.publicUrl,
      x64: release.assets.x64.publicUrl,
    },
  }
}

export const MAC_DESKTOP_BETA: MacDesktopBetaPresentation = {
  ...toPresentation(MAC_DESKTOP_BETA_RELEASE),
  downloads: {
    arm64: '/downloads/mac/arm64',
    x64: '/downloads/mac/x64',
  },
}

export async function fetchCurrentMacDesktopBeta(
  fetcher: typeof fetch = fetch,
): Promise<MacDesktopBetaPresentation> {
  const response = await fetcher('/downloads/mac/current.json', {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Current Mac beta release returned HTTP ${response.status}.`)
  return toPresentation(parseMacDesktopPublicReleaseManifest(
    await response.json(),
    MAC_DESKTOP_BETA_RELEASE.version,
  ))
}
