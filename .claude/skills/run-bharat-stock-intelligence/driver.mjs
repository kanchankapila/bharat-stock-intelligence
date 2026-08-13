#!/usr/bin/env node
// Minimal chromium-cli-alike for this repo. No chromium-cli/tmux on this box (Windows,
// no apt), so this is the "adapt the REPL driver" fallback playwright.md points at --
// except a one-shot SCRIPT RUNNER instead of a REPL, since there's no tmux here to
// send-keys into. Same command vocabulary and heredoc-over-stdin UX as chromium-cli.
//
// Usage:
//   node driver.mjs <<'EOF'
//   nav http://localhost:3000
//   wait-for text=Dashboard
//   screenshot 01-landing
//   click button:has-text("Screener")
//   screenshot 02-screener
//   console-errors
//   EOF
//
// Commands (one per line, space-separated args; text args may contain spaces):
//   nav <url>                    goto a URL
//   wait-for text=<substr>       poll body innerText for a substring (10s timeout)
//   wait-for <css-selector>      waitForSelector (10s timeout)
//   screenshot [name]            PNG -> SHOT_DIR/<name-or-ts>.png
//   click <css-selector>         DOM click via evaluate (bypasses overlay hit-testing)
//   click-text <text>            click first button/a/[role=button] containing text
//   fill <css-selector> <text>   Playwright locator.fill (fires React onChange)
//   press <key>                  keyboard.press on the active element
//   eval <js-expr>                page.evaluate, prints JSON
//   text [css-selector]          print innerText (body if no selector)
//   console-errors               print console.error/pageerror seen since launch
//   sleep <ms>                   last resort; prefer wait-for
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const SHOT_DIR = process.env.SCREENSHOT_DIR || path.resolve(import.meta.dirname, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const consoleLog = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (msg) => { if (msg.type() === 'error') consoleLog.push('[console.error] ' + msg.text()); });
page.on('pageerror', (err) => consoleLog.push('[pageerror] ' + err.message));

async function run(cmd, argline) {
  switch (cmd) {
    case 'nav':
      await page.goto(argline, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log('nav ->', page.url());
      return;
    case 'wait-for': {
      if (argline.startsWith('text=')) {
        const needle = argline.slice(5);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const body = await page.evaluate(() => document.body.innerText);
          if (body.includes(needle)) { console.log('found text:', needle); return; }
          await page.waitForTimeout(200);
        }
        console.log('TIMEOUT waiting for text:', needle);
        return;
      }
      try { await page.waitForSelector(argline, { timeout: 10_000 }); console.log('found:', argline); }
      catch { console.log('TIMEOUT:', argline); }
      return;
    }
    case 'screenshot': {
      const f = path.join(SHOT_DIR, (argline || `ss-${Date.now()}`) + '.png');
      await page.screenshot({ path: f });
      console.log('screenshot:', f);
      return;
    }
    case 'click': {
      const r = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return 'NOT_FOUND';
        el.click(); return 'OK';
      }, argline);
      console.log('click', argline, '->', r);
      return;
    }
    case 'click-text': {
      const r = await page.evaluate((t) => {
        const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')];
        const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
        if (!el) return 'NOT_FOUND';
        el.click(); return 'OK: ' + el.tagName;
      }, argline);
      console.log('click-text', JSON.stringify(argline), '->', r);
      return;
    }
    case 'fill': {
      const sp = argline.indexOf(' ');
      const sel = sp === -1 ? argline : argline.slice(0, sp);
      const val = sp === -1 ? '' : argline.slice(sp + 1);
      await page.locator(sel).fill(val);
      console.log('fill', sel, '->', JSON.stringify(val));
      return;
    }
    case 'press':
      await page.keyboard.press(argline);
      console.log('press', argline);
      return;
    case 'eval':
      try { console.log(JSON.stringify(await page.evaluate(argline))); }
      catch (e) { console.log('ERROR:', e.message); }
      return;
    case 'text':
      console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', argline || null));
      return;
    case 'console-errors':
      console.log(consoleLog.length ? consoleLog.join('\n') : '(none)');
      return;
    case 'sleep':
      await page.waitForTimeout(Number(argline) || 0);
      return;
    default:
      console.log('unknown command:', cmd);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const sp = trimmed.indexOf(' ');
  const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const argline = sp === -1 ? '' : trimmed.slice(sp + 1);
  try { await run(cmd, argline); } catch (e) { console.log('ERROR running', cmd, '->', e.message); }
}
await browser.close();
