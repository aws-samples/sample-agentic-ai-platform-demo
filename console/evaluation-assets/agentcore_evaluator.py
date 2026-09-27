"""On-demand AgentCore Evaluations adapter. Requires boto3, AWS credentials and actual OTEL spans."""
import json
from pathlib import Path

def evaluate(case, result):
    import boto3
    config = json.loads((Path(__file__).parent / 'config.json').read_text())
    spans = result.get('sessionSpans')
    if not isinstance(spans, list) or not spans:
        raise ValueError('AgentCore Evaluation requires real OpenTelemetry sessionSpans from your Agent.')
    response = boto3.client('bedrock-agentcore').evaluate(
        evaluatorId=config['evaluator']['id'], evaluationInput={'sessionSpans': spans})
    rows = response.get('evaluationResults', [])
    if not rows or any(row.get('errorCode') or row.get('errorMessage') for row in rows):
        raise ValueError('AgentCore returned no successful evaluation results.')
    values = [row.get('value') for row in rows]
    if any(not isinstance(v, (int, float)) or not 0 <= v <= 1 for v in values):
        raise ValueError('Configure a custom adapter for categorical or non-[0,1] rating scales; no implicit normalization.')
    return {'score': min(values), 'reason': json.dumps(rows, default=str)}
