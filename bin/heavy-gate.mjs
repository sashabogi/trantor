#!/usr/bin/env node
import { runHeavyGate } from "../lib/heavy-gate.mjs";

process.exit(runHeavyGate(process.argv.slice(2)));
