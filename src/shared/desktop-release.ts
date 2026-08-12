const MAC_DESKTOP_BETA_VERSION = "0.1.4";
const MAC_DESKTOP_PUBLIC_BASE_URL = "https://downloads.letagents.chat/desktop";

function macDesktopAsset(architecture: "arm64" | "x64", sha256: string) {
  const fileName = `LetAgents-${MAC_DESKTOP_BETA_VERSION}-darwin-${architecture}.dmg`;
  return {
    fileName,
    publicUrl: `${MAC_DESKTOP_PUBLIC_BASE_URL}/v${MAC_DESKTOP_BETA_VERSION}/${fileName}`,
    sha256,
  } as const;
}

export const MAC_DESKTOP_BETA_RELEASE = {
  version: MAC_DESKTOP_BETA_VERSION,
  tag: `desktop-v${MAC_DESKTOP_BETA_VERSION}`,
  assets: {
    arm64: macDesktopAsset(
      "arm64",
      "27abe236232d33db10ed4533f4a7443a66f93568e9fa73a2ca472b6467fcf1cb",
    ),
    x64: macDesktopAsset(
      "x64",
      "4c807ad0c799b4e46ab81d1098e5b65934d6b0b49f0a99ced2713897e1c2bc35",
    ),
  },
} as const;

export const MAC_DESKTOP_BETA_CHECKSUM_RELEASES = [
  MAC_DESKTOP_BETA_RELEASE,
  {
    version: "0.1.3",
    assets: {
      arm64: {
        fileName: "LetAgents-0.1.3-darwin-arm64.dmg",
        sha256: "6010454bc7375a38571d707f90c077207a7d2b49b01a1db1655b03f4def9b502",
      },
      x64: {
        fileName: "LetAgents-0.1.3-darwin-x64.dmg",
        sha256: "b7574e17ef87aebf418926478de10d9937fd1a96ca0c7a53b826a109302c5560",
      },
    },
  },
  {
    version: "0.1.2",
    assets: {
      arm64: {
        fileName: "LetAgents-0.1.2-darwin-arm64.dmg",
        sha256: "e5355deced8383bc7d024ec60b109a38dde69dfeb6b6339352e1f5bc5c53bd43",
      },
      x64: {
        fileName: "LetAgents-0.1.2-darwin-x64.dmg",
        sha256: "67d2896b806695dae8c0224b3bc2780aee6902e897569c983ecc1bdb0330b6b0",
      },
    },
  },
] as const;

export type MacDesktopArchitecture = keyof typeof MAC_DESKTOP_BETA_RELEASE.assets;
