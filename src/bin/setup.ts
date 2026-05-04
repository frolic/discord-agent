#!/usr/bin/env bun
/**
 * Setup entry — runs the interactive first-run wizard, then exits.
 * Separate from `agent.ts` (the runtime) on purpose: setup creates an
 * agent home, runtime starts an existing one. No overlap.
 */
import { runSetupWizard } from "./setupWizard.ts";

await runSetupWizard();
