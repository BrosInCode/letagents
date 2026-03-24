import { normalizeGitRemote } from "../git-remote";

describe("normalizeGitRemote", () => {
  // SSH format tests
  it("normalizes SSH git@github.com format", () => {
    expect(normalizeGitRemote("git@github.com:BrosInCode/letagents.git")).toBe(
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes SSH without .git suffix", () => {
    expect(normalizeGitRemote("git@github.com:BrosInCode/letagents")).toBe(
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes SSH with gitlab host", () => {
    expect(normalizeGitRemote("git@gitlab.com:team/project.git")).toBe(
      "gitlab.com/team/project"
    );
  });

  // HTTPS format tests
  it("normalizes HTTPS with .git suffix", () => {
    expect(
      normalizeGitRemote("https://github.com/BrosInCode/letagents.git")
    ).toBe("github.com/BrosInCode/letagents");
  });

  it("normalizes HTTPS without .git suffix", () => {
    expect(normalizeGitRemote("https://github.com/BrosInCode/letagents")).toBe(
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes HTTPS with trailing slash", () => {
    expect(normalizeGitRemote("https://github.com/BrosInCode/letagents/")).toBe(
      "github.com/BrosInCode/letagents"
    );
  });

  // SSH protocol format tests
  it("normalizes ssh:// protocol format", () => {
    expect(
      normalizeGitRemote("ssh://git@gitlab.com/team/project.git")
    ).toBe("gitlab.com/team/project");
  });

  // Edge cases
  it("handles whitespace", () => {
    expect(
      normalizeGitRemote("  git@github.com:BrosInCode/letagents.git  ")
    ).toBe("github.com/BrosInCode/letagents");
  });

  it("handles nested paths", () => {
    expect(
      normalizeGitRemote("https://gitlab.com/org/sub-group/project.git")
    ).toBe("gitlab.com/org/sub-group/project");
  });

  it("handles Bitbucket SSH format", () => {
    expect(
      normalizeGitRemote("git@bitbucket.org:workspace/repo.git")
    ).toBe("bitbucket.org/workspace/repo");
  });
});
