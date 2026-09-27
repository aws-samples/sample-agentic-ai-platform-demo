def evaluate(case, result):
    """Starter deterministic expected-text check; replace with your business rubric."""
    expected = case.get('expected')
    if not isinstance(expected, str) or not expected.strip():
        raise ValueError('This evaluator requires expected text for every case.')
    passed = expected.casefold() in result['output'].casefold()
    return {'score': float(passed), 'reason': 'Expected text found' if passed else 'Expected text missing'}
