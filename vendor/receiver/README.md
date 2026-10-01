# Nait-AWG Receiver 0.2.1

This is an independent copy of the AWG control code from the local NaitRelax
working tree (`Nait-AWG-Node/receiver`, version 0.2.1). The GitHub checkout of
Nait-AWG-Node was still at 0.1.8 when this copy was made. No runtime dependency
on that private repository exists.

Nait-AWG uses only the AWG routes. Its `src/app.js` is a smaller loopback-only
entrypoint. The API requires a non-placeholder Bearer key for all AWG routes;
unlike the original multi-node receiver, it does not trust a network overlay
without authentication.

Changes here are maintained locally in Nait-AWG. Fixes to the multi-node receiver
are not copied automatically; review and test them separately if needed.
