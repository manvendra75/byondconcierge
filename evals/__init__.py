"""evals — the test and evaluation harness.

Deterministic unit tests for the LLM-free tools, plus scenario-based
behavioural evals (happy paths, injection attempts, out-of-scope, lead
capture) with trace-level assertions. Run with ``pytest evals/``.

Modules are added by later tasks (T6.x); this file just marks the directory as
a Python package.
"""
