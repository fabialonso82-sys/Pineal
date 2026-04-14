#!/usr/bin/env node
/**
 * Session Digest Hook — PreCompact (runs before Claude compacts context)
 *
 * Saves a summary of the current session state so it can be
 * recovered after context compaction. Writes to .chati/memories/shared/session/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Extract structured 8-section digest from session state.
 * Enriched version captures decisions, blockers, gotchas for better recovery.
 */
function extractDigest(projectDir) {
  const sessionPath = join(projectDir, '.chati', 'session.yaml');
  if (!existsSync(sessionPath)) return null;

  const raw = readFileSync(sessionPath, 'utf-8');
  const extract = (key) => {
    const match = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
  };

  // Base digest (backward-compatible)
  const base = {
    timestamp: new Date().toISOString(),
    mode: extract('mode') || 'discover',
    currentAgent: extract('current_agent') || 'none',
    pipelinePosition: extract('pipeline_position') || 'unknown',
    workflow: extract('workflow') || 'unknown',
  };

  // Enrich with gotchas (lightweight read, capped at 10)
  let gotchas = [];
  try {
    const gotchasPath = join(projectDir, '.chati', 'memories', 'shared', 'gotchas.json');
    if (existsSync(gotchasPath)) {
      const gotchasData = JSON.parse(readFileSync(gotchasPath, 'utf-8'));
      const entries = Array.isArray(gotchasData) ? gotchasData : (gotchasData.gotchas || []);
      gotchas = entries.slice(0, 10).map(g => ({
        id: g.id,
        message: (g.message || '').slice(0, 200),
        severity: g.severity,
      }));
    }
  } catch { /* ignore read errors */ }

  return {
    ...base,
    version: '2.0',
    // Structured sections (enriched)
    active_task: extract('active_task') || null,
    blockers: [],      // Populated by agents at runtime
    decisions_made: [], // Populated by agents at runtime
    gotchas_found: gotchas,
    next_steps: [],    // Populated by agents at runtime
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const event = JSON.parse(input);
    const projectDir = event.cwd || process.cwd();
    const digest = extractDigest(projectDir);

    if (digest) {
      const digestDir = join(projectDir, '.chati', 'memories', 'shared', 'session');
      mkdirSync(digestDir, { recursive: true });

      const fileName = `digest-${Date.now()}.yaml`;
      // Serialize to YAML-like format supporting arrays and objects
      const lines = [];
      for (const [k, v] of Object.entries(digest)) {
        if (Array.isArray(v)) {
          if (v.length === 0) {
            lines.push(`${k}: []`);
          } else {
            lines.push(`${k}:`);
            for (const item of v) {
              lines.push(`  - ${typeof item === 'object' ? JSON.stringify(item) : item}`);
            }
          }
        } else if (v === null) {
          lines.push(`${k}: null`);
        } else {
          lines.push(`${k}: ${JSON.stringify(String(v))}`);
        }
      }

      writeFileSync(join(digestDir, fileName), lines.join('\n') + '\n', 'utf-8');

      // Auto daily digest: append session entry on every PreCompact
      try {
        const dailyDir = join(projectDir, '.chati', 'memories', 'shared', 'daily');
        mkdirSync(dailyDir, { recursive: true });
        const dateStr = new Date().toISOString().split('T')[0];
        const dailyPath = join(dailyDir, `${dateStr}.md`);
        const time = new Date().toISOString().split('T')[1].split('.')[0];
        const entry = `### ${time} -- ${digest.mode} (${digest.currentAgent})\n- Pipeline: ${digest.pipelinePosition}\n\n`;
        let existing = '';
        if (existsSync(dailyPath)) {
          existing = readFileSync(dailyPath, 'utf-8');
        } else {
          existing = `# Daily Digest -- ${dateStr}\n\n`;
        }
        writeFileSync(dailyPath, existing + entry, 'utf-8');
      } catch (err) {
        process.stderr.write(`[chati] session-digest daily-append: ${err.message}\n`);
      }

      // Auto memory consolidation: trigger when memories accumulate
      try {
        const memBase = join(projectDir, '.chati', 'memories');
        if (existsSync(memBase)) {
          let totalEntries = 0;
          const dirs = readdirSync(memBase, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name !== 'shared');
          for (const d of dirs) {
            const memFile = join(memBase, d.name, 'MEMORY.md');
            if (existsSync(memFile)) {
              const content = readFileSync(memFile, 'utf-8');
              totalEntries += (content.match(/^- /gm) || []).length;
            }
          }
          // Consolidate when > 100 entries (50% of 200 cap)
          if (totalEntries > 100) {
            process.stderr.write(`[chati] auto-dream: ${totalEntries} entries, triggering consolidation\n`);
            // Fire-and-forget: consolidation runs in background
            // Import would fail in hook context, so we spawn a child process
            const { execSync } = await import('child_process');
            try {
              execSync(`node -e "import('./packages/chati-dev/src/memory/dream.js').then(m => m.runDreamConsolidation('${projectDir.replace(/'/g, "\\'")}'))"`, {
                cwd: projectDir,
                timeout: 10000,
                stdio: 'ignore',
              });
            } catch { /* expected: consolidation may timeout or fail */ }
          }
        }
      } catch (err) {
        process.stderr.write(`[chati] session-digest auto-dream: ${err.message}\n`);
      }
    }

    // Session telemetry ping (moved from license-guard to reduce per-prompt overhead)
    // 5-minute throttle with phase/agent change detection
    try {
      const homedir = process.env.HOME || '';
      const pingsPath = join(homedir, '.chati-dev', 'pings.yaml');
      const licensePath = join(homedir, '.chati-dev', 'license.yaml');

      if (existsSync(licensePath)) {
        const licenseRaw = readFileSync(licensePath, 'utf-8');
        const keyMatch = licenseRaw.match(/key:\s*["']?([^"'\n]+)/);
        const licenseKey = keyMatch ? keyMatch[1].trim() : null;

        if (licenseKey && digest) {
          let shouldPing = false;
          const now = Date.now();
          const currentState = `${digest.mode}|${digest.currentAgent}`;

          if (existsSync(pingsPath)) {
            const pingsRaw = readFileSync(pingsPath, 'utf-8');
            const entryMatch = pingsRaw.match(new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*?'([^']+)'`));
            if (entryMatch) {
              const [ts, phase, agent] = entryMatch[1].split('|');
              const elapsed = now - parseInt(ts);
              const stateChanged = `${phase}|${agent}` !== currentState;
              shouldPing = elapsed > 300000 || stateChanged; // 5 min or state change
            } else {
              shouldPing = true;
            }
          } else {
            shouldPing = true;
          }

          if (shouldPing) {
            // Update ping timestamp
            mkdirSync(join(homedir, '.chati-dev'), { recursive: true });
            writeFileSync(pingsPath, `'${projectDir}': '${now}|${currentState}'\n`, 'utf-8');

            // Fire-and-forget telemetry (3s timeout, never blocks)
            try {
              const body = JSON.stringify({
                license_key: licenseKey,
                project_name: digest.currentAgent || 'unknown',
                events: [{ type: 'session_active', timestamp: new Date().toISOString(), properties: { pipeline_phase: digest.mode, current_agent: digest.currentAgent } }],
              });
              fetch('https://chati.dev/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(3000) }).catch(() => {});
            } catch { /* expected: network may be unavailable */ }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[chati] session-digest telemetry-ping: ${err.message}\n`);
    }

    process.stdout.write(JSON.stringify({ result: 'allow' }));
  } catch (err) {
    process.stderr.write(`[chati] session-digest: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ result: 'allow' }));
  }
}

// Only run main when executed directly (not imported by tests)
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
