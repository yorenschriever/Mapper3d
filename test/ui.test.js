import { test } from "node:test";
import assert from "node:assert/strict";
import { errorSummary } from "../web/ui/error-notice.js";
import { ProcessingScreen } from "../web/ui/processing-screen.js";

test("scan errors give actionable summaries without exposing technical diagnostics", () => {
  const movement = errorSummary({ message: "Not enough camera movement or shared lights: 19 lights in 444 frames" });
  assert.match(movement, /Move sideways/);
  assert.doesNotMatch(movement, /444 frames/);
  assert.match(errorSummary({ name: "RangeError", message: "allocation failed" }), /memory/i);
  assert.match(errorSummary({ name: "NotAllowedError", message: "Permission denied" }), /browser settings/i);
  assert.match(errorSummary({ message: "Cannot read this video" }), /MP4/);
});

test("processing displays a percentage when progress is known and spins otherwise", () => {
  const known = ProcessingScreen({ fraction: 0.63, status: "Registering cameras" }).props.children[0];
  assert.equal(known.props["aria-valuenow"], 63);
  assert.equal(known.props.children[1].props.children[0], 63);
  assert.doesNotMatch(known.props.class, /spinning/);
  const unknown = ProcessingScreen({}).props.children[0];
  assert.equal(unknown.props["aria-valuenow"], undefined);
  assert.match(unknown.props.class, /spinning/);
});
