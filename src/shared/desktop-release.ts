export const MAC_DESKTOP_BETA_RELEASE = {
  version: "0.1.2",
  tag: "desktop-v0.1.2",
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
} as const;

export type MacDesktopArchitecture = keyof typeof MAC_DESKTOP_BETA_RELEASE.assets;
