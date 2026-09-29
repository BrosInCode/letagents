import type { DatabaseSync } from "node:sqlite";

const definition = `CREATE TABLE managed_launch_contracts (
  runtime_generation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  execution_generation_id TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256)=64 AND contract_sha256 NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)
    REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id)
) STRICT`;
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function applyManagedLaunchContractSchema(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='managed_launch_contracts'").get()) database.exec(definition);
  validateManagedLaunchContractSchema(database);
}

export function validateManagedLaunchContractSchema(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='managed_launch_contracts'").get();
  if (normalize(String(row?.sql ?? "")) !== normalize(definition)) throw new Error("Managed launch contract schema is invalid.");
}
