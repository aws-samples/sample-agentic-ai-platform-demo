#!/usr/bin/env python3
"""Prepare a fail-closed, minimal CFN update from this release's CDK assembly.
No cloud writes. Preserve unrelated deployed artifacts, all IAM, Runtime, and
runtime-config. Publish selected CDK assets and execute the resulting template
only after reviewing the manifest. Re-run on every fixed release SHA.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--assembly', required=True, type=Path)
parser.add_argument('--deployed-template', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]

def git(*values):
    return subprocess.check_output(['git', '-C', str(repo), *values], text=True).strip()

if git('branch', '--show-current') != 'release/platform-demo-dev':
    raise SystemExit('Only release/platform-demo-dev may prepare this update')
if git('status', '--porcelain'):
    raise SystemExit('Release tree must be clean')
sha = git('rev-parse', 'HEAD')
if git('rev-parse', 'origin/release/platform-demo-dev') != sha:
    raise SystemExit('Release SHA must be pushed before preparation')
old = json.loads(args.deployed_template.read_text())
new = json.loads((args.assembly / 'PlatformWebStack.template.json').read_text())
# Every function containing the changed shared state/Registry modules must ship
# together. No seed custom resource, unrelated provider or runtime is updated.
functions = {
    'PlatformAdminApiFunction8E9F7DA7', 'ControlPlaneReadApiFunctionE89496DE',
    'GovernanceApiFunction8F88C871', 'WorkspaceApiFunctionDFEDDCFC',
    'BuilderApiFunction70E14B32', 'JourneyApiFunction2FCFFF93',
    'DeploymentApiFunction000D83C8', 'ModelGovernanceApiFunction12DE995F',
    'ExperienceApiFunctionBB6E58D2', 'OperationsApiFunctionAE836B11',
    'AccessAdminApiFunction60BB9A7E',
}
frontend = 'PublishFrontendCustomResourceB1C656F9'
invalidation = 'CloudFrontInvalidation'
if old['Resources'].keys() != new['Resources'].keys():
    raise SystemExit('Unexpected resource additions/removals; review the CDK source/context')
for key, resource in old['Resources'].items():
    candidate = copy.deepcopy(new['Resources'][key])
    before = copy.deepcopy(resource)
    kind = resource['Type']
    # Asset paths are build metadata, not resource configuration. Preserve all
    # other metadata and compare every deployable property below.
    for value in [before, candidate]:
        value.get('Metadata', {}).pop('aws:asset:path', None)
    if kind == 'AWS::Lambda::Function':
        before['Properties'].pop('Code', None)
        candidate['Properties'].pop('Code', None)
    elif kind == 'AWS::BedrockAgentCore::Runtime':
        before['Properties'].pop('AgentRuntimeArtifact', None)
        candidate['Properties'].pop('AgentRuntimeArtifact', None)
    elif key == frontend:
        before['Properties'].pop('SourceObjectKeys', None)
        candidate['Properties'].pop('SourceObjectKeys', None)
    elif key == invalidation:
        before['Properties'].pop('DeploymentVersion', None)
        candidate['Properties'].pop('DeploymentVersion', None)
    elif kind == 'AWS::CDK::Metadata':
        continue
    if before != candidate:
        raise SystemExit(f'Unexpected non-artifact drift: {key}; check context before deployment')
# JWT and precise Lambda permission must already be in the unified source and
# remain present. This release does not tolerate accidental route deletion.
route_key = 'POST /api/governance/publication-initiations'
routes = [v for v in new['Resources'].values() if v['Type'] == 'AWS::ApiGatewayV2::Route'
          and v['Properties'].get('RouteKey') == route_key]
if len(routes) != 1 or routes[0]['Properties'].get('AuthorizationType') != 'JWT':
    raise SystemExit('Missing JWT publication initiation route')
permissions = [v for v in new['Resources'].values() if v['Type'] == 'AWS::Lambda::Permission'
               and 'publication-initiations' in json.dumps(v)]
if len(permissions) != 1:
    raise SystemExit('Missing precise publication initiation Lambda permission')
result = copy.deepcopy(old)
for key in functions:
    result['Resources'][key]['Properties']['Code'] = new['Resources'][key]['Properties']['Code']
old_front = old['Resources'][frontend]['Properties']
new_front = new['Resources'][frontend]['Properties']
if old_front['SourceObjectKeys'][1:] != new_front['SourceObjectKeys'][1:]:
    raise SystemExit('Runtime-config source changed unexpectedly')
result['Resources'][frontend] = new['Resources'][frontend]
result['Resources'][invalidation] = new['Resources'][invalidation]
needed = {new['Resources'][key]['Properties']['Code']['S3Key'] for key in functions}
needed.update(new_front['SourceObjectKeys'])
assets = json.loads((args.assembly / 'PlatformWebStack.assets.json').read_text())['files']
selected = {}
for asset_id, asset in assets.items():
    matches = [d for d in asset['destinations'].values() if d['objectKey'] in needed]
    if matches:
        selected[asset_id] = asset
if {d['objectKey'] for a in selected.values() for d in a['destinations'].values()} != needed:
    raise SystemExit('Selected template assets are not covered by the same CDK assembly')
args.output.mkdir(parents=True, exist_ok=True)
text = json.dumps(result, indent=2) + '\n'
(args.output / 'template.json').write_text(text)
(args.output / 'assets.json').write_text(json.dumps({'version':'54.0.0', 'files':selected}, indent=2))
manifest = {'sha':sha, 'assembly':str(args.assembly.resolve()),
            'baselineTemplateSha256':hashlib.sha256(args.deployed_template.read_bytes()).hexdigest(),
            'candidateTemplateSha256':hashlib.sha256(text.encode()).hexdigest(),
            'functions':sorted(functions), 'frontend':frontend, 'invalidation':invalidation,
            'runtimeConfigPreserved':True, 'iamPreserved':True, 'runtimePreserved':True,
            'publicationInitiationJwtAndPermission':True, 'assetKeys':sorted(needed)}
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
