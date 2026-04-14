#!/usr/bin/env node
/**
 * PRISM Engine Hook — UserPromptSubmit
 *
 * Injects PRISM context block into every user prompt.
 * Reads session state to determine bracket, agent, and mode,
 * then runs the PRISM pipeline to produce XML context.
 *
 * Claude Code Hook: triggers on every user message submission.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Read session.yaml and extract key fields for PRISM.
 */
function readSessionState(projectDir) {
  const sessionPath = join(projectDir, '.chati', 'session.yaml');
  if (!existsSync(sessionPath)) return null;

  const raw = readFileSync(sessionPath, 'utf-8');
  // Lightweight YAML extraction (avoid dependency)
  const extract = (key) => {
    const match = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
  };

  return {
    mode: extract('mode') || 'discover',
    currentAgent: extract('current_agent') || null,
    workflow: extract('workflow') || null,
    pipelinePosition: extract('pipeline_position') || null,
    turnCount: parseInt(extract('turn_count') || '0', 10),
    provider: extract('provider') || 'claude',
  };
}

/**
 * Main hook handler.
 * Reads stdin for hook event, outputs context to inject.
 */
async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const event = JSON.parse(input);
    const projectDir = event.cwd || process.cwd();
    const session = readSessionState(projectDir);

    if (!session) {
      // No active session — don't inject anything
      process.stdout.write(JSON.stringify({ result: 'allow' }));
      return;
    }

    // Estimate remaining context — prefer token-based estimation over turn count
    // Token estimation: 1 token ≈ 4 characters (Claude Code pattern)
    // SYNC: These limits MUST match packages/chati-dev/src/utils/provider-limits.js
    const HOOK_MODEL_LIMITS = { opus: 1_000_000, sonnet: 200_000, haiku: 200_000, pro: 1_000_000, flash: 1_000_000, codex: 128_000 };
    const HOOK_PROVIDER_LIMITS = { claude: 200_000, gemini: 1_000_000, codex: 128_000 };

    // Infer model from current agent via AGENT_MODELS map
    const HOOK_AGENT_MODELS = {
      orchestrator: 'sonnet', 'greenfield-wu': 'haiku', 'brownfield-wu': 'opus',
      brief: 'sonnet', detail: 'opus', architect: 'opus', ux: 'sonnet',
      phases: 'sonnet', tasks: 'sonnet', 'qa-planning': 'opus',
      'qa-implementation': 'opus', dev: 'opus', devops: 'sonnet',
    };
    const inferredModel = session.currentAgent ? HOOK_AGENT_MODELS[session.currentAgent] : null;

    // Resolve context limit: model > provider > default
    function hookResolveLimit(model, provider) {
      if (model && HOOK_MODEL_LIMITS[model]) return HOOK_MODEL_LIMITS[model];
      if (provider && HOOK_PROVIDER_LIMITS[provider]) return HOOK_PROVIDER_LIMITS[provider];
      return 200_000;
    }

    let remainingPercent;
    const promptText = event.prompt || '';
    if (promptText.length > 0) {
      const estimatedTokens = Math.ceil(promptText.length / 4);
      const contextLimit = hookResolveLimit(inferredModel, session.provider);
      remainingPercent = Math.max(0, Math.round((1 - estimatedTokens / contextLimit) * 100));
    } else {
      // Fallback to turn-count heuristic when prompt text unavailable
      const maxTurns = 40;
      remainingPercent = Math.max(0, Math.round((1 - session.turnCount / maxTurns) * 100));
    }

    // Determine bracket
    let bracket = 'FRESH';
    if (remainingPercent < 25) bracket = 'CRITICAL';
    else if (remainingPercent < 40) bracket = 'DEPLETED';
    else if (remainingPercent < 60) bracket = 'MODERATE';

    // Load agent memory (if active agent has MEMORY.md)
    let memoryBlock = '';
    if (session.currentAgent) {
      const memoryPath = join(projectDir, '.chati', 'memories', session.currentAgent, 'MEMORY.md');
      if (existsSync(memoryPath)) {
        const raw = readFileSync(memoryPath, 'utf-8').trim();
        if (raw) {
          const trimmed = raw.slice(0, 500);
          memoryBlock = `  <agent-memory agent="${session.currentAgent}">\n${trimmed}\n  </agent-memory>`;
        }
      }
    }

    // Frustration detection — adapt response style when user is frustrated
    const frustrationDetected = detectFrustration(promptText);

    // Microcompact advisory — hint to economize context when depleted + idle
    let microcompactAdvisory = '';
    if ((bracket === 'DEPLETED' || bracket === 'CRITICAL') && session.turnCount > 10) {
      microcompactAdvisory = '  <advisory priority="medium">Context constrained. Avoid re-reading files already in context. Summarize stale outputs before proceeding.</advisory>';
    }

    // Build minimal context block (full PRISM pipeline is used by orchestrator internally)
    const contextBlock = [
      `<chati-context bracket="${bracket}">`,
      `  <mode>${session.mode}</mode>`,
      session.currentAgent ? `  <agent>${session.currentAgent}</agent>` : '',
      session.pipelinePosition ? `  <pipeline-position>${session.pipelinePosition}</pipeline-position>` : '',
      memoryBlock,
      bracket === 'CRITICAL' ? '  <advisory>Context running low. Consider handoff or summary.</advisory>' : '',
      microcompactAdvisory,
      frustrationDetected ? '  <advisory priority="high">User shows signs of frustration. Be more direct, acknowledge the issue explicitly, focus on the solution, avoid repeating previous suggestions.</advisory>' : '',
      '</chati-context>',
    ].filter(Boolean).join('\n');

    process.stdout.write(JSON.stringify({
      result: 'allow',
      prefix: contextBlock,
    }));
  } catch (err) {
    process.stderr.write(`[chati] prism-engine: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ result: 'allow' }));
  }
}

/**
 * Frustration detection patterns.
 * Inspired by Claude Code's regex-based emotion detection.
 * Soft advisory only — never blocks or overrides behavior.
 */
const FRUSTRATION_PATTERNS = [
  /this (is|isn't|isnt) working/i,
  /I (already|just) (told|said|asked)/i,
  /why (won't|doesn't|can't|isn't|wont|doesnt|cant|isnt)/i,
  /stop (doing|repeating|ignoring)/i,
  /you('re| are) (not|never) (listening|reading|understanding)/i,
  /for the (second|third|fourth|last) time/i,
  /!!+/,
  /\b(WTF|WHAT THE|FFS|OMG)\b/i,
];

/**
 * Detect user frustration from prompt text.
 * @param {string} prompt - User prompt text
 * @returns {boolean} True if frustration patterns detected
 */
function detectFrustration(prompt) {
  if (!prompt || prompt.length < 5) return false;
  return FRUSTRATION_PATTERNS.some(p => p.test(prompt));
}

export { readSessionState, detectFrustration };

// Only run main when executed directly (not imported by tests)
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
