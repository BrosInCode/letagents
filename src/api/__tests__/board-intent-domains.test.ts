import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const coordinationDirectory = join(testDirectory, "../db/coordination");

const domainDeclarations = {
  manager: [
    "DEFAULT_BOARD_MANAGER_MODE:export",
    "isValidBoardManagerMode:private",
    "isValidRuntimeSource:private",
    "normalizeBoardManagerMode:export",
    "normalizeBoardManagerRuntimeSource:export",
    "getRoomBoardSettings:export",
    "setRoomBoardManagerMode:export",
    "getActiveBoardManager:export",
    "inferBoardManagerRuntimeSource:export",
    "assignBoardManager:export",
    "releaseBoardManager:export",
  ],
  lifecycle: [
    "BOARD_INTENT_PENDING_TTL_MS:export",
    "BOARD_INTENT_APPROVAL_TTL_MS:export",
    "approvalToken:private",
    "defaultPendingIntentExpiresAt:private",
    "createBoardIntent:export",
    "listBoardIntents:export",
    "getBoardIntent:export",
    "countBoardIntents:export",
    "approveBoardIntent:export",
    "markBoardIntentTaskResult:export",
    "denyBoardIntent:export",
    "expireBoardIntents:export",
  ],
  approval: [
    "BoardIntentApprovalCheck:export",
    "BoardIntentApprovalDenial:export",
    "BoardIntentApprovalDecision:export",
    "BoardIntentConsumptionInput:export",
    "BoardIntentExecutor:export",
    "BoardIntentApprovalConsumptionError:export",
    "stableJson:private",
    "hashBoardIntentPayload:export",
    "verifyBoardIntentApproval:export",
    "consumeBoardIntentApproval:export",
    "assertConsumeBoardIntentApproval:export",
    "shouldRequireBoardIntent:export",
  ],
  escalation: [
    "EscalationCandidateBoardIntent:export",
    "listEscalationCandidateBoardIntents:export",
    "rescheduleEscalationCandidateBoardIntent:export",
    "claimBoardIntentEscalationTx:export",
    "markBoardIntentAutoApprovedTx:export",
    "countRecentAutoApprovedIntents:export",
    "BoardIntentAutoApprovalIneligibleReason:export",
    "BoardIntentAutoApprovalIneligibleError:export",
    "assertBoardIntentAutoApprovalEligibilityTx:export",
  ],
} as const;

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

function facadeExportInventory(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      inventory.push(
        `${element.name.text}:${statement.isTypeOnly || element.isTypeOnly ? "type" : "value"}`,
      );
    }
  }
  return inventory;
}

function exportsFromModule(fileName: string, source: string, moduleSpecifier: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier) continue;
    for (const element of statement.exportClause.elements) {
      inventory.push(
        `${element.name.text}:${statement.isTypeOnly || element.isTypeOnly ? "type" : "value"}`,
      );
    }
  }
  return inventory;
}

const facadeExports = [
  "boardIntentPayloadForLeaseAction:value",
  "boardIntentPayloadForTaskCreate:value",
  "boardIntentPayloadForTaskMutation:value",
  "DEFAULT_BOARD_MANAGER_MODE:value",
  "assignBoardManager:value",
  "getActiveBoardManager:value",
  "getRoomBoardSettings:value",
  "inferBoardManagerRuntimeSource:value",
  "normalizeBoardManagerMode:value",
  "normalizeBoardManagerRuntimeSource:value",
  "releaseBoardManager:value",
  "setRoomBoardManagerMode:value",
  "BOARD_INTENT_APPROVAL_TTL_MS:value",
  "BOARD_INTENT_PENDING_TTL_MS:value",
  "approveBoardIntent:value",
  "countBoardIntents:value",
  "createBoardIntent:value",
  "denyBoardIntent:value",
  "expireBoardIntents:value",
  "getBoardIntent:value",
  "listBoardIntents:value",
  "markBoardIntentTaskResult:value",
  "BoardIntentApprovalConsumptionError:value",
  "assertConsumeBoardIntentApproval:value",
  "consumeBoardIntentApproval:value",
  "hashBoardIntentPayload:value",
  "shouldRequireBoardIntent:value",
  "verifyBoardIntentApproval:value",
  "BoardIntentApprovalCheck:type",
  "BoardIntentApprovalDecision:type",
  "BoardIntentApprovalDenial:type",
  "BoardIntentConsumptionInput:type",
  "BoardIntentAutoApprovalIneligibleError:value",
  "assertBoardIntentAutoApprovalEligibilityTx:value",
  "claimBoardIntentEscalationTx:value",
  "countRecentAutoApprovedIntents:value",
  "listEscalationCandidateBoardIntents:value",
  "markBoardIntentAutoApprovedTx:value",
  "rescheduleEscalationCandidateBoardIntent:value",
  "BoardIntentAutoApprovalIneligibleReason:type",
  "EscalationCandidateBoardIntent:type",
] as const;

const outerDbBoardIntentExports = [
  "assertBoardIntentAutoApprovalEligibilityTx:value",
  "BoardIntentAutoApprovalIneligibleError:value",
  "claimBoardIntentEscalationTx:value",
  "countRecentAutoApprovedIntents:value",
  "listEscalationCandidateBoardIntents:value",
  "markBoardIntentAutoApprovedTx:value",
  "EscalationCandidateBoardIntent:type",
  "assertConsumeBoardIntentApproval:value",
  "BoardIntentApprovalConsumptionError:value",
  "assignBoardManager:value",
  "approveBoardIntent:value",
  "boardIntentPayloadForLeaseAction:value",
  "boardIntentPayloadForTaskCreate:value",
  "boardIntentPayloadForTaskMutation:value",
  "consumeBoardIntentApproval:value",
  "countBoardIntents:value",
  "createBoardIntent:value",
  "denyBoardIntent:value",
  "expireBoardIntents:value",
  "getActiveBoardManager:value",
  "getBoardIntent:value",
  "getRoomBoardSettings:value",
  "listBoardIntents:value",
  "normalizeBoardManagerMode:value",
  "normalizeBoardManagerRuntimeSource:value",
  "releaseBoardManager:value",
  "setRoomBoardManagerMode:value",
  "shouldRequireBoardIntent:value",
  "verifyBoardIntentApproval:value",
] as const;

test("board-intents.ts remains a bounded compatibility facade", async () => {
  const source = readFileSync(join(coordinationDirectory, "board-intents.ts"), "utf8");
  assert.ok(source.split("\n").length <= 65, "board-intent facade must stay small");
  assert.doesNotMatch(source, /from ["']\.\.\/client/, "the facade must not own persistence");
  assert.deepEqual(facadeExportInventory("board-intents.ts", source), facadeExports);

  const facade = await import("../db/coordination/board-intents.js");
  assert.deepEqual(
    Object.keys(facade).sort(),
    facadeExports.filter((entry) => entry.endsWith(":value"))
      .map((entry) => entry.slice(0, -":value".length))
      .sort(),
  );
});

test("every board-intent declaration keeps one exact domain owner and visibility", () => {
  const declarations = new Set<string>();
  for (const [domain, expected] of Object.entries(domainDeclarations)) {
    const source = readFileSync(join(coordinationDirectory, `board-intent-${domain}.ts`), "utf8");
    const actual = topLevelDeclarationInventory(`board-intent-${domain}.ts`, source);
    assert.deepEqual(actual, expected, `${domain} ownership, order, or visibility changed`);
    for (const declaration of actual) {
      const name = declaration.slice(0, declaration.lastIndexOf(":"));
      assert.ok(!declarations.has(name), `${name} has more than one domain owner`);
      declarations.add(name);
    }
  }
  assert.equal(declarations.size, 44);
});

test("board-intent domains are acyclic and never import the facade", () => {
  const domains = new Set(Object.keys(domainDeclarations));
  const graph = new Map<string, string[]>();
  for (const domain of domains) {
    const source = readFileSync(join(coordinationDirectory, `board-intent-${domain}.ts`), "utf8");
    assert.doesNotMatch(source, /from ["']\.\/board-intents\.js["']/);
    assert.doesNotMatch(
      source,
      /from ["']\.\/board-governance\.js["']/,
      `${domain} must not statically import the governance module`,
    );
    const dependencies = [...source.matchAll(/from ["']\.\/board-intent-([^"']+)\.js["']/g)]
      .map((match) => match[1])
      .filter((dependency) => domains.has(dependency));
    graph.set(domain, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (domain: string) => {
    assert.ok(!visiting.has(domain), `board-intent import cycle reaches ${domain}`);
    if (visited.has(domain)) return;
    visiting.add(domain);
    for (const dependency of graph.get(domain) ?? []) visit(dependency);
    visiting.delete(domain);
    visited.add(domain);
  };
  for (const domain of domains) visit(domain);

  const managerSource = readFileSync(
    join(coordinationDirectory, "board-intent-manager.ts"),
    "utf8",
  );
  assert.equal(
    [...managerSource.matchAll(/await import\(["']\.\/board-governance\.js["']\)/g)].length,
    3,
    "manager events must retain their three lazy governance imports",
  );
  const governanceSource = readFileSync(join(coordinationDirectory, "board-governance.ts"), "utf8");
  assert.match(
    governanceSource,
    /from ["']\.\/board-intents\.js["']/,
    "the governance module's facade dependency must remain explicit",
  );
});

test("primary and coordination facades preserve exact exports and runtime identities", async () => {
  const coordinationSource = readFileSync(join(coordinationDirectory, "../coordination.ts"), "utf8");
  assert.deepEqual(exportsFromModule(
    "coordination.ts",
    coordinationSource,
    "./coordination/board-intents.js",
  ), [
    "assertConsumeBoardIntentApproval:value",
    "BoardIntentApprovalConsumptionError:value",
    "assignBoardManager:value",
    "approveBoardIntent:value",
    "boardIntentPayloadForLeaseAction:value",
    "boardIntentPayloadForTaskCreate:value",
    "boardIntentPayloadForTaskMutation:value",
    "consumeBoardIntentApproval:value",
    "countBoardIntents:value",
    "createBoardIntent:value",
    "denyBoardIntent:value",
    "expireBoardIntents:value",
    "getActiveBoardManager:value",
    "getBoardIntent:value",
    "getRoomBoardSettings:value",
    "hashBoardIntentPayload:value",
    "listBoardIntents:value",
    "normalizeBoardManagerMode:value",
    "normalizeBoardManagerRuntimeSource:value",
    "releaseBoardManager:value",
    "setRoomBoardManagerMode:value",
    "shouldRequireBoardIntent:value",
    "verifyBoardIntentApproval:value",
    "assertBoardIntentAutoApprovalEligibilityTx:value",
    "BoardIntentAutoApprovalIneligibleError:value",
    "claimBoardIntentEscalationTx:value",
    "countRecentAutoApprovedIntents:value",
    "listEscalationCandidateBoardIntents:value",
    "markBoardIntentAutoApprovedTx:value",
    "EscalationCandidateBoardIntent:type",
  ]);

  const facade = await import("../db/coordination/board-intents.js");
  const coordination = await import("../db/coordination.js");
  const payloads = await import("../board-intent-payloads.js");
  const manager = await import("../db/coordination/board-intent-manager.js");
  const lifecycle = await import("../db/coordination/board-intent-lifecycle.js");
  const approval = await import("../db/coordination/board-intent-approval.js");
  const escalation = await import("../db/coordination/board-intent-escalation.js");
  const implementations = { ...payloads, ...manager, ...lifecycle, ...approval, ...escalation };

  for (const name of Object.keys(facade)) {
    assert.strictEqual(facade[name], implementations[name], `${name} must be a direct domain re-export`);
    if (name in coordination) {
      assert.strictEqual(coordination[name], facade[name], `${name} identity must survive coordination.ts`);
    }
  }
});

test("the outer db compatibility barrel pins board-intent exports and identities", async () => {
  const dbSource = readFileSync(join(coordinationDirectory, "../../db.ts"), "utf8");
  const boardIntentExportNames = new Set(outerDbBoardIntentExports);
  assert.deepEqual(
    exportsFromModule("db.ts", dbSource, "./db/coordination.js")
      .filter((entry) => boardIntentExportNames.has(entry as typeof outerDbBoardIntentExports[number])),
    outerDbBoardIntentExports,
  );

  const facade = await import("../db/coordination/board-intents.js");
  const publicDb = await import("../db.js");
  for (const entry of outerDbBoardIntentExports) {
    if (!entry.endsWith(":value")) continue;
    const name = entry.slice(0, -":value".length);
    assert.strictEqual(publicDb[name], facade[name], `${name} identity must survive db.ts`);
  }
});
