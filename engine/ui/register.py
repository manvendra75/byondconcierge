"""engine.ui.register — the B2B registration gate (Streamlit).

Renders the sign-in form and validates it through the SAME ``UserProfile``
contract the backend uses, so the UI can never admit a user the rest of the
system would reject (single source of validation). Kept out of app.py so the
form + error handling stays small and reusable.
"""

from __future__ import annotations

import streamlit as st
from pydantic import ValidationError

from engine.schemas import UserProfile


# ---------------------------------------------------------------------------
# The registration form
# ---------------------------------------------------------------------------
def render_registration_gate() -> UserProfile | None:
    """Render the registration form and return a validated ``UserProfile`` once
    the user submits valid details — otherwise ``None`` (while the form is
    untouched, or after showing inline errors for invalid input).

    The four fields map 1:1 to ``UserProfile``; validation (email format, phone
    ``+``-digits, length bounds) is delegated to the model, so the rules live in
    one place.
    """
    st.subheader("Partner sign-in")
    st.caption("Register your agency to start. We use these details only to follow up on enquiries.")

    # st.form batches the inputs so nothing runs until the user clicks Enter.
    with st.form("registration"):
        agency = st.text_input("Agency name", key="reg_agency")
        full_name = st.text_input("Full name", key="reg_name")
        email = st.text_input("Email", key="reg_email")
        phone = st.text_input("Phone (international, e.g. +97144580111)", key="reg_phone")
        submitted = st.form_submit_button("Enter")

    if not submitted:
        return None

    # Validate through the shared contract; surface any field error inline and
    # keep the user on the form (return None) so they can fix it.
    try:
        return UserProfile(
            agency=agency.strip(),
            full_name=full_name.strip(),
            email=email.strip(),
            phone=phone.strip(),
        )
    except ValidationError as exc:
        for err in exc.errors():
            field = err["loc"][0] if err["loc"] else "input"
            st.error(f"**{field}** — {err['msg']}")
        return None
