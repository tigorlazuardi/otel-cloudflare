#!/usr/bin/env node
/**
 * Fix TypeDoc navigation.js to replace 'functions/' with 'fn/'
 * TypeDoc stores navigation data as base64-encoded zlib-compressed JSON
 */
import { readFileSync, writeFileSync } from 'fs';
import { inflateSync, deflateSync } from 'zlib';

const navPath = 'docs/assets/navigation.js';
const content = readFileSync(navPath, 'utf8');
const match = content.match(/navigationData = "([^"]+)"/);

if (!match) {
  console.error('Could not find navigationData in', navPath);
  process.exit(1);
}

const decoded = Buffer.from(match[1], 'base64');
const decompressed = inflateSync(decoded).toString();
const fixed = decompressed.replaceAll('functions/', 'fn/');
const recompressed = deflateSync(fixed);
const reencoded = recompressed.toString('base64');
const newContent = content.replace(match[1], reencoded);

writeFileSync(navPath, newContent);
console.log('Fixed navigation.js: replaced functions/ with fn/');
