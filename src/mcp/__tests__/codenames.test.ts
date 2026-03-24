import { AGENT_CODENAMES, AGENT_CODENAME_SPACE, codenameFromIndex } from "../codenames.js";

describe("codenameFromIndex", () => {
  it("keeps the full two-part combination space for one-word codenames", () => {
    expect(AGENT_CODENAME_SPACE).toBe(AGENT_CODENAMES.length * AGENT_CODENAMES.length);
  });

  it("returns fused one-word names for new codenames", () => {
    const codename = codenameFromIndex(0);

    expect(codename.name).toBe("amberamber");
    expect(codename.display_name).toBe("AmberAmber");
    expect(codename.name.includes("-")).toBe(false);
    expect(codename.display_name.includes(" ")).toBe(false);
  });

  it("keeps distinct indices distinct", () => {
    expect(codenameFromIndex(0)).not.toEqual(codenameFromIndex(1));
    expect(codenameFromIndex(AGENT_CODENAMES.length)).not.toEqual(codenameFromIndex(1));
  });
});
