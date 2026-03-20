import { parseGitHubIdentity, checkGitHubVisibility } from "../github-visibility";

describe("parseGitHubIdentity", () => {
  it("parses a standard github.com remote", () => {
    expect(parseGitHubIdentity("github.com/EmmyMay/letagents")).toEqual({
      owner: "EmmyMay",
      repo: "letagents",
    });
  });

  it("parses owner with hyphens", () => {
    expect(parseGitHubIdentity("github.com/some-org/my-repo")).toEqual({
      owner: "some-org",
      repo: "my-repo",
    });
  });

  it("returns null for gitlab remotes", () => {
    expect(parseGitHubIdentity("gitlab.com/team/project")).toBeNull();
  });

  it("returns null for bitbucket remotes", () => {
    expect(parseGitHubIdentity("bitbucket.org/workspace/repo")).toBeNull();
  });

  it("returns null for arbitrary strings", () => {
    expect(parseGitHubIdentity("not-a-url")).toBeNull();
  });

  it("returns null if path has too many segments", () => {
    expect(parseGitHubIdentity("github.com/org/sub/repo")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGitHubIdentity("")).toBeNull();
  });
});

describe("checkGitHubVisibility", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(status: number) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
    });
  }

  it("returns 'public' for a 200 response", async () => {
    mockFetch(200);
    const result = await checkGitHubVisibility("github.com/EmmyMay/letagents");
    expect(result).toBe("public");
  });

  it("returns 'private' for a 404 response", async () => {
    mockFetch(404);
    const result = await checkGitHubVisibility("github.com/EmmyMay/private-repo");
    expect(result).toBe("private");
  });

  it("returns 'unknown' for rate-limit 403", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation();
    mockFetch(403);
    const result = await checkGitHubVisibility("github.com/EmmyMay/letagents");
    expect(result).toBe("unknown");
    spy.mockRestore();
  });

  it("returns 'unknown' for rate-limit 429", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation();
    mockFetch(429);
    const result = await checkGitHubVisibility("github.com/EmmyMay/letagents");
    expect(result).toBe("unknown");
    spy.mockRestore();
  });

  it("returns 'unknown' for non-GitHub remote", async () => {
    const result = await checkGitHubVisibility("gitlab.com/team/project");
    expect(result).toBe("unknown");
    // fetch should not have been called
    expect(global.fetch).toBeUndefined();
  });

  it("returns 'unknown' on network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
    const spy = jest.spyOn(console, "error").mockImplementation();
    const result = await checkGitHubVisibility("github.com/EmmyMay/letagents");
    expect(result).toBe("unknown");
    spy.mockRestore();
  });

  it("sends correct GitHub API headers", async () => {
    mockFetch(200);
    await checkGitHubVisibility("github.com/EmmyMay/letagents");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/EmmyMay/letagents",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      })
    );
  });
});
