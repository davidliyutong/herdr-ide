// Package pricing carries the AI usage feature's price table,
// pricing.json: the API prices the cost scanners apply, by provider and
// model. One file for both machine sides while the Go program exists: the
// Go agent embeds it here (internal/usage), the TypeScript machine side and
// core import it (backend/features/usage). Edit it by hand from the
// providers' pages; go run ./scripts/pricecheck lists what differs from
// LiteLLM's table.
package pricing

import _ "embed"

// JSON is pricing.json.
//
//go:embed pricing.json
var JSON []byte
