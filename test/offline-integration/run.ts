import { runScenarios } from "./scenarios.js";

console.log(JSON.stringify(await runScenarios(), null, 2));
