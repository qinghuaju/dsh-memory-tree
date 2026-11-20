#!/usr/bin/env node
/** Install/uninstall only Memory Tree's MCP and hook entries; preserve user config. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from '../src/engine/config.mjs';
import { parse as parseToml } from 'smol-toml';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BEGIN = '# BEGIN memory-tree managed MCP';
const END = '# END memory-tree managed MCP';
const STATUS = 'Memory Tree: ';

export function shellCommand(args, platform = process.platform) {
  if (platform === 'win32') {
    return args.map(arg => {
      if (/["%!\r\n\0]/.test(arg)) throw new Error('Unsupported shell character in Windows installation path');
      return `"${arg}"`;
    }).join(' ');
  }
  return args.map(arg => `'${arg.replace(/'/g, `'"'"'`)}'`).join(' ');
}

function stripManaged(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return text;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + BEGIN.length) >= 0) {
    throw new Error('Malformed Memory Tree config markers; refusing to edit config.toml');
  }
  return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
}

export function planCodexInstall({ directory, dataDir, uninstall = false, asyncHooks = false, node = process.execPath, root = ROOT }) {
  const configPath = join(directory, 'config.toml');
  const hooksPath = join(directory, 'hooks.json');
  const oldConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const oldHooks = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf8') : '';
  const baseConfig = stripManaged(oldConfig);
  let parsedConfig;
  try { parsedConfig = parseToml(baseConfig, { integersAsBigInt: 'asNeeded' }); }
  catch { throw new Error('Invalid existing config.toml; no changes made'); }
  if (!uninstall && parsedConfig.mcp_servers?.memory_tree !== undefined) {
    throw new Error('An unmanaged mcp_servers.memory_tree already exists; choose how to merge it before installing');
  }
  let hooks;
  try { hooks = oldHooks ? JSON.parse(oldHooks) : { hooks: {} }; }
  catch { throw new Error('Invalid existing hooks.json; no changes made'); }
  if (!hooks || Array.isArray(hooks) || typeof hooks !== 'object' ||
    (hooks.hooks !== undefined && (typeof hooks.hooks !== 'object' || !hooks.hooks || Array.isArray(hooks.hooks)))) {
    throw new Error('Invalid hooks.json structure');
  }
  hooks.hooks ??= {};
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group.hooks))) throw new Error(`Invalid hook groups: ${event}`);
    hooks.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(handler =>
      !(handler.statusMessage?.startsWith(STATUS) && /src[\\/]+codex[\\/]+hook\.mjs/.test(handler.command || '')),
    ) })).filter(group => group.hooks.length);
    if (!hooks.hooks[event].length) delete hooks.hooks[event];
  }
  const args = [join(root, 'src/mcp/server.mjs'), '--data-dir', dataDir];
  // Codex's stdio environment does not implicitly forward provider credentials.
  // Forward variable names only; never persist the values in config.toml.
  const memoryConfig = resolveConfig({ dataDir });
  const embedding = memoryConfig.embedding;
  const envVars = [...new Set([embedding.apiKeyEnv, ...embedding.apiKeyEnvFallbacks])]
    .filter(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  const block = `${BEGIN}\n[mcp_servers.memory_tree]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\nenv_vars = ${JSON.stringify(envVars)}\nstartup_timeout_sec = 15\ntool_timeout_sec = 600\n${END}\n`;
  const generated = {};
  if (!uninstall) {
    const command = shellCommand([node, join(root, 'src/codex/hook.mjs'), '--data-dir', dataDir]);
    for (const [event, async, timeout, label] of [
      ['UserPromptSubmit', false, Math.max(5, Math.ceil(memoryConfig.recall.timeoutMs / 1000) + 2), 'recall'],
      ['Stop', asyncHooks, 180, 'capture'],
      ['SessionStart', asyncHooks, 180, 'retry queued captures'],
    ]) {
      const group = { hooks: [{ type: 'command', command, async, timeout, statusMessage: STATUS + label }] };
      generated[event] = [group];
      hooks.hooks[event] ??= [];
      hooks.hooks[event].push(group);
    }
  }
  const nextConfig = uninstall ? baseConfig : baseConfig.replace(/\s*$/, '\n\n') + block;
  try { parseToml(nextConfig, { integersAsBigInt: 'asNeeded' }); }
  catch { throw new Error('Generated MCP configuration conflicts with existing config.toml; no changes made'); }
  const nextHooks = JSON.stringify(hooks, null, 2) + '\n';
  return {
    preview: uninstall ? 'Remove managed memory_tree MCP entry and Memory Tree hooks.' : block + '\n' + JSON.stringify({ hooks: generated }, null, 2),
    changes: [
      { path: configPath, before: oldConfig, after: nextConfig },
      { path: hooksPath, before: oldHooks, after: nextHooks },
    ].filter(change => change.before !== change.after),
  };
}

function main() {
  const flags = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--dry-run', '--uninstall', '--sync-hooks', '--async-hooks', '--help'].includes(key)) flags[key] = true;
    else if (['--codex-home', '--project', '--data-dir'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) flags[key] = resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  if (flags['--help']) {
    console.log('node scripts/install-codex.mjs [--project <root> | --codex-home <dir>] [--data-dir <dir>] [--async-hooks | --sync-hooks] [--dry-run] [--uninstall]');
    return;
  }
  if (flags['--project'] && flags['--codex-home']) throw new Error('Choose either --project or --codex-home');
  if (flags['--async-hooks'] && flags['--sync-hooks']) throw new Error('Choose either --async-hooks or --sync-hooks');
  const directory = flags['--project'] ? join(flags['--project'], '.codex')
    : flags['--codex-home'] || process.env.CODEX_HOME || join(homedir(), '.codex');
  const dataDir = flags['--data-dir'] || resolveConfig().dataDir;
  const plan = planCodexInstall({ directory, dataDir, uninstall: flags['--uninstall'], asyncHooks: flags['--async-hooks'] });
  if (flags['--dry-run']) {
    console.log(plan.preview);
    console.log(`\nWould update ${plan.changes.length} file(s) in ${directory}. No changes made.`);
    return;
  }
  mkdirSync(directory, { recursive: true });
  for (const change of plan.changes) {
    if (existsSync(change.path)) copyFileSync(change.path, `${change.path}.backup-${randomUUID()}`);
    writeFileSync(change.path, change.after, { mode: 0o600 });
  }
  console.log(`${flags['--uninstall'] ? 'Removed' : 'Installed'} Memory Tree entries in ${directory} (${plan.changes.length} file(s) changed).`);
  if (!flags['--uninstall']) {
    console.log(`Data directory: ${dataDir}\nKeep this checkout and Node executable in place. Restart Codex; review and trust the new hooks in /hooks before testing.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`install-codex: ${error.message}`); process.exitCode = 1; }
}
