import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import * as provider from "./index.mjs";

const {
  reconcileCloudFrontAlarm,
  reconcileManagedPolicyTags,
  reconcileRuntimeBoundaryTags,
  requestCloudFrontInvalidation,
} = provider;

const BOUNDARY_ARN =
  "arn:aws:iam::111122223333:"
  + "policy/AgenticPlatform-Web-RuntimePermissionsBoundary";
const BOUNDARY_REQUIRED_TAGS = [
  { Key: "auto-delete", Value: "no" },
  { Key: "managedBy", Value: "cdk" },
  { Key: "project", Value: "agentic-ai-platform-demo" },
];
const BOOTSTRAP_POLICY_NAME =
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement";
const BOOTSTRAP_POLICY_ARN =
  `arn:aws:iam::111122223333:policy/${BOOTSTRAP_POLICY_NAME}`;
const ALARM_NAME =
  "PlatformWeb-AgenticPlatform-Web-EDFDVBD6EXAMPLE-CloudFront-5xx";
const ALARM_ARN =
  `arn:aws:cloudwatch:us-east-1:111122223333:alarm:${ALARM_NAME}`;
const OLD_ALARM_NAME =
  "PlatformWeb-AgenticPlatform-Web-EOLDDISTEXAMPLE-CloudFront-5xx";
const OLD_ALARM_ARN =
  `arn:aws:cloudwatch:us-east-1:111122223333:alarm:${OLD_ALARM_NAME}`;
const OWNERSHIP_TAGS = [
  { Key: "managedBy", Value: "cdk" },
  { Key: "project", Value: "agentic-ai-platform-demo" },
];
const REQUIRED_TAGS = [
  { Key: "auto-delete", Value: "no" },
  ...OWNERSHIP_TAGS,
];
const REQUEST_MARKER_KEY = "cloudFormationRequestId";

function boundaryTagEvent(requestType, eventOverrides = {}) {
  const event = {
    RequestType: requestType,
    RequestId: `request-${requestType.toLowerCase()}`,
    ResourceProperties: {
      AccountId: "111122223333",
      Partition: "aws",
      PolicyArn: BOUNDARY_ARN,
      RequiredTags: BOUNDARY_REQUIRED_TAGS,
    },
  };
  if (requestType !== "Create") {
    event.PhysicalResourceId = BOUNDARY_ARN;
  }
  if (requestType === "Update") {
    event.OldResourceProperties = { ...event.ResourceProperties };
  }
  return { ...event, ...eventOverrides };
}

test("generic managed-policy reconciliation accepts the exact configured policy only", async () => {
  const calls = [];
  const iam = {
    async listPolicyTags(parameters) {
      calls.push(["listPolicyTags", parameters]);
      return { IsTruncated: false, Tags: [] };
    },
    async tagPolicy(parameters) {
      calls.push(["tagPolicy", parameters]);
    },
    async untagPolicy(parameters) {
      calls.push(["untagPolicy", parameters]);
    },
  };
  const event = {
    RequestType: "Create",
    ResourceProperties: {
      AccountId: "111122223333",
      Partition: "aws",
      PolicyArn: BOOTSTRAP_POLICY_ARN,
      RequiredTags: BOUNDARY_REQUIRED_TAGS,
    },
  };

  const result = await reconcileManagedPolicyTags(
    event,
    iam,
    BOOTSTRAP_POLICY_NAME,
  );

  assert.deepEqual(result, { PhysicalResourceId: BOOTSTRAP_POLICY_ARN });
  assert.deepEqual(calls, [
    ["listPolicyTags", { PolicyArn: BOOTSTRAP_POLICY_ARN }],
    ["tagPolicy", {
      PolicyArn: BOOTSTRAP_POLICY_ARN,
      Tags: BOUNDARY_REQUIRED_TAGS,
    }],
  ]);
  await assert.rejects(
    reconcileManagedPolicyTags(
      {
        ...event,
        ResourceProperties: {
          ...event.ResourceProperties,
          PolicyArn:
            "arn:aws:iam::111122223333:policy/UnrelatedPolicy",
        },
      },
      iam,
      BOOTSTRAP_POLICY_NAME,
    ),
    /exact root policy/,
  );
});

test("runtime boundary tags reconcile exact required values on the root policy ARN", async () => {
  const calls = [];
  const iam = {
    async listPolicyTags(parameters) {
      calls.push(["listPolicyTags", parameters]);
      return {
        IsTruncated: false,
        Tags: [
          { Key: "auto-delete", Value: "yes" },
          { Key: "project", Value: "agentic-ai-platform-demo" },
          { Key: "stale", Value: "" },
        ],
      };
    },
    async tagPolicy(parameters) {
      calls.push(["tagPolicy", parameters]);
    },
    async untagPolicy(parameters) {
      calls.push(["untagPolicy", parameters]);
    },
  };

  const result = await reconcileRuntimeBoundaryTags(
    boundaryTagEvent("Create"),
    iam,
  );

  assert.deepEqual(result, { PhysicalResourceId: BOUNDARY_ARN });
  assert.deepEqual(calls, [
    ["listPolicyTags", { PolicyArn: BOUNDARY_ARN }],
    ["untagPolicy", {
      PolicyArn: BOUNDARY_ARN,
      TagKeys: ["stale"],
    }],
    ["tagPolicy", {
      PolicyArn: BOUNDARY_ARN,
      Tags: [
        { Key: "auto-delete", Value: "no" },
        { Key: "managedBy", Value: "cdk" },
      ],
    }],
  ]);
});

test("runtime boundary tag Delete preserves retained policy tags without IAM calls", async () => {
  const iam = {
    async listPolicyTags() {
      assert.fail("Delete must not read retained policy tags");
    },
    async tagPolicy() {
      assert.fail("Delete must not tag the retained policy");
    },
    async untagPolicy() {
      assert.fail("Delete must not untag the retained policy");
    },
  };

  const result = await reconcileRuntimeBoundaryTags(
    boundaryTagEvent("Delete"),
    iam,
  );

  assert.deepEqual(result, { PhysicalResourceId: BOUNDARY_ARN });
});

test("runtime boundary tag Update is bound to the same physical policy and old properties", async () => {
  const invalidEvents = [
    [
      boundaryTagEvent("Update", { PhysicalResourceId: undefined }),
      /Physical resource ID/,
    ],
    [
      boundaryTagEvent("Update", {
        PhysicalResourceId:
          "arn:aws:iam::111122223333:policy/AnotherPolicy",
      }),
      /Physical resource ID.*exact runtime boundary policy ARN/i,
    ],
    [
      boundaryTagEvent("Update", { OldResourceProperties: undefined }),
      /Old resource properties/,
    ],
    [
      boundaryTagEvent("Update", {
        OldResourceProperties: {
          AccountId: "111122223333",
          Partition: "aws",
          PolicyArn:
            "arn:aws:iam::111122223333:policy/AnotherPolicy",
          RequiredTags: BOUNDARY_REQUIRED_TAGS,
        },
      }),
      /Old resource properties.*exact root policy/i,
    ],
  ];

  for (const [event, expectedError] of invalidEvents) {
    const iam = {
      async listPolicyTags() {
        assert.fail("invalid Update must fail before IAM lookup");
      },
    };
    await assert.rejects(
      reconcileRuntimeBoundaryTags(event, iam),
      expectedError,
    );
  }
});

test("runtime boundary tag Update is idempotent when exact tags already exist", async () => {
  const calls = [];
  const iam = {
    async listPolicyTags(parameters) {
      calls.push(["listPolicyTags", parameters]);
      return {
        IsTruncated: false,
        Tags: BOUNDARY_REQUIRED_TAGS,
      };
    },
    async tagPolicy() {
      assert.fail("exact tags must not be written again");
    },
    async untagPolicy() {
      assert.fail("exact tags must not be removed");
    },
  };

  const result = await reconcileRuntimeBoundaryTags(
    boundaryTagEvent("Update"),
    iam,
  );

  assert.deepEqual(result, { PhysicalResourceId: BOUNDARY_ARN });
  assert.deepEqual(calls, [
    ["listPolicyTags", { PolicyArn: BOUNDARY_ARN }],
  ]);
});

test("runtime boundary tag lookup rejects pagination before mutation", async () => {
  const iam = {
    async listPolicyTags() {
      return {
        IsTruncated: true,
        Marker: "next-page",
        Tags: BOUNDARY_REQUIRED_TAGS,
      };
    },
    async tagPolicy() {
      assert.fail("paginated lookup must fail before tag mutation");
    },
    async untagPolicy() {
      assert.fail("paginated lookup must fail before untag mutation");
    },
  };

  await assert.rejects(
    reconcileRuntimeBoundaryTags(boundaryTagEvent("Create"), iam),
    /pagination/i,
  );
});

test("runtime boundary Create failure sends FAILED with the exact policy identity", async () => {
  const event = boundaryTagEvent("Create");
  const responseCalls = [];
  let lookupCalls = 0;
  const iam = {
    async listPolicyTags() {
      lookupCalls += 1;
      throw new Error("sensitive-exception-marker");
    },
  };

  const result = await provider.handleRuntimeBoundaryTags(
    event,
    { logStreamName: "provider-log-stream" },
    iam,
    {
      logTerminalError: () => {
        assert.fail("delivered FAILED response must not log a terminal error");
      },
      sendResponse: async (...args) => {
        responseCalls.push(args);
      },
    },
  );

  assert.deepEqual(result, { PhysicalResourceId: BOUNDARY_ARN });
  assert.equal(lookupCalls, 1);
  assert.equal(responseCalls.length, 1);
  assert.equal(responseCalls[0][2], "FAILED");
  assert.deepEqual(responseCalls[0][3], {
    PhysicalResourceId: BOUNDARY_ARN,
  });
  assert.equal(responseCalls[0][4], "Custom resource operation failed.");
  assert.doesNotMatch(
    JSON.stringify(responseCalls),
    /sensitive-exception-marker/,
  );
});

function requestMarker(requestId) {
  return { Key: REQUEST_MARKER_KEY, Value: requestId };
}

function atomicAlarmTags(requestId) {
  return [...REQUIRED_TAGS, requestMarker(requestId)];
}

function alarmProperties(overrides = {}) {
  return {
    AlarmName: ALARM_NAME,
    AlarmArn: ALARM_ARN,
    DistributionId: "EDFDVBD6EXAMPLE",
    OwnershipTags: OWNERSHIP_TAGS,
    RequiredTags: REQUIRED_TAGS,
    ...overrides,
  };
}

function alarmEvent(
  requestType,
  propertyOverrides = {},
  eventOverrides = {},
) {
  const properties = alarmProperties(propertyOverrides);
  const event = {
    RequestType: requestType,
    RequestId: `request-${requestType.toLowerCase()}`,
    ResourceProperties: properties,
  };
  if (requestType === "Update") {
    event.PhysicalResourceId = properties.AlarmName;
    event.OldResourceProperties = { ...properties };
  } else if (requestType === "Delete") {
    event.PhysicalResourceId = properties.AlarmName;
  }
  return { ...event, ...eventOverrides };
}

function replacementAlarmEvent(eventOverrides = {}) {
  return alarmEvent("Update", {}, {
    PhysicalResourceId: OLD_ALARM_NAME,
    OldResourceProperties: alarmProperties({
      AlarmName: OLD_ALARM_NAME,
      AlarmArn: OLD_ALARM_ARN,
      DistributionId: "EOLDDISTEXAMPLE",
    }),
    ...eventOverrides,
  });
}

function alarmParameters(
  alarmName = ALARM_NAME,
  distributionId = "EDFDVBD6EXAMPLE",
  tags,
) {
  const parameters = {
    AlarmName: alarmName,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    Dimensions: [
      { Name: "DistributionId", Value: distributionId },
      { Name: "Region", Value: "Global" },
    ],
    EvaluationPeriods: 2,
    MetricName: "5xxErrorRate",
    Namespace: "AWS/CloudFront",
    Period: 300,
    Statistic: "Average",
    Threshold: 5,
    TreatMissingData: "notBreaching",
  };
  if (tags !== undefined) {
    parameters.Tags = tags;
  }
  return parameters;
}

function resourceNotFound() {
  return Object.assign(new Error("alarm not found"), {
    name: "ResourceNotFoundException",
  });
}

test("Create proves absence before atomically creating the tagged alarm", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      throw resourceNotFound();
    },
    async putMetricAlarm(parameters) {
      calls.push(["putMetricAlarm", parameters]);
    },
    async tagResource() {
      assert.fail("tagResource must not run after an atomic create");
    },
    async untagResource() {
      assert.fail("untagResource must not run for an absent alarm");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run on create");
    },
  };

  const result = await reconcileCloudFrontAlarm(
    alarmEvent("Create"),
    cloudWatch,
  );

  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ["putMetricAlarm", alarmParameters(
      ALARM_NAME,
      "EDFDVBD6EXAMPLE",
      atomicAlarmTags("request-create"),
    )],
  ]);
});

test("Create put failure performs no follow-up tag mutation", async () => {
  const calls = [];
  const putFailure = new Error("simulated put failure");
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      throw resourceNotFound();
    },
    async putMetricAlarm(parameters) {
      calls.push(["putMetricAlarm", parameters]);
      throw putFailure;
    },
    async tagResource() {
      assert.fail("tagResource must not run after putMetricAlarm failure");
    },
    async untagResource() {
      assert.fail("untagResource must not run after putMetricAlarm failure");
    },
  };

  await assert.rejects(
    reconcileCloudFrontAlarm(alarmEvent("Create"), cloudWatch),
    (error) => error === putFailure,
  );
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ["putMetricAlarm", alarmParameters(
      ALARM_NAME,
      "EDFDVBD6EXAMPLE",
      atomicAlarmTags("request-create"),
    )],
  ]);
});

test("duplicate Create succeeds without mutation for the same owned request marker", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: atomicAlarmTags("request-create"),
      };
    },
    async putMetricAlarm() {
      assert.fail("putMetricAlarm must not run for a duplicate create");
    },
    async tagResource() {
      assert.fail("tagResource must not run for a duplicate create");
    },
    async untagResource() {
      assert.fail("untagResource must not run for a duplicate create");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run on create");
    },
  };

  const result = await reconcileCloudFrontAlarm(
    alarmEvent("Create"),
    cloudWatch,
  );
  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
  ]);
});

for (const [description, tags] of [
  ["missing request marker", REQUIRED_TAGS],
  [
    "different request marker",
    [...REQUIRED_TAGS, requestMarker("another-request")],
  ],
]) {
  test(`Create rejects an owned collision with ${description}`, async () => {
    const calls = [];
    const cloudWatch = {
      async listTagsForResource(parameters) {
        calls.push(["listTagsForResource", parameters]);
        return { Tags: tags };
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run for a create collision");
      },
      async tagResource() {
        assert.fail("tagResource must not run for a create collision");
      },
      async untagResource() {
        assert.fail("untagResource must not run for a create collision");
      },
      async deleteAlarms() {
        assert.fail("deleteAlarms must not run on create");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(alarmEvent("Create"), cloudWatch),
      /already exists|collision|request marker/i,
    );
    assert.deepEqual(calls, [
      ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ]);
  });
}

test("Create rejects matching request marker when normal ownership does not match", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: [
          { Key: "managedBy", Value: "manual" },
          { Key: "project", Value: "agentic-ai-platform-demo" },
          requestMarker("request-create"),
        ],
      };
    },
    async putMetricAlarm() {
      assert.fail("putMetricAlarm must not run for an unowned collision");
    },
    async tagResource() {
      assert.fail("tagResource must not run for an unowned collision");
    },
    async untagResource() {
      assert.fail("untagResource must not run for an unowned collision");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run on create");
    },
  };

  await assert.rejects(
    reconcileCloudFrontAlarm(alarmEvent("Create"), cloudWatch),
    /ownership/i,
  );
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
  ]);
});

for (const [description, requestId] of [
  ["empty", ""],
  ["overlong", "r".repeat(257)],
  ["tag-unsafe", "request\nunsafe"],
]) {
  test(`Create rejects ${description} RequestId before lookup`, async () => {
    const cloudWatch = {
      async listTagsForResource() {
        assert.fail("lookup must not run before RequestId validation");
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run for invalid RequestId");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(
        alarmEvent("Create", {}, { RequestId: requestId }),
        cloudWatch,
      ),
      /request id/i,
    );
  });
}

test("same-name Update proves exact ownership before alarm and tag mutation", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: [
          ...OWNERSHIP_TAGS,
          { Key: "auto-delete", Value: "yes" },
          requestMarker("request-update"),
          { Key: "drifted-tag", Value: "remove-me" },
        ],
      };
    },
    async putMetricAlarm(parameters) {
      calls.push(["putMetricAlarm", parameters]);
    },
    async untagResource(parameters) {
      calls.push(["untagResource", parameters]);
    },
    async tagResource(parameters) {
      calls.push(["tagResource", parameters]);
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run on update");
    },
  };

  const result = await reconcileCloudFrontAlarm(
    alarmEvent("Update"),
    cloudWatch,
  );

  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ["putMetricAlarm", alarmParameters()],
    [
      "untagResource",
      {
        ResourceARN: ALARM_ARN,
        TagKeys: [REQUEST_MARKER_KEY, "drifted-tag"],
      },
    ],
    [
      "tagResource",
      {
        ResourceARN: ALARM_ARN,
        Tags: REQUIRED_TAGS,
      },
    ],
  ]);
});

test("replacement Update atomically creates only an absent tagged alarm", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      throw resourceNotFound();
    },
    async putMetricAlarm(parameters) {
      calls.push(["putMetricAlarm", parameters]);
    },
    async tagResource() {
      assert.fail("tagResource must not run after an atomic replacement");
    },
    async untagResource() {
      assert.fail("untagResource must not run for an absent replacement");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run during replacement update");
    },
  };

  const result = await reconcileCloudFrontAlarm(
    replacementAlarmEvent(),
    cloudWatch,
  );

  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ["putMetricAlarm", alarmParameters(
      ALARM_NAME,
      "EDFDVBD6EXAMPLE",
      atomicAlarmTags("request-update"),
    )],
  ]);
});

test("duplicate replacement Update succeeds without mutation for the same owned request marker", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return { Tags: atomicAlarmTags("request-update") };
    },
    async putMetricAlarm() {
      assert.fail("putMetricAlarm must not run for a duplicate replacement");
    },
    async untagResource() {
      assert.fail("untagResource must not run for a duplicate replacement");
    },
    async tagResource() {
      assert.fail("tagResource must not run for a duplicate replacement");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run during replacement update");
    },
  };

  const result = await reconcileCloudFrontAlarm(
    replacementAlarmEvent(),
    cloudWatch,
  );
  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
  ]);
});

for (const [description, tags] of [
  ["missing request marker", REQUIRED_TAGS],
  [
    "different request marker",
    [...REQUIRED_TAGS, requestMarker("another-request")],
  ],
  [
    "malformed request marker",
    [...REQUIRED_TAGS, requestMarker("")],
  ],
  [
    "duplicate request marker",
    [
      ...REQUIRED_TAGS,
      requestMarker("request-update"),
      requestMarker("request-update"),
    ],
  ],
]) {
  test(`replacement Update rejects a collision with ${description}`, async () => {
    const calls = [];
    const cloudWatch = {
      async listTagsForResource(parameters) {
        calls.push(["listTagsForResource", parameters]);
        return { Tags: tags };
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run for a replacement collision");
      },
      async untagResource() {
        assert.fail("untagResource must not run for a replacement collision");
      },
      async tagResource() {
        assert.fail("tagResource must not run for a replacement collision");
      },
      async deleteAlarms() {
        assert.fail("deleteAlarms must not run during replacement update");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(replacementAlarmEvent(), cloudWatch),
      /already exists|collision|request marker|duplicate tag/i,
    );
    assert.deepEqual(calls, [
      ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ]);
  });
}

test("Update refuses an unowned alarm before any mutation", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: [
          { Key: "managedBy", Value: "manual" },
          { Key: "project", Value: "agentic-ai-platform-demo" },
        ],
      };
    },
    async putMetricAlarm() {
      assert.fail("putMetricAlarm must not run for an unowned alarm");
    },
    async untagResource() {
      assert.fail("untagResource must not run for an unowned alarm");
    },
    async tagResource() {
      assert.fail("tagResource must not run for an unowned alarm");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run on update");
    },
  };

  await assert.rejects(
    reconcileCloudFrontAlarm(alarmEvent("Update"), cloudWatch),
    /ownership/i,
  );
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
  ]);
});

test("old-resource Delete proves ownership before deleting only the old alarm", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: [...REQUIRED_TAGS, requestMarker("request-update")],
      };
    },
    async putMetricAlarm() {
      assert.fail("putMetricAlarm must not run on delete");
    },
    async untagResource() {
      assert.fail("untagResource must not run on delete");
    },
    async tagResource() {
      assert.fail("tagResource must not run on delete");
    },
    async deleteAlarms(parameters) {
      calls.push(["deleteAlarms", parameters]);
    },
  };

  const result = await reconcileCloudFrontAlarm(
    alarmEvent(
      "Delete",
      {
        AlarmName: OLD_ALARM_NAME,
        AlarmArn: OLD_ALARM_ARN,
        DistributionId: "EOLDDISTEXAMPLE",
      },
      { PhysicalResourceId: OLD_ALARM_NAME },
    ),
    cloudWatch,
  );

  assert.deepEqual(result, { PhysicalResourceId: OLD_ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: OLD_ALARM_ARN }],
    ["deleteAlarms", { AlarmNames: [OLD_ALARM_NAME] }],
  ]);
});

test("Delete refuses an unowned alarm before mutation", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: [
          { Key: "managedBy", Value: "manual" },
          { Key: "project", Value: "agentic-ai-platform-demo" },
        ],
      };
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run for an unowned alarm");
    },
  };

  await assert.rejects(
    reconcileCloudFrontAlarm(alarmEvent("Delete"), cloudWatch),
    /ownership/i,
  );
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
  ]);
});

test("Delete is a no-op only for the exact resource-not-found classification", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      throw resourceNotFound();
    },
    async putMetricAlarm() {
      assert.fail("putMetricAlarm must not run on delete");
    },
    async untagResource() {
      assert.fail("untagResource must not run on delete");
    },
    async tagResource() {
      assert.fail("tagResource must not run on delete");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run for an absent alarm");
    },
  };

  const result = await reconcileCloudFrontAlarm(
    alarmEvent("Delete"),
    cloudWatch,
  );

  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
  ]);
});

for (const [description, event] of [
  [
    "Create with an unexpected physical ID",
    alarmEvent("Create", {}, { PhysicalResourceId: ALARM_NAME }),
  ],
  [
    "same-name Update with a missing physical ID",
    alarmEvent("Update", {}, { PhysicalResourceId: undefined }),
  ],
  [
    "Update with a physical ID matching neither old nor new name",
    replacementAlarmEvent({ PhysicalResourceId: "unexpected-alarm" }),
  ],
  [
    "Delete with a mismatched physical ID",
    alarmEvent("Delete", {}, { PhysicalResourceId: OLD_ALARM_NAME }),
  ],
]) {
  test(`${description} fails before lookup or mutation`, async () => {
    const cloudWatch = {
      async listTagsForResource() {
        assert.fail("lookup must not run before physical-ID validation");
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run");
      },
      async untagResource() {
        assert.fail("untagResource must not run");
      },
      async tagResource() {
        assert.fail("tagResource must not run");
      },
      async deleteAlarms() {
        assert.fail("deleteAlarms must not run");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(event, cloudWatch),
      /physical resource id/i,
    );
  });
}

for (const [description, event] of [
  [
    "missing OldResourceProperties",
    alarmEvent("Update", {}, { OldResourceProperties: undefined }),
  ],
  [
    "same-name Update with a different old alarm name",
    alarmEvent("Update", {}, {
      OldResourceProperties: alarmProperties({
        AlarmName: OLD_ALARM_NAME,
        AlarmArn: OLD_ALARM_ARN,
      }),
    }),
  ],
  [
    "replacement Update with an old ARN for another alarm",
    replacementAlarmEvent({
      OldResourceProperties: alarmProperties({
        AlarmName: OLD_ALARM_NAME,
        AlarmArn: ALARM_ARN,
        DistributionId: "EOLDDISTEXAMPLE",
      }),
    }),
  ],
]) {
  test(`${description} fails before lookup or mutation`, async () => {
    const cloudWatch = {
      async listTagsForResource() {
        assert.fail("lookup must not run before old-property validation");
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run");
      },
      async untagResource() {
        assert.fail("untagResource must not run");
      },
      async tagResource() {
        assert.fail("tagResource must not run");
      },
      async deleteAlarms() {
        assert.fail("deleteAlarms must not run");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(event, cloudWatch),
      /old resource properties|alarm arn|physical resource id/i,
    );
  });
}

for (const error of [
  Object.assign(new Error("ResourceNotFoundException"), {
    name: "AccessDeniedException",
  }),
  Object.assign(new Error("alarm not found"), {
    name: "ResourceNotFound",
  }),
]) {
  test(`alarm lookup fails closed for ${error.name}`, async () => {
    const cloudWatch = {
      async listTagsForResource() {
        throw error;
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run after lookup failure");
      },
      async untagResource() {
        assert.fail("untagResource must not run after lookup failure");
      },
      async tagResource() {
        assert.fail("tagResource must not run after lookup failure");
      },
      async deleteAlarms() {
        assert.fail("deleteAlarms must not run after lookup failure");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(alarmEvent("Delete"), cloudWatch),
      (caught) => caught === error,
    );
  });
}

for (const [description, overrides] of [
  [
    "missing ownership marker",
    {
      OwnershipTags: [
        { Key: "managedBy", Value: "cdk" },
      ],
    },
  ],
  [
    "duplicate ownership marker",
    {
      OwnershipTags: [
        ...OWNERSHIP_TAGS,
        { Key: "project", Value: "agentic-ai-platform-demo" },
      ],
    },
  ],
  [
    "extra ownership marker",
    {
      OwnershipTags: [
        ...OWNERSHIP_TAGS,
        { Key: "owner", Value: "unexpected" },
      ],
      RequiredTags: [
        ...REQUIRED_TAGS,
        { Key: "owner", Value: "unexpected" },
      ],
    },
  ],
  [
    "malformed ownership marker",
    {
      OwnershipTags: [
        { Key: "managedBy", Value: "cdk" },
        { Key: "project" },
      ],
    },
  ],
  [
    "missing mandatory auto-delete tag",
    {
      RequiredTags: OWNERSHIP_TAGS,
    },
  ],
  [
    "wrong mandatory auto-delete value",
    {
      RequiredTags: [
        { Key: "auto-delete", Value: "yes" },
        ...OWNERSHIP_TAGS,
      ],
    },
  ],
  [
    "extra required tag",
    {
      RequiredTags: [
        ...REQUIRED_TAGS,
        { Key: "environment", Value: "demo" },
      ],
    },
  ],
  [
    "conflicting required ownership marker",
    {
      RequiredTags: [
        { Key: "auto-delete", Value: "no" },
        { Key: "managedBy", Value: "manual" },
        { Key: "project", Value: "agentic-ai-platform-demo" },
      ],
    },
  ],
]) {
  test(`alarm properties reject ${description} before lookup`, async () => {
    const calls = [];
    const cloudWatch = {
      async listTagsForResource(parameters) {
        calls.push(["listTagsForResource", parameters]);
        return { Tags: REQUIRED_TAGS };
      },
      async putMetricAlarm(parameters) {
        calls.push(["putMetricAlarm", parameters]);
      },
      async untagResource(parameters) {
        calls.push(["untagResource", parameters]);
      },
      async tagResource(parameters) {
        calls.push(["tagResource", parameters]);
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(
        alarmEvent("Update", overrides),
        cloudWatch,
      ),
      /tag|ownership/i,
    );
    assert.deepEqual(
      calls,
      [],
      "invalid tag properties must fail before lookup or mutation",
    );
  });
}

for (const [description, tags] of [
  [
    "duplicate existing tag records",
    [
      ...OWNERSHIP_TAGS,
      { Key: "project", Value: "agentic-ai-platform-demo" },
    ],
  ],
  [
    "malformed existing tag records",
    [
      { Key: "managedBy", Value: "cdk" },
      { Key: "project" },
    ],
  ],
]) {
  test(`Update rejects ${description} before mutation`, async () => {
    const calls = [];
    const cloudWatch = {
      async listTagsForResource(parameters) {
        calls.push(["listTagsForResource", parameters]);
        return { Tags: tags };
      },
      async putMetricAlarm() {
        assert.fail("putMetricAlarm must not run for malformed tags");
      },
      async untagResource() {
        assert.fail("untagResource must not run for malformed tags");
      },
      async tagResource() {
        assert.fail("tagResource must not run for malformed tags");
      },
    };

    await assert.rejects(
      reconcileCloudFrontAlarm(alarmEvent("Update"), cloudWatch),
      /tag/i,
    );
    assert.deepEqual(calls, [
      ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ]);
  });
}

test("Update removes extra current tags with empty values", async () => {
  const calls = [];
  const cloudWatch = {
    async listTagsForResource(parameters) {
      calls.push(["listTagsForResource", parameters]);
      return {
        Tags: [
          ...OWNERSHIP_TAGS,
          { Key: "auto-delete", Value: "" },
          { Key: "empty-drift", Value: "" },
        ],
      };
    },
    async putMetricAlarm(parameters) {
      calls.push(["putMetricAlarm", parameters]);
    },
    async untagResource(parameters) {
      calls.push(["untagResource", parameters]);
    },
    async tagResource(parameters) {
      calls.push(["tagResource", parameters]);
    },
  };

  const result = await reconcileCloudFrontAlarm(
    alarmEvent("Update"),
    cloudWatch,
  );

  assert.deepEqual(result, { PhysicalResourceId: ALARM_NAME });
  assert.deepEqual(calls, [
    ["listTagsForResource", { ResourceARN: ALARM_ARN }],
    ["putMetricAlarm", alarmParameters()],
    [
      "untagResource",
      {
        ResourceARN: ALARM_ARN,
        TagKeys: ["empty-drift"],
      },
    ],
    [
      "tagResource",
      {
        ResourceARN: ALARM_ARN,
        Tags: REQUIRED_TAGS,
      },
    ],
  ]);
});

test("duplicate alarm handler delivery sends SUCCESS twice without replaying the mutation", async () => {
  const event = alarmEvent("Create");
  let currentTags;
  let putCalls = 0;
  const responseStatuses = [];
  const cloudWatch = {
    async listTagsForResource() {
      if (currentTags === undefined) {
        throw resourceNotFound();
      }
      return { Tags: currentTags };
    },
    async putMetricAlarm(parameters) {
      putCalls += 1;
      currentTags = parameters.Tags;
    },
    async tagResource() {
      assert.fail("tagResource must not run for atomic creation or replay");
    },
    async untagResource() {
      assert.fail("untagResource must not run for atomic creation or replay");
    },
    async deleteAlarms() {
      assert.fail("deleteAlarms must not run for create replay");
    },
  };
  const sendResponse = async (_event, _context, status, result) => {
    responseStatuses.push([status, result?.PhysicalResourceId]);
  };

  for (let delivery = 0; delivery < 2; delivery += 1) {
    await provider.handleCustomResource(
      event,
      { logStreamName: "provider-log-stream" },
      () => reconcileCloudFrontAlarm(event, cloudWatch),
      { sendResponse },
    );
  }

  assert.equal(putCalls, 1);
  assert.deepEqual(responseStatuses, [
    ["SUCCESS", ALARM_NAME],
    ["SUCCESS", ALARM_NAME],
  ]);
});

function invalidationEvent(requestType) {
  return {
    RequestType: requestType,
    RequestId: `request-${requestType.toLowerCase()}`,
    ResourceProperties: {
      DistributionId: "EDFDVBD6EXAMPLE",
      Paths: ["/*"],
    },
  };
}

function createInvalidationParameters(requestType = "Create") {
  return {
    DistributionId: "EDFDVBD6EXAMPLE",
    InvalidationBatch: {
      CallerReference: `request-${requestType.toLowerCase()}`,
      Paths: {
        Items: ["/*"],
        Quantity: 1,
      },
    },
  };
}

function sdkDeadlineHarness() {
  const controllers = [];
  const timers = [];

  return {
    clearTimer(timer) {
      timer.cleared = true;
    },
    controllers,
    createAbortController() {
      const signal = { aborted: false };
      const controller = {
        abort() {
          signal.aborted = true;
        },
        signal,
      };
      controllers.push(controller);
      return controller;
    },
    fireTimer(index) {
      timers[index].callback();
    },
    setTimer(callback, milliseconds) {
      const timer = {
        callback,
        cleared: false,
        milliseconds,
      };
      timers.push(timer);
      return timer;
    },
    timers,
  };
}

async function waitForTimerCount(harness, count) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (harness.timers.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail(`Expected ${count} SDK deadline timers.`);
}

test("completed create forwards an abort signal and clears its per-call deadline", async () => {
  const harness = sdkDeadlineHarness();
  const calls = [];
  const cloudFront = {
    async createInvalidation(parameters, options) {
      calls.push(["createInvalidation", parameters, options]);
      return { Invalidation: { Id: "I123", Status: "Completed" } };
    },
    async getInvalidation() {
      assert.fail("getInvalidation must not run for completed create");
    },
  };

  const result = await requestCloudFrontInvalidation(
    invalidationEvent("Create"),
    cloudFront,
    {
      clearTimer: harness.clearTimer,
      createAbortController: harness.createAbortController,
      getRemainingTimeInMillis: () => 80_000,
      maxSdkAttemptDurationMs: 20_000,
      setTimer: harness.setTimer,
    },
  );

  assert.deepEqual(result, {
    PhysicalResourceId: "cloudfront-invalidation-EDFDVBD6EXAMPLE",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], createInvalidationParameters());
  assert.equal(
    calls[0][2].abortSignal,
    harness.controllers[0].signal,
  );
  assert.equal(harness.controllers[0].signal.aborted, false);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].milliseconds, 20_000);
  assert.equal(harness.timers[0].cleared, true);
});

test("never-resolving create aborts and rejects before consuming the response reserve", async () => {
  const harness = sdkDeadlineHarness();
  let createOptions;
  const cloudFront = {
    createInvalidation(_parameters, options) {
      createOptions = options;
      return new Promise(() => {});
    },
    async getInvalidation() {
      assert.fail("getInvalidation must not run after create timeout");
    },
  };

  const request = requestCloudFrontInvalidation(
    invalidationEvent("Create"),
    cloudFront,
    {
      clearTimer: harness.clearTimer,
      createAbortController: harness.createAbortController,
      getRemainingTimeInMillis: () => 70_000,
      maxSdkAttemptDurationMs: 20_000,
      responseReserveMs: 45_000,
      setTimer: harness.setTimer,
    },
  );
  await waitForTimerCount(harness, 1);
  harness.fireTimer(0);

  await assert.rejects(request, /SDK request|deadline|remaining time/i);
  assert.equal(
    createOptions.abortSignal,
    harness.controllers[0].signal,
  );
  assert.equal(harness.controllers[0].signal.aborted, true);
  assert.equal(harness.timers[0].milliseconds, 20_000);
  assert.equal(harness.timers[0].cleared, true);
});

test("never-resolving poll aborts and rejects before consuming the response reserve", async () => {
  const harness = sdkDeadlineHarness();
  let getOptions;
  const cloudFront = {
    async createInvalidation() {
      return { Invalidation: { Id: "I123", Status: "InProgress" } };
    },
    getInvalidation(_parameters, options) {
      getOptions = options;
      return new Promise(() => {});
    },
  };

  const request = requestCloudFrontInvalidation(
    invalidationEvent("Create"),
    cloudFront,
    {
      clearTimer: harness.clearTimer,
      createAbortController: harness.createAbortController,
      getRemainingTimeInMillis: () => 70_000,
      maxAttempts: 1,
      maxSdkAttemptDurationMs: 20_000,
      pollIntervalMs: 0,
      responseReserveMs: 45_000,
      setTimer: harness.setTimer,
      sleep: async () => {},
    },
  );
  await waitForTimerCount(harness, 2);
  harness.fireTimer(1);

  await assert.rejects(request, /SDK request|deadline|remaining time/i);
  assert.equal(
    getOptions.abortSignal,
    harness.controllers[1].signal,
  );
  assert.equal(harness.controllers[1].signal.aborted, true);
  assert.equal(harness.timers[0].cleared, true);
  assert.equal(harness.timers[1].milliseconds, 20_000);
  assert.equal(harness.timers[1].cleared, true);
});

test("invalidation polls InProgress to Completed with exact identifiers", async () => {
  const calls = [];
  const pollResponses = [
    { Invalidation: { Id: "I123", Status: "InProgress" } },
    { Invalidation: { Id: "I123", Status: "Completed" } },
  ];
  const cloudFront = {
    async createInvalidation(parameters) {
      calls.push(["createInvalidation", parameters]);
      return { Invalidation: { Id: "I123", Status: "InProgress" } };
    },
    async getInvalidation(parameters) {
      calls.push(["getInvalidation", parameters]);
      return pollResponses.shift();
    },
  };
  const sleepCalls = [];

  const result = await requestCloudFrontInvalidation(
    invalidationEvent("Create"),
    cloudFront,
    {
      maxAttempts: 3,
      pollIntervalMs: 17,
      getRemainingTimeInMillis: () => 120_000,
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
      },
    },
  );

  assert.deepEqual(result, {
    PhysicalResourceId: "cloudfront-invalidation-EDFDVBD6EXAMPLE",
  });
  assert.deepEqual(calls, [
    ["createInvalidation", createInvalidationParameters()],
    [
      "getInvalidation",
      { DistributionId: "EDFDVBD6EXAMPLE", Id: "I123" },
    ],
    [
      "getInvalidation",
      { DistributionId: "EDFDVBD6EXAMPLE", Id: "I123" },
    ],
  ]);
  assert.deepEqual(sleepCalls, [17, 17]);
});

test("invalidation deadline fails before sleeping when reserve would be crossed", async () => {
  const calls = [];
  const remainingTimes = [120_000, 35_000];
  const cloudFront = {
    async createInvalidation(parameters) {
      calls.push(["createInvalidation", parameters]);
      return { Invalidation: { Id: "I123", Status: "InProgress" } };
    },
    async getInvalidation(parameters) {
      calls.push(["getInvalidation", parameters]);
      return { Invalidation: { Id: "I123", Status: "Completed" } };
    },
  };

  await assert.rejects(
    requestCloudFrontInvalidation(
      invalidationEvent("Create"),
      cloudFront,
      {
        getRemainingTimeInMillis: () => remainingTimes.shift(),
        pollIntervalMs: 5_000,
        responseReserveMs: 30_000,
        sleep: async (milliseconds) => {
          calls.push(["sleep", milliseconds]);
        },
      },
    ),
    /remaining time|deadline/i,
  );
  assert.deepEqual(calls, [
    ["createInvalidation", createInvalidationParameters()],
  ]);
});

test("invalidation deadline fails after sleep but before the poll call", async () => {
  const calls = [];
  const remainingTimes = [120_000, 40_000, 30_000];
  const cloudFront = {
    async createInvalidation(parameters) {
      calls.push(["createInvalidation", parameters]);
      return { Invalidation: { Id: "I123", Status: "InProgress" } };
    },
    async getInvalidation(parameters) {
      calls.push(["getInvalidation", parameters]);
      return { Invalidation: { Id: "I123", Status: "Completed" } };
    },
  };

  await assert.rejects(
    requestCloudFrontInvalidation(
      invalidationEvent("Create"),
      cloudFront,
      {
        getRemainingTimeInMillis: () => remainingTimes.shift(),
        pollIntervalMs: 5_000,
        responseReserveMs: 30_000,
        sleep: async (milliseconds) => {
          calls.push(["sleep", milliseconds]);
        },
      },
    ),
    /remaining time|deadline/i,
  );
  assert.deepEqual(calls, [
    ["createInvalidation", createInvalidationParameters()],
    ["sleep", 5_000],
  ]);
});

test("already-Completed create returns without polling or sleeping", async () => {
  const calls = [];
  const cloudFront = {
    async createInvalidation(parameters) {
      calls.push(["createInvalidation", parameters]);
      return { Invalidation: { Id: "I123", Status: "Completed" } };
    },
    async getInvalidation() {
      assert.fail("getInvalidation must not run for completed create");
    },
  };

  const result = await requestCloudFrontInvalidation(
    invalidationEvent("Update"),
    cloudFront,
    {
      sleep: async () => {
        assert.fail("sleep must not run for completed create");
      },
    },
  );

  assert.deepEqual(result, {
    PhysicalResourceId: "cloudfront-invalidation-EDFDVBD6EXAMPLE",
  });
  assert.deepEqual(calls, [
    ["createInvalidation", createInvalidationParameters("Update")],
  ]);
});

for (const [description, response] of [
  ["missing invalidation", {}],
  ["missing invalidation ID", { Invalidation: { Status: "InProgress" } }],
  ["missing invalidation status", { Invalidation: { Id: "I123" } }],
  ["unknown invalidation status", {
    Invalidation: { Id: "I123", Status: "Succeeded" },
  }],
]) {
  test(`create rejects ${description}`, async () => {
    const cloudFront = {
      async createInvalidation() {
        return response;
      },
      async getInvalidation() {
        assert.fail("getInvalidation must not run after malformed create");
      },
    };

    await assert.rejects(
      requestCloudFrontInvalidation(
        invalidationEvent("Create"),
        cloudFront,
      ),
      /invalidation|status/i,
    );
  });
}

for (const [description, response] of [
  ["missing invalidation", {}],
  ["mismatched invalidation ID", {
    Invalidation: { Id: "I999", Status: "Completed" },
  }],
  ["unknown invalidation status", {
    Invalidation: { Id: "I123", Status: "Failed" },
  }],
]) {
  test(`poll rejects ${description}`, async () => {
    const cloudFront = {
      async createInvalidation() {
        return { Invalidation: { Id: "I123", Status: "InProgress" } };
      },
      async getInvalidation() {
        return response;
      },
    };

    await assert.rejects(
      requestCloudFrontInvalidation(
        invalidationEvent("Create"),
        cloudFront,
        {
          maxAttempts: 1,
          pollIntervalMs: 0,
          sleep: async () => {},
        },
      ),
      /invalidation|status/i,
    );
  });
}

test("invalidation polling throws after the bounded attempt limit", async () => {
  const calls = [];
  const cloudFront = {
    async createInvalidation() {
      return { Invalidation: { Id: "I123", Status: "InProgress" } };
    },
    async getInvalidation(parameters) {
      calls.push(parameters);
      return { Invalidation: { Id: "I123", Status: "InProgress" } };
    },
  };

  await assert.rejects(
    requestCloudFrontInvalidation(
      invalidationEvent("Create"),
      cloudFront,
      {
        maxAttempts: 2,
        pollIntervalMs: 0,
        sleep: async () => {},
      },
    ),
    /did not complete.*2 attempts/i,
  );
  assert.deepEqual(calls, [
    { DistributionId: "EDFDVBD6EXAMPLE", Id: "I123" },
    { DistributionId: "EDFDVBD6EXAMPLE", Id: "I123" },
  ]);
});

test("Delete retains deployed content without requesting an invalidation", async () => {
  const cloudFront = {
    async createInvalidation() {
      assert.fail("createInvalidation must not run on delete");
    },
    async getInvalidation() {
      assert.fail("getInvalidation must not run on delete");
    },
  };

  const result = await requestCloudFrontInvalidation(
    invalidationEvent("Delete"),
    cloudFront,
  );

  assert.deepEqual(result, {
    PhysicalResourceId: "cloudfront-invalidation-EDFDVBD6EXAMPLE",
  });
});

function cloudFormationResponseEvent() {
  return {
    LogicalResourceId: "CloudFrontInvalidation",
    RequestId: "request-response",
    ResponseURL:
      "https://response.example.test/upload?X-Amz-Signature=do-not-expose",
    StackId: "stack-response",
  };
}

function responseUploadHarness() {
  let responseCallback;
  let timerCallback;
  const request = new EventEmitter();
  request.destroyedByTimeout = false;
  request.end = () => {};
  request.destroy = () => {
    request.destroyedByTimeout = true;
  };

  return {
    clearTimer: () => {},
    fireTimeout: () => timerCallback(),
    request,
    requestTransport: (_options, callback) => {
      responseCallback = callback;
      return request;
    },
    respond(statusCode) {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.resume = () => {};
      responseCallback(response);
      return response;
    },
    setTimer(callback) {
      timerCallback = callback;
      return { timer: true };
    },
  };
}

function assertGenericUploadError(error, pattern) {
  assert.ok(error instanceof Error);
  assert.match(error.message, pattern);
  assert.doesNotMatch(error.message, /response\.example\.test|X-Amz-Signature/i);
  return true;
}

test("CloudFormation response resolves only after a successful 2xx response ends", async () => {
  const harness = responseUploadHarness();
  let settled = false;
  const upload = provider.sendCloudFormationResponse(
    cloudFormationResponseEvent(),
    { logStreamName: "provider-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: "resource-id" },
    undefined,
    harness,
  ).then(() => {
    settled = true;
  });

  const response = harness.respond(204);
  await Promise.resolve();
  assert.equal(settled, false);
  response.emit("end");
  await upload;
  assert.equal(settled, true);
});

test("CloudFormation response rejects a non-2xx status generically", async () => {
  const harness = responseUploadHarness();
  const upload = provider.sendCloudFormationResponse(
    cloudFormationResponseEvent(),
    { logStreamName: "provider-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: "resource-id" },
    undefined,
    harness,
  );
  const response = harness.respond(403);
  response.emit("end");

  await assert.rejects(
    upload,
    (error) => assertGenericUploadError(error, /status|upload/i),
  );
});

test("CloudFormation response rejects response-stream errors generically", async () => {
  const harness = responseUploadHarness();
  const upload = provider.sendCloudFormationResponse(
    cloudFormationResponseEvent(),
    { logStreamName: "provider-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: "resource-id" },
    undefined,
    harness,
  );
  const response = harness.respond(200);
  response.emit(
    "error",
    new Error("https://response.example.test/upload?X-Amz-Signature=secret"),
  );

  await assert.rejects(
    upload,
    (error) => assertGenericUploadError(error, /upload/i),
  );
});

test("CloudFormation response rejects request errors generically", async () => {
  const harness = responseUploadHarness();
  const upload = provider.sendCloudFormationResponse(
    cloudFormationResponseEvent(),
    { logStreamName: "provider-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: "resource-id" },
    undefined,
    harness,
  );
  harness.request.emit(
    "error",
    new Error("https://response.example.test/upload?X-Amz-Signature=secret"),
  );

  await assert.rejects(
    upload,
    (error) => assertGenericUploadError(error, /upload/i),
  );
});

test("CloudFormation response rejects and destroys a timed-out upload", async () => {
  const harness = responseUploadHarness();
  const upload = provider.sendCloudFormationResponse(
    cloudFormationResponseEvent(),
    { logStreamName: "provider-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: "resource-id" },
    undefined,
    {
      ...harness,
      timeoutMs: 1_000,
    },
  );
  harness.fireTimeout();

  await assert.rejects(
    upload,
    (error) => assertGenericUploadError(error, /timed out/i),
  );
  assert.equal(harness.request.destroyedByTimeout, true);
});

function customResourceEvent(overrides = {}) {
  return {
    ...cloudFormationResponseEvent(),
    RequestType: "Create",
    ...overrides,
  };
}

test("custom-resource handling sends SUCCESS once and returns the operation result", async () => {
  const operationResult = {
    PhysicalResourceId: "created-resource-id",
    Data: { state: "ready" },
  };
  let operationCalls = 0;
  const responseCalls = [];

  const result = await provider.handleCustomResource(
    customResourceEvent(),
    { logStreamName: "provider-log-stream" },
    async () => {
      operationCalls += 1;
      return operationResult;
    },
    {
      sendResponse: async (...args) => {
        responseCalls.push(args);
      },
      sleep: async () => {
        assert.fail("backoff must not run after first-attempt success");
      },
      logTerminalError: () => {
        assert.fail("terminal error must not be logged after success");
      },
    },
  );

  assert.equal(result, operationResult);
  assert.equal(operationCalls, 1);
  assert.equal(responseCalls.length, 1);
  assert.equal(responseCalls[0][2], "SUCCESS");
  assert.equal(responseCalls[0][3], operationResult);
  assert.equal(responseCalls[0][4], undefined);
});

test("custom-resource handling retries the identical SUCCESS response without replaying the operation", async () => {
  const operationResult = {
    PhysicalResourceId: "replacement-resource-id",
    Data: { state: "created" },
  };
  let operationCalls = 0;
  const responseCalls = [];
  const backoffs = [];

  const result = await provider.handleCustomResource(
    customResourceEvent({
      PhysicalResourceId: "old-resource-id",
      RequestType: "Update",
    }),
    { logStreamName: "provider-log-stream" },
    async () => {
      operationCalls += 1;
      return operationResult;
    },
    {
      responseRetryDelayMs: 17,
      sendResponse: async (...args) => {
        responseCalls.push(args);
        if (responseCalls.length < 3) {
          throw new Error(
            "https://response.example.test/?X-Amz-Signature=secret",
          );
        }
      },
      sleep: async (milliseconds) => {
        backoffs.push(milliseconds);
      },
      logTerminalError: () => {
        assert.fail("terminal error must not be logged after retry success");
      },
    },
  );

  assert.equal(result, operationResult);
  assert.equal(operationCalls, 1);
  assert.deepEqual(backoffs, [17, 17]);
  assert.equal(responseCalls.length, 3);
  for (const call of responseCalls) {
    assert.equal(call[2], "SUCCESS");
    assert.equal(call[3], operationResult);
    assert.equal(call[3].PhysicalResourceId, "replacement-resource-id");
    assert.equal(call[4], undefined);
  }
});

test("exhausted SUCCESS uploads send FAILED with the exact new physical identity", async () => {
  const operationResult = {
    PhysicalResourceId: "replacement-resource-id",
    Data: { state: "created" },
  };
  let operationCalls = 0;
  const responseCalls = [];

  const result = await provider.handleCustomResource(
    customResourceEvent({
      PhysicalResourceId: "old-resource-id",
      RequestType: "Update",
    }),
    { logStreamName: "provider-log-stream" },
    async () => {
      operationCalls += 1;
      return operationResult;
    },
    {
      responseRetryDelayMs: 0,
      sendResponse: async (...args) => {
        responseCalls.push(args);
        if (args[2] === "SUCCESS") {
          throw new Error("upload failed");
        }
      },
      sleep: async () => {},
      logTerminalError: () => {
        assert.fail("terminal error must not be logged after FAILED delivery");
      },
    },
  );

  assert.equal(result, operationResult);
  assert.equal(operationCalls, 1);
  assert.equal(responseCalls.length, 4);
  assert.deepEqual(
    responseCalls.slice(0, 3).map((call) => call[2]),
    ["SUCCESS", "SUCCESS", "SUCCESS"],
  );
  const failedCall = responseCalls[3];
  assert.equal(failedCall[2], "FAILED");
  assert.equal(failedCall[3], operationResult);
  assert.equal(
    failedCall[3].PhysicalResourceId,
    "replacement-resource-id",
  );
  assert.match(failedCall[4], /response delivery failed/i);
});

test("operation failure sends FAILED with the existing physical identity and does not throw after delivery", async () => {
  const responseCalls = [];
  let operationCalls = 0;
  const event = customResourceEvent({
    PhysicalResourceId: "existing-resource-id",
    RequestType: "Delete",
  });

  const result = await provider.handleCustomResource(
    event,
    { logStreamName: "provider-log-stream" },
    async () => {
      operationCalls += 1;
      throw new Error(
        "https://response.example.test/?X-Amz-Signature=secret",
      );
    },
    {
      sendResponse: async (...args) => {
        responseCalls.push(args);
      },
      logTerminalError: () => {
        assert.fail("terminal error must not be logged after FAILED delivery");
      },
    },
  );

  assert.deepEqual(result, {
    PhysicalResourceId: "existing-resource-id",
  });
  assert.equal(operationCalls, 1);
  assert.equal(responseCalls.length, 1);
  assert.equal(responseCalls[0][2], "FAILED");
  assert.deepEqual(responseCalls[0][3], {
    PhysicalResourceId: "existing-resource-id",
  });
  assert.match(responseCalls[0][4], /operation failed/i);
  assert.doesNotMatch(
    responseCalls[0][4],
    /response\.example\.test|X-Amz-Signature/i,
  );
});

test("terminal response-upload failure is logged generically without operation replay or throw", async () => {
  const operationResult = {
    PhysicalResourceId: "created-resource-id",
  };
  let operationCalls = 0;
  const responseCalls = [];
  const terminalMessages = [];

  const result = await provider.handleCustomResource(
    customResourceEvent(),
    { logStreamName: "provider-log-stream" },
    async () => {
      operationCalls += 1;
      return operationResult;
    },
    {
      responseRetryDelayMs: 0,
      sendResponse: async (...args) => {
        responseCalls.push(args);
        throw new Error(
          "https://response.example.test/?X-Amz-Signature=secret",
        );
      },
      sleep: async () => {},
      logTerminalError: (message) => {
        terminalMessages.push(message);
      },
    },
  );

  assert.equal(result, operationResult);
  assert.equal(operationCalls, 1);
  assert.equal(responseCalls.length, 4);
  assert.deepEqual(
    responseCalls.map((call) => call[2]),
    ["SUCCESS", "SUCCESS", "SUCCESS", "FAILED"],
  );
  assert.equal(responseCalls[3][3], operationResult);
  assert.equal(terminalMessages.length, 1);
  assert.match(terminalMessages[0], /response delivery failed/i);
  assert.doesNotMatch(
    terminalMessages[0],
    /response\.example\.test|X-Amz-Signature/i,
  );
});
