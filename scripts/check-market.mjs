#!/usr/bin/env node
/**
 * Validate market/index.json against the format-1 rules that
 * @deepseek-ai/dsh-plugin-market-index enforces.
 *
 *   node scripts/check-market.mjs [path]
 *
 * Exits 0 when the file is absent (nothing to validate) unless --require is passed.
 * No external dependencies, so CI can run it before DSH packages are installed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const requireFile = args.includes('--require');
const file = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(ROOT, 'market', 'index.json'));

const failures = [];
const fail = (path, reason) => failures.push(`${path}: ${reason}`);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE = /^[<>=~^ ]*\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s*[<>=~^]\s*\d+(?:\.\d+){0,2})*$/;
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalized(value, path) {
  if (typeof value === 'string') return true;
  if (!isObject(value)) return fail(path, 'must be a string or a language map');
  if (typeof value.en !== 'string') return fail(path, 'must contain en');
  for (const [language, text] of Object.entries(value)) {
    if (typeof text !== 'string') fail(`${path}.${language}`, 'must be a string');
  }
  return true;
}

function isHttpUrl(value, path, { allowQuery = false } = {}) {
  if (typeof value !== 'string') return fail(path, 'must be a string URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail(path, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:');
  if (url.username || url.password) fail(path, 'must not contain credentials');
  if (!allowQuery && (url.href.includes('?') || url.href.includes('#'))) fail(path, 'must not contain a query or fragment');
  return true;
}

if (!existsSync(file)) {
  if (requireFile) fail(file, 'missing market index');
  else console.log(`market index skipped (not found): ${file}`);
} else {
  let index;
  try {
    index = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail('$', `invalid JSON: ${error.message}`);
  }

  if (index) {
    if (!isObject(index)) fail('$', 'must be an object');
    else {
      if (index.format !== 1) fail('$.format', 'must be 1');
      isLocalized(index.title, '$.title');
      if (index.description !== undefined) isLocalized(index.description, '$.description');
      if (!Array.isArray(index.plugins) || index.plugins.length === 0) fail('$.plugins', 'must be a non-empty array');

      const names = new Set();
      const base = new URL(`file:///${file.replace(/\\/g, '/')}`);
      (Array.isArray(index.plugins) ? index.plugins : []).forEach((plugin, position) => {
        const at = `$.plugins[${position}]`;
        if (!isObject(plugin)) return fail(at, 'must be an object');
        if (typeof plugin.name !== 'string' || !PACKAGE_NAME.test(plugin.name)) fail(`${at}.name`, 'must be a valid npm package name');
        else if (names.has(plugin.name)) fail(`${at}.name`, `duplicates ${plugin.name}`);
        else names.add(plugin.name);
        if (plugin.title !== undefined) isLocalized(plugin.title, `${at}.title`);
        if (plugin.description !== undefined) isLocalized(plugin.description, `${at}.description`);
        if (plugin.homepage !== undefined) isHttpUrl(plugin.homepage, `${at}.homepage`, { allowQuery: true });
        if (plugin.repository !== undefined) {
          isHttpUrl(plugin.repository.url, `${at}.repository.url`);
          if (plugin.repository.directory !== undefined && !String(plugin.repository.directory).split('/').every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
            fail(`${at}.repository.directory`, 'must be a relative directory without . or ..');
          }
        }
        if (plugin.icon !== undefined) {
          if (typeof plugin.icon !== 'string') fail(`${at}.icon`, 'must be a string');
          else if (/^data:image\/(?:svg\+xml|png|jpeg|webp);base64,/i.test(plugin.icon)) {
            // inline icon: size is enforced by DSH; nothing else to check here
          } else if (/^[a-z]+:/i.test(plugin.icon)) {
            isHttpUrl(plugin.icon, `${at}.icon`);
          } else if (plugin.icon.split('/').some((segment) => segment === '.' || segment === '..')) {
            fail(`${at}.icon`, 'relative icon must not contain . or .. segments');
          }
        }
        if (plugin.metadata !== undefined && !isObject(plugin.metadata)) fail(`${at}.metadata`, 'must be an object');

        if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) return fail(`${at}.versions`, 'must be a non-empty array');
        const seen = new Set();
        plugin.versions.forEach((version, index2) => {
          const vAt = `${at}.versions[${index2}]`;
          if (!isObject(version)) return fail(vAt, 'must be an object');
          if (typeof version.version !== 'string' || !SEMVER.test(version.version)) fail(`${vAt}.version`, 'must be an exact SemVer version');
          else if (seen.has(version.version)) fail(`${vAt}.version`, `duplicates ${version.version}`);
          else seen.add(version.version);
          if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0 || version.publishTimestamp >= 1e11) {
            fail(`${vAt}.publishTimestamp`, 'must be an integer Unix-seconds value in [0, 10^11)');
          }
          if (!isObject(version.source)) return fail(`${vAt}.source`, 'must be an object');
          if (version.source.type === 'npm') {
            if (version.source.registry !== undefined) isHttpUrl(version.source.registry, `${vAt}.source.registry`);
          } else if (version.source.type === 'git') {
            isHttpUrl(version.source.url, `${vAt}.source.url`);
            if (typeof version.source.url === 'string' && !/^(?:\/[^/]+){2,}$/.test(new URL(version.source.url).pathname)) fail(`${vAt}.source.url`, 'must name a repository with at least two path segments');
            if (typeof version.source.commit !== 'string' || !COMMIT.test(version.source.commit)) fail(`${vAt}.source.commit`, 'must be a lowercase 40-hex commit SHA');
            if (version.source.path !== undefined && !String(version.source.path).split('/').every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
              fail(`${vAt}.source.path`, 'must be a relative directory without . or ..');
            }
          } else {
            fail(`${vAt}.source.type`, 'must be "npm" or "git"');
          }
          if (version.engines !== undefined) {
            if (!isObject(version.engines)) fail(`${vAt}.engines`, 'must be an object');
            else if (version.engines.dsh !== undefined && (typeof version.engines.dsh !== 'string' || !RANGE.test(version.engines.dsh))) {
              fail(`${vAt}.engines.dsh`, 'must be a SemVer range');
            }
          }
        });
      });
    }
  }
}

if (failures.length > 0) {
  console.error(`market index invalid (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
if (existsSync(file)) console.log(`market index OK: ${file}`);
