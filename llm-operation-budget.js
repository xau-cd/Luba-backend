"use strict";

// Budget partagé par toutes les générations d'une même opération (tous modèles et toutes clés confondus).
// Les variables d'environnement peuvent réduire les plafonds, jamais les augmenter au-delà de 5 / 5 minutes.
const HARD_MAX_GENERATIONS = 5;
const HARD_MAX_DURATION_MS = 5 * 60 * 1000;

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createOperationBudget({ startedAt = Date.now(), deadlineAt = null, maxAttempts: requestedAttempts = null, maxDurationMs: requestedDuration = null } = {}) {
  const start = Number.isFinite(startedAt) ? startedAt : Date.now();
  const configuredDuration = boundedInteger("LLM_MAX_OPERATION_MS", HARD_MAX_DURATION_MS, 1000, HARD_MAX_DURATION_MS);
  const configuredAttempts = boundedInteger("LLM_MAX_GENERATION_ATTEMPTS", HARD_MAX_GENERATIONS, 1, HARD_MAX_GENERATIONS);
  const maxDurationMs = requestedDuration !== null && requestedDuration !== undefined && Number.isFinite(Number(requestedDuration)) ? Math.min(configuredDuration, Math.max(1000, Math.min(HARD_MAX_DURATION_MS, Number(requestedDuration)))) : configuredDuration;
  const maxAttempts = requestedAttempts !== null && requestedAttempts !== undefined && Number.isFinite(Number(requestedAttempts)) ? Math.min(configuredAttempts, Math.max(1, Math.min(HARD_MAX_GENERATIONS, Number(requestedAttempts)))) : configuredAttempts;
  const hardDeadline = start + maxDurationMs;
  const requestedDeadline = Number.isFinite(deadlineAt) ? deadlineAt : hardDeadline;
  return {
    startedAt: start,
    deadlineAt: Math.min(requestedDeadline, hardDeadline),
    maxAttempts,
    attempts: 0,
    maxDurationMs
  };
}

function remainingMs(budget, now = Date.now(), localDeadlineAt = null) {
  if (!budget || !Number.isFinite(budget.deadlineAt)) return 0;
  const deadline = Number.isFinite(localDeadlineAt) ? Math.min(budget.deadlineAt, localDeadlineAt) : budget.deadlineAt;
  return Math.max(0, deadline - now);
}

function tryConsumeGeneration(budget, now = Date.now(), localDeadlineAt = null) {
  if (!budget || !Number.isFinite(budget.maxAttempts) || !Number.isFinite(budget.attempts)) {
    return { ok: false, code: "LLM_BUDGET_INVALID", message: "Budget de génération LLM invalide." };
  }
  if (remainingMs(budget, now, localDeadlineAt) <= 0) {
    return { ok: false, code: "OPERATION_TIMEOUT", message: "Le délai maximal de l'opération est dépassé." };
  }
  if (budget.attempts >= Math.min(HARD_MAX_GENERATIONS, budget.maxAttempts)) {
    return { ok: false, code: "LLM_ATTEMPTS_EXHAUSTED", message: "La limite de générations LLM de cette opération est atteinte." };
  }
  budget.attempts += 1;
  return { ok: true, attempt: budget.attempts, remainingMs: remainingMs(budget, now, localDeadlineAt) };
}

module.exports = {
  HARD_MAX_GENERATIONS,
  HARD_MAX_DURATION_MS,
  createOperationBudget,
  remainingMs,
  tryConsumeGeneration
};
