// The seal of letagents-process-tree.exe: the digest of its source and of
// each build, with the compiler and SDK that made it. Pure, so the packaging
// tests check it on any platform.
import { createHash } from "node:crypto";

/** sha256 of the source with LF line endings, whatever the checkout wrote. */
export function sourceDigest(bytes) {
  return createHash("sha256").update(Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Compare one build with the seal. `builds.<arch>` is one build or a list of
 * builds, one for each MSVC and SDK pair that is sealed: GitHub rolls a new
 * runner image out over days, so CI and the release may run on either the
 * old or the new compiler. An error when a sealed compiler and SDK made
 * different bytes (or the source no longer matches the seal); a warning
 * with the values to add when no sealed build used this compiler and SDK.
 */
export function checkProcessTreeSeal(seal, build) {
  if (build.sourceSha256 !== seal.sourceSha256) {
    return { level: "error", message: `The source digest ${build.sourceSha256} is not the sealed ${seal.sourceSha256}.` };
  }
  const entry = seal.builds?.[build.arch];
  const sealed = (Array.isArray(entry) ? entry : [entry]).filter(Boolean);
  const reseal = `Add to builds.${build.arch} in shared/letagents-process-tree.seal.json: `
    + JSON.stringify({ sha256: build.sha256, vcToolsVersion: build.vcToolsVersion, windowsSdkVersion: build.windowsSdkVersion }) + ".";
  if (sealed.length === 0) return { level: "warning", message: `No sealed ${build.arch} build. ${reseal}` };
  const sameTools = sealed.filter((each) => each.vcToolsVersion === build.vcToolsVersion && each.windowsSdkVersion === build.windowsSdkVersion);
  if (sameTools.length === 0) {
    return {
      level: "warning",
      message: `This build used MSVC ${build.vcToolsVersion} and SDK ${build.windowsSdkVersion}; the seal names `
        + sealed.map((each) => `MSVC ${each.vcToolsVersion} and SDK ${each.windowsSdkVersion}`).join(", ") + `. ${reseal}`,
    };
  }
  if (!sameTools.some((each) => each.sha256 === build.sha256)) {
    return {
      level: "error",
      message: `The same MSVC ${build.vcToolsVersion} and SDK ${build.windowsSdkVersion} built ${build.sha256}, `
        + `not the sealed ${sameTools.map((each) => each.sha256).join(" or ")}. The build is not reproducible or the seal is wrong.`,
    };
  }
  return { level: "ok", message: `letagents-process-tree.exe (${build.arch}) matches its seal ${build.sha256}.` };
}
