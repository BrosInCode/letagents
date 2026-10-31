// The seal of letagents-process-tree.exe: the digest of its source and of
// each build, with the compiler and SDK that made it. Pure, so the packaging
// tests check it on any platform.
import { createHash } from "node:crypto";

/** sha256 of the source with LF line endings, whatever the checkout wrote. */
export function sourceDigest(bytes) {
  return createHash("sha256").update(Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Compare one build with the seal. An error when the same compiler and SDK
 * made different bytes (or the source no longer matches the seal); a warning
 * with the values to reseal when the compiler or SDK differ from the seal's.
 */
export function checkProcessTreeSeal(seal, build) {
  if (build.sourceSha256 !== seal.sourceSha256) {
    return { level: "error", message: `The source digest ${build.sourceSha256} is not the sealed ${seal.sourceSha256}.` };
  }
  const sealed = seal.builds?.[build.arch];
  const reseal = `Reseal builds.${build.arch} in shared/letagents-process-tree.seal.json as `
    + JSON.stringify({ sha256: build.sha256, vcToolsVersion: build.vcToolsVersion, windowsSdkVersion: build.windowsSdkVersion }) + ".";
  if (!sealed) return { level: "warning", message: `No sealed ${build.arch} build. ${reseal}` };
  if (sealed.vcToolsVersion !== build.vcToolsVersion || sealed.windowsSdkVersion !== build.windowsSdkVersion) {
    return {
      level: "warning",
      message: `This build used MSVC ${build.vcToolsVersion} and SDK ${build.windowsSdkVersion}; the seal names `
        + `MSVC ${sealed.vcToolsVersion} and SDK ${sealed.windowsSdkVersion}. ${reseal}`,
    };
  }
  if (sealed.sha256 !== build.sha256) {
    return {
      level: "error",
      message: `The same MSVC ${build.vcToolsVersion} and SDK ${build.windowsSdkVersion} built ${build.sha256}, `
        + `not the sealed ${sealed.sha256}. The build is not reproducible or the seal is wrong.`,
    };
  }
  return { level: "ok", message: `letagents-process-tree.exe (${build.arch}) matches its seal ${build.sha256}.` };
}
