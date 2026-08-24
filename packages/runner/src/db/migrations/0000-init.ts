/**
 * Migration 0000 - the five tables of docs/ARCHITECTURE.md 7.
 *
 * The SQL is written out by hand rather than generated, because the migration
 * is what actually constrains the data and this project's premise is that every
 * claim is checkable. It is templated per dialect so that the enum arrays in
 * `@adversary/core` remain the single source of truth for the CHECK lists -
 * adding a member to `MONEY_KINDS` widens the constraint automatically, and the
 * compile-time parity assertions in `enums.ts` keep that array honest.
 */

import {
  GATE_DECISIONS,
  IDEMPOTENCY_SOURCES,
  INVARIANT_STATUSES,
  MONEY_KINDS,
  RAIL_KINDS,
  RAIL_RESULTS,
  REPRODUCIBILITY_TIERS,
  SCENARIO_FAMILIES,
  SCENARIO_KINDS,
  TRAJECTORY_EVENT_KINDS,
  TRAJECTORY_ROLES,
} from '@adversary/core';

import { sqlInList } from '../table-spec.js';
import type { Dialect } from '../dialect.js';

/**
 * The only three places the two dialects actually differ in this schema.
 *
 * Epoch milliseconds do not fit in a 32-bit integer, so Postgres needs BIGINT;
 * SQLite's INTEGER is already 64-bit. SQLite has no boolean type. Amounts stay
 * plain INTEGER in both: the per-transaction cap that any scenario can express
 * is orders of magnitude below 2^31 paise.
 */
function types(dialect: Dialect) {
  return {
    epochMs: dialect === 'postgres' ? 'BIGINT' : 'INTEGER',
    bool: dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER',
    int: 'INTEGER',
    text: 'TEXT',
  };
}

export const id = '0000-init';

export function up(dialect: Dialect): string[] {
  const t = types(dialect);

  return [
    // --- runs --------------------------------------------------------------
    `CREATE TABLE runs (
      id                    ${t.text} PRIMARY KEY NOT NULL,
      run_key               ${t.text} NOT NULL,
      attempt               ${t.int} NOT NULL,
      scenario_id           ${t.text} NOT NULL,
      scenario_content_hash ${t.text} NOT NULL,
      seed                  ${t.int} NOT NULL,
      rail                  ${t.text} NOT NULL,
      gate_enabled          ${t.bool} NOT NULL,
      agent_name            ${t.text} NOT NULL,
      agent_version         ${t.text} NOT NULL,
      model                 ${t.text},
      reproducibility       ${t.text} NOT NULL,
      cassette_hash         ${t.text},
      started_at            ${t.epochMs} NOT NULL,
      finished_at           ${t.epochMs},
      verdict               ${t.text},
      error                 ${t.text},
      turns_used            ${t.int} NOT NULL DEFAULT 0,
      CONSTRAINT runs_attempt_positive CHECK (attempt >= 0),
      CONSTRAINT runs_turns_positive CHECK (turns_used >= 0),
      CONSTRAINT runs_rail_valid CHECK (rail IN (${sqlInList(RAIL_KINDS)})),
      CONSTRAINT runs_reproducibility_valid
        CHECK (reproducibility IN (${sqlInList(REPRODUCIBILITY_TIERS)})),
      CONSTRAINT runs_verdict_valid
        CHECK (verdict IS NULL OR verdict IN (${sqlInList(INVARIANT_STATUSES)})),
      CONSTRAINT runs_key_attempt_unique UNIQUE (run_key, attempt)
    )`,
    `CREATE INDEX runs_scenario_idx ON runs (scenario_id, rail, gate_enabled)`,
    `CREATE INDEX runs_run_key_idx ON runs (run_key)`,

    // --- money_actions -----------------------------------------------------
    //
    // Append-only by construction: the ledger exposes no update and no delete,
    // and nothing in the codebase issues UPDATE or DELETE against this table.
    // Blocked actions are rows too, with rail_result = 'not_executed' - that
    // row is the entire containment-rate metric.
    `CREATE TABLE money_actions (
      id                 ${t.text} PRIMARY KEY NOT NULL,
      run_id             ${t.text} NOT NULL REFERENCES runs(id),
      seq                ${t.int} NOT NULL,
      ts                 ${t.epochMs} NOT NULL,
      kind               ${t.text} NOT NULL,
      params_json        ${t.text} NOT NULL DEFAULT '{}',
      amount_paise       ${t.int} NOT NULL,
      payee_ref          ${t.text},
      subject_ref        ${t.text},
      idempotency_key    ${t.text} NOT NULL,
      idempotency_source ${t.text} NOT NULL,
      taint_json         ${t.text} NOT NULL DEFAULT '[]',
      gate_decision      ${t.text} NOT NULL,
      gate_reasons_json  ${t.text} NOT NULL DEFAULT '[]',
      rule_trace_json    ${t.text} NOT NULL DEFAULT '[]',
      agent_rationale    ${t.text} NOT NULL DEFAULT '',
      rail_result        ${t.text} NOT NULL,
      rail_ref           ${t.text},
      rail_error         ${t.text},
      CONSTRAINT money_actions_seq_positive CHECK (seq >= 0),
      CONSTRAINT money_actions_amount_non_negative CHECK (amount_paise >= 0),
      CONSTRAINT money_actions_kind_valid CHECK (kind IN (${sqlInList(MONEY_KINDS)})),
      CONSTRAINT money_actions_gate_decision_valid
        CHECK (gate_decision IN (${sqlInList(GATE_DECISIONS)})),
      CONSTRAINT money_actions_rail_result_valid
        CHECK (rail_result IN (${sqlInList(RAIL_RESULTS)})),
      CONSTRAINT money_actions_idempotency_source_valid
        CHECK (idempotency_source IN (${sqlInList(IDEMPOTENCY_SOURCES)})),
      CONSTRAINT money_actions_run_seq_unique UNIQUE (run_id, seq)
    )`,
    `CREATE INDEX money_actions_run_idx ON money_actions (run_id, seq)`,

    // --- trajectory_events -------------------------------------------------
    `CREATE TABLE trajectory_events (
      id           ${t.text} PRIMARY KEY NOT NULL,
      run_id       ${t.text} NOT NULL REFERENCES runs(id),
      seq          ${t.int} NOT NULL,
      role         ${t.text} NOT NULL,
      kind         ${t.text} NOT NULL,
      content_json ${t.text} NOT NULL DEFAULT '{}',
      CONSTRAINT trajectory_events_seq_positive CHECK (seq >= 0),
      CONSTRAINT trajectory_events_role_valid
        CHECK (role IN (${sqlInList(TRAJECTORY_ROLES)})),
      CONSTRAINT trajectory_events_kind_valid
        CHECK (kind IN (${sqlInList(TRAJECTORY_EVENT_KINDS)})),
      CONSTRAINT trajectory_events_run_seq_unique UNIQUE (run_id, seq)
    )`,
    `CREATE INDEX trajectory_events_run_idx ON trajectory_events (run_id, seq)`,

    // --- verdicts ----------------------------------------------------------
    //
    // witness_ids_json records which actions produced a violation. Without it
    // blast radius is a number nobody can check.
    `CREATE TABLE verdicts (
      run_id             ${t.text} NOT NULL REFERENCES runs(id),
      invariant_id       ${t.text} NOT NULL,
      status             ${t.text} NOT NULL,
      observed_json      ${t.text} NOT NULL DEFAULT 'null',
      expected_json      ${t.text} NOT NULL DEFAULT 'null',
      blast_radius_paise ${t.int} NOT NULL DEFAULT 0,
      witness_ids_json   ${t.text} NOT NULL DEFAULT '[]',
      CONSTRAINT verdicts_blast_radius_non_negative CHECK (blast_radius_paise >= 0),
      CONSTRAINT verdicts_status_valid
        CHECK (status IN (${sqlInList(INVARIANT_STATUSES)})),
      CONSTRAINT verdicts_pk PRIMARY KEY (run_id, invariant_id)
    )`,
    `CREATE INDEX verdicts_run_idx ON verdicts (run_id)`,

    // --- scenarios ---------------------------------------------------------
    //
    // Keyed by (id, content_hash), not by id. Editing a scenario creates a new
    // row rather than mutating the old one, so a scorecard from last month can
    // still be explained by the corpus that produced it.
    `CREATE TABLE scenarios (
      id            ${t.text} NOT NULL,
      version       ${t.text} NOT NULL,
      content_hash  ${t.text} NOT NULL,
      kind          ${t.text} NOT NULL,
      family        ${t.text} NOT NULL,
      pair_id       ${t.text},
      yaml_snapshot ${t.text} NOT NULL,
      CONSTRAINT scenarios_kind_valid CHECK (kind IN (${sqlInList(SCENARIO_KINDS)})),
      CONSTRAINT scenarios_family_valid
        CHECK (family IN (${sqlInList(SCENARIO_FAMILIES)})),
      CONSTRAINT scenarios_pk PRIMARY KEY (id, content_hash)
    )`,
  ];
}
