import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const authDirectory = join(testDirectory, "../db/auth");

const domainDeclarations = {
  "auth-states": ["createAuthState:export", "consumeAuthState:export"],
  "account-sessions": [
    "upsertAccount:export",
    "createSession:export",
    "refreshProviderAccessTokenForAccount:export",
    "getSessionAccountByToken:export",
    "deleteSessionByToken:export",
  ],
  "owner-tokens": ["createOwnerToken:export", "getOwnerTokenAccountByToken:export"],
  "agent-identities": [
    "registerAgentIdentity:export",
    "getAgentIdentityByCanonicalKey:export",
    "getAgentIdentitiesForOwner:export",
  ],
  "supervisor-grants": [
    "makeSupervisorGrantToken:export",
    "toSupervisorHostGrant:private",
    "SupervisorGrantFence:export",
    "SupervisorGrantFenceStaleError:export",
    "isSupervisorGrantFenceStaleError:export",
    "SupervisorGrantProvisionConflictError:export",
    "isSupervisorGrantProvisionConflictError:export",
    "assertSupervisorGrantFenceTx:export",
    "createSupervisorHostGrant:export",
    "getSupervisorHostGrantByToken:export",
    "getSupervisorHostGrantById:export",
    "rotateSupervisorHostGrant:export",
    "advanceSupervisorHostGrantGeneration:export",
    "revokeSupervisorHostGrant:export",
  ],
  "room-agent-sessions": [
    "MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION:private",
    "collectSessionCredentialFingerprintsTx:private",
    "retireRoomAgentDeliveryTx:private",
    "emitCommittedCredentialInvalidations:private",
    "makeAgentSessionToken:export",
    "makeAgentSessionBearerToken:export",
    "toRoomAgentSessionBearer:private",
    "newBearerExpiry:private",
    "CreateRoomAgentSessionInput:export",
    "SAME_INSTANCE_RECLAIM_STALE_AFTER_MS:export",
    "ActiveAgentInstanceConflictError:export",
    "isActiveAgentInstanceConflictError:export",
    "isActiveRoomAgentSessionStaleForRegistration:export",
    "RoomAgentSessionReplacementProof:export",
    "replacementProofMatches:private",
    "insertRoomAgentSessionTx:private",
    "rotateRoomAgentSessionTx:private",
    "createRoomAgentSession:export",
    "createFencedRoomAgentSession:export",
    "createOrRotateSupervisorWorkerSession:export",
    "getActiveRoomAgentSessionsForWorkerIdentity:export",
    "getLastEndedWorkerSessionDisplayName:export",
    "getRoomAgentSessionByCredentials:export",
    "getSupervisorRoomAgentSession:export",
    "ResolvedRoomAgentSessionBearer:export",
    "getRoomAgentSessionBearerByToken:export",
    "revokeRoomAgentSessionBearer:export",
    "rotateRoomAgentSessionBearer:export",
    "touchRoomAgentSession:export",
    "endRoomAgentSession:export",
    "markUnresolvedReceiptsUnavailableTx:private",
  ],
  "project-admins": [
    "assignProjectAdmin:export",
    "assignProjectAdminIfRoomHasNoAdmins:export",
    "isProjectAdmin:export",
  ],
} as const;

const facadeLines = Object.keys(domainDeclarations).map((domain) =>
  `export * from "./auth/${domain}.js";`
);

function topLevelDeclarationInventory(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory: string[] = [];
  for (const statement of sourceFile.statements) {
    const visibility = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ? "export" : "private";
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        inventory.push(`${declaration.name.getText(sourceFile)}:${visibility}`);
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      inventory.push(`${statement.name.text}:${visibility}`);
    }
  }
  return inventory;
}

test("auth.ts remains a compatibility facade over bounded auth domains", () => {
  const facade = readFileSync(join(testDirectory, "../db/auth.ts"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(facade, facadeLines);
});

test("every auth declaration has one bounded-domain owner and visibility", () => {
  const sources = Object.fromEntries(
    Object.keys(domainDeclarations).map((domain) => [
      domain,
      readFileSync(join(authDirectory, `${domain}.ts`), "utf8"),
    ]),
  );

  const actualByDomain = Object.fromEntries(
    Object.entries(sources).map(([domain, source]) => [
      domain,
      topLevelDeclarationInventory(`${domain}.ts`, source),
    ]),
  );
  for (const [owner, declarations] of Object.entries(domainDeclarations)) {
    assert.deepEqual(
      actualByDomain[owner],
      declarations,
      `${owner} declaration ownership or visibility changed`,
    );
    for (const declaration of declarations) {
      for (const [otherDomain, inventory] of Object.entries(actualByDomain)) {
        if (otherDomain === owner) continue;
        const name = declaration.split(":", 1)[0];
        assert.ok(
          !inventory.some((candidate) => candidate.startsWith(`${name}:`)),
          `${name} has multiple domain owners`,
        );
      }
    }
  }

  for (const [domain, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /from ["'][^"']*\/auth\.js["']/, `${domain} must not import the facade`);
  }
});

test("the facade preserves direct runtime export identities", async () => {
  const facade = await import("../db/auth.js");
  for (const domain of Object.keys(domainDeclarations)) {
    const implementation = await import(`../db/auth/${domain}.js`);
    for (const [name, value] of Object.entries(implementation)) {
      assert.strictEqual(facade[name], value, `${name} must be a direct facade re-export`);
    }
  }
});
