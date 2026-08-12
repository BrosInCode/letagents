import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const messagesDirectory = join(testDirectory, "../db/messages");
const historyDirectory = join(messagesDirectory, "history");

const domainDeclarations = {
  activity: [
    "getRoomMessageCountsBySender:export",
    "hasMessagesFromSender:export",
  ],
  "message-history": [
    "MessageHydrationOptions:private",
    "MessageHistoryOptions:private",
    "getMessages:export",
    "getLatestMessages:export",
    "getMessagesBefore:export",
    "getMessageById:export",
    "hydrateMessageReplies:export",
    "getMessagesAfter:export",
  ],
  "recipient-routing": [
    "MAX_BRIDGE_MESSAGE_RECIPIENTS:private",
    "getMessageRecipientAgentTargets:export",
    "getMessageRecipientAgentKeys:export",
  ],
  "thread-summaries": [
    "materializedThreadKeySelection:export",
    "MaterializedThreadKeySelection:export",
    "MaterializedThreadSummarySelection:export",
    "getVisibleMessageRow:export",
    "buildThreadSummariesForRoots:export",
    "materializedThreadReadJoin:export",
    "toMaterializedThreadSummaryRow:export",
    "loadMessageRowsByNumber:export",
    "toMaterializedThreadSummary:export",
    "loadThreadParticipants:export",
    "buildEmptyThreadSummary:export",
    "buildEmptyThreadSummariesForRoots:export",
    "loadThreadReadCursors:private",
    "toEmptyThreadSummary:private",
    "UnreadThreadStats:export",
    "getUnreadThreadStats:export",
    "loadUnreadThreadPageKeys:export",
  ],
  threads: [
    "MessageThreadPage:export",
    "MessageThreadInboxFilter:export",
    "MessageThreadInboxItem:export",
    "MessageThreadInboxPage:export",
    "getMessageThread:export",
    "getMessageThreads:export",
    "markMessageThreadRead:export",
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

function exportsFromModule(
  fileName: string,
  source: string,
  moduleSpecifier: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier) continue;
    return statement.exportClause.elements.map(
      (element) => `${element.name.text}:${statement.isTypeOnly || element.isTypeOnly ? "type" : "value"}`,
    );
  }
  return [];
}

test("message history remains a bounded compatibility facade", async () => {
  const source = readFileSync(join(messagesDirectory, "history.ts"), "utf8");
  assert.ok(source.split("\n").length <= 35, "message history facade must stay small");
  assert.doesNotMatch(source, /from ["']\.\.\/client/, "the facade must not own persistence");
  assert.deepEqual(facadeExportInventory("history.ts", source), [
    "getLatestMessages:value",
    "getMessageById:value",
    "getMessages:value",
    "getMessagesAfter:value",
    "getMessagesBefore:value",
    "hydrateMessageReplies:value",
    "getMessageRecipientAgentKeys:value",
    "getMessageRecipientAgentTargets:value",
    "getMessageThread:value",
    "getMessageThreads:value",
    "markMessageThreadRead:value",
    "MessageThreadInboxFilter:type",
    "MessageThreadInboxItem:type",
    "MessageThreadInboxPage:type",
    "MessageThreadPage:type",
    "getRoomMessageCountsBySender:value",
    "hasMessagesFromSender:value",
  ]);

  const facade = await import("../db/messages/history.js");
  assert.deepEqual(Object.keys(facade).sort(), [
    "getLatestMessages",
    "getMessageById",
    "getMessageRecipientAgentKeys",
    "getMessageRecipientAgentTargets",
    "getMessageThread",
    "getMessageThreads",
    "getMessages",
    "getMessagesAfter",
    "getMessagesBefore",
    "getRoomMessageCountsBySender",
    "hasMessagesFromSender",
    "hydrateMessageReplies",
    "markMessageThreadRead",
  ]);
});

test("every message-history declaration keeps one exact domain owner and visibility", () => {
  const allDeclarations = new Set<string>();
  for (const [domain, expected] of Object.entries(domainDeclarations)) {
    const source = readFileSync(join(historyDirectory, `${domain}.ts`), "utf8");
    const actual = topLevelDeclarationInventory(`${domain}.ts`, source);
    assert.deepEqual(actual, expected, `${domain} ownership, order, or visibility changed`);
    for (const declaration of actual) {
      const name = declaration.slice(0, declaration.lastIndexOf(":"));
      assert.ok(!allDeclarations.has(name), `${name} has more than one domain owner`);
      allDeclarations.add(name);
    }
  }
  assert.equal(allDeclarations.size, 37);
});

test("message-history domains are acyclic and never import the facade", () => {
  const domains = new Set(Object.keys(domainDeclarations));
  const graph = new Map<string, string[]>();
  for (const domain of domains) {
    const source = readFileSync(join(historyDirectory, `${domain}.ts`), "utf8");
    assert.doesNotMatch(source, /from ["']\.\.\/history\.js["']/);
    const dependencies = [...source.matchAll(/from ["']\.\/([^"']+)\.js["']/g)]
      .map((match) => match[1])
      .filter((dependency) => domains.has(dependency));
    graph.set(domain, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (domain: string) => {
    assert.ok(!visiting.has(domain), `message-history import cycle reaches ${domain}`);
    if (visited.has(domain)) return;
    visiting.add(domain);
    for (const dependency of graph.get(domain) ?? []) visit(dependency);
    visiting.delete(domain);
    visited.add(domain);
  };
  for (const domain of domains) visit(domain);
});

test("both message facades preserve direct runtime identities", async () => {
  const messagesSource = readFileSync(join(messagesDirectory, "../messages.ts"), "utf8");
  assert.deepEqual(exportsFromModule(
    "messages.ts",
    messagesSource,
    "./messages/history.js",
  ), [
    "getLatestMessages:value",
    "getMessageById:value",
    "getMessageRecipientAgentKeys:value",
    "getMessageRecipientAgentTargets:value",
    "getMessageThread:value",
    "getMessageThreads:value",
    "getMessages:value",
    "getMessagesAfter:value",
    "getMessagesBefore:value",
    "getRoomMessageCountsBySender:value",
    "hasMessagesFromSender:value",
    "hydrateMessageReplies:value",
    "markMessageThreadRead:value",
    "MessageThreadInboxFilter:type",
    "MessageThreadInboxItem:type",
    "MessageThreadInboxPage:type",
    "MessageThreadPage:type",
  ]);

  const history = await import("../db/messages/history.js");
  const messages = await import("../db/messages.js");
  const basic = await import("../db/messages/history/message-history.js");
  const recipient = await import("../db/messages/history/recipient-routing.js");
  const threads = await import("../db/messages/history/threads.js");
  const activity = await import("../db/messages/history/activity.js");
  const implementations = { ...basic, ...recipient, ...threads, ...activity };

  for (const name of Object.keys(history)) {
    assert.strictEqual(history[name], implementations[name], `${name} must be a direct domain re-export`);
    assert.strictEqual(messages[name], history[name], `${name} identity must survive the db facade`);
  }
});
