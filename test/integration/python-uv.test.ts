import { runFixtureScenarios } from "./scenarios.ts";

runFixtureScenarios({
  fixtureName: "python-uv",
  lintStep: "lint",
  testStep: "test",
  sampleFile: "src/my_pkg/__init__.py",
});
