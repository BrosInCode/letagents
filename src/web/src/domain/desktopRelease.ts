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
    /** The Windows installer, once the current release has one. */
    windows: string | null
  }
}

/** Builds are unsigned for now, so Windows asks before the first run. */
export const WINDOWS_SMARTSCREEN_NOTE = 'Windows may show SmartScreen: More info → Run anyway.'

function toPresentation(release: {
  version: string
  checksumsUrl?: string
  assets: Record<'arm64' | 'x64', { publicUrl: string }>
  windows?: { x64: { publicUrl: string } } | null
}): MacDesktopBetaPresentation {
  return {
    version: release.version,
    checksumsUrl: release.checksumsUrl ?? `/downloads/mac/v${release.version}/checksums`,
    downloads: {
      arm64: release.assets.arm64.publicUrl,
      x64: release.assets.x64.publicUrl,
      windows: release.windows?.x64.publicUrl ?? null,
    },
  }
}

// The bundled release predates Windows builds; the Windows link appears once
// the current-release manifest names an installer.
export const MAC_DESKTOP_BETA: MacDesktopBetaPresentation = {
  ...toPresentation(MAC_DESKTOP_BETA_RELEASE),
  downloads: {
    arm64: '/downloads/mac/arm64',
    x64: '/downloads/mac/x64',
    windows: null,
  },
}

export type DesktopVisitorPlatform = 'mac' | 'windows' | 'other'

export interface DesktopDownloadLink {
  platform: 'mac' | 'windows'
  label: string
  href: string
}

/** Reads what the browser says. Only ever orders the links, so a wrong guess costs one extra click. */
export function detectDesktopVisitorPlatform(
  browser: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined,
): DesktopVisitorPlatform {
  const reported = `${browser?.userAgentData?.platform ?? ''} ${browser?.platform ?? ''} ${browser?.userAgent ?? ''}`
  if (/iphone|ipad|android/i.test(reported)) return 'other'
  if (/\bwin(dows|32|64)\b/i.test(reported)) return 'windows'
  if (/mac/i.test(reported)) return 'mac'
  return 'other'
}

/** The visitor's own platform leads. A Windows link exists only once a release has an installer. */
export function desktopDownloadOffer(
  release: MacDesktopBetaPresentation,
  platform: DesktopVisitorPlatform,
): { primary: DesktopDownloadLink; others: DesktopDownloadLink[] } {
  const appleSilicon: DesktopDownloadLink = { platform: 'mac', label: 'Mac · Apple Silicon', href: release.downloads.arm64 }
  const intel: DesktopDownloadLink = { platform: 'mac', label: 'Intel Mac', href: release.downloads.x64 }
  const windows: DesktopDownloadLink | null = release.downloads.windows
    ? { platform: 'windows', label: 'Windows', href: release.downloads.windows }
    : null
  if (windows && platform === 'windows') return { primary: windows, others: [appleSilicon, intel] }
  return { primary: appleSilicon, others: windows ? [intel, windows] : [intel] }
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
