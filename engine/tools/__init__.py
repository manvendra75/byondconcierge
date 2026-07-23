"""engine.tools — the typed functions the agent is allowed to call.

Four read tools (search_sailings, get_line_overview / compare_lines,
search_knowledge) and one write tool (create_lead_enquiry). Each has a strict
Pydantic input/output contract; the model only supplies validated arguments,
it never runs SQL or sends email directly.

Modules are added by later tasks (T2.x, T5.x); this file just marks the
directory as a Python package.
"""
