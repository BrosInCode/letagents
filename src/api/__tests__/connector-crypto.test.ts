import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  ConnectorDecryptError,
  ConnectorKeyMissingError,
  createConnectorCipher,
  loadConnectorCipher,
  redactConnectorSecrets,
} from "../connectors/crypto.js";
import { mapTicketState, parseStatusMap, remainingUnmapped } from "../connectors/status-map.js";
import { normalizeJiraSiteUrl, TrackerSiteUrlError } from "../connectors/site-url.js";
import { DEFAULT_STATUS_MAPS } from "../../../shared/ticket-connectors.mjs";

const key = randomBytes(32);
const binding = { connection_id: "tcon_1", account_id: "acct_1" };

test("credentials round-trip through AES-256-GCM with a hex or base64 key", () => {
  for (const raw of [key.toString("hex"), key.toString("base64"), key.toString("base64url")]) {
    const cipher = createConnectorCipher(raw);
    const sealed = cipher.encrypt({ kind: "api_token", api_key: "lin_api_secretvalue1234567890" }, binding);
    assert.equal(sealed.version, 1);
    assert.ok(!sealed.ciphertext.includes("lin_api"));
    assert.deepEqual(cipher.decrypt(sealed, binding), { kind: "api_token", api_key: "lin_api_secretvalue1234567890" });
  }
});

test("each encryption uses a fresh IV", () => {
  const cipher = createConnectorCipher(key.toString("hex"));
  const a = cipher.encrypt({ value: "same" }, binding);
  const b = cipher.encrypt({ value: "same" }, binding);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("ciphertext bound to one connection does not decrypt on another, under another key, or tampered", () => {
  const cipher = createConnectorCipher(key.toString("hex"));
  const sealed = cipher.encrypt({ token: "x" }, binding);
  assert.throws(() => cipher.decrypt(sealed, { ...binding, connection_id: "tcon_2" }), ConnectorDecryptError);
  assert.throws(() => cipher.decrypt(sealed, { ...binding, account_id: "acct_2" }), ConnectorDecryptError);
  assert.throws(() => createConnectorCipher(randomBytes(32).toString("hex")).decrypt(sealed, binding), ConnectorDecryptError);
  const bytes = Buffer.from(sealed.ciphertext, "base64");
  bytes[0] ^= 1;
  assert.throws(() => cipher.decrypt({ ...sealed, ciphertext: bytes.toString("base64") }, binding), ConnectorDecryptError);
  assert.throws(() => cipher.decrypt({ ...sealed, version: 2 }, binding), ConnectorDecryptError);
});

test("decrypt errors never carry plaintext or ciphertext", () => {
  const cipher = createConnectorCipher(key.toString("hex"));
  const sealed = cipher.encrypt({ token: "ATATT3xFfGF0supersecretvalue" }, binding);
  try {
    cipher.decrypt(sealed, { ...binding, connection_id: "other" });
    assert.fail("expected a decrypt error");
  } catch (error) {
    const message = (error as Error).message;
    assert.ok(!message.includes("ATATT"));
    assert.ok(!message.includes(sealed.ciphertext.slice(0, 12)));
  }
});

test("without a valid key there is no cipher, and a bad key is refused", () => {
  assert.equal(loadConnectorCipher({}), null);
  assert.equal(loadConnectorCipher({ LETAGENTS_CONNECTOR_SECRET_KEY: "  " }), null);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(loadConnectorCipher({ LETAGENTS_CONNECTOR_SECRET_KEY: "too-short" }), null);
  } finally {
    console.error = originalError;
  }
  assert.throws(() => createConnectorCipher(randomBytes(16).toString("hex")), ConnectorKeyMissingError);
  assert.ok(loadConnectorCipher({ LETAGENTS_CONNECTOR_SECRET_KEY: key.toString("hex") }));
});

test("redaction scrubs tracker tokens, authorization headers and named secrets", () => {
  const text = redactConnectorSecrets(
    'Basic dXNlckBleGFtcGxlLmNvbTp0b2tlbg== failed with ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz and lin_oauth_abcdefghijklmnopqrstuvwx '
      + '{"access_token":"plainsecret","refresh_token":"another"} custom-secret-value',
    ["custom-secret-value"],
  );
  for (const leaked of ["dXNlckBleGFtcGxl", "ATATT3x", "lin_oauth_abc", "plainsecret", "another", "custom-secret-value"]) {
    assert.ok(!text.includes(leaked), `${leaked} leaked: ${text}`);
  }
});

test("default status maps follow the plan and unmapped statuses become in_progress", () => {
  const jira = DEFAULT_STATUS_MAPS.jira;
  assert.deepEqual(mapTicketState(jira, { name: "to do" }), { ticket_state: "todo", unmapped: false });
  assert.deepEqual(mapTicketState(jira, { name: "Code Review" }), { ticket_state: "in_review", unmapped: false });
  assert.deepEqual(mapTicketState(jira, { name: "Closed" }), { ticket_state: "done", unmapped: false });
  assert.deepEqual(mapTicketState(jira, { name: "Blocked" }), { ticket_state: "in_progress", unmapped: true });
  // A status the map does not name maps by its Jira status category.
  assert.deepEqual(mapTicketState(jira, { name: "Backlog", type: "new" }), { ticket_state: "todo", unmapped: false });
  assert.deepEqual(mapTicketState(jira, { name: "Blocked", type: "indeterminate" }), { ticket_state: "in_progress", unmapped: false });
  assert.deepEqual(mapTicketState(jira, { name: "Won't Fix", type: "done" }), { ticket_state: "done", unmapped: false });
  // A name entry wins over the category.
  assert.deepEqual(mapTicketState(jira, { name: "In Review", type: "indeterminate" }), { ticket_state: "in_review", unmapped: false });
  const linear = DEFAULT_STATUS_MAPS.linear;
  assert.deepEqual(mapTicketState(linear, { name: "Todo", type: "unstarted" }), { ticket_state: "todo", unmapped: false });
  assert.deepEqual(mapTicketState(linear, { name: "In Review", type: "started" }), { ticket_state: "in_review", unmapped: false });
  assert.deepEqual(mapTicketState(linear, { name: "Building", type: "started" }), { ticket_state: "in_progress", unmapped: false });
  assert.deepEqual(mapTicketState(linear, { name: "Won't do", type: "canceled" }), { ticket_state: "done", unmapped: false });
});

test("status map input is validated and mapping clears unmapped flags", () => {
  assert.equal(parseStatusMap([]).ok, false);
  assert.equal(parseStatusMap({ Blocked: "stuck" }).ok, false);
  assert.equal(parseStatusMap({ "": "todo" }).ok, false);
  const parsed = parseStatusMap({ " Blocked ": "in_progress", QA: "in_review" });
  assert.deepEqual(parsed, { ok: true, map: { Blocked: "in_progress", QA: "in_review" } });
  assert.deepEqual(remainingUnmapped({ QA: "in_review" }, ["QA", "Parked"]), ["Parked"]);
});

test("Jira site URLs must be Jira Cloud on atlassian.net unless a host is allowed", () => {
  assert.equal(normalizeJiraSiteUrl("acme.atlassian.net", {}), "https://acme.atlassian.net");
  assert.equal(normalizeJiraSiteUrl("https://ACME.atlassian.net/jira/your-work", {}), "https://acme.atlassian.net");
  for (const bad of [
    "http://acme.atlassian.net",
    "https://169.254.169.254",
    "https://localhost",
    "https://evil.com/.atlassian.net",
    "https://acme.atlassian.net.evil.com",
    "https://user:pw@acme.atlassian.net",
    "https://acme.atlassian.net:8443",
    "file:///etc/passwd",
    "",
  ]) {
    assert.throws(() => normalizeJiraSiteUrl(bad, {}), TrackerSiteUrlError, bad);
  }
  assert.equal(
    normalizeJiraSiteUrl("https://jira.example.com", { LETAGENTS_JIRA_ALLOWED_HOSTS: "jira.example.com, other.example" }),
    "https://jira.example.com",
  );
});
