CREATE INDEX "execution_delegation_decisions_applicable_idx"
  ON "execution_delegation_decisions" (
    "delegation_instance_id",
    "delegation_revision",
    "decided_at",
    "decision_id"
  );
