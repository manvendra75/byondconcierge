"""scripts/chat.py — an interactive terminal REPL for the full turn pipeline.

A dev tool (not part of the app) to try the whole flow end to end before the
Streamlit UI exists: registration -> scope gate -> branch -> agent -> no-price
guard -> persistence. Run from the conversational-engine folder:

    python scripts/chat.py

Type a message and press Enter. Type 'quit' (or blank + Enter) to exit.
Each reply shows a [intent | lead_signal] footer so you can see the routing.
"""

import sys
import uuid
from pathlib import Path

# Make `engine` importable when run as `python scripts/chat.py` from any directory:
# add the project root (the parent of this scripts/ folder) to the import path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.db import create_session, init_db, upsert_user
from engine.orchestrator import handle_turn
from engine.schemas import UserProfile
from pydantic import ValidationError


def register() -> UserProfile:
    """Collect and validate the four registration fields, re-prompting on error.
    This mirrors what the Streamlit gate (T4.1) will enforce."""
    print("=== Byond Borders Cruise Concierge — registration ===")
    while True:
        try:
            return UserProfile(
                agency=input("Agency name: ").strip(),
                full_name=input("Full name : ").strip(),
                email=input("Email      : ").strip(),
                phone=input("Phone (+...): ").strip(),
            )
        except ValidationError as e:
            # Show which field failed and try again.
            print("  ! invalid:", "; ".join(err["msg"] for err in e.errors()), "\n")


def main() -> None:
    init_db()
    profile = register()
    upsert_user(profile)

    # One session per run; keep the running history in memory to feed each turn.
    session_id = str(uuid.uuid4())
    create_session(session_id, profile.email)
    history: list[dict] = []

    print(f"\nHi {profile.full_name.split()[0]} — ask about cruises. Type 'quit' to exit.\n")
    while True:
        message = input("You: ").strip()
        if message.lower() in ("", "quit", "exit"):
            print("Bye!")
            break

        # Stream in-scope answers live; remember if anything streamed so we don't
        # double-print canned replies (which don't stream).
        streamed: list[str] = []
        print("Concierge: ", end="", flush=True)
        result = handle_turn(
            session_id, profile, history, message,
            on_delta=lambda d: (streamed.append(d), print(d, end="", flush=True)),
        )
        if not streamed:                       # canned/scope/price reply (no stream)
            print(result["reply"], end="")
        print(f"\n   [intent={result['intent']} | lead_signal={result['lead_signal']}]\n")

        # Keep the conversation context for the next turn.
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": result["reply"]})


if __name__ == "__main__":
    main()
