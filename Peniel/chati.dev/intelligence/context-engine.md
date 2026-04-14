# Context Engine — Bracket-Aware Context Management

## Purpose

The Context Engine monitors context window usage and adapts what information is injected into each agent's prompt. As the context fills, fewer layers are injected to maintain focus, while per-layer reinforcement INCREASES to compensate for the model forgetting initial instructions (Progressive Reinforcement Model).

---

## Context Brackets

Four brackets define behavior based on remaining context:

| Bracket | Context Remaining | Behavior |
|---------|-------------------|----------|
| **FRESH** | 60-100% | All 6 layers active. Minimal reinforcement (1.5%) — context is plentiful. No memory injection. |
| **MODERATE** | 40-60% | 5 layers (skip L4). Growing reinforcement (2.5%) — model starting to forget. Metadata memory. |
| **DEPLETED** | 25-40% | 3 layers (L0-L2). Heavy reinforcement (4.0%) — significant context loss. Chunk memory recovery. |
| **CRITICAL** | <25% | 2 layers (L0-L1). Maximum reinforcement (5.0%) — last interactions before handoff. Full memory dump. |

### Static/Dynamic PRISM Boundary

The PRISM engine separates context into a **static prefix** (L0 Constitution + L1 Global rules) and a **dynamic suffix** (L2-L5, changes per turn). A `<!-- STATIC_BOUNDARY -->` marker separates them in the XML output.

This enables prompt cache reuse — the static prefix is identical across turns within the same mode, so the LLM provider can cache it and only reprocess the dynamic portion.

The static cache is invalidated when the governance mode changes (planning → build → deploy).

---

## Layered Context Injection

The orchestrator injects context through 6 hierarchical layers:

| Layer | Name | Source | When Active |
|-------|------|--------|-------------|
| **L0** | Constitution | `chati.dev/constitution.md` (Articles I-XIX) | ALWAYS (non-negotiable) |
| **L1** | Mode + Global | `config.yaml` + mode governance (planning/build/deploy) | ALWAYS |
| **L2** | Agent Scope | `chati.dev/agents/{agent}/` — mission, inputs, outputs, criteria | When agent is active |
| **L3** | Pipeline State | `.chati/session.yaml` — pipeline position, scores, backlog | When session is active |
| **L4** | Task Context | Active artifact + previous agent's handoff | When task is active |
| **L5** | Keywords | `chati.dev/domains/keywords/` — dynamic rules from user prompt | FRESH + MODERATE only |

### Layer Activation by Bracket

| Bracket | Active Layers | Budget Ratio | Claude (200K) | Gemini (1M) | Codex (128K) |
|---------|--------------|-------------|---------------|-------------|--------------|
| FRESH | L0, L1, L2, L3, L4, L5 | 1.5% | 3,000 | 15,000 | 1,920 |
| MODERATE | L0, L1, L2, L3, L5 | 2.5% | 5,000 | 25,000 | 3,200 |
| DEPLETED | L0, L1, L2 | 4.0% | 8,000 | 40,000 | 5,120 |
| CRITICAL | L0, L1 | 5.0% | 10,000 | 50,000 | 6,400 |

Budgets are proportional to the provider's context window. As context degrades, fewer layers are active (focus) but each active layer receives MORE reinforcement tokens (strength).

---

## Context Block Format

The orchestrator produces a structured XML block injected into agent prompts:

```xml
<chati-context bracket="MODERATE">
  <constitution>
    Articles I-XIX governing agent behavior.
    Key: Self-validation required. Loop until quality threshold.
    Guided options (1,2,3). Persistent session state.
    Two-layer handoff. Language protocol. Deviation protocol.
    Mode governance (planning/build/deploy).
    Context brackets. Memory governance. Registry governance.
  </constitution>

  <mode>planning</mode>

  <agent name="brief" mission="Extract user requirements in 5 structured phases">
    <inputs>WU artifact, user access</inputs>
    <outputs>Brief document with functional/non-functional requirements</outputs>
    <criteria>All 5 phases completed, requirements categorized, user confirmed</criteria>
  </agent>

  <pipeline>
    WU(100%) -> Brief(in_progress, 45%) -> Detail(pending) -> Architect(pending)
    -> UX(pending) -> Phases(pending) -> Tasks(pending) -> QA-Planning(pending)
  </pipeline>

  <task>Phase 2: Core Requirements Elicitation</task>

  <handoff from="greenfield-wu" score="95">
    Project: SaaS platform for team collaboration.
    Stack: Next.js + PostgreSQL + Vercel.
    Key constraint: Must support real-time features.
  </handoff>

  <memory bracket="MODERATE" level="metadata">
    [3 HOT memories available: auth-pattern, db-migration-gotcha, user-preference-dark-mode]
  </memory>
</chati-context>
```

---

## Bracket Detection

Context usage is estimated using prompt count and average token size:

```
contextPercent = (estimatedUsedTokens / maxContextTokens) * 100
bracket = calculateBracket(100 - contextPercent)
```

The orchestrator recalculates the bracket before each agent interaction and adjusts injection accordingly.

### Token-Based Bracket Estimation

Context remaining percentage is estimated from actual prompt content size rather than conversation turn count:

```
estimatedTokens = promptText.length / 4
remainingPercent = (1 - estimatedTokens / providerLimit) * 100
```

This replaces the legacy heuristic (`turnCount / maxTurns`) which was inaccurate for sessions with large tool results or long agent outputs. The token-based approach scales correctly across providers (Claude 200K, Gemini 1M, Codex 128K).

Fallback: If prompt text is unavailable, the turn-count heuristic is used.

---

## Autonomous Context Recovery

### Level 1: Smart Continuation (default, automatic)

When context is compacted by the IDE (PreCompact event), the orchestrator continues seamlessly:

1. Capture session digest (decisions, errors, patterns)
2. Persist all HOT+WARM memories to `.chati/memories/`
3. Store continuation state in `.chati/session.yaml`
4. After compaction: bracket resets to FRESH
5. Orchestrator loads HOT memories for current agent
6. Rebuilds `<chati-context>` with FRESH bracket
7. Agent resumes exactly where it left off

The user experiences zero interruption.

### Level 2: Autonomous Session Spawn (fallback)

If Smart Continuation is insufficient, the orchestrator spawns a new session:

1. Generate comprehensive continuation prompt with full pipeline state
2. Persist to `.chati/continuation/latest.md`
3. Spawn new session via IDE-specific mechanism

### Spawn Decision Criteria

| Condition | Threshold | Rationale |
|-----------|-----------|-----------|
| Multiple compactions | 3+ in single session | Context is churning too fast |
| Post-compact quality | Agent score drops >15% | Compaction lost critical context |
| Critical bracket persists | CRITICAL for 3+ consecutive interactions | Recovery not working |
| Agent handoff pending | Current agent done, next agent needs fresh context | Clean start is better |

### IDE-Specific Behavior

| IDE | Level 1 | Level 2 |
|-----|---------|---------|
| Claude Code | Automatic via PreCompact hook | Task tool subagent or CLI spawn |
| AntiGravity | Automatic via platform hooks | New agent session via platform API |
| Cursor / VS Code | Automatic via context detection | Continuation file for manual resume |
| Gemini CLI | Automatic via context detection | CLI spawn |

---

## Integration with Memory Layer

Memory injection follows the same progressive reinforcement principle: as context degrades, memory becomes MORE important.

| Bracket | Memory Level | Behavior |
|---------|-------------|----------|
| FRESH | none | Context is sufficient — no memory injection needed |
| MODERATE | metadata | Light reminder of relevant memories (~50 tokens) |
| DEPLETED | chunks | Context recovery via memory summaries (~200 tokens) |
| CRITICAL | full | Full memory dump for session handoff (~1000+ tokens) |

---

## Constitution Reference

**Article XII: Context Bracket Governance** — Brackets are calculated automatically. In CRITICAL, only L0+L1 are injected. Handoff is mandatory when context < 15%.

---

*Context Engine v4.0 — Chati.dev Intelligence Layer (Progressive Reinforcement Model)*

---

## Multi-CLI Context Strategy (v3.0.0)

When agents execute on different CLI providers, context injection adapts to the provider's capabilities:

### Hook-Based Providers (Claude Code, Gemini CLI)
- PRISM context injected via `UserPromptSubmit` hook
- Mode governance enforced via `PreToolUse` hook
- Constitution guard enforced via `PreToolUse` hook
- Full governance parity with Claude Code

### Prompt-Based Providers (Codex CLI)
- PRISM context embedded directly in the spawned prompt (via prompt-builder)
- Governance directives included as system instructions in the prompt
- Softer enforcement — relies on model compliance rather than hook interception
- Write scope restrictions communicated via prompt, not blocked at tool level

### Context File Mapping
| Provider | Context File | Generation |
|----------|-------------|------------|
| Claude Code | CLAUDE.md | Native (already exists) |
| Gemini CLI | GEMINI.md | Auto-generated from CLAUDE.md |
| Codex CLI | AGENTS.md | Auto-generated from CLAUDE.md |

### Cross-Provider Handoff
Handoff format is identical regardless of which provider executed the agent. The two-layer structure (Article VIII) ensures any provider can read any handoff. Session state in `.chati/session.yaml` is the single source of truth — all providers read from and write to the same session file.
