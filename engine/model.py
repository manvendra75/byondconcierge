"""engine.model — the safe, structured model-call wrapper.

Every structured model step in the system goes through ``call_structured`` rather
than calling OpenAI directly. It wraps a single call with the reliability ladder
the guide requires:

  validate → retry-with-error → escalate small→large → typed failure

Concretely:
* the raw reply is parsed and validated against a Pydantic schema;
* a bad/invalid reply is retried once, with the error fed back so the model can
  fix it;
* transient provider errors (rate limit / timeout) back off and retry;
* a *small*-model step that keeps failing escalates to the large model;
* if everything fails, a typed ``StepFailed`` is raised (never a raw crash);
* and every attempt writes a ``StepTrace`` (tokens, cost, latency, retry index).

The actual network call is isolated in ``_complete`` so tests can stub it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from engine.config import MODEL_ROUTES, Step, settings
from engine.trace import cost_of, timed_step


# ---------------------------------------------------------------------------
# Typed failure — raised only when every attempt is exhausted
# ---------------------------------------------------------------------------
class StepFailed(Exception):
    """Raised when a structured model step can't produce a valid result after
    retries + escalation. Carries the step name and a short reason so the caller
    (the agent) can degrade gracefully instead of crashing."""

    def __init__(self, step: str, detail: str):
        self.step = step
        self.detail = detail
        super().__init__(f"[{step}] {detail}")


# ---------------------------------------------------------------------------
# The isolated network call (stubbed in tests)
# ---------------------------------------------------------------------------
@dataclass
class _Completion:
    """The minimal result we need from a model call: the text plus token usage."""

    content: str
    tokens_in: int
    tokens_out: int


_client = None


def _openai():
    """Lazily-created OpenAI client (so importing this module needs no key)."""
    global _client
    if _client is None:
        from openai import OpenAI
        _client = OpenAI(api_key=settings.openai_api_key)
    return _client


def _complete(model: str, messages: list[dict], max_tokens: int, temperature: float) -> _Completion:
    """Make ONE OpenAI chat call and return its content + usage. This is the only
    function that talks to the network; tests monkeypatch it to simulate
    good/bad/transient responses without spending tokens."""
    resp = _openai().chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format={"type": "json_object"},   # force a parseable JSON object
    )
    usage = resp.usage
    return _Completion(resp.choices[0].message.content, usage.prompt_tokens, usage.completion_tokens)


# Names of OpenAI exceptions we treat as transient (back off + retry).
_TRANSIENT = {"RateLimitError", "APITimeoutError", "APIConnectionError", "InternalServerError"}


def _is_transient(exc: Exception) -> bool:
    """True for provider errors worth a backoff-and-retry rather than a re-prompt."""
    return type(exc).__name__ in _TRANSIENT


# ---------------------------------------------------------------------------
# One attempt — makes the call, validates, logs its own trace
# ---------------------------------------------------------------------------
def _attempt(step: Step, model: str, messages: list[dict], route: dict,
             attempt_idx: int, schema: type[BaseModel], session_id: str | None) -> BaseModel:
    """Run a single try: call the model, record usage/cost on a trace, then parse
    + validate the reply into ``schema``. Raises on any failure (the caller loops).
    The trace is written by ``timed_step`` on exit even when this raises, so every
    attempt is observable."""
    with timed_step(session_id, step.value) as trace:
        trace.model = model
        trace.retries = attempt_idx                 # 0 on the first try, 1 on retry, ...
        comp = _complete(model, messages, route["max_tokens"], route["temperature"])
        trace.tokens_in, trace.tokens_out = comp.tokens_in, comp.tokens_out
        trace.cost_usd = cost_of(model, comp.tokens_in, comp.tokens_out)
        try:
            result = schema.model_validate_json(comp.content)   # parse + validate in one step
        except ValidationError:
            trace.guard_outcome = "validation_error"            # note the failure on the trace
            raise
        trace.guard_outcome = "ok"
        return result


# ---------------------------------------------------------------------------
# The public wrapper
# ---------------------------------------------------------------------------
def call_structured(step: Step, prompt: str, schema: type[BaseModel],
                    session_id: str | None = None) -> BaseModel:
    """Call the model for ``step`` and return a validated ``schema`` instance.

    Attempt chain: the routed model is tried, retried once (with the prior error
    appended), and — for a small-model step — escalated to the large model on a
    third try. Transient provider errors back off between attempts. If none
    succeed, raises :class:`StepFailed`.
    """
    route = MODEL_ROUTES[step]

    # Build the attempt chain: same model twice, then large model if we started small.
    attempt_models = [route["model"], route["model"]]
    if route["model"] == settings.model_small:
        attempt_models.append(settings.model_large)     # escalation path

    # A short system instruction naming the expected schema/fields.
    system = (f"Return ONLY a JSON object matching the {schema.__name__} schema. "
              f"Fields: {list(schema.model_fields)}.")

    last_error = ""
    for attempt_idx, model in enumerate(attempt_models):
        # On a retry, feed the previous error back so the model can correct itself.
        user = prompt if not last_error else (
            f"{prompt}\n\nYour previous reply was invalid ({last_error}). "
            f"Return corrected JSON only."
        )
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]

        try:
            return _attempt(step, model, messages, route, attempt_idx, schema, session_id)
        except ValidationError as e:
            last_error = str(e).splitlines()[0][:200]       # keep the reason short
        except Exception as e:
            if _is_transient(e):
                time.sleep(0.5 * (attempt_idx + 1))         # simple linear backoff
                last_error = f"transient {type(e).__name__}"
            else:
                last_error = f"{type(e).__name__}: {e}"[:200]

    # Every attempt exhausted.
    raise StepFailed(step.value, f"no valid result after {len(attempt_models)} attempts: {last_error}")
