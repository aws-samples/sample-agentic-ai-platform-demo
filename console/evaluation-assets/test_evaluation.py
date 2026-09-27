"""Run with python -m pytest evaluation/test_evaluation.py -q. No deployed agent assumed."""
import importlib.util
import json
import math
import os
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent

def module(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj

def test_business_evaluation():
    config = json.loads((ROOT / 'evaluation/config.json').read_text())
    report = {'status': 'NOT_CONFIGURED', 'results': []}
    target = ROOT / 'evaluation/report.json'
    try:
        if config['dataset']['source'] == 'later' or config['evaluator']['type'] == 'later':
            pytest.fail('Business evaluation is NOT_CONFIGURED. Configure dataset/evaluator after export; no evaluation has passed.')
        dataset = ROOT / 'evaluation/dataset.jsonl'
        if config['dataset']['source'] == 'reference':
            dataset = Path(os.environ.get('EVAL_DATASET_PATH', '/dataset-not-configured'))
        cases = [json.loads(line) for line in dataset.read_text().splitlines() if line.strip()]
        assert cases, 'Empty datasets never pass'
        adapter = module(ROOT / 'evaluation/agent_adapter.py')
        evaluator = module(ROOT / 'evaluation/evaluator.py')
        report['status'] = 'FAILED'
        for case in cases:
            result = adapter.run(case)
            assert isinstance(result, dict) and isinstance(result.get('output'), str), 'Agent adapter must return actual output'
            verdict = evaluator.evaluate(case, result)
            score = verdict.get('score')
            assert isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score) and 0 <= score <= 1, 'Evaluator must return a finite score in [0,1]'
            assert isinstance(verdict.get('reason'), str) and verdict['reason'].strip(), 'Evaluator must explain the score'
            report['results'].append({'id': case['id'], 'score': score, 'reason': verdict['reason']})
        # The shared platform contract remains the floor; this file does not supply an override.
        floor = json.loads((ROOT / 'gates/platform-gates.json').read_text())['threshold']
        assert all(row['score'] >= floor for row in report['results']), 'Evaluation below the inherited threshold'
        report['status'] = 'PASSED'
    finally:
        target.write_text(json.dumps(report, indent=2)+'\n')
