import { runFixtureScenarios } from "./scenarios.ts";

runFixtureScenarios({
  fixtureName: "bun-ts",
  lintStep: "lint",
  testStep: "test",
  sampleFile: "src/a.ts",
});
