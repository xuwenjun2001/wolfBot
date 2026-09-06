-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "preview_url" TEXT,
    "preview_port" INTEGER,
    "repo_path" TEXT,
    "initial_prompt" TEXT,
    "template_type" TEXT,
    "preferred_cli" TEXT,
    "selected_model" TEXT,
    "agent_profile_id" TEXT NOT NULL DEFAULT 'quantpilot.finance-research',
    "agent_profile_version" TEXT NOT NULL DEFAULT '1.0.0',
    "data_agent_composition_sha256" TEXT NOT NULL DEFAULT 'sha256:89436aed794ee3f03ae211a3d07ea6bc0c7fd94cd46663dba9f31917fcb8d575',
    "settings" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata_json" TEXT,
    "parent_message_id" TEXT,
    "conversation_id" TEXT,
    "duration_ms" INTEGER,
    "token_count" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "commit_sha" TEXT,
    "cli_source" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_requests" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "instruction" TEXT NOT NULL,
    "cli_preference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "user_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "run_instance_id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT,
    "actor_user_id" TEXT,
    "workspace_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "workspace_fencing_token" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "framework_version" TEXT NOT NULL,
    "build_revision" TEXT NOT NULL,
    "profile_hash" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "tool_hash" TEXT NOT NULL,
    "skill_hash" TEXT NOT NULL,
    "workspace_hash" TEXT NOT NULL,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_miss_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_event_sequence" INTEGER NOT NULL DEFAULT 0,
    "latest_checkpoint_sequence" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_workspace_leases" (
    "project_id" TEXT NOT NULL,
    "workspace_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'free',
    "active_run_id" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_workspace_leases_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "agent_generation_leases" (
    "project_id" TEXT NOT NULL,
    "active_request_id" TEXT,
    "operation_id" TEXT,
    "stage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'free',
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_generation_leases_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "agent_generation_jobs" (
    "id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT NOT NULL DEFAULT 'agent_execution',
    "execution_envelope" JSONB NOT NULL,
    "instruction_hash" TEXT NOT NULL,
    "instruction_preview" TEXT NOT NULL,
    "cli_preference" TEXT,
    "selected_model" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_generation_outbox_events" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_generation_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_worker_slots" (
    "pool_key" TEXT NOT NULL,
    "slot_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'free',
    "active_job_id" UUID,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_worker_slots_pkey" PRIMARY KEY ("pool_key","slot_number")
);

-- CreateTable
CREATE TABLE "agent_worker_instances" (
    "id" UUID NOT NULL,
    "pool_key" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "process_id" INTEGER NOT NULL,
    "process_concurrency" INTEGER NOT NULL,
    "global_concurrency" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_worker_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_idempotency_operations" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "actor_key" TEXT NOT NULL,
    "idempotency_key_hash" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "response_bytes" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "completed_at" TIMESTAMP(3),
    "retention_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_idempotency_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_checkpoints" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "turn" INTEGER NOT NULL,
    "boundary" TEXT NOT NULL,
    "recovery_mode" TEXT NOT NULL DEFAULT 'replan_required',
    "public_state" JSONB NOT NULL,
    "opaque_state" TEXT,
    "opaque_codec" TEXT,
    "state_hash" TEXT NOT NULL,
    "state_version" INTEGER NOT NULL,
    "fencing_token" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tool_executions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "tool_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "idempotency" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "result_receipt" JSONB,
    "pre_state_hash" TEXT,
    "post_state_hash" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "fencing_token" INTEGER NOT NULL,
    "workspace_fencing_token" INTEGER NOT NULL DEFAULT 0,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tool_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tool_approvals" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "tool_call_id_hash" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "idempotency" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "public_input" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "allowed_decisions" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "edited_input" JSONB,
    "resolved_by_actor_id" TEXT,
    "resolved_by_user_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tool_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_missions" (
    "id" TEXT NOT NULL,
    "generation_id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "active_slot" INTEGER DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "candidate_version" INTEGER NOT NULL DEFAULT 0,
    "current_candidate_run_id" TEXT,
    "current_candidate_request_id" TEXT,
    "accepted_receipt_id" TEXT,
    "verification_lease_owner" TEXT,
    "verification_lease_expires_at" TIMESTAMP(3),
    "verification_last_heartbeat_at" TIMESTAMP(3),
    "verification_fencing_token" INTEGER NOT NULL DEFAULT 0,
    "spec" JSONB NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "candidate_submitted_at" TIMESTAMP(3),
    "verification_started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_mission_nodes" (
    "id" TEXT NOT NULL,
    "mission_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 0,
    "dependencies" JSONB NOT NULL,
    "allowed_tools" JSONB NOT NULL,
    "required_skill_sections" JSONB NOT NULL,
    "input_artifacts" JSONB NOT NULL,
    "output_artifacts" JSONB NOT NULL,
    "budget" JSONB NOT NULL,
    "acceptance_predicates" JSONB NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_mission_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_evidence_receipts" (
    "id" TEXT NOT NULL,
    "mission_id" TEXT NOT NULL,
    "candidate_version" INTEGER NOT NULL,
    "receipt_type" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "receipt_hash" TEXT NOT NULL,
    "source_run_id" TEXT,
    "source_request_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_evidence_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "report_created_at" TIMESTAMP(3) NOT NULL,
    "mtime_ms" DOUBLE PRECISION NOT NULL,
    "report_sha256" TEXT,
    "passed" BOOLEAN NOT NULL,
    "total" INTEGER NOT NULL,
    "passed_count" INTEGER NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "pass_rate" INTEGER NOT NULL,
    "average_score" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_queue_items" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cli" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoning_effort" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL DEFAULT 'rule-strict',
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "repeat" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL DEFAULT 'contract',
    "selected_cases" JSONB NOT NULL,
    "limit" INTEGER,
    "keep_projects" BOOLEAN NOT NULL,
    "report_id" TEXT,
    "report_path" TEXT,
    "log_path" TEXT,
    "pid" INTEGER,
    "exit_code" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_repair_tickets" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "report_path" TEXT NOT NULL,
    "project_id" TEXT,
    "failures" JSONB NOT NULL,
    "validation_summaries" JSONB NOT NULL,
    "suggested_actions" JSONB NOT NULL,
    "skill_versions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_repair_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_cases" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_sets" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");

-- CreateIndex
CREATE INDEX "projects_agent_profile_id_idx" ON "projects"("agent_profile_id");

-- CreateIndex
CREATE INDEX "projects_data_agent_composition_sha256_idx" ON "projects"("data_agent_composition_sha256");

-- CreateIndex
CREATE INDEX "messages_project_id_idx" ON "messages"("project_id");

-- CreateIndex
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at");

-- CreateIndex
CREATE INDEX "messages_project_id_created_at_idx" ON "messages"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_cli_source_idx" ON "messages"("cli_source");

-- CreateIndex
CREATE INDEX "messages_request_id_idx" ON "messages"("request_id");

-- CreateIndex
CREATE INDEX "user_requests_project_id_idx" ON "user_requests"("project_id");

-- CreateIndex
CREATE INDEX "user_requests_status_idx" ON "user_requests"("status");

-- CreateIndex
CREATE INDEX "user_requests_actor_user_id_created_at_idx" ON "user_requests"("actor_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_requests_id_project_id_key" ON "user_requests"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_run_instance_id_key" ON "agent_runs"("run_instance_id");

-- CreateIndex
CREATE INDEX "agent_runs_project_id_created_at_idx" ON "agent_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_request_id_created_at_idx" ON "agent_runs"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_actor_user_id_created_at_idx" ON "agent_runs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_status_lease_expires_at_idx" ON "agent_runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workspace_leases_workspace_key_key" ON "agent_workspace_leases"("workspace_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workspace_leases_active_run_id_key" ON "agent_workspace_leases"("active_run_id");

-- CreateIndex
CREATE INDEX "agent_workspace_leases_status_lease_expires_at_idx" ON "agent_workspace_leases"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "agent_generation_leases_status_lease_expires_at_idx" ON "agent_generation_leases"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "agent_generation_leases_active_request_id_idx" ON "agent_generation_leases"("active_request_id");

-- CreateIndex
CREATE INDEX "agent_generation_jobs_project_id_queued_at_idx" ON "agent_generation_jobs"("project_id", "queued_at");

-- CreateIndex
CREATE INDEX "agent_generation_jobs_status_available_at_idx" ON "agent_generation_jobs"("status", "available_at");

-- CreateIndex
CREATE INDEX "agent_generation_jobs_status_lease_expires_at_idx" ON "agent_generation_jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_generation_jobs_request_id_project_id_key" ON "agent_generation_jobs"("request_id", "project_id");

-- CreateIndex
CREATE INDEX "agent_generation_outbox_events_project_id_created_at_idx" ON "agent_generation_outbox_events"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_generation_outbox_events_published_at_created_at_idx" ON "agent_generation_outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_generation_outbox_events_job_id_sequence_key" ON "agent_generation_outbox_events"("job_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "agent_worker_slots_active_job_id_key" ON "agent_worker_slots"("active_job_id");

-- CreateIndex
CREATE INDEX "agent_worker_slots_pool_key_status_lease_expires_at_idx" ON "agent_worker_slots"("pool_key", "status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "agent_worker_instances_pool_key_status_lease_expires_at_idx" ON "agent_worker_instances"("pool_key", "status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "agent_worker_instances_status_lease_expires_at_idx" ON "agent_worker_instances"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "api_idempotency_operations_status_lease_expires_at_idx" ON "api_idempotency_operations"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "api_idempotency_operations_retention_expires_at_idx" ON "api_idempotency_operations"("retention_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_idempotency_operations_scope_actor_key_idempotency_key__key" ON "api_idempotency_operations"("scope", "actor_key", "idempotency_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_event_id_key" ON "agent_events"("event_id");

-- CreateIndex
CREATE INDEX "agent_events_run_id_created_at_idx" ON "agent_events"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_run_id_sequence_key" ON "agent_events"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "agent_checkpoints_run_id_created_at_idx" ON "agent_checkpoints"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_checkpoints_run_id_sequence_key" ON "agent_checkpoints"("run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tool_executions_operation_id_key" ON "agent_tool_executions"("operation_id");

-- CreateIndex
CREATE INDEX "agent_tool_executions_run_id_status_idx" ON "agent_tool_executions"("run_id", "status");

-- CreateIndex
CREATE INDEX "agent_tool_executions_status_updated_at_idx" ON "agent_tool_executions"("status", "updated_at");

-- CreateIndex
CREATE INDEX "agent_tool_approvals_run_id_requested_at_idx" ON "agent_tool_approvals"("run_id", "requested_at");

-- CreateIndex
CREATE INDEX "agent_tool_approvals_status_expires_at_idx" ON "agent_tool_approvals"("status", "expires_at");

-- CreateIndex
CREATE INDEX "agent_tool_approvals_resolved_by_actor_id_resolved_at_idx" ON "agent_tool_approvals"("resolved_by_actor_id", "resolved_at");

-- CreateIndex
CREATE INDEX "agent_tool_approvals_resolved_by_user_id_resolved_at_idx" ON "agent_tool_approvals"("resolved_by_user_id", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_missions_generation_id_key" ON "agent_missions"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_missions_request_id_key" ON "agent_missions"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_missions_accepted_receipt_id_key" ON "agent_missions"("accepted_receipt_id");

-- CreateIndex
CREATE INDEX "agent_missions_project_id_status_updated_at_idx" ON "agent_missions"("project_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "agent_missions_status_updated_at_idx" ON "agent_missions"("status", "updated_at");

-- CreateIndex
CREATE INDEX "agent_missions_status_verification_lease_expires_at_idx" ON "agent_missions"("status", "verification_lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_missions_request_id_project_id_key" ON "agent_missions"("request_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_missions_project_id_active_slot_key" ON "agent_missions"("project_id", "active_slot");

-- CreateIndex
CREATE INDEX "agent_mission_nodes_mission_id_status_idx" ON "agent_mission_nodes"("mission_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_mission_nodes_mission_id_node_key_key" ON "agent_mission_nodes"("mission_id", "node_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_evidence_receipts_receipt_hash_key" ON "agent_evidence_receipts"("receipt_hash");

-- CreateIndex
CREATE INDEX "agent_evidence_receipts_mission_id_candidate_version_create_idx" ON "agent_evidence_receipts"("mission_id", "candidate_version", "created_at");

-- CreateIndex
CREATE INDEX "agent_evidence_receipts_verdict_created_at_idx" ON "agent_evidence_receipts"("verdict", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_evidence_receipts_mission_id_candidate_version_receip_key" ON "agent_evidence_receipts"("mission_id", "candidate_version", "receipt_type", "subject_hash");

-- CreateIndex
CREATE INDEX "eval_runs_report_created_at_idx" ON "eval_runs"("report_created_at");

-- CreateIndex
CREATE INDEX "eval_runs_passed_idx" ON "eval_runs"("passed");

-- CreateIndex
CREATE INDEX "eval_queue_items_status_idx" ON "eval_queue_items"("status");

-- CreateIndex
CREATE INDEX "eval_queue_items_created_at_idx" ON "eval_queue_items"("created_at");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_run_id_idx" ON "eval_repair_tickets"("run_id");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_case_id_idx" ON "eval_repair_tickets"("case_id");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_status_idx" ON "eval_repair_tickets"("status");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_created_at_idx" ON "eval_repair_tickets"("created_at");

-- CreateIndex
CREATE INDEX "eval_cases_created_at_idx" ON "eval_cases"("created_at");

-- CreateIndex
CREATE INDEX "eval_sets_created_at_idx" ON "eval_sets"("created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_requests" ADD CONSTRAINT "user_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_request_id_project_id_fkey" FOREIGN KEY ("request_id", "project_id") REFERENCES "user_requests"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_workspace_leases" ADD CONSTRAINT "agent_workspace_leases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_generation_leases" ADD CONSTRAINT "agent_generation_leases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_generation_leases" ADD CONSTRAINT "agent_generation_leases_active_request_id_project_id_fkey" FOREIGN KEY ("active_request_id", "project_id") REFERENCES "user_requests"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_generation_jobs" ADD CONSTRAINT "agent_generation_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_generation_jobs" ADD CONSTRAINT "agent_generation_jobs_request_id_project_id_fkey" FOREIGN KEY ("request_id", "project_id") REFERENCES "user_requests"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_generation_outbox_events" ADD CONSTRAINT "agent_generation_outbox_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "agent_generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_executions" ADD CONSTRAINT "agent_tool_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_approvals" ADD CONSTRAINT "agent_tool_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_missions" ADD CONSTRAINT "agent_missions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_missions" ADD CONSTRAINT "agent_missions_request_id_project_id_fkey" FOREIGN KEY ("request_id", "project_id") REFERENCES "user_requests"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_missions" ADD CONSTRAINT "agent_missions_accepted_receipt_id_fkey" FOREIGN KEY ("accepted_receipt_id") REFERENCES "agent_evidence_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_mission_nodes" ADD CONSTRAINT "agent_mission_nodes_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_evidence_receipts" ADD CONSTRAINT "agent_evidence_receipts_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
