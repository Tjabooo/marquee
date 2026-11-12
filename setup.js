#!/usr/bin/env node
// Lilin setup, diagnostics and service management. Run `node setup.js --help`.
import { main } from './src/setup/cli.js';

process.exitCode = await main();
