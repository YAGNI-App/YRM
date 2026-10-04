#!/usr/bin/env bun
import { runCli } from "./cli.ts";
import { isCompiled, provideCoreToRuntimeImports } from "./compiled.ts";

if (isCompiled()) provideCoreToRuntimeImports();

process.exitCode = await runCli(process.argv.slice(2));
