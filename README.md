# LinkDash

LinkDash is a Cockpit plugin that provides service bookmarks with
optional embedded view support.

It is designed to integrate cleanly with Cockpit's PatternFly theme
without introducing visual drift, hardcoded styles, or framework
conflicts.

LinkDash was designed to be:
-   PF-token driven
-   Theme-safe inside Cockpit
-   Behavior-consistent
-   Minimal by design

------------------------------------------------------------------------
## Design Philosophy

-   Zero visual drift from Cockpit
-   No local theme system
-   No hardcoded design tokens
-   Explicit behavior over magic
-   Clean DOM structure
-   Strict separation of concerns
------------------------------------------------------------------------
## File Structure

    index.html        → Layout + structure
    linkdash.css      → Token-mapped styling (PF → LD)
    linkdash.js       → Logic + state handling
    manifest.json     → Cockpit integration metadata
    readme.md         → This file

------------------------------------------------------------------------
###  UI Behavior 

-   Open behavior is dynamic:
    -   If "Open in frame" selected → open embedded
    -   Otherwise → open in new tab
-   Reorder is global
-   Reorder is independent of search or group filters
-   "Save order" activates only after reorder changes

------------------------------------------------------------------------

### Theme Integration
-   No hardcoded color values
-   No color fallbacks
-   All colors must come from PatternFly tokens
-   PatternFly tokens are sourced from Cockpit `shell.css`
-   Components use only internal `--ld-*` tokens
-   `--ld-*` tokens are mapped from PF tokens in `:root`
  PatternFly → LinkDash mapping example:
  :root {
    --ld-bg: var(--pf-t--global--background--color--secondary--default);
    --ld-text: var(--pf-t--global--text--color--regular);
    --ld-primary-bg: var(--pf-t--global--background--color--action--primary--default);
  }
  #### Iframe Theme Handling
  -   PatternFly tokens are not inherited inside iframe context
  -   Theme mapping  read values from `window.top`
  -   No assumptions that PF exists inside the iframe
  -   Theme detection is  explicit
  
------------------------------------------------------------------------
