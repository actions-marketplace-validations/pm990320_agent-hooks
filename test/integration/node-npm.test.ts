import { runFixtureScenarios } from "./scenarios.ts";

runFixtureScenarios({
  fixtureName: "node-npm",
  lintStep: "lint",
  testStep: "test",
  sampleFile: "src/a.js",
});
