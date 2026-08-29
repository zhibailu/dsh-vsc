/**
 * --import entry point for the runtime overlay.
 *
 * The launcher spawns the harness as:
 *   node --import <dist>/overlay-register.mjs <dsh>/lib/bin.js web ...
 * This module registers the loader (overlay-loader.mjs) BEFORE bin.js's own
 * imports run, so every dsh module load in the harness process goes through
 * the overlay hook. module.register() needs Node >= 20.6.
 */
import { register } from "node:module";

await register(new URL("./overlay-loader.mjs", import.meta.url));
