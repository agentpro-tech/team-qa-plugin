// Playwright for the R1e browser tests, when it is installed. QA GUI itself drives Dragon (HR1); Playwright only stands
// in for Dragon in tests, behind the same reader and driver interfaces. Resolution: the `playwright` package from this
// checkout, else the module path in QA_GUI_PLAYWRIGHT_MODULE. Without either the browser tests are skipped.
import { createRequire } from 'node:module';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const path = process.env.QA_GUI_PLAYWRIGHT_MODULE;
  if (!path) return null;
  try { return createRequire(import.meta.url)(path); } catch { return null; }
}

export const PLAYWRIGHT_SKIP = 'Playwright is not installed: install `playwright` or set QA_GUI_PLAYWRIGHT_MODULE to its module path';
