import assert from "node:assert/strict";
import test from "node:test";
import * as app from "../bin/app";
import type { DeploymentRegionSources } from "../bin/app";

type RegionResolver = (sources: DeploymentRegionSources) => string;

const resolveDeploymentRegion = (
  app as typeof app & {
    resolveDeploymentRegion?: RegionResolver;
  }
).resolveDeploymentRegion;

for (const [name, sources, expected] of [
  [
    "explicit CDK context wins over both environment regions",
    {
      contextRegion: "context-region",
      awsRegion: "aws-region",
      cdkDefaultRegion: "cdk-region",
    },
    "context-region",
  ],
  [
    "AWS_REGION wins over a conflicting stale CDK_DEFAULT_REGION",
    {
      awsRegion: "aws-region",
      cdkDefaultRegion: "stale-cdk-region",
    },
    "aws-region",
  ],
  [
    "AWS_REGION is used when CDK_DEFAULT_REGION is absent",
    { awsRegion: "aws-region" },
    "aws-region",
  ],
  [
    "CDK_DEFAULT_REGION is used when AWS_REGION is absent",
    { cdkDefaultRegion: "cdk-region" },
    "cdk-region",
  ],
  [
    "the fixed default is used when no region source is present",
    {},
    "us-west-2",
  ],
  [
    "an empty AWS_REGION falls back to CDK_DEFAULT_REGION",
    { awsRegion: "", cdkDefaultRegion: "cdk-region" },
    "cdk-region",
  ],
  [
    "empty environment regions fall back to the fixed default",
    { awsRegion: "", cdkDefaultRegion: "" },
    "us-west-2",
  ],
] as const) {
  test(name, () => {
    assert.equal(
      typeof resolveDeploymentRegion,
      "function",
      "app must export a pure deployment-region resolver",
    );
    assert.equal(resolveDeploymentRegion(sources), expected);
  });
}

for (const [source, sources] of [
  ["CDK context region", { contextRegion: " us-west-2" }],
  ["AWS_REGION", { awsRegion: "us-west-2 " }],
  ["CDK_DEFAULT_REGION", { cdkDefaultRegion: "   " }],
] as const) {
  test(`${source} rejects surrounding or whitespace-only values`, () => {
    assert.equal(
      typeof resolveDeploymentRegion,
      "function",
      "app must export a pure deployment-region resolver",
    );
    assert.throws(
      () => resolveDeploymentRegion(sources),
      /must be a non-empty region without surrounding whitespace/,
    );
  });
}
