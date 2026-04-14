#!/usr/bin/env node
/**
 * Constitution Guard Hook — PreToolUse (Write/Edit/Bash)
 *
 * BLOCKS operations that violate Constitution Article IV:
 * - Writing files that contain secrets/credentials
 * - Destructive operations without explicit user confirmation
 *
 * Also enforces Article XV: Session lock awareness.
 */

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i,
  /(?:secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /(?:token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i,
  /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*[:=]/i,
  /(?:PRIVATE[_-]?KEY|-----BEGIN (?:RSA |EC )?PRIVATE KEY)/i,
  /(?:Bearer\s+)[A-Za-z0-9_\-./]{20,}/,
  // GitHub tokens
  /ghp_[A-Za-z0-9]{36,}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  // Slack tokens
  /xox[bpa]-[A-Za-z0-9\-]{10,}/,
  // Database connection strings
  /(?:postgresql|mongodb\+srv|mysql):\/\/[^\s]{10,}/i,
  // OpenSSH private key
  /BEGIN OPENSSH PRIVATE KEY/,
  // JWT token pattern
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
];

const DESTRUCTIVE_COMMANDS = [
  /rm\s+-rf\s+[/~]/,
  /git\s+reset\s+--hard/,
  /git\s+push\s+--force/,
  /drop\s+(?:table|database)/i,
  /truncate\s+table/i,
  /DELETE\s+FROM\s+\w+\s*(?:;|$)/i,
  /git\s+clean\s+-f/,
  /git\s+push\s+--force-with-lease/,
  /DROP\s+SCHEMA/i,
  /DROP\s+INDEX/i,
];

/**
 * Check if content contains potential secrets.
 */
function containsSecrets(content) {
  if (!content || typeof content !== 'string') return [];
  const found = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      found.push(pattern.source.slice(0, 40));
    }
  }
  return found;
}

/**
 * Check if a bash command is destructive.
 */
function isDestructiveCommand(command) {
  if (!command || typeof command !== 'string') return false;
  return DESTRUCTIVE_COMMANDS.some(pattern => pattern.test(command));
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name || '';
    const toolInput = event.tool_input || {};

    // Check Write/Edit operations for secrets
    if (toolName === 'Write' || toolName === 'Edit') {
      const content = toolInput.content || toolInput.new_string || '';
      const secrets = containsSecrets(content);

      if (secrets.length > 0) {
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: `[Article IV] Potential secret detected in file content. Pattern: ${secrets[0]}. Use environment variables instead.`,
        }));
        return;
      }
    }

    // Check Bash operations for destructive commands
    if (toolName === 'Bash') {
      const command = toolInput.command || '';
      if (isDestructiveCommand(command)) {
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: `[Article IV] Destructive command detected: "${command.slice(0, 60)}...". This requires explicit user confirmation.`,
        }));
        return;
      }

      // Run 23-point shell injection security checks
      const injectionFindings = runShellInjectionChecks(command);
      if (injectionFindings.length > 0) {
        const critical = injectionFindings.filter(f => f.severity === 'critical');
        if (critical.length > 0) {
          process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: `[Article IV] Shell injection risk detected (${critical.length} critical): ${critical.map(f => f.id).join(', ')}. Command: "${command.slice(0, 60)}..."`,
          }));
          return;
        }
        // High/medium findings: allow with warning (advisory)
        process.stdout.write(JSON.stringify({
          decision: 'allow',
          reason: `[Security Advisory] ${injectionFindings.length} shell security finding(s): ${injectionFindings.map(f => f.id).join(', ')}`,
        }));
        return;
      }
    }

    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } catch (err) {
    process.stderr.write(`[chati-hook-error] constitution-guard: ${err?.message || 'unknown'}\n`);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Hook error — fail-closed for safety' }));
  }
}

/**
 * 23-point shell injection security checks.
 * Inline implementation (hooks are standalone — no imports from src/).
 * Based on Claude Code's bashSecurity.ts patterns.
 */
// SYNC: These 23 check IDs MUST match packages/chati-dev/src/security/bash-security.js
// Hooks are standalone (no imports from src/), so duplication is necessary.
// If you update here, update bash-security.js too. Run: npm test to verify both.
const SHELL_INJECTION_CHECKS = [
  { id: 'INCOMPLETE_COMMANDS', pattern: /[|&;]\s*$/, severity: 'high' },
  { id: 'JQ_SYSTEM_FUNCTION', pattern: /jq\b.*\bsystem\s*\(/i, severity: 'critical' },
  { id: 'JQ_FILE_ARGUMENTS', pattern: /jq\b.*--from-file|jq\b.*-f\s+[^|&;]+/i, severity: 'high' },
  { id: 'OBFUSCATED_FLAGS', pattern: /\$[({].*[)}].*-/, severity: 'high' },
  { id: 'SHELL_METACHARACTERS', pattern: /[`]|(?:\$\((?!.*\becho\b))/, severity: 'critical' },
  { id: 'DANGEROUS_VARIABLES', pattern: /(?:^|\s)(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|PYTHONPATH|NODE_PATH|RUBYLIB|PERL5LIB)\s*=/, severity: 'critical' },
  { id: 'NEWLINES', pattern: /(?<!\\)\n.*(?:rm|curl|wget|chmod|chown|sudo|eval|exec)/, severity: 'high' },
  { id: 'BACKSLASH_ESCAPED_WHITESPACE', pattern: /\\\s+(?:-|\/)/,severity: 'medium' },
  // eslint-disable-next-line no-control-regex
  { id: 'CONTROL_CHARACTERS', pattern: /[\x00-\x08\x0e-\x1f\x7f]/, severity: 'critical' },
  { id: 'UNICODE_WHITESPACE', pattern: /[\u200B-\u200F\u2028-\u202F\uFEFF\u00A0\u2060\u180E]/, severity: 'critical' },
  { id: 'DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION', pattern: /\$\(.*(?:curl|wget|nc|bash|sh|python|perl|ruby|node)\b/i, severity: 'critical' },
  { id: 'DANGEROUS_PATTERNS_INPUT_REDIRECTION', pattern: /<\s*(?:\/etc\/(?:passwd|shadow|sudoers)|\/proc\/|~\/\.ssh\/|~\/\.aws\/)/, severity: 'critical' },
  { id: 'DANGEROUS_PATTERNS_OUTPUT_REDIRECTION', pattern: />\s*(?:\/etc\/|~\/\.ssh\/|~\/\.bashrc|~\/\.zshrc|~\/\.profile|~\/\.gitconfig)/, severity: 'critical' },
  { id: 'IFS_INJECTION', pattern: /\bIFS\s*=/, severity: 'critical' },
  { id: 'BRACE_EXPANSION', pattern: /\{.*(?:rm|curl|wget|chmod|eval|exec|sudo).*[,}]/, severity: 'high' },
  { id: 'GIT_COMMIT_SUBSTITUTION', pattern: /git\s+(?:commit|push|tag).*\$[({]/, severity: 'high' },
  { id: 'PROC_ENVIRON_ACCESS', pattern: /\/proc\/(?:self|\d+)\/(?:environ|cmdline|maps|mem)/, severity: 'critical' },
  { id: 'MALFORMED_TOKEN_INJECTION', pattern: /\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\[0-7]{3}/i, severity: 'high' },
  { id: 'MID_WORD_HASH', pattern: /\w#\w/, severity: 'medium' },
  { id: 'COMMENT_QUOTE_DESYNC', pattern: /#.*['"][^'"]*$/, severity: 'medium' },
  { id: 'QUOTED_NEWLINE', pattern: /["'][^"']*\n[^"']*["']/, severity: 'high' },
  { id: 'ZSH_DANGEROUS_COMMANDS', pattern: /\b(?:zmodload|sysopen|sysread|syswrite|zsystem|zselect|ztcp)\b/, severity: 'critical' },
  { id: 'BACKSLASH_ESCAPED_OPERATORS', pattern: /\\[|;&]/, severity: 'medium' },
];

function runShellInjectionChecks(command) {
  if (!command || typeof command !== 'string') return [];
  const findings = [];
  for (const check of SHELL_INJECTION_CHECKS) {
    check.pattern.lastIndex = 0;
    if (check.pattern.test(command)) {
      findings.push({ id: check.id, severity: check.severity });
    }
  }
  return findings;
}

export { containsSecrets, isDestructiveCommand, runShellInjectionChecks, SECRET_PATTERNS, DESTRUCTIVE_COMMANDS, SHELL_INJECTION_CHECKS };

// Only run main when executed directly (not imported by tests)
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
