#!/usr/bin/env bun
import { run } from "./cli.ts";
import { installSignalHandlers } from "./runners/process-registry.ts";

installSignalHandlers();

const code = await run(process.argv.slice(2));
process.exit(code);
