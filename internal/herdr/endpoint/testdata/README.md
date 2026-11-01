# Endpoint test data

- `herdr/endpoint-*-v1.json` are copied unchanged from herdr 0.9.5
  (`tests/fixtures/`, commit 2ecf19a), Apache-2.0; see
  [licenses/herdr](../../../../licenses/herdr/LICENSE). herdr keeps them as
  the frozen JSON shapes of endpoint generation 1.
- `session/NNN.bin` are the server message payloads (without the length
  prefix), in order, that herdr 0.9.5 sent to one endpoint connection of an
  isolated dev session: the handshake follow-ups, a full surface, patches,
  `endpoint.surface-scroll.v1` controls while a shell printed lines, and a
  second full surface after a cell-size change.
