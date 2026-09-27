# Evaluation setup

This export is an undeployed Agent construct. Business evaluation has NOT RUN.
Foundation controls and their CI checks remain mandatory and separate.

1. Implement the Domain Harness using AGENTS.md/CLAUDE.md. Connect
   `evaluation/agent_adapter.py` to the real local Agent, preserving tool evidence.
2. Edit `evaluation/config.json` and dataset/evaluator files. You may defer both
   when exporting. Blueprint cases are illustrative starters, not business acceptance.
3. Dataset JSONL schema: `{"id":"case-1","input":"request","expected":"optional expected text"}`.
   Map existing dataset columns to these keys. For a referenced S3 dataset, fetch it
   with your own scoped credentials and set EVAL_DATASET_PATH; contents are not exported.
4. Custom Python evaluator interface: `evaluate(case, result) -> {"score": 0.0..1.0,
   "reason": "evidence"}`. result includes output and may include tool/trace data.
   The platform packages uploaded source; it does not execute it. Review it before
   running in a dedicated CI runner. Do not provide unneeded credentials or use
   production credentials. Do not run untrusted code on a shared persistent runner.
5. `pip install -r evaluation/requirements.txt`
   then `python -m pytest evaluation/test_evaluation.py -q`.
   Reports: evaluation/report.json. Missing configuration, an unimplemented adapter,
   empty cases, invalid scores, runtime errors or scores below the inherited floor
   fail the business check. They never count as a pass. Export itself is allowed.

## AgentCore Evaluations

Choose an existing built-in or custom evaluator ID. The shipped boto3 adapter
calls the on-demand Evaluate API with actual OpenTelemetry sessionSpans from the
Agent adapter. Set AWS_REGION/AWS_DEFAULT_REGION and scoped AWS credentials in
that execution environment. An endpoint or a plain answer alone is insufficient.
Custom evaluator provisioning (LLM judge or Lambda), online evaluation sampling,
IAM and telemetry setup are separate deployment work; this export does not claim
those resources exist. Local Python is not automatically uploaded as an AgentCore
custom evaluator. Numeric [0,1] results are supported; other scales require an
explicit custom mapping. Dataset expected values are not automatically translated
into AgentCore reference inputs; add a domain-specific adapter when required.

CI runs this package alongside existing Foundation controls, with a job timeout.
It uploads the report even on failure. Configure required checks for promotion;
production also requires the separate release-bound human decision. Do not relax
Foundation checks or mark an unconfigured business evaluation as approved.
