"""engine.ui.sidebar — the sidebar ad banner + "Powered by AtlasIQ" credit.

The concierge's left panel carries an advertising slot Byond Borders sells to
cruise companies. This module renders that slot plus a subtle vendor credit,
kept out of app.py so the (only) HTML in the app lives in one small, reviewable
place.

The banner is DATA, not code: the image + click URL come from ``settings`` (env
vars, see engine/config.py T4.3), so an ad is sold, swapped, or pulled by editing
env vars and redeploying — this module never changes. When no image is set it
shows a neutral placeholder that also advertises the slot itself.

HTML-injection note: the only values interpolated into markup are
``banner_image_url`` / ``banner_link_url``, which come from OUR trusted ops
config, never from user input. They are still ``html.escape``-d as
defence-in-depth so a stray quote in an env var can't break out of the attribute.
This contained use of ``unsafe_allow_html`` is why it is safe.
"""

from __future__ import annotations

import html

import streamlit as st

from engine.config import Settings

# The vendor credit target. A constant, not config: it's our own attribution and
# should never vary per deployment.
_ATLASIQ_URL = "https://www.atlasiq.co"


def render_ad_and_credit(settings: Settings) -> None:
    """Render the ad banner then the "Powered by AtlasIQ" credit into the current
    sidebar context (call inside a ``with st.sidebar:`` block).

    Banner: if ``settings.banner_image_url`` is a real http(s) URL, a full-width
    rounded, clickable image (links to ``banner_link_url`` in a new tab, or is
    unlinked if that's blank). Otherwise a neutral dashed placeholder that reads
    "Advertising space" — so the slot always renders something, and an empty slot
    doubles as a pitch to fill it.
    """
    # --- Banner ---------------------------------------------------------------
    img = (settings.banner_image_url or "").strip()
    link = (settings.banner_link_url or "").strip()

    if img.lower().startswith("http"):
        # A live ad. Escape both URLs before dropping them into attributes; fall
        # back to "#" (unlinked) when no advertiser landing page is configured.
        safe_img = html.escape(img, quote=True)
        safe_link = html.escape(link, quote=True) if link.lower().startswith("http") else "#"
        banner = (
            f'<a href="{safe_link}" target="_blank" rel="noopener">'
            f'<img src="{safe_img}" alt="Advertisement" '
            f'style="width:100%;border-radius:8px;display:block"></a>'
        )
    else:
        # No ad set (or a malformed URL — see engine/validate.py banner_config):
        # show the neutral placeholder. Theme-neutral rgba colours so it reads on
        # both light and dark Streamlit themes.
        banner = (
            '<div style="width:100%;padding:1.5rem 0.75rem;border:1px dashed rgba(128,128,128,0.5);'
            'border-radius:8px;text-align:center;color:rgba(128,128,128,0.9);font-size:0.85em;'
            'line-height:1.4">Advertising space<br>'
            '<span style="opacity:0.75">reach cruise agencies here</span></div>'
        )

    # --- Credit ---------------------------------------------------------------
    # Subtle, dimmed, new-tab link. Small top margin so it sits just under the banner.
    credit = (
        f'<div style="margin-top:0.5rem;text-align:center">'
        f'<a href="{_ATLASIQ_URL}" target="_blank" rel="noopener" '
        f'style="font-size:0.8em;opacity:0.65;text-decoration:none">Powered by AtlasIQ</a></div>'
    )

    st.markdown(banner + credit, unsafe_allow_html=True)
