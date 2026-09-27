# HITL policy catalog v1

This is a versioned configuration catalog, not a tool execution engine. `enabled`
is a saved configuration flag, never proof of runtime enforcement. Every API
response explicitly reports `enforcement: "NOT_CONFIGURED"`.

## Semantics

Derived from `console/server.mjs` `hitlPolicies`/`matchHitlPolicy`:
- `toolMatch` is an ordered list of tool-name patterns; only `*` is a wildcard.
- `mode` is `require_approval` or `notify_only`.
- Catalog array order retains legacy first-enabled-match precedence.
- The legacy `agentScope` compares a **project** string, not an agent identifier.
  V1 makes this explicit: `scope: {kind:"domain"}` or
  `scope: {kind:"project",projectId:"..."}`. No single-agent scope is supported.
- The containing catalog's `domainId` always bounds scope. Legacy `all` maps to
  all projects in that domain, not all domains. There is no automatic migration:
  an owner must explicitly choose each catalog's domain. `projectId` is a stable
  identifier supplied by the owner; read validation does not assert the project
  currently exists or that any runtime is attached.

## Storage and initialization

Use the existing platform workspace DynamoDB table:
- `pk = HITL_POLICY#<domainId>`
- `sk = CATALOG`
- `entityType = HITL_POLICY_CATALOG`
- `document` (String) is the validated JSON snapshot:
  `{schemaVersion:1,revision,domainId,updatedAt,policies}`.
- Each policy has exactly
  `{id,version,name,toolMatch,mode,scope,enabled,createdAt}`.
- Positive integer revisions, unique IDs, ISO timestamps, max 200 policies and
  max 256 KiB document. Unsupported schema/scope or malformed fields fail closed.

`buildHitlCatalogInitialization({tableName,catalog})` produces an offline
PutItem **input artifact only**, with revision 1 and
`attribute_not_exists(pk) AND attribute_not_exists(sk)`. It never sends AWS
requests. The caller must explicitly supply `policies`, including `[]` when an
owner intentionally initializes an empty catalog. The deployment custom resource initializes only a missing platform catalog with an explicitly empty snapshot, retaining existing catalogs. It does not create default policy rules, adopt resources or grant runtime writes. Other domains remain unconfigured until explicitly initialized.

Future catalog replacement must atomically replace this item, require the old
revision in a conditional expression, increment revision, and not reset policy
versions. A disabled-only platform draft writer is implemented below; enabling, deletion and runtime activation remain unimplemented. Read consumers
reject a changed revision between pages, but cannot detect an out-of-band writer
violating this revision contract. Creation/update/deletion approval and retention
of historical revisions require separate review. This v1 stores only the current
versioned snapshot, not immutable revision history.

## API / security

Existing Governance integration, JWT GET `/api/hitl` and POST `/api/governance/policy-drafts`.
Server-produced identity and `manageApprovalPolicies` capability authorize the
read. Lead/builder/user are denied by the existing bundle. An authorized admin
reads the explicit active domain, or `platform` when unscoped; the domain must be
in the active domain directory. No client-supplied capabilities or query-domain
substitution. No domain-wide scan and no domain content beyond policy metadata.

The workspace reader uses one strongly consistent `GetItem`; missing Item is
unconfigured, `policies:[]` in a valid stored snapshot is configured-empty, and
transport/shape/domain/schema failures are errors. No read path writes or seeds.

Response includes `ok,schemaVersion,revision,domainId,updatedAt,source,policies,
cursor,enforcement`. `source` is `workspace-hitl-policy-catalog`. UI compatibility
`agentScope` is projected as `all` or the project's ID. `limit` defaults to 20,
max 50. Cursor contains schema version/domain/revision/offset, is bounded and
validated. It is not signed: it is a pagination position, not an authorization
credential; every request reauthorizes the domain and revalidates the snapshot.
Revision change returns 409; cross-domain or out-of-range cursor returns 400.

The UI collects all pages only while the same domain/revision/update timestamp
holds, rejects duplicates/partial/errors, validates the envelope and policies,
then renders a read-only list. No partial successful list is displayed.

## Infrastructure review boundary

IaC source adds GET invocation permission and `dynamodb:GetItem` only for
`HITL_POLICY#*` on the existing table, in both the Governance role and runtime
permissions boundary. No HITL Query/Scan/write grants, no new table/index/role.
The shared Governance Lambda still has broader pre-existing permissions for
other workflows. The deployment initializer is separately scoped to the exact platform catalog key, as described below.

## Deployment initialization

The PlatformHitlCatalog custom resource initializes an explicitly empty platform catalog through the existing workspace seed provider, using a conditional PutItem. It retains existing valid catalogs unchanged, fails on malformed stored data, and does not delete on stack removal. Its deployment role gains only HITL_POLICY#platform GetItem/PutItem on the existing table. Runtime roles remain read-only; no tool enforcement, policy authoring API, adoption or cross-domain defaults are introduced.


## Disabled platform drafts

POST `/api/governance/policy-drafts` requires an authenticated Admin with
`manageApprovalPolicies`, platform in its server-resolved domain directory,
and no non-platform active domain. Other domains retain read-only behavior.
The request ID is mandatory; exact body keys are `operation` (create/update),
`expectedRevision`, `expectedPolicyVersion` (null for create), `policy`, and
`reason` (10–1024 characters). Policy accepts only id/name/toolMatch/mode/scope.
Client enabled/version/createdAt/domain substitutions are rejected.

The server creates only enabled=false records. Updates require the existing
record to be disabled with matching version. Creation increments catalog
revision, appends version1; update increments both versions, retains createdAt
and position, and preserves every other policy. No activation/deletion/binding
or project-existence guarantee is implied by a saved scope declaration.

Catalog replacement, WORKSPACE_AUDIT metadata and MUTATION_RESULT are one
DynamoDB TransactWriteItems operation. The condition compares the exact prior
catalog document including revision; lost concurrent updates fail with 409.
Same actor/request-id/canonical payload replays completion without another
write; mismatched payload conflicts. Replay returns the current catalog and
savedRevision, so a later update is not misrepresented as the old snapshot.
Audit contains actor/resource/reason/action, not the policy content.

Identity IAM adds only transactional PutItem for HITL_POLICY#platform; existing
transactional audit/mutation permissions are reused. The permissions boundary
source includes the exact platform key (the existing deployment compactor
already makes platform table read/write a broad ceiling; identity IAM remains
the precise enforceable partition boundary). JWT route and invoke permission
are exact. Runtime/tool execution IAM is unchanged.

UI edits are disabled configurations, not enforcement. Save requires reason,
retains drafts on failure/conflict, binds unknown-result retry to the same
request, and fences actor/domain/epoch/removed form callbacks. Leaving dirty
fields invokes the shared dirty guard. Saving never calls a runtime API.
