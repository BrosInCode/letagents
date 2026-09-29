import assert from "node:assert/strict";
import test from "node:test";

import { executionApprovalProjectionPathsAreSafe } from "../execution-approval-projection-policy.js";

test("ordinary project files are safe to show and to delegate", () => {
  for (const path of ["src/a.ts", "README.md", "docs/My Notes.md", "src/caf\u00e9.ts", "config/keys.ts", "environment.ts"]) {
    assert.equal(executionApprovalProjectionPathsAreSafe([path]), true, path);
  }
  assert.equal(executionApprovalProjectionPathsAreSafe(["src/a.ts", "src/b.ts"]), true);
});

test("credentials and history are never safe, however their names are spelled", () => {
  for (const path of [".env", ".env.local", "config/.env", ".git/config", ".ssh/config", ".aws/credentials", "secrets/prod.json",
    "deploy/id_rsa", "certs/server.pem", ".npmrc", ".docker/config.json", "gcloud/application_default_credentials.json",
    // In capitals.
    ".ENV", ".Git/config", ".SSH/config", "Secrets/prod.json", "certs/server.PEM",
    // With a character macOS reads as another: a long s, a sharp s in either case, a wide letter.
    ".\u017f\u017fh/config", ".\u00dfh/config", ".\u1e9eh/config", "\u017fecrets/prod.json", "credential\u017f/x", ".aw\u017f/credentials",
    "deploy/id_r\u017fa", ".\uff45nv", "\uff0eenv", ".\uff47it/config",
  ]) {
    assert.equal(executionApprovalProjectionPathsAreSafe([path]), false, JSON.stringify(path));
    assert.equal(executionApprovalProjectionPathsAreSafe(["src/a.ts", path]), false, JSON.stringify(path));
  }
});

test("two names for one file are never safe together", () => {
  assert.equal(executionApprovalProjectionPathsAreSafe(["src/a.ts", "src/A.ts"]), false);
  assert.equal(executionApprovalProjectionPathsAreSafe(["src/a.ts", "src/a.ts"]), false);
});
