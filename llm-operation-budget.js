"use strict";

// Budget global d'UNE opération LUBA : toutes les générations, tous les fournisseurs
// et toutes les clés sont comptés ensemble. Les plafonds ne peuvent pas être relevés
// au-delà des constantes de sécurité ci-dessous.
const HARD_MAX_GENERATIONS = 5;
const HARD_MAX_DURATION_MS = 5 * 60 * 1000;
const HARD_MAX_INPUT_TOKENS = 60000;
const HARD_MAX_OUTPUT_TOKENS = 12000;

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createOperationBudget({
  startedAt = Date.now(), deadlineAt = null,
  maxAttempts: requestedAttempts = null,
  maxDurationMs: requestedDuration = null,
  maxInputTokens: requestedInput = null,
  maxOutputTokens: requestedOutput = null
} = {}) {
  const start = Number.isFinite(startedAt) ? startedAt : Date.now();
  const configuredDuration = boundedInteger("LLM_MAX_OPERATION_MS", HARD_MAX_DURATION_MS, 1000, HARD_MAX_DURATION_MS);
  const configuredAttempts = boundedInteger("LLM_MAX_GENERATION_ATTEMPTS", HARD_MAX_GENERATIONS, 1, HARD_MAX_GENERATIONS);
  const configuredInput = boundedInteger("LLM_OPERATION_MAX_INPUT_TOKENS", 24000, 2000, HARD_MAX_INPUT_TOKENS);
  const configuredOutput = boundedInteger("LLM_OPERATION_MAX_OUTPUT_TOKENS", 6500, 500, HARD_MAX_OUTPUT_TOKENS);
  const bounded = (value, fallback, min, max) => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Number(value))) : fallback;
  const maxDurationMs = Math.min(configuredDuration, bounded(requestedDuration, configuredDuration, 1000, HARD_MAX_DURATION_MS));
  const maxAttempts = Math.min(configuredAttempts, bounded(requestedAttempts, configuredAttempts, 1, HARD_MAX_GENERATIONS));
  const maxInputTokens = Math.min(configuredInput, bounded(requestedInput, configuredInput, 1000, HARD_MAX_INPUT_TOKENS));
  const maxOutputTokens = Math.min(configuredOutput, bounded(requestedOutput, configuredOutput, 256, HARD_MAX_OUTPUT_TOKENS));
  const hardDeadline = start + maxDurationMs;
  const requestedDeadline = Number.isFinite(deadlineAt) ? deadlineAt : hardDeadline;
  return {
    startedAt: start,
    deadlineAt: Math.min(requestedDeadline, hardDeadline),
    maxAttempts,
    attempts: 0,
    maxDurationMs,
    maxInputTokens,
    maxOutputTokens,
    inputTokens: 0,
    outputTokens: 0
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

// Réserve les tokens d'entrée avant chaque appel. La sortie est plafonnée selon
// le solde restant, puis comptabilisée à la réception de la réponse réelle.
function reserveTokens(budget, promptTokens, requestedOutputTokens) {
  if (!budget || !Number.isFinite(budget.inputTokens) || !Number.isFinite(budget.outputTokens)) {
    return { ok: false, code: "LLM_TOKEN_BUDGET_INVALID", message: "Budget de tokens invalide." };
  }
  const input = Math.max(0, Math.ceil(Number(promptTokens) || 0));
  const remainingInput = budget.maxInputTokens - budget.inputTokens;
  if (input > remainingInput) {
    return { ok: false, code: "LLM_INPUT_BUDGET_EXHAUSTED", message: "Le contexte dépasse le budget de tokens de cette opération." };
  }
  const remainingOutput = budget.maxOutputTokens - budget.outputTokens;
  if (remainingOutput < 128) {
    return { ok: false, code: "LLM_OUTPUT_BUDGET_EXHAUSTED", message: "Le budget de réponse de cette opération est atteint." };
  }
  budget.inputTokens += input;
  return { ok: true, maxOutputTokens: Math.max(128, Math.min(Math.ceil(Number(requestedOutputTokens) || 128), remainingOutput)) };
}

function recordOutputTokens(budget, completionTokens) {
  if (!budget || !Number.isFinite(budget.outputTokens)) return;
  const n = Math.max(0, Math.ceil(Number(completionTokens) || 0));
  budget.outputTokens = Math.min(budget.maxOutputTokens, budget.outputTokens + n);
}

module.exports = {
  HARD_MAX_GENERATIONS,
  HARD_MAX_DURATION_MS,
  HARD_MAX_INPUT_TOKENS,
  HARD_MAX_OUTPUT_TOKENS,
  createOperationBudget,
  remainingMs,
  tryConsumeGeneration,
  reserveTokens,
  recordOutputTokens
};
