import { DockerSubscriptionLoginDriver } from './docker-login.js';
import type { DockerLoginOptions } from './docker-login.js';
import type { DockerInteraction } from '../docker/process.js';
import { CodexSubscriptionCodec } from './codex-subscription.js';
import { ClaudeSubscriptionCodec } from './claude-subscription.js';
import { CODEX_VERSION } from '../harness/codex.js';
import { CLAUDE_VERSION } from '../harness/claude.js';

export const CODEX_LOGIN_HOSTS: readonly string[] = Object.freeze(['auth.openai.com', 'chatgpt.com']);
export const CLAUDE_LOGIN_HOSTS: readonly string[] = Object.freeze(['claude.ai', 'claude.com', 'platform.claude.com', 'api.anthropic.com']);

export class CodexSubscriptionLoginDriver extends DockerSubscriptionLoginDriver {
  constructor(options: DockerLoginOptions, interaction: DockerInteraction) {
    super(options, interaction, { version: CODEX_VERSION, versionCommand: ['codex', '--version'],
      argv: ['codex', 'login', '-c', 'cli_auth_credentials_store="file"', '--device-auth'],
      hosts: CODEX_LOGIN_HOSTS, directory: 'codex', filename: 'auth.json', environment: { CODEX_HOME: '/task/state/codex' },
      validateCredential: content => new CodexSubscriptionCodec().validate(content),
      parseVersion: stdout => /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(stdout)?.[1] ?? null });
  }
}
export class ClaudeSubscriptionLoginDriver extends DockerSubscriptionLoginDriver {
  constructor(options: DockerLoginOptions, interaction: DockerInteraction) {
    super(options, interaction, { version: CLAUDE_VERSION, versionCommand: ['claude', '--version'],
      argv: ['/usr/bin/env', 'DISABLE_AUTOUPDATER=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'claude', 'auth', 'login', '--claudeai'],
      hosts: CLAUDE_LOGIN_HOSTS, directory: 'claude', filename: '.credentials.json', environment: { CLAUDE_CONFIG_DIR: '/task/state/claude' },
      validateCredential: content => new ClaudeSubscriptionCodec().validateLogin(content),
      parseVersion: stdout => /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)\s*$/.exec(stdout)?.[1] ?? null });
  }
}
